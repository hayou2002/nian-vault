// 后端路由：抽成纯函数，方便本地用内存实现跑测试，也让 index.js 只负责接线。
import path from "node:path";
import { extractArticle as defaultExtractArticle } from "./article.js";

export function registerRoutes(app, deps) {
  // wrap 统一包 {ok:true, ...结果}。但资源路由返回的是 Response（c.body），
  // 摊开会把 Response 拆成 {ok,status,json:fn}，前端拿不到字节。
  // 所以先识别 Response / 带 json() 的对象，原样返回。
  const isRaw = (v) => v && typeof v === "object" && typeof v.json === "function" && "status" in v;
  const wrap = (fn) => async (c) => {
    try {
      const out = await fn(c);
      return isRaw(out) ? out : c.json({ ok: true, ...(out || {}) });
    } catch (err) {
      if (process.env.NV_DEBUG_STACK) console.error("[route]", err);
      return c.json({ ok: false, error: String(err?.message || err) }, 400);
    }
  };
  const body = async (c) => { try { return await c.req.json(); } catch { return {}; } };

  app.get("/status", wrap(async () => {
    const v = await deps.getVault();
    return {
      ...v.stats(),
      defaultRoot: deps.defaultRoot,
      configured: await deps.currentLocation(),
      warning: deps.getWarning(),
    };
  }));

  app.get("/categories", wrap(async () => ({ categories: (await deps.getVault()).listCategories() })));

  app.post("/categories", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).createCategory(b.name, b.description);
  }));

  app.post("/categories/rename", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).renameCategory(b.from, b.to, b.description);
  }));

  app.post("/categories/delete", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).deleteCategory(b.name);
  }));

  // ---------- 库规则（RULES.md）----------
  // 规则是家规：人和 AI 都按它办事。读/写库根下的 RULES.md。
  // 路径固定为库根 + RULES.md，不接受调用方传任意路径。
  app.get("/rules", wrap(async () => {
    const v = await deps.getVault();
    const f = path.join(v.root, "RULES.md");
    if (!(await v.fs.exists(f))) return { exists: false, rules: "", path: f };
    const txt = await v.fs.readText(f);
    // 限长：面板上不必渲染一整篇论文
    const MAX = 20000;
    return { exists: true, rules: txt.length > MAX ? txt.slice(0, MAX) + "\n…（过长，已截断显示）" : txt, path: f };
  }));

  app.post("/rules", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    const f = path.join(v.root, "RULES.md");
    const txt = String(b.content ?? "");
    if (txt.length > 50000) throw new Error("规则文件超过 50000 字上限");
    // 空内容 = 删掉规则文件，回到无规则模式（AI 自由发挥）
    if (!txt.trim()) {
      if (await v.fs.exists(f)) await v.fs.removeFile(f);
      return { ok: true, removed: true };
    }
    await v.fs.writeText(f, txt);
    return { ok: true, bytes: txt.length };
  }));

  app.get("/tags", wrap(async () => {
    const v = await deps.getVault();
    return { tags: v.listTags ? v.listTags() : [] };
  }));

  app.get("/entries", wrap(async (c) => {
    // q 可能为 null（某些宿主实现下 req.query() 无参会返回 null），
    // 不防护的话 q.category 直接炸，而 /entries 是面板的生命线。
    const q = c.req.query() || {};
    return { entries: (await deps.getVault()).list({ category: q.category, query: q.q, tag: q.tag, limit: q.limit }) };
  }));

  app.get("/entry", wrap(async (c) => {
    const e = (await deps.getVault()).get(c.req.query("id"));
    if (!e) throw new Error("条目不存在");
    return { entry: e };
  }));

  app.post("/entry", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    // extra 要显式透传：create 靠它把 ref（原件指针）写进 meta。
    // 之前整个 body 直接展开也行，但 update 不认 extra，
    // 导致剪藏条目一编辑就丢掉原网址。
    const extra = b.extra && typeof b.extra === "object" ? b.extra : undefined;
    const entry = b.id
      ? await v.update(b.id, { ...b, extra })
      : await v.create({ ...b, source: b.source || "手动添加" });
    return { entry };
  }));

  // 批量操作：多选后一次改一批。逐条独立成败，
  // 失败的条目照样报出来，不静默跳过。
  app.post("/entries/batch", wrap(async (c) => {
    const b = await body(c);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    const op = String(b.op || "");
    if (!ids.length) return { ok: false, error: "没有选中任何条目" };
    if (!["move", "tag", "delete", "pin", "unpin", "homePin", "homeUnpin"].includes(op)) {
      return { ok: false, error: `不支持的操作：${op}` };
    }
    const v = await deps.getVault();
    const done = [];
    const failed = [];
    for (const id of ids) {
      try {
        if (op === "delete") await v.remove(id);
        else if (op === "move") await v.update(id, { category: b.category });
        else if (op === "tag") {
          const cur = v.get(id);
          if (!cur) throw new Error("条目不存在");
          const add = Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
          const merged = [...new Set([...(cur.tags || []), ...add])];
          await v.update(id, { tags: merged });
        }
        else if (op === "pin") await v.update(id, { pinned: true });
        else if (op === "unpin") await v.update(id, { pinned: false });
        else if (op === "homePin") await v.update(id, { homePinned: true });
        else if (op === "homeUnpin") await v.update(id, { homePinned: false });
        done.push(id);
      } catch (err) {
        failed.push({ id, error: String(err?.message || err) });
      }
    }
    return { done: done.length, failed };
  }));

  // 彻底清空回收站：/entries/batch 的 delete 只是移进 _trash，
  // 用户说「清空了就不再存在」，所以这里补一个连回收站一起清的。
  app.post("/trash/purge", wrap(async (c) => {
    const v = await deps.getVault();
    return await v.purgeTrash();
  }));

  // ---------- 资源类收藏 ----------
  // 收录本地文件/文件夹：存引用不复制。
  app.post("/ref/collect", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    return { entry: await v.collectRef(b.target, {
      title: b.title,
      type: b.type,
      category: b.category,
      tags: b.tags,
      content: b.content,
    }) };
  }));

  // 收录网址
  app.post("/ref/collect-url", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    return { entry: await v.collectUrl(b.url, { title: b.title, category: b.category, tags: b.tags }) };
  }));

  // 校验引用是否还有效（文件被移动/删除时标 missing）
  app.post("/ref/check", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).checkRef(b.id);
  }));

  // 重新读一次文件夹结构（用户往文件夹里加了东西后刷新）
  app.post("/ref/restat", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    const e = v.get(b.id);
    if (!e) throw new Error("条目不存在");
    if (e.type !== "folder" || !e.ref || e.ref.kind !== "path") throw new Error("不是文件夹类型的收藏");
    const children = await v.statFolder(e.ref.target);
    const full = await v.get(b.id);
    full.ref.children = children;
    await v.update(b.id, { ref: { ...full.ref, children } });
    return { children };
  }));

  // 用系统默认应用打开（本地文件/文件夹）：走宿主的 open-external
  app.post("/ref/open", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    const e = v.get(b.id);
    if (!e) throw new Error("条目不存在");
    if (!e.ref) throw new Error("这条没有引用目标");
    if (e.ref.kind === "url") return { url: e.ref.target };
    const exists = await v.fs.exists(e.ref.target);
    if (!exists) throw new Error(`原件不存在或已被移动：${e.ref.target}`);
    return { path: e.ref.target };
  }));

  app.post("/entry/delete", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).remove(b.id);
  }));

  // 复制为新条目：标题加「副本」，其余照搬。右键菜单「复制」用。
  app.post("/entry/duplicate", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    const src = v.get(b.id);
    if (!src) return { ok: false, error: "条目不存在" };
    const title = (src.title || "未命名") + " 副本";
    const entry = await v.create({
      title,
      content: src.content ?? "",
      category: src.category,
      tags: [...(src.tags || [])],
      type: src.type || "note",
      source: src.source || "复制",
      // create 只认 extra 里带进来的元数据，parent/pinned 必须放这里
      extra: { parent: src.parent || null, pinned: false, homePinned: false },
    });
    return { ok: true, entry };
  }));

  app.post("/rescan", wrap(async () => {
    const v = await deps.getVault();
    await v.init();
    return v.stats();
  }));

  app.post("/location", wrap(async (c) => {
    const b = await body(c);
    return await deps.setLocation(b.path, b.mode === "copy" ? "copy" : "switch");
  }));

  app.get("/entry/backlinks", wrap(async (c) => {
    const v = await deps.getVault();
    const id = c.req.query("id");
    return {
      backlinks: v.findBacklinks(id),
      mentions: v.findUnlinkedMentions ? v.findUnlinkedMentions(id) : [],
    };
  }));

  app.post("/entry/link-mention", wrap(async (c) => {
    const b = await body(c);
    const entry = await (await deps.getVault()).linkMention(b.sourceId, b.targetTitle);
    return { entry };
  }));

  app.get("/link-graph", wrap(async () => {
    return (await deps.getVault()).buildLinkGraph();
  }));

  // ---- 首页 ----
  app.get("/home", wrap(async () => {
    const v = await deps.getVault();
    const all = v.allTodos();
    const homePinned = v.list({ limit: 500 }).filter((e) => e.homePinned);
    const inbox = v.list({ category: "收件箱", limit: 6 });
    return { todos: all.groups, hiddenTodos: all.hidden, recent: v.recent(10), homePinned, inbox, tags: v.listTags ? v.listTags() : [], categories: v.listCategories(), tree: v.tree() };
  }));

  app.post("/task/toggle", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).toggleTask(b.id, b.line);
  }));

  app.post("/entry/opened", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).markOpened(b.id);
  }));

  app.post("/entry/pref", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).setPref(b.id, { hideTodos: b.hideTodos });
  }));

  app.post("/categories/star", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).starCategory(b.name);
  }));

  // ---- AI 智能能力路由（直连 OpenHanako 模型供应商 + 离线智能兜底） ----
  app.get("/ai/status", wrap(async () => {
    if (!deps.ai) return { models: [], settings: { modelPref: "auto", proactive: "high" } };
    const [models, settings] = await Promise.all([deps.ai.listHostModels(), deps.ai.getSettings()]);
    return { models, settings };
  }));

  app.post("/ai/settings", wrap(async (c) => {
    const b = await body(c);
    if (!deps.ai) return { settings: b };
    return { settings: await deps.ai.saveSettings(b) };
  }));

  app.post("/ai/analyze", wrap(async (c) => {
    const b = await body(c);
    if (!deps.ai) throw new Error("AI 模块未初始化");
    return await deps.ai.analyzeEntry({ title: b.title, content: b.content });
  }));

  app.post("/ai/organize-inbox", wrap(async () => {
    if (!deps.ai) throw new Error("AI 模块未初始化");
    return await deps.ai.suggestInboxOrganization();
  }));

  // 文件管理器的 AI 整理建议：对一批文件给「放哪 + 改名 + 一句话说明」。
  // 只给建议，不动文件——搬不搬由人点。
  app.post("/ai/organize-files", wrap(async (c) => {
    const b = await body(c);
    if (!deps.ai) throw new Error("AI 模块未初始化");
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).map((x) => ({
      name: String(x.name || ""),
      path: String(x.path || ""),
      isDir: !!x.isDir,
      type: String(x.type || "file"),
      size: Number(x.size) || 0,
      count: Number(x.count) || 0,
    })).filter((x) => x.name);
    if (!items.length) return { ok: false, error: "没有可整理的文件" };
    return await deps.ai.organizeFiles(items);
  }));

  app.post("/ai/ask", wrap(async (c) => {
    const b = await body(c);
    if (!deps.ai) throw new Error("AI 模块未初始化");
    return await deps.ai.askVault(b.question);
  }));

  const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
  // 完整 MIME 表。之前除了图片一律回 application/octet-stream，
  // 结果 PDF 在 iframe 里被当成下载、<video>/<audio> 拿不到类型直接不播——
  // 预览弹窗能弹出来，里面是空的，就是这个原因。
  const MIME_BY_EXT = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
    avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
    m4v: "video/x-m4v", mkv: "video/x-matroska", avi: "video/x-msvideo",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
    m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
    markdown: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
    json: "application/json; charset=utf-8", log: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  const mimeOf = (ext) => MIME_BY_EXT[String(ext || "").toLowerCase()] || "application/octet-stream";
  const MAX_ASSET = 50 * 1024 * 1024; // 50MB

  // ---------- 备份：导出 zip / 预览导入 / 确认导入 ----------
  app.get("/backup/export", async (c) => {
    try {
      const buf = await (await deps.getVault()).exportZip();
      const name = c.req.query("name") || "nian-vault-backup.zip";
      const safe = String(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, "-").slice(0, 80) || "nian-vault-backup.zip";
      return c.body(buf, 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
      });
    } catch (err) {
      return c.json({ ok: false, error: String(err?.message || err) }, 400);
    }
  });

  const b64ToBuf = (b) => {
    const raw = String(b || "").replace(/^data:[^,]*,/, "");
    const buf = Buffer.from(raw, "base64");
    if (!buf.length) throw new Error("备份内容为空，请重新选择文件");
    if (buf.length > 200 * 1024 * 1024) throw new Error("备份包超过 200MB 上限");
    return buf;
  };

  app.post("/backup/import/preview", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).importZip(b64ToBuf(b.contentBase64), { dryRun: true });
  }));

  app.post("/backup/import", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).importZip(b64ToBuf(b.contentBase64), { dryRun: false });
  }));

  // 把导出包另存进库旁的备份文件夹（Agent 定时备份也走这里）
  app.post("/backup/snapshot", wrap(async (c) => {
    const v = await deps.getVault();
    const buf = await v.exportZip();
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dest = path.join(v.root, "_backup", `nian-vault-${stamp}.zip`);
    await v.fs.mkdir(path.dirname(dest));
    await v.fs.writeBytes(dest, buf);
    // 配了云备份且开启，顺带推一份
    let cloud = null;
    const cfg = await deps.getCloudConfig?.();
    if (cfg?.enabled && cfg.url) cloud = await deps.pushToCloud?.(dest, cfg, buf) ?? null;
    return { path: dest, bytes: buf.length, cloud };
  }));

  // ---------------- 云备份（WebDAV / S3） ----------------
  app.get("/cloud/config", wrap(async () => {
    const cfg = await deps.getCloudConfig?.() || null;
    const redacted = cfg ? { ...cfg, pass: cfg.pass ? "••••••" : "" } : null;
    return { config: redacted, spawnEnabled: await deps.spawnEnabled?.() === true };
  }));

  app.post("/cloud/config", wrap(async (c) => {
    const b = await body(c);
    const prev = await deps.getCloudConfig?.();
    const next = {
      enabled: !!b.enabled,
      proto: b.proto === "s3" ? "s3" : "webdav",
      url: String(b.url || "").trim(),
      region: String(b.region || "").trim(),
      user: String(b.user || "").trim(),
      // 前端回传星号占位表示“保持原密码”
      pass: /^•+$/.test(String(b.pass || "")) ? prev?.pass || "" : String(b.pass || ""),
      updated: new Date().toISOString(),
    };
    if (next.url && !/^https?:\/\/.+/i.test(next.url)) throw new Error("服务地址必须以 http:// 或 https:// 开头");
    if (next.enabled && !next.url) throw new Error("启用云备份前请填写服务地址");
    if (next.enabled && next.proto === "s3" && !next.region) throw new Error("S3 需要填写 region");
    if (next.enabled && !next.user) throw new Error("请填写账号或 Access Key");
    await deps.setCloudConfig?.(next);
    return { ok: true, config: { ...next, pass: next.pass ? "••••••" : "" } };
  }));

  app.post("/cloud/upload", wrap(async () => {
    const cfg = await deps.getCloudConfig?.();
    if (!cfg?.url) throw new Error("还没填写服务地址");
    const v = await deps.getVault();
    const buf = await v.exportZip();
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = "nian-vault-latest.zip";
    const dest = path.join(v.root, "_backup", filename);
    await v.fs.mkdir(path.dirname(dest));
    await v.fs.writeBytes(dest, buf);
    const r = await deps.pushToCloud?.(dest, cfg, buf);
    if (!r?.ok) throw new Error(r?.error || "上传失败");
    return { ok: true, file: filename, bytes: buf.length, status: r.status };
  }));

  app.post("/cloud/download", wrap(async () => {
    const cfg = await deps.getCloudConfig?.();
    if (!cfg?.url) throw new Error("还没填写服务地址");
    const v = await deps.getVault();
    const result = await deps.pullFromCloud?.(cfg);
    if (!result?.ok) throw new Error(result?.error || "云端下载失败");
    if (result.bytes > 512 * 1024 * 1024) throw new Error("云端备份超过 512MB 限制");
    return result;
  }));

  // ---------------- 收藏↔会话互指 ----------------
  app.post("/entry/session", wrap(async (c) => {
    const b = await body(c);
    return { entry: await (await deps.getVault()).attachSession(b.id, b.session) };
  }));

  app.get("/session/resolve", wrap(async (c) => {
    const p = String(c.req.query("path") || "");
    if (!p) throw new Error("缺少会话路径");
    return { session: await deps.resolveSession?.(p) || null };
  }));

  // ---------------- 把收藏摄成一摊工作台 ----------------
  app.post("/studio/expand", wrap(async (c) => {
    const b = await body(c);
    const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 12);
    if (!ids.length) throw new Error("至少选一条收藏");
    const r = await deps.expandToStudio?.({ ids, prompt: String(b.prompt || "") });
    if (!r?.ok) throw new Error(r?.error || "创建工作台失败");
    return r;
  }));

  // ---------------- 收藏候选（先列后存，点了有反馈） ----------------
  app.get("/clip/stage", wrap(async () => await deps.clips.list()));

  app.get("/clip/notice", wrap(async () => {
    return { notice: await deps.getClipNotice?.() || null };
  }));

  // 输入栏按钮那条路：候选不在 clipstore 里，而是随卡片一起落在全局存储。
  // 勾选后按 id 提交，这里直接调 AI 整理入库，再给一张回执卡。
  app.get("/clip/pick", wrap(async () => {
    return { pick: await deps.getClipPick?.() || null };
  }));

  app.post("/clip/pick", wrap(async (c) => {
    const b = await body(c);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!ids.length) {
      // 空勾选 = 取消，清理候选就收工，不报错。
      await deps.clearClipPick?.();
      return { ok: true, canceled: true, count: 0, entries: [] };
    }
    const pick = await deps.getClipPick?.();
    if (!pick?.items?.length) throw new Error("没有可选的候选（可能已过期），请重新点一次输入栏的「念念收藏」");
    const picked = pick.items.filter((it) => ids.includes(String(it.id)));
    if (!picked.length) throw new Error("没选中任何候选");
    const v = await deps.getVault();
    const saved = [];
    for (const it of picked) {
      let category = b.category || "收件箱";
      let tags = [];
      let title = it.title || String(it.text || "").slice(0, 24);
      const a = await deps.ai.analyzeEntry({ title: "", content: it.text }).catch(() => null);
      if (a) {
        if (a.title) title = a.title;
        tags = a.tags || [];
        if ((b.category === "auto" || !b.category) && a.category && a.category !== "收件箱") category = a.category;
      }
      const e = await v.create({
        title,
        content: it.text,
        category,
        tags,
        source: "对话勾选",
        session: pick.sessionPath ? { sessionPath: pick.sessionPath } : null,
      });
      saved.push(e);
    }
    await deps.clearClipPick?.();
    await deps.deliverClipNotice?.({
      at: new Date().toISOString(),
      from: "clip-picker",
      sessionPath: pick.sessionPath || null,
      items: saved.map((e) => ({ id: e.id, title: e.title, category: e.category, tags: e.tags, snippet: String(e.content || "").replace(/\s+/g, " ").slice(0, 90) })),
      stats: { total: saved.length },
    });
    return { ok: true, count: saved.length, entries: saved.map((e) => ({ id: e.id, title: e.title, category: e.category, tags: e.tags })) };
  }));

  app.post("/clip/stage", wrap(async (c) => {
    const b = await body(c);
    const text = String(b.text || "").trim();
    if (!text) throw new Error("没有可收藏的内容");
    return await deps.clips.stage(text, { from: b.from || "对话" });
  }));

  app.post("/clip/commit", wrap(async (c) => {
    const b = await body(c);
    const keys = Array.isArray(b.keys) ? b.keys : [];
    if (!keys.length) throw new Error("没选中任何候选");
    const picked = await deps.clips.get(keys);
    if (!picked.length) throw new Error("选中的候选已过期，请重新收藏");
    const v = await deps.getVault();
    const results = [];
    for (const it of picked) {
      let category = b.category || "收件箱";
      let tags = [];
      let title = it.title;
      if (b.auto !== false) {
        const a = await deps.ai.analyzeEntry({ title: "", content: it.text }).catch(() => null);
        if (a) {
          if (a.title) title = a.title;
          tags = a.tags || [];
          if (b.category === "auto" && a.category && a.category !== "收件箱") category = a.category;
        }
      }
      const e = await v.create({ title, content: it.text, category, tags, source: it.from || "对话剪藏" });
      results.push({ key: it.key, id: e.id, title: e.title, category: e.category });
    }
    await deps.clips.drop(keys);
    const rest = await deps.clips.list();
    return { saved: results.length, entries: results, total: rest.items.length };
  }));

  app.post("/clip/discard", wrap(async (c) => {
    const b = await body(c);
    return await deps.clips.drop(Array.isArray(b.keys) ? b.keys : []);
  }));

  // ---------- 文件管理器 ----------
  // 列 _assets/ 某一层；rel 空 = 根。
  app.get("/assets/list", wrap(async (c) => {
    const v = await deps.getVault();
    return await v.listAssets(c.req.query("rel") || "");
  }));

  // 谁引用了这个资源（扫 ![[名]]、![](_assets/...)、自身 ref）
  app.get("/assets/refs", wrap(async (c) => {
    const v = await deps.getVault();
    return { refs: v.refsOfAsset(c.req.query("rel") || "") };
  }));

  // 库外引用（meta.ref 指向 _assets/ 之外）
  // ---------- 网页剪藏 ----------
  // 给一个网址，抓回来提取正文 + 转 Markdown。
  // 只抓不存：返回给面板，用户看过内容、改过标题标签，确认了才入库。
  // 抓不到正文不假装成功——error 里说清原因，面板据此提示。
  app.post("/article/extract", wrap(async (c2) => {
    const b = await body(c2);
    const url = String(b.url || "").trim();
    if (!url) return { ok: false, error: "请输入网址" };
    try {
      const extract = deps.extractArticle || defaultExtractArticle;
      const a = await extract(url, {
        timeoutMs: Number(b.timeoutMs) > 0 ? Math.min(Number(b.timeoutMs), 30000) : 15000,
      });
      return {
        ok: true,
        title: a.title,
        description: a.description,
        siteName: a.siteName,
        author: a.author,
        published: a.published,
        markdown: a.markdown,
        chars: a.chars,
        truncated: a.truncated,
        // 正文太短说明大概率没提对（比如只抓到一段版权声明），如实告诉前端
        thin: a.chars < 120,
      };
    } catch (err) {
      const m = String(err?.message || err);
      // 超时和连不上给个能看懂的说明
      const friendly = /abort/i.test(m) ? "抓取超时，站点响应太慢或需要登录"
        : /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(m) ? `连不上这个站点（${m}）`
        : m;
      return { ok: false, error: friendly };
    }
  }));

  // 清理正文里被写进去的宿主绝对地址
  // （老版本 bug：把 http://127.0.0.1:端口/api/apps/.../routes/_assets/xxx 存进了正文）
  app.post("/assets/clean-urls", wrap(async (c2) => {
    const b = await body(c2);
    const v = await deps.getVault();
    return await v.cleanAssetUrls({ dryRun: !!b.dryRun });
  }));

  // 资源扁平索引：整棵 _assets/ 树压平成清单。
  // 编辑器附件面板和 AI 整理都用它——两边看到的是同一份资源名，
  // AI 说得出真实文件名，附件面板也插得进去。
  app.get("/assets/index", wrap(async () => {
    const v = await deps.getVault();
    const items = await v.assetIndex();
    // 上限 500：面板一次渲染不了更多，全给了也是白占带宽
    return { items: items.slice(0, 500), total: items.length };
  }));

  app.get("/assets/external", wrap(async (c) => {
    const v = await deps.getVault();
    return { items: v.externalRefs() };
  }));

  app.post("/assets/rename", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    const to = await v.renameAsset(b.rel, b.name);
    return { to };
  }));

  app.post("/assets/delete", wrap(async (c) => {
    const b = await body(c);
    const v = await deps.getVault();
    // 有引用的要先确认：调用方传 force 才真删
    const refs = v.refsOfAsset(b.rel);
    if (refs.length && !b.force) {
      return { ok: false, needConfirm: true, refs };
    }
    return { ...(await v.deleteAsset(b.rel)), refs: refs.length };
  }));

  app.post("/assets/mkdir", wrap(async (c) => {
    const b = await body(c);
    return await (await deps.getVault()).mkAssetDir(b.rel || "", b.name);
  }));

  // 批量移动：paths 数组 + destRel 目标文件夹。
  // 逐条独立成败；带引用重写（![](_assets/旧) 会跟着改，![[名]] 不受影响）。
  app.post("/assets/move", wrap(async (c) => {
    const b = await body(c);
    const paths = Array.isArray(b.paths) ? b.paths.map(String) : [];
    if (!paths.length) return { ok: false, error: "没有选中任何文件" };
    return await (await deps.getVault()).moveAssets(paths, b.dest || "", { rewriteLinks: b.rewriteLinks !== false });
  }));

  // 批量删除：复用单条的引用确认逻辑，逐条独立成败。
  app.post("/assets/delete-batch", wrap(async (c) => {
    const b = await body(c);
    const paths = Array.isArray(b.paths) ? b.paths.map(String) : [];
    if (!paths.length) return { ok: false, error: "没有选中任何文件" };
    const v = await deps.getVault();
    // 有引用的先整体确认：调用方传 force 才真删
    if (!b.force) {
      const refs = [];
      for (const rel of paths) refs.push(...v.refsOfAsset(rel));
      const uniq = [...new Map(refs.map((x) => [x.id, x])).values()];
      if (uniq.length) return { ok: false, needConfirm: true, refs: uniq, paths };
    }
    const done = [];
    const failed = [];
    let refCount = 0;
    for (const rel of paths) {
      try {
        const r = await v.deleteAsset(rel);
        refCount += v.refsOfAsset(rel).length;
        done.push(r.deleted);
      } catch (err) {
        failed.push({ path: rel, error: String(err?.message || err) });
      }
    }
    return { deleted: done.length, done, failed, refs: refCount };
  }));

  // 上传：支持传 subdir（前端让用户选传到哪个子文件夹）
  // 保留原文件名，不再随机化
  app.post("/asset/upload", wrap(async (c) => {
    const fd = await c.req.parseBody();
    const file = fd.file;
    if (!(file && typeof file === "object" && typeof file.arrayBuffer === "function")) throw new Error("未上传文件");
    if (file.size > MAX_ASSET) throw new Error(`文件超过 ${Math.round(MAX_ASSET / 1024 / 1024)}MB 上限`);
    const buffer = Buffer.from(await file.arrayBuffer());
    const sub = typeof fd.subdir === "string" ? fd.subdir : "";
    const path = await (await deps.getVault()).saveAsset(buffer, file.name || "clipboard.png", sub);
    return { path };
  }));

  // 读资源：/asset/xxx、/_assets/子目录/xxx 都走这里。
  // 用 /* 通配：Hono 的 buildWildcardRegExp 只认识 "路径/*" 这种结尾，
  // 写成 :p{\w+}* 虽然不抛错，但生成的正则只匹配字面字符串，永远命中不了。
  // param("p") 由下面的 helper 从 URL 里抠。
  const serveAsset = wrap(async (c) => {
    // 通配路由下 Hono 的 param 行为不确定，直接从完整路径取更可靠
    const raw = c.req.raw?.url || c.req.url || "";
    let rest = "";
    const m = String(raw).match(/\/(?:_assets|asset)\/(.+)$/);
    if (m) rest = decodeURIComponent(m[1]);
    else rest = String(c.req.param("p") || c.req.param("d") || "") + (c.req.param("f") ? "/" + c.req.param("f") : "");
    const buf = await (await deps.getVault()).readAsset(`_assets/${rest}`);
    const ext = (rest.match(/\.(\w{1,8})$/) || [])[1]?.toLowerCase() || "";
    const mime = mimeOf(ext);
    // PDF / 视频 / 音频 / 文本要能被浏览器内联渲染，不能再让它们变成下载。
    // inline 明确告诉浏览器"直接在页面里显示"，文件名只用于另存。
    return c.body(buf, 200, {
      "Content-Type": mime,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(rest.split("/").pop() || "file")}`,
      "Cache-Control": "max-age=300",
    });
  });
  app.get("/asset/*", serveAsset);
  app.get("/_assets/*", serveAsset);
}
