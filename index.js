import path from "node:path";
import fs from "node:fs/promises";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { NodeFs, ResourceFs } from "./lib/storage.js";
import { Vault } from "./lib/vault.js";
import { VaultAI } from "./lib/ai.js";
import { registerRoutes } from "./lib/routes.js";
import { makeClipStore } from "./lib/clipstore.js";
import { CLOUD_KEY, uploadViaCurl, downloadViaCurl, setResolver } from "./lib/cloud.js";
import { splitCandidates } from "./lib/clip.js";

export const name = "nian-vault";

const LOCATION_KEY = "vaultLocation";
const NOTICE_KEY = "lastClipNotice";
const PICK_KEY = "lastClipPick";

function textResult(text) { return { content: [{ type: "text", text }] }; }

async function fsStat(p) {
  const fs = await import("node:fs/promises");
  const st = await fs.stat(p);
  return { isDirectory: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString().slice(0, 10) };
}

function fmtSize(n) {
  if (n == null) return "未知";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function guessType(p) {
  const ext = p.match(/\.(\w{1,8})$/)?.[1]?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "mkv", "mov", "avi", "webm", "flv"].includes(ext)) return "video";
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "md", "txt"].includes(ext)) return "file";
  return "file";
}

// 从 hook 入参里挖「这次消息带了哪些附件」。
// 字段名没有文档，把所有见过/可能的名字都探一遍：
//   inv.attachments / inv.files / inv.sessionFiles / inv.attachedFiles
// 每条归一成 { name, kind, path?, url?, mime? }。挖不到就返回空数组。
// 绝不抛异常：猜错字段名只该让这个功能不触发，不该让 hook 挂掉。
function extractAttachments(inv) {
  const out = [];
  const push = (raw) => {
    if (!raw) return;
    const name = String(raw.name || raw.fileName || raw.filename || raw.label || raw.title || "").trim();
    if (!name) return;
    const kind = String(raw.kind || raw.type || raw.mimeType || raw.mime || "").toLowerCase();
    out.push({
      name,
      kind,
      path: raw.path || raw.filePath || raw.localPath || raw.uri || null,
      url: raw.url || raw.href || null,
      size: typeof raw.size === "number" ? raw.size : null,
      mime: raw.mimeType || raw.mime || null,
    });
  };
  for (const key of ["attachments", "files", "sessionFiles", "attachedFiles", "resources"]) {
    const arr = inv?.[key];
    if (Array.isArray(arr)) arr.forEach(push);
  }
  // 去重：同一个文件被多个字段名带上时只留一条
  const seen = new Set();
  return out.filter((a) => {
    const k = a.path || a.url || a.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 附件分类：图片 / 视频 / 音频 / 其他文件。决定横幅文案和入库方式。
function classifyAttachment(a) {
  const ext = (a.name.match(/\.(\w{1,8})$/) || [])[1]?.toLowerCase() || "";
  const k = a.kind || "";
  if (/^image\//.test(k) || ["png","jpg","jpeg","gif","webp","bmp","svg","avif"].includes(ext)) return "image";
  if (/^video\//.test(k) || ["mp4","webm","mov","mkv","avi","m4v","flv"].includes(ext)) return "video";
  if (/^audio\//.test(k) || ["mp3","wav","ogg","m4a","flac","aac"].includes(ext)) return "audio";
  return "file";
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export default defineApp(async (sdk) => {
  const defaultRoot = path.join(sdk.dataDir, "vault");
  let vault = null;
  let lastError = null;

  // 自定义位置：dataDir 内用 node:fs；盘外走 ResourceIO（需要资源读写授权）
  function backendFor(root) {
    return isInside(root, sdk.dataDir) ? new NodeFs() : new ResourceFs(sdk.resources);
  }

  async function openVault(root) {
    // extFs 专门用来操作「库外路径」。
    // 沙箱里 NodeFs 读不到 Desktop 这类外部目录（stat 恒 null），
    // 而宿主资源接口能读——诊断已经证实：resources.stat 返回 isDirectory:true，
    // 同一路径走 node:fs 却是 null。
    const v = new Vault(backendFor(root), root, new ResourceFs(sdk.resources));
    await v.init();
    return v;
  }

  async function currentLocation() {
    const saved = await sdk.storage.global.get(LOCATION_KEY, null).catch(() => null);
    return typeof saved === "string" && path.isAbsolute(saved) ? saved : defaultRoot;
  }

  async function getVault() {
    if (vault) return vault;
    const root = await currentLocation();
    try {
      vault = await openVault(root);
      lastError = null;
    } catch (err) {
      lastError = `无法打开收藏库位置 ${root}：${err?.message || err}`;
      await sdk.logger.warn(lastError);
      if (root === defaultRoot) throw err;
      vault = await openVault(defaultRoot);
    }
    return vault;
  }

  async function setLocation(target, mode) {
    const raw = String(target ?? "").trim();
    if (raw && !path.isAbsolute(raw)) throw new Error("请填写绝对路径，例如 D:\\我的收藏");
    const root = raw ? path.resolve(raw) : defaultRoot;
    const old = await getVault();
    if (path.resolve(old.root).toLowerCase() === root.toLowerCase()) return { root, changed: false };
    if (isInside(root, old.root) || isInside(old.root, root)) throw new Error("新位置不能在当前收藏库里面，也不能是它的上级目录");
    const fsImpl = backendFor(root);
    let copied = 0;
    if (mode === "copy") {
      const r = await old.copyTo(fsImpl, root);
      copied = r.files;
    }
    const next = new Vault(fsImpl, root);
    await next.init();
    vault = next;
    lastError = null;
    await sdk.storage.global.set(LOCATION_KEY, root === defaultRoot ? null : root);
    return { root, changed: true, copied, oldRoot: old.root };
  }

  const ai = new VaultAI(sdk, getVault);
  const clips = makeClipStore(sdk);
  setResolver(async (candidate) => await sdk.process?.resolveExecutable?.({ candidates: [candidate] }) || null);

  const getCloudConfig = async () => await sdk.storage.global.get(CLOUD_KEY, null).catch(() => null);
  const setCloudConfig = async (cfg) => { await sdk.storage.global.set(CLOUD_KEY, cfg); return cfg; };
  const spawnEnabled = async () => {
    try {
      const r = await sdk.bus.request("app:capabilities", {});
      return (r?.capabilities || []).some((x) => x.capability === "app/process.spawn" && (x.status === "always" || x.status === "session"));
    } catch {
      return false;
    }
  };
  const pushToCloud = async (file, cfg, bytes) => {
    // curl 子进程只获准读取 App dataDir；自定义库可能位于授权目录之外。
    const safeFile = path.join(sdk.dataDir, "_cloud-upload", "nian-vault-latest.zip");
    const data = bytes || await (await getVault()).fs.readBytes(file);
    await fs.mkdir(path.dirname(safeFile), { recursive: true });
    await fs.writeFile(safeFile, data);
    return await uploadViaCurl(cfg, safeFile, await spawnEnabled());
  };
  const pullFromCloud = async (cfg) => {
    const safeFile = path.join(sdk.dataDir, "_cloud-upload", `restore-${Date.now()}.zip`);
    await fs.mkdir(path.dirname(safeFile), { recursive: true });
    const result = await downloadViaCurl(cfg, safeFile, await spawnEnabled());
    if (!result.ok) return result;
    const data = await fs.readFile(safeFile);
    await fs.unlink(safeFile).catch(() => {});
    return { ...result, bytes: data.length, contentBase64: data.toString("base64") };
  };

  // ---------------- 会话侧联动 ----------------
  // 会话定位：session:list 在实测中（scope:"all"）能返回全部会话，
  // 官方文档写“只看得到归属自己的”，文档与实现不一致时以实测为准。
  // 失败时如实报错，不把权限缺失伪装成“没有来源会话”。
  const normPath = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  let sessionCache = { at: 0, rows: [] };
  async function listSessions(force = false) {
    if (!force && Date.now() - sessionCache.at < 15000) return sessionCache.rows;
    try {
      const res = await sdk.bus.request("session:list", { scope: "all", lifecycle: "all" });
      sessionCache = { at: Date.now(), rows: Array.isArray(res?.sessions) ? res.sessions : [] };
    } catch (err) {
      throw new Error(`读不到会话列表（可能缺 app/sessions.read）：${err?.message || err}`);
    }
    return sessionCache.rows;
  }

  const resolveSession = async (p) => {
    const target = normPath(p);
    if (!target) return null;
    for (const s of await listSessions()) {
      if (normPath(s.path) === target || normPath(s.sessionPath) === target) {
        return { sessionId: s.sessionId || null, title: s.title || null, agentName: s.agentName || null, path: s.path || null };
      }
    }
    return null;
  };

  // 把几条收藏摄成一摞“后台工作会话”：App 建的会话宿主钉成 plugin_private，
  // 不进用户主会话列表，所以产出统一落回收藏夹，而不是“开一个看得见的工作台”。
  const expandToStudio = async ({ ids, prompt }) => {
    const v = await getVault();
    const picked = ids.map((id) => v.get(id)).filter(Boolean);
    if (!picked.length) return { ok: false, error: "选中的收藏都不存在" };
    const brief = picked
      .map((e) => `### ${e.title}\n分类：${e.category}\n标签：${e.tags.join("、") || "无"}\n\n${e.content.slice(0, 4000)}`)
      .join("\n\n---\n\n");
    const task = `${prompt || "请把下面几条收藏整理成一份可用的学习/工作材料：先给一句结论，再给要点清单，最后给可执行的下一步。"}\n\n${brief}`;
    let created = null;
    let lastErr = null;
    // 先带工作目录试一次；目录不可用时退到最小请求，不把失败说成成功。
    for (const payload of [{ cwd: await currentLocation() }, {}]) {
      try {
        created = await sdk.bus.request("session:create", payload);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!created) {
      return { ok: false, error: `建不了工作会话（可能缺 app/sessions.manage）：${lastErr?.message || lastErr}` };
    }
    const sid = created?.sessionId || created?.sessionPath;
    if (!sid) return { ok: false, error: "宿主没返回新会话标识" };
    try {
      await sdk.bus.request("session:send", {
        sessionId: created?.sessionId || undefined,
        sessionPath: created?.sessionPath || undefined,
        text: task,
      });
    } catch (err) {
      return { ok: false, error: `工作会话已建但发不出任务：${err?.message || err}`, sessionId: created?.sessionId || null };
    }
    const note = await v.create({
      title: `工作台·${picked[0].title.slice(0, 20)}`,
      content: [
        `> 已把 ${picked.length} 条收藏交给 AI 处理（后台工作会话，不在主会话列表里）。`,
        "",
        "## 送进去的材料",
        ...picked.map((e) => `- [[${e.title}]]（${e.category}）`),
        "",
        "## 任务",
        task.slice(0, 600),
      ].join("\n"),
      category: "收件箱",
      tags: ["工作台", "待回收"],
      source: "收藏摄成工作台",
    });
    return { ok: true, sessionId: created?.sessionId || null, entries: picked.length, noteId: note.id, private: true };
  };

  // 对话里的流内回执卡：把“收了什么”直接画在对话里。
  // 两条入口的凭证不同：模型循环通道宿主铸 callToken；按钮通道（输入栏按钮、右键、快捷键）
  // **不铸令牌**，只给 sessionPath。只认 callToken 会让按钮那条路永远投不出去。
  const sayInSession = async (ctx, text) => {
    if (!ctx?.sessionPath) return;
    try {
      await sdk.inputBanner.set({ sessionPath: ctx.sessionPath, bannerId: "nian-vault-notice", text, buttons: [] });
    } catch { /* banner 也发不出去就只能记日志 */ }
  };

  const deliverCard = async (ctx, customType, content, payloadKey) => {
    if (payloadKey) {
      try { await sdk.storage.global.set(payloadKey, content); }
      catch (err) { await sdk.logger.warn(`投递载荷落库失败：${err?.message || err}`).catch(() => {}); }
    }
    const target = ctx.callToken
      ? { callToken: ctx.callToken }
      : ctx.sessionPath
        ? { sessionPath: ctx.sessionPath, scope: "all" }
        : null;
    if (!target) {
      await sdk.logger.warn(`${customType}：按钮通道没拿到 callToken 也没有 sessionPath，无法投递`).catch(() => {});
      await sayInSession(ctx, "念念收藏夹：这次没能把卡片投进对话（没拿到会话定位）。");
      return false;
    }
    try {
      await sdk.bus.request("session:send-custom", {
        ...target,
        customType,
        display: true,
        triggerTurn: false,
        content,
      });
      return true;
    } catch (err) {
      await sdk.logger.warn(`${customType} 投递失败：${err?.message || err}`).catch(() => {});
      await sayInSession(ctx, `念念收藏夹：卡片没投出来（${String(err?.message || err).slice(0, 90)}）。请从左侧导航打开面板。`);
      return false;
    }
  };

const deliverNotice = async (args, payload) => {
    const ctx = args?.context || {};
    return await deliverCard(ctx, "clip-notice", payload.from === "panel-hint" ? "念念收藏夹" : "已收入念念收藏夹", NOTICE_KEY);
  };

  // ---------------- 给 AI 与宿主界面用的工具 ----------------
  const reg = (tool) => sdk.tools.register(tool).catch((e) => sdk.logger.error(`工具注册失败 ${tool.name}: ${e?.message || e}`));

  await reg({
    name: "nian_vault_save",
    description:
      "把内容收藏进用户的「念念收藏夹」（个人数字资产库，Markdown 存储）。用户说「记下来/收藏/存一下/记到某某分类」或对话中出现重要知识、链接、配置方案时调用。" +
      "先用 nian_vault_categories 看已有分类，尽量归入已有分类；确实没有合适的才新建（category 填新名字会自动创建），拿不准就不填（进「收件箱」）。" +
      "content 用 Markdown，保留原文要点，不要擅自删减用户原话。\n" +
      "【网页/文章收藏】不要只存 URL：先 web_fetch 抓标题与正文要点作 content，type=link，source=完整 URL。\n" +
      "【B站/抖音视频页收藏】type=video，source=原页面 URL；并从页面提取封面图填 cover；embed 填播放器地址 https://player.bilibili.com/player.html?bvid=BVxxx&autoplay=0；content 写标题/UP主/简介/时长。\n" +
      "【本地文件】改用 nian_vault_save_file。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Markdown 正文" },
        title: { type: "string", description: "标题，简短；不填则由 AI 或正文第一行生成" },
        category: { type: "string", description: "分类名；不存在会新建；不填则智能推荐或进收件箱" },
        tags: { type: "array", items: { type: "string" }, description: "标签，最多 20 个" },
        type: { type: "string", enum: ["note", "text", "link", "image", "video", "file", "folder", "memory", "experience"], description: "内容类型，默认 note" },
        source: { type: "string", description: "来源，例如网址或「对话」" },
        cover: { type: "string", description: "封面图 URL（视频/网页收藏可选）" },
        embed: { type: "string", description: "可嵌入/可播放的链接，如 B站播放器或直链视频（可选）" },
      },
      required: ["content"],
    },
    execute: async (args) => {
      const v = await getVault();
      let { title, category, tags } = args;
      // 若调用时未传标签或标题，自动调用内置 AI 补全
      if (!tags?.length || !title) {
        const auto = await ai.analyzeEntry({ title: title || "", content: args.content }).catch(() => null);
        if (auto) {
          if (!title) title = auto.title;
          if (!tags?.length) tags = auto.tags;
          if (!category && auto.category && auto.category !== "收件箱") category = auto.category;
        }
      }
      const e = await v.create({ ...args, title, category, tags, source: args.source || "对话", session: args?.context?.sessionPath ? { sessionPath: args.context.sessionPath, messageId: args?.context?.messageId || null } : null });
      return textResult(`已收藏到「${e.category}」：${e.title}（id: ${e.id}${e.tags.length ? "，标签: " + e.tags.join("、") : ""}）`);
    },
  });

  await reg({
    name: "nian_vault_pick_from_chat",
    description: "在对话里弹一张勾选卡：从当前这段对话中拆出候选片段，让你勾选要收藏的内容，勾完后由 AI 自动生成标题、分类和标签收入收藏夹。绑在输入栏「念念收藏」按钮上。当用户点那个按钮、或说「把刚才那段收进收藏夹」时使用。",
    parameters: { type: "object", properties: {} },
    execute: async (args) => {
      const ctx = args?.context || {};
      const target = ctx.callToken ? { callToken: ctx.callToken } : ctx.sessionPath ? { sessionPath: ctx.sessionPath, scope: "all" } : null;
      if (!target) return textResult("这个入口拿不到当前会话的位置，没法读对话内容。请从左侧导航打开「念念收藏夹」。");

      let history;
      try {
        history = await sdk.bus.request("session:history", { ...target, limit: 30 });
      } catch (err) {
        await sdk.logger.warn(`读会话历史失败：${err?.message || err}`).catch(() => {});
        return textResult(`读不到这段对话的内容（${String(err?.message || err).slice(0, 80)}）。请从左侧导航打开「念念收藏夹」。`);
      }

      const turns = (history?.messages || [])
        .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
        .slice(-12);
      if (!turns.length) return textResult("这段对话里还没有可整理的内容。");

      const items = [];
      for (const m of turns) {
        const who = m.role === "user" ? "你" : "我";
        for (const c of splitCandidates(`${who}：${String(m.content).trim()}`)) {
          items.push({ id: `c${items.length}`, title: c.title, text: c.text, from: who });
        }
      }
      if (!items.length) return textResult("这段对话里没有能拆出的可收藏片段。");

      const payload = { at: new Date().toISOString(), sessionPath: ctx.sessionPath || null, items: items.slice(0, 24) };
      try { await sdk.storage.global.set(PICK_KEY, payload); } catch { /* 落库失败不影响投卡 */ }
      const ok = await deliverCard(ctx, "clip-picker", "选要收藏的内容", null);
      if (!ok) return textResult("勾选卡没投出来。请确认已批准 App 的「app/session.start-turn」权限（在设置 → App 里）。");
      return textResult(`已弹出勾选卡：从这段对话里拆出 ${payload.items.length} 个候选片段，勾选后会自动调 AI 整理进收藏夹。`);
    },
  });

  await reg({
    name: "nian_vault_open_panel",
    description: "在对话里打开念念收藏夹：投递一张卡片，显示当前收件箱待整理数与待确认候选数，并提供直达入口。当用户说「打开收藏夹/念念收藏夹/收件箱」或想整理待收藏内容时使用。",
    parameters: { type: "object", properties: {} },
    execute: async (args) => {
      const v = await getVault();
      const inbox = v.listCategories().find((c) => c.name === "收件箱")?.count || 0;
      const pending = await clips.list();
      const ok = await deliverNotice(args, {
        at: new Date().toISOString(),
        from: "panel-hint",
        items: [],
        stats: { inbox, pending: pending.items?.length || 0, total: v.entries.size },
      });
      if (ok) return textResult("已在对话里打开念念收藏夹卡片。");
      // 投递失败只说明明说，不自毁按钮：自动隐藏会把一次可诊断的失败
      // 变成“按钮凭空不见了”，下一次更难查。真正的根因写进日志。
      await sdk.logger.warn("clip-notice 投递失败：多半是 app/session.start-turn 权限没批准，或该通道拿不到会话定位").catch(() => {});
      await sayInSession(ctx, "念念收藏夹：卡片没投出来。原因见 App 日志（多半是 start-turn 权限未批准）。面板仍可从左侧导航打开。");
      return textResult("卡片没投出来。请从左侧导航打开「念念收藏夹」；或直接跟我说“打开收藏夹”，我走模型通道给你投。");
    },
  });

  await reg({
    name: "nian_vault_quick_clip",
    description: "一键将当前聊天消息或划选文字收入「念念收藏夹」，并自动使用 OpenHanako 模型生成标题、分类与标签（绑定在消息底部按钮与选中文本右键菜单上）。若没有可确定的文本（典型情形：输入栏按钮与全局快捷键），请改用 nian_vault_open_panel 打开面板。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要收藏的文本（留空则自动读取当前消息或划选文字）" },
        category: { type: "string", description: "可选目标分类" },
      },
    },
    execute: async (args) => {
      const rawText = String(args?.text || args?.context?.selectionText || args?.context?.messageText || "").trim();
      if (!rawText) return textResult("未检测到可收藏的消息内容：这个入口拿不到具体是哪条消息（输入栏按钮与快捷键都属此类）。请用消息气泡下方的「📥 收入念念收藏夹」，或让我直接调用 nian_vault_open_panel 打开面板。");

      // 按钮/选区入口先列候选；Agent 显式传 text 时保留原有直接收藏语义。
      const fromUi = !String(args?.text || "").trim() && !!args?.context?.sessionPath;
      if (fromUi) {
        const items = splitCandidates(rawText).map((it) => ({ id: it.id, title: it.title, text: it.text }));
        const requestedSchema = {
          type: "object",
          properties: Object.fromEntries(items.map((it) => [it.id, { type: "boolean" }])),
        };
        try {
          const answer = await sdk.userInteraction.ask({
            sessionPath: args.context.sessionPath,
            title: "选择要收藏的内容",
            message: `从这条消息中整理出 ${items.length} 个候选片段。勾选后会由 AI 生成标题和标签，并收入收件箱。`,
            requestedSchema,
            contentFrame: { route: "/clip-picker.html", data: { items } },
            presentation: { height: 420, collapsedHeight: 42, expanded: true },
            timeoutMs: 5 * 60 * 1000,
          });
          if (answer?.action !== "confirmed") return textResult("已取消收藏，没有写入任何内容。");
          const selected = items.filter((it) => answer.value?.[it.id] === true);
          if (!selected.length) return textResult("没有选中候选内容，没有写入收藏夹。");
          const v = await getVault();
          const saved = [];
          for (const it of selected) {
            const a = await ai.analyzeEntry({ title: it.title, content: it.text }).catch(() => null);
            const e = await v.create({ title: a?.title || it.title, content: it.text, category: "收件箱", tags: a?.tags || [], source: "对话剪藏", session: { sessionPath: args.context.sessionPath, messageId: args?.context?.messageId || null } });
            saved.push(e);
          }
          await deliverNotice(args, { at: new Date().toISOString(), from: "clip-picker",
        items: saved.map((e) => ({ id: e.id, title: e.title, category: e.category, tags: e.tags, snippet: String(e.content || "").replace(/\s+/g, " ").slice(0, 90) })) });
    return textResult(`✓ 已收藏 ${saved.length} 条到「收件箱」：${saved.map((e) => `《${e.title}》`).join("、")}`);
        } catch (err) {
          const staged = await clips.stage(rawText, { from: "对话待确认" }).catch(() => ({ added: 0, items: [] }));
          return textResult(`收藏选择面板未能打开：${err?.message || err}。已把 ${staged.added || 0} 条候选放入念念收藏夹「待确认收藏」，打开面板勾选后即可收入收件箱。`);
        }
      }

      const v = await getVault();
      const analysis = await ai.analyzeEntry({ title: "", content: rawText });
      const e = await v.create({ title: analysis.title, content: rawText, category: args?.category || analysis.category || "收件箱", tags: analysis.tags, source: "对话一键剪藏", session: args?.context?.sessionPath ? { sessionPath: args.context.sessionPath, messageId: args?.context?.messageId || null } : null });
      await deliverNotice(args, { at: new Date().toISOString(), from: "quick-clip",
        items: [{ id: e.id, title: e.title, category: e.category, tags: e.tags, snippet: String(e.content || "").replace(/\s+/g, " ").slice(0, 90) }] });
      return textResult(`✨ 已智能归档到「${e.category}」：《${e.title}》（标签：${e.tags.join("、") || "无"}）`);
    },
  });

  await reg({
    name: "nian_vault_search",
    description: "在「念念收藏夹」里按关键词搜索收藏内容（标题、标签、正文），可限定分类或标签。用户问「我之前收藏过/记过什么」时使用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，空格分隔表示同时包含" },
        category: { type: "string" },
        tag: { type: "string" },
        limit: { type: "number", description: "默认 10，最多 50" },
      },
    },
    execute: async (args) => {
      const v = await getVault();
      const items = v.list({ ...args, limit: Math.min(50, Number(args.limit) || 10) });
      if (!items.length) return textResult("没有找到匹配的收藏。");
      return textResult(items.map((i) => `- [${i.category}] ${i.title}（id: ${i.id}${i.tags.length ? "，标签: " + i.tags.join("/") : ""}）\n  ${i.snippet}`).join("\n"));
    },
  });

  await reg({
    name: "nian_vault_get",
    description: "读取「念念收藏夹」中一条收藏的完整 Markdown 内容。",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async ({ id }) => {
      const e = (await getVault()).get(id);
      if (!e) return textResult(`找不到 id 为 ${id} 的收藏。`);
      return textResult(`# ${e.title}\n分类：${e.category}　标签：${e.tags.join("、") || "无"}　更新：${e.updated}\n\n${e.content}`);
    },
  });

  await reg({
    name: "nian_vault_categories",
    description: "列出「念念收藏夹」的全部分类及每类条目数，也可新建分类（传 create）。收藏前先调用它决定归类。",
    parameters: {
      type: "object",
      properties: {
        create: { type: "string", description: "要新建的分类名（可选）" },
        description: { type: "string", description: "新分类的说明（可选）" },
      },
    },
    execute: async ({ create, description }) => {
      const v = await getVault();
      let note = "";
      if (create) {
        const r = await v.createCategory(create, description);
        note = r.created ? `已新建分类「${r.name}」。\n` : `分类「${r.name}」已存在。\n`;
      }
      return textResult(note + v.listCategories().map((c) => `- ${c.name}（${c.count}）${c.description ? "：" + c.description : ""}`).join("\n"));
    },
  });

  await reg({
    name: "nian_vault_update",
    description: "修改「念念收藏夹」里的一条收藏：改标题/标签/分类，整体替换正文（content）或在末尾追加（append）。用于合并同主题内容。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string", description: "替换整个正文" },
        append: { type: "string", description: "追加到正文末尾" },
        category: { type: "string", description: "移动到该分类（不存在则新建）" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
    execute: async ({ id, ...patch }) => {
      const e = await (await getVault()).update(id, patch);
      return textResult(`已更新「${e.title}」（分类：${e.category}）。`);
    },
  });

  await reg({
    name: "nian_vault_save_file",
    description:
      "把本地文件/文件夹以引用方式收藏进「念念收藏夹」：只记录路径与元信息，不移动、不复制原文件。" +
      "用户说「把这个文件收进来/引用这个视频/收藏这个文件夹」时调用。需要先用本地工具确认路径存在。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "绝对路径" },
        title: { type: "string", description: "标题，不填取文件名" },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string", description: "备注，例如文件内容概述" },
      },
      required: ["path"],
    },
    execute: async ({ path: p, title, category, tags, note }) => {
      const v = await getVault();
      let kind = "file";
      let metaLine = "";
      const statLike = async () => {
        try { return await fsStat(p); }
        catch (err) {
          if (err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "ENOTCONN" || err.code === "EPERM_SANDBOX")) {
            const res = await sdk.resources.stat({ kind: "local-file", path: p }).catch(() => null);
            if (res && res.exists !== false) {
              const size = res.size ?? (typeof res.byteLength === "number" ? res.byteLength : null);
              const mt = res.mtimeMs ?? res.mtime ?? null;
              const mtime = typeof mt === "number" ? new Date(mt).toISOString().slice(0, 10) : mt ? String(mt).slice(0, 10) : "";
              return { isDirectory: !!(res.isDirectory ?? res.isDir), size, mtime };
            }
          }
          return null;
        }
      };
      const st = await statLike();
      if (st) {
        kind = st.isDirectory ? "folder" : guessType(p);
        metaLine = `\n\n> 大小 ${fmtSize(st.size)}　修改于 ${st.mtime || "未知"}`;
      } else {
        metaLine = "\n\n> ⚠ 保存时无法访问此路径（可能未挂载或无权限），使用前请确认";
      }
      const content = `# 文件引用\n\n- 路径：\`${p}\`\n- 类型：${kind === "folder" ? "文件夹" : kind}${note ? "\n- 备注：" + note : ""}${metaLine}\n\n原文件保留在原位置，本条目只存指针。`;
      const e = await v.create({
        title: title || p.split(/[\\/]/).filter(Boolean).pop() || "未命名文件",
        content,
        category,
        tags,
        type: kind === "folder" ? "folder" : kind,
        source: p,
      });
      return textResult(`已收藏文件引用到「${e.category}」：${e.title}（id: ${e.id}）。原文件未移动。`);
    },
  });

  await reg({
    name: "nian_vault_list_inbox",
    description:
      "列出「念念收藏夹」收件箱里的全部条目（含正文摘要），用于 AI 整理归位。" +
      "配合 nian_vault_batch_move 使用：先看收件箱有什么，再决定每条该去哪个分类。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const v = await getVault();
      const items = v.list({ category: "收件箱", limit: 100 });
      if (!items.length) return textResult("收件箱是空的，没有待整理的内容。");
      const cats = v.listCategories().filter((c) => c.name !== "收件箱").map((c) => c.name);
      return textResult(
        `收件箱共 ${items.length} 条。现有分类：${cats.join("、")}\n\n` +
        items.map((i) => `- id: ${i.id}\n  标题：${i.title}\n  摘要：${i.snippet}`).join("\n")
      );
    },
  });

  await reg({
    name: "nian_vault_batch_move",
    description:
      "批量把「念念收藏夹」条目移到分类并打标签（AI 整理归位用）。先调 nian_vault_list_inbox 看内容再调用本工具。",
    parameters: {
      type: "object",
      properties: {
        moves: {
          type: "array",
          description: "移动清单",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              category: { type: "string", description: "目标分类，不存在会新建" },
              tags: { type: "array", items: { type: "string" }, description: "追加的标签（与现有标签合并）" },
            },
            required: ["id", "category"],
          },
        },
      },
      required: ["moves"],
    },
    execute: async ({ moves }) => {
      const v = await getVault();
      let ok = 0;
      const errors = [];
      for (const m of moves || []) {
        try {
          let tags = m.tags;
          if (tags?.length) {
            const cur = v.get(m.id);
            tags = [...new Set([...(cur?.tags || []), ...tags])];
          }
          await v.update(m.id, { category: m.category, tags });
          ok++;
        } catch (err) {
          errors.push(`${m.id}: ${err?.message || err}`);
        }
      }
      return textResult(`已归位 ${ok}/${moves?.length || 0} 条。${errors.length ? "失败：" + errors.join("；") : ""}`);
    },
  });

  // ---------------- 聊天框斜杠命令：/vault、/收藏、/nian ----------------
  if (sdk.commands?.register) {
    await sdk.commands.register({
      name: "vault",
      aliases: ["收藏", "nian"],
      description: "快速把内容存入念念收藏夹，或输入 `/vault 整理` 自动整理收件箱",
      usage: "/vault <要收藏的内容 | 整理>",
      handler: async (inv) => {
        const arg = String(inv.args || "").trim();
        const v = await getVault();
        if (!arg || arg === "整理" || arg === "organize") {
          const plan = await ai.suggestInboxOrganization();
          if (!plan.suggestions.length) return "📭 念念收藏夹「收件箱」目前是空的，无需整理。";
          let moved = 0;
          for (const s of plan.suggestions) {
            await v.update(s.id, { category: s.category, tags: s.tags }).catch(() => {});
            moved++;
          }
          return `✨ 已通过 AI 自动整理收件箱 ${moved} 条内容！`;
        }
        const analysis = await ai.analyzeEntry({ content: arg });
        const e = await v.create({
          title: analysis.title,
          content: arg,
          category: analysis.category,
          tags: analysis.tags,
          source: "斜杠命令 /vault",
        });
        return `📥 已存入念念收藏夹「${e.category}」：《${e.title}》 [标签: ${e.tags.join(" / ") || "无"}]`;
      },
    }).catch(() => {});
  }

  // ---------------- 对话高感知 Hook：自动召回记忆 + 智能归档提醒横幅 ----------------
  if (sdk.hooks?.onDecision) {
    await sdk.hooks.onDecision("agent/before-start", async (inv) => {
      const { proactive } = await ai.getSettings();
      if (proactive === "off") return undefined;
      const v = await getVault();
      const prompt = String(inv.prompt || "").trim();
      if (!prompt) return undefined;

      const words = prompt.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w.length >= 2).slice(0, 3);
      let hits = [];
      for (const w of words) {
        hits = v.list({ query: w, limit: 4 });
        if (hits.length) break;
      }
      const recallBlock = hits.length
        ? `\n\n[念念收藏夹·自动关联记忆]（用户库中已有以下相关条目，回答时可直接参考或用 nian_vault_get 读全文）：\n` +
          hits.map((h) => `- [${h.category}] 《${h.title}》(id:${h.id})：${h.snippet}`).join("\n")
        : "";

      const proactiveGuide = proactive === "high"
        ? `\n[念念收藏夹·主动协作守则]：当用户在对话中分享了有价值的网址链接、B站视频、服务器配置指针、排错经验或学习笔记时，请主动调用 nian_vault_save 帮用户归档（或在回答末尾顺手提示已帮其收入收藏夹），无需等用户每次手动叮嘱“帮我收藏”。`
        : "";

      if (!recallBlock && !proactiveGuide) return undefined;
      return { systemPrompt: `${inv.systemPrompt || ""}${recallBlock}${proactiveGuide}` };
    }).catch(() => {});

    await sdk.hooks.onDecision("session/input", async (inv) => {
      const { proactive } = await ai.getSettings();
      if (proactive === "off") return undefined;
      const text = String(inv.text || "").trim();
      const hasUrl = /https?:\/\/[^\s]+/i.test(text);
      const isLongNote = text.length >= 180 && (text.includes("\n") || /笔记|总结|配置|步骤|课标|台账/.test(text));
      // 附件：粘贴的图片、拖入的视频、贴的本地文件。
      // 有附件就优先走附件分支——它比「长文本」更明确是用户想留的东西。
      const atts = extractAttachments(inv);
      const attKinds = [...new Set(atts.map(classifyAttachment))];
      if (atts.length && inv.session?.sessionPath && sdk.inputBanner?.set) {
        try {
          const kindWord = { image: "图片", video: "视频", audio: "音频", file: "文件" }[attKinds[0]] || "文件";
          const more = atts.length > 1 ? ` 等 ${atts.length} 个` : "";
          const names = atts.slice(0, 2).map((a) => a.name).join("、");
          sdk.inputBanner.set({
            sessionPath: inv.session.sessionPath,
            bannerId: "nv-collect-hint",
            text: `📎 检测到消息中附了${kindWord}（${names}${more}），是否收入「念念收藏夹」？`,
            buttons: [
              {
                id: "attach-file",
                title: "📦 存入资源库",
                action: {
                  kind: "post-message",
                  text: `请把本条消息附带的文件（${names}${more}）用 nian_vault_save_file 收进念念收藏夹：path 填文件的本地绝对路径，title 起个易懂的名字，tags 按内容给 2~4 个，note 写一句话说明这是什么。只做引用收藏，不要复制或移动原文件。`,
                },
              },
              {
                id: "attach-note",
                title: "📝 存资源并记一笔",
                action: {
                  kind: "post-message",
                  text: `请把本条消息附带的文件（${names}${more}）收进念念收藏夹并写一条笔记引用它：先用 nian_vault_save_file 存引用（path 用本地绝对路径，title 起易懂名，tags 2~4 个，note 一句话说明），再用 nian_vault_save 写一条笔记，正文里用 ![](资源的本地路径) 嵌入这个${kindWord}，分类按内容自动判断。`,
                },
              },
            ],
          });
        } catch {}
      }
      return undefined;
    }).catch(() => {});
  }

  // ---------------- 卡片界面用的路由 ----------------
  await sdk.routes.register((app) => {
    registerRoutes(app, {
      sdk,
      getVault,
      setLocation,
      currentLocation,
      defaultRoot,
      getWarning: () => lastError,
      ai,
      clips,
      getCloudConfig,
      setCloudConfig,
      pushToCloud,
      pullFromCloud,
      resolveSession,
      expandToStudio,
      getClipNotice: async () => await sdk.storage.global.get(NOTICE_KEY, null).catch(() => null),
      getClipPick: async () => await sdk.storage.global.get(PICK_KEY, null).catch(() => null),
      clearClipPick: async () => await sdk.storage.global.set(PICK_KEY, null).catch(() => {}),
      deliverClipNotice: async (payload) => {
        if (!payload?.sessionPath) {
          try { await sdk.storage.global.set(NOTICE_KEY, payload); } catch { /* 回执投递不了就算了 */ }
          return false;
        }
        return await deliverCard({ sessionPath: payload.sessionPath, scope: "all" }, "clip-notice", "已收入念念收藏夹", NOTICE_KEY);
      },
      dataDir: sdk.dataDir,
      spawnEnabled,
    });
  });

  await sdk.logger.info("nian-vault 0.4.0 loaded");
});
