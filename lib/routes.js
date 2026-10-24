// 后端路由：抽成纯函数，方便本地用内存实现跑测试，也让 index.js 只负责接线。
import path from "node:path";

export function registerRoutes(app, deps) {
  const wrap = (fn) => async (c) => {
    try {
      return c.json({ ok: true, ...(await fn(c)) });
    } catch (err) {
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

  app.get("/tags", wrap(async () => {
    const v = await deps.getVault();
    return { tags: v.listTags ? v.listTags() : [] };
  }));

  app.get("/entries", wrap(async (c) => {
    const q = c.req.query();
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
    const entry = b.id
      ? await v.update(b.id, b)
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

  app.post("/ai/ask", wrap(async (c) => {
    const b = await body(c);
    if (!deps.ai) throw new Error("AI 模块未初始化");
    return await deps.ai.askVault(b.question);
  }));

  const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
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

  app.post("/asset/upload", wrap(async (c) => {
    const fd = await c.req.parseBody();    const file = fd.file;
    if (!(file && typeof file === "object" && typeof file.arrayBuffer === "function")) throw new Error("未上传文件");
    if (file.size > MAX_ASSET) throw new Error(`文件超过 ${Math.round(MAX_ASSET / 1024 / 1024)}MB 上限`);
    const buffer = Buffer.from(await file.arrayBuffer());
    const path = await (await deps.getVault()).saveAsset(buffer, file.name || "clipboard.png");
    return { path };
  }));

  // 读资源：兼容 /asset/202610/xxx.png 与 /_assets/202610/xxx.png
  const serveAsset = wrap(async (c) => {
    const buf = await (await deps.getVault()).readAsset(`_assets/${c.req.param("d")}/${c.req.param("f")}`);
    const ext = (c.req.param("f").match(/\.(\w{1,8})$/)?.[1] || "").toLowerCase();
    const mime = IMG_EXT.has(ext) ? `image/${ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext}` : "application/octet-stream";
    return c.body(buf, 200, { "Content-Type": mime });
  });
  app.get("/asset/:d/:f", serveAsset);
  app.get("/_assets/:d/:f", serveAsset);
}
