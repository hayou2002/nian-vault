// 收藏库核心：分类 + 条目（Markdown 文件）的增删改查与检索。
// 目录结构（root 可由用户自定义）：
//   root/_vault.json            分类表与库元数据
//   root/<分类文件夹>/<id>.md    条目，front matter + Markdown 正文
//   root/_trash/<分类>/<id>.md   删除的条目（可手动找回）
import path from "node:path";
import { zipSync, unzipSync } from "./zip.js";
import crypto from "node:crypto";
import { parseEntry, serializeEntry } from "./frontmatter.js";

export const INBOX = "收件箱";
const META_FILE = "_vault.json";
const RESERVED = new Set([META_FILE, "_trash", "_assets", "_backup"]);
const TYPES = new Set(["note", "text", "link", "image", "video", "file", "folder", "memory", "experience"]);

export function sanitizeName(name) {
  const s = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60);
  if (!s || s.startsWith("_") || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) return "";
  return s;
}

function newId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString("hex")}`;
}

function nowIso() { return new Date().toISOString(); }

// 单调递增的时间戳：nowIso() 是毫秒精度，连续两次写（比如快速打开两条）
// 会拿到同一个值，排序就成了 Map 迭代序这种不稳定结果。
// 这里保证每次调用都不小于上一次，真正相等时往前借 1ms。
let lastStamp = 0;
function nowIsoMono() {
  let t = Date.now();
  if (t <= lastStamp) t = lastStamp + 1;
  lastStamp = t;
  return new Date(t).toISOString();
}

function normTags(tags) {
  if (tags == null) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(/[,，、\s]+/);
  return [...new Set(list.map((t) => String(t).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 20);
}

// 来源会话的规范化：只存定位所需字段，不存对话内容
function normSession(s) {
  if (!s || typeof s !== "object") return null;
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const sessionId = str(s.sessionId);
  const sessionPath = str(s.sessionPath);
  if (!sessionId && !sessionPath) return null;
  return {
    sessionId,
    sessionPath,
    agentId: str(s.agentId),
    messageId: str(s.messageId),
    at: str(s.at) || nowIso(),
  };
}

function deriveTitle(body) {
  const line = String(body ?? "").split("\n").map((l) => l.replace(/^#+\s*|^[-*>]\s*/g, "").trim()).find(Boolean) || "未命名";
  return line.length > 40 ? line.slice(0, 40) + "…" : line;
}

function snippet(body, query) {
  const text = String(body ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[#>*`_\[\]()!-]/g, " ").replace(/\s+/g, " ").trim();
  if (!query) return text.slice(0, 120);
  const i = text.toLowerCase().indexOf(String(query).toLowerCase());
  if (i < 0) return text.slice(0, 120);
  const start = Math.max(0, i - 40);
  return (start > 0 ? "…" : "") + text.slice(start, start + 120);
}

export class Vault {
  constructor(fsImpl, root) {
    this.fs = fsImpl;
    this.root = root;
    this.meta = null;        // {version, categories:[{name, description, created}]}
    this.entries = null;     // Map id -> {id, category, file, meta, body}
    this.queue = Promise.resolve();
  }

  // 写操作串行化，避免并发改同一份 _vault.json
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async init() {
    return this.serial(async () => {
      await this.fs.mkdir(this.root);
      const metaPath = path.join(this.root, META_FILE);
      if (await this.fs.exists(metaPath)) {
        try { this.meta = JSON.parse(await this.fs.readText(metaPath)); } catch { this.meta = null; }
      }
      if (!this.meta || !Array.isArray(this.meta.categories)) {
        this.meta = { app: "nian-vault", version: 1, created: nowIso(), categories: [] };
      }
      // 磁盘上已有的文件夹也认作分类（用户手动建的文件夹不丢）
      for (const d of await this.fs.list(this.root)) {
        if (d.isDir && !RESERVED.has(d.name) && !d.name.startsWith(".") && !this.findCategory(d.name)) {
          this.meta.categories.push({ name: d.name, description: "", created: nowIso() });
        }
      }
      if (!this.findCategory(INBOX)) this.meta.categories.unshift({ name: INBOX, description: "未分类的内容先放这里", created: nowIso() });
      await this.fs.mkdir(path.join(this.root, INBOX));
      await this.saveMeta();
      await this._rescan();
      return this;
    });
  }

  async saveMeta() {
    this.meta.updated = nowIso();
    const p = path.join(this.root, META_FILE);
    // 原子写：先写临时文件再 rename，写一半崩掉不会损坏主文件
    const tmp = p + ".tmp";
    await this.fs.writeText(tmp, JSON.stringify(this.meta, null, 2));
    try { await this.fs.rename(tmp, p); } catch {
      await this.fs.writeText(p, JSON.stringify(this.meta, null, 2)); // ResourceFs 的 move 可能不支持覆盖，退回直接写
    }
  }

  findCategory(name) {
    const key = String(name ?? "").trim().toLowerCase();
    return this.meta.categories.find((c) => c.name.toLowerCase() === key) || null;
  }

  async rescan() { return this.serial(() => this._rescan()); }

  async _rescan() {
    const map = new Map();
    for (const cat of this.meta.categories) {
      const dir = path.join(this.root, cat.name);
      for (const f of await this.fs.list(dir)) {
        if (f.isDir || !f.name.toLowerCase().endsWith(".md")) continue;
        const file = path.join(dir, f.name);
        try {
          const { meta, body } = parseEntry(await this.fs.readText(file));
          const id = String(meta.id || f.name.replace(/\.md$/i, ""));
          if (map.has(id)) continue;
          map.set(id, { id, category: cat.name, file, meta: { ...meta, id }, body });
        } catch { /* 单个坏文件不影响整体 */ }
      }
    }
    this.entries = map;
  }

  // ---------- 分类 ----------
  listCategories() {
    const counts = new Map();
    for (const e of this.entries.values()) counts.set(e.category, (counts.get(e.category) || 0) + 1);
    // 星标的排前面
    return [...this.meta.categories]
      .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0))
      .map((c) => ({ name: c.name, description: c.description || "", count: counts.get(c.name) || 0, starred: !!c.starred }));
  }

  createCategory(name, description = "") {
    return this.serial(async () => {
      const clean = sanitizeName(name);
      if (!clean) throw new Error("分类名不合法（不能为空、不能以 _ 开头、不能含 \\ / : * ? \" < > |）");
      const existing = this.findCategory(clean);
      if (existing) return { name: existing.name, created: false };
      await this.fs.mkdir(path.join(this.root, clean));
      this.meta.categories.push({ name: clean, description: String(description || ""), created: nowIso() });
      await this.saveMeta();
      return { name: clean, created: true };
    });
  }

  renameCategory(oldName, newName, description) {
    return this.serial(async () => {
      const cat = this.findCategory(oldName);
      if (!cat) throw new Error(`分类不存在：${oldName}`);
      const clean = sanitizeName(newName ?? cat.name);
      if (!clean) throw new Error("新分类名不合法");
      if (cat.name === INBOX && clean !== INBOX) throw new Error("「收件箱」是默认分类，不能改名");
      if (clean.toLowerCase() !== cat.name.toLowerCase() && this.findCategory(clean)) throw new Error(`已存在同名分类：${clean}`);
      if (clean !== cat.name) {
        const from = path.join(this.root, cat.name);
        const to = path.join(this.root, clean);
        // 逐个搬文件，兼容两种存储后端。
        // 顺序要紧：先把所有文件搬完，全部成功了才改内存和 meta。
        // 否则搬一半失败，内存已是新分类、磁盘还留在旧目录，
        // saveMeta 又不会执行，下次重扫时旧目录不在分类表里，那批文件直接失联。
        await this.fs.mkdir(to);
        const moved = [];
        for (const e of this.entries.values()) {
          if (e.category !== cat.name) continue;
          const dest = path.join(to, path.basename(e.file));
          await this.fs.rename(e.file, dest);
          moved.push([e, dest]);
        }
        // 搬完了，此刻起才允许改内存
        for (const [e, dest] of moved) {
          e.file = dest;
          e.category = clean;
        }
        // 旧目录删不掉不阻塞改名（可能留着用户自己的文件），但要说出来
        try {
          await this.fs.removeDir(from);
        } catch (err) {
          console.warn(`[nian-vault] 旧目录未能删除：${from}`, err?.message || err);
        }
        cat.name = clean;
      }
      if (description !== undefined) cat.description = String(description || "");
      await this.saveMeta();
      return { name: clean };
    });
  }

  deleteCategory(name) {
    return this.serial(async () => {
      const cat = this.findCategory(name);
      if (!cat) throw new Error(`分类不存在：${name}`);
      if (cat.name === INBOX) throw new Error("「收件箱」是默认分类，不能删除");
      let moved = 0;
      const inboxDir = path.join(this.root, INBOX);
      await this.fs.mkdir(inboxDir);
      // 同 renameCategory：先搬完所有文件，成功后才改内存，
      // 避免搬一半失败导致内存与磁盘分叉。
      const movedPairs = [];
      for (const e of this.entries.values()) {
        if (e.category !== cat.name) continue;
        const dest = path.join(inboxDir, path.basename(e.file));
        await this.fs.rename(e.file, dest);
        movedPairs.push([e, dest]);
      }
      for (const [e, dest] of movedPairs) {
        e.file = dest;
        e.category = INBOX;
        moved++;
      }
      try {
        await this.fs.removeDir(path.join(this.root, cat.name));
      } catch (err) {
        console.warn(`[nian-vault] 分类目录未能删除：${cat.name}`, err?.message || err);
      }
      this.meta.categories = this.meta.categories.filter((c) => c !== cat);
      await this.saveMeta();
      return { deleted: cat.name, movedToInbox: moved };
    });
  }

  // ---------- 条目 ----------
  summary(e, query) {
    return {
      id: e.id,
      title: e.meta.title || deriveTitle(e.body),
      category: e.category,
      type: e.meta.type || "note",
      tags: normTags(e.meta.tags),
      cover: e.meta.cover || null,
      embed: e.meta.embed || null,
      created: e.meta.created || null,
      updated: e.meta.updated || e.meta.created || null,
      snippet: snippet(e.body, query),
      pinned: !!e.meta.pinned,
      homePinned: !!e.meta.homePinned,
      parent: e.meta.parent || null,
      parentTitle: e.meta.parent ? this.entries.get(e.meta.parent)?.meta.title || null : null,
      opened: e.meta.opened || null,
      session: e.meta.session || null,
    };
  }

  full(e) { return { ...this.summary(e), source: e.meta.source ?? null, homePinned: !!e.meta.homePinned, parentTitle: e.meta.parent ? this.entries.get(e.meta.parent)?.meta.title || null : null, todos: this.todosOf(e), content: e.body }; }

  get(id) {
    const e = this.entries.get(String(id));
    return e ? this.full(e) : null;
  }

  list({ category, query, tag, limit = 200 } = {}) {
    const q = String(query ?? "").trim().toLowerCase();
    const words = q ? q.split(/\s+/).filter(Boolean) : [];
    const cat = category ? this.findCategory(category)?.name ?? "\u0000" : null;
    const out = [];
    for (const e of this.entries.values()) {
      if (cat && e.category !== cat) continue;
      // tags 可能是字符串或对象（用户手写过 front matter），统一走 normTags 归一，
      // 否则 .includes 会直接 TypeError，整个 /entries 请求挂掉
      if (tag && !normTags(e.meta.tags).includes(tag)) continue;
      let score = 0;
      if (words.length) {
        const title = String(e.meta.title || "").toLowerCase();
        const tags = normTags(e.meta.tags).join(" ").toLowerCase();
        const body = String(e.body || "").toLowerCase();
        let ok = true;
        for (const w of words) {
          const s = (title.includes(w) ? 5 : 0) + (tags.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0) + (e.category.toLowerCase().includes(w) ? 1 : 0);
          if (!s) { ok = false; break; }
          score += s;
        }
        if (!ok) continue;
      }
      out.push({ e, score });
    }
    out.sort((a, b) => {
      // 置顶优先
      if (a.e.meta.pinned && !b.e.meta.pinned) return -1;
      if (!a.e.meta.pinned && b.e.meta.pinned) return 1;
      // 然后按分数与时间
      return b.score - a.score || String(b.e.meta.updated || b.e.meta.created || "").localeCompare(String(a.e.meta.updated || a.e.meta.created || ""));
    });
    return out.slice(0, Math.max(1, Math.min(500, Number(limit) || 200))).map((x) => this.summary(x.e, q));
  }

  create({ title, content, category, tags, type, source, cover, embed, session, extra } = {}) {
    return this.serial(async () => {
      const body = String(content ?? "");
      if (!body.trim() && !String(title ?? "").trim()) throw new Error("内容和标题不能都为空");
      let catName = INBOX;
      if (category && String(category).trim()) {
        const found = this.findCategory(category);
        if (found) catName = found.name;
        else {
          const clean = sanitizeName(category);
          if (!clean) throw new Error(`分类名不合法：${category}`);
          await this.fs.mkdir(path.join(this.root, clean));
          this.meta.categories.push({ name: clean, description: "", created: nowIso() });
          await this.saveMeta();
          catName = clean;
        }
      }
      const id = newId();
      const ts = nowIso();
      const meta = {
        ...(extra && typeof extra === "object" ? extra : {}),
        id,
        title: String(title ?? "").trim() || deriveTitle(body),
        type: TYPES.has(type) ? type : "note",
        tags: normTags(tags),
        source: source ?? undefined,
        cover: cover ? String(cover) : undefined,
        embed: embed ? String(embed) : undefined,
        session: normSession(session) || undefined,
        created: ts,
        updated: ts,
      };
      const file = path.join(this.root, catName, `${id}.md`);
      await this.fs.writeText(file, serializeEntry(meta, body));
      const entry = { id, category: catName, file, meta, body };
      this.entries.set(id, entry);
      return this.full(entry);
    });
  }

  update(id, patch = {}) {
    return this.serial(async () => {
      const e = this.entries.get(String(id));
      if (!e) throw new Error(`条目不存在：${id}`);
      // 先校验后赋值：分类名非法时直接抛错，内存不能比磁盘先改
      let destCat = null;
      if (patch.category && this.findCategory(patch.category)?.name !== e.category) {
        let cat = this.findCategory(patch.category);
        if (!cat) {
          const clean = sanitizeName(patch.category);
          if (!clean) throw new Error(`分类名不合法：${patch.category}`);
          await this.fs.mkdir(path.join(this.root, clean));
          cat = { name: clean, description: "", created: nowIso() };
          this.meta.categories.push(cat);
          await this.saveMeta();
        }
        destCat = cat;
      }
      // 全部校验通过，copy-on-write 改副本，成功后才替换
      const meta = { ...e.meta };
      let body = e.body;
      if (Object.keys(patch).length === 1 && patch.pinned !== undefined) {
        // 只切置顶时不动 updated，避免把笔记顶到「最近更新」第一位
        meta.pinned = !!patch.pinned;
      } else {
        meta.updated = nowIso();
        if (patch.content !== undefined) body = String(patch.content);
        if (patch.append) body = body.replace(/\s*$/, "") + "\n\n" + String(patch.append);
        if (patch.title !== undefined) meta.title = String(patch.title).trim() || deriveTitle(body);
        if (patch.tags !== undefined) meta.tags = normTags(patch.tags);
        if (patch.type !== undefined && TYPES.has(patch.type)) meta.type = patch.type;
        if (patch.source !== undefined) meta.source = patch.source;
        if (patch.cover !== undefined) meta.cover = patch.cover ? String(patch.cover) : undefined;
        if (patch.embed !== undefined) meta.embed = patch.embed ? String(patch.embed) : undefined;
        if (patch.homePinned !== undefined) meta.homePinned = !!patch.homePinned;
        if (patch.pinned !== undefined) meta.pinned = !!patch.pinned;
        if (patch.parent !== undefined) {
          // 层级父子关系：parent 指向同分类内另一条的 id；null = 回到顶层
          if (patch.parent === null) meta.parent = undefined;
          else {
            const p = this.entries.get(String(patch.parent));
            const finalCat = destCat ? destCat.name : e.category;
            if (!p) throw new Error(`父条目不存在：${patch.parent}`);
            if (p.category !== finalCat) throw new Error("父条目必须在同一分类");
            if (p.id === e.id) throw new Error("不能把自己设为父条目");
            // 防环：p 不能是 e 的后代
            let cur = p;
            while (cur?.meta?.parent) {
              if (cur.meta.parent === e.id) throw new Error("不能把子孙条目设为父条目（会形成循环）");
              cur = this.entries.get(cur.meta.parent);
            }
            meta.parent = p.id;
          }
        }
        if (patch.order !== undefined) meta.order = Number(patch.order) || 0;
      }
      let file = e.file;
      let category = e.category;
      if (destCat) {
        const prevCat = e.category;
        file = path.join(this.root, destCat.name, path.basename(e.file));
        await this.fs.rename(e.file, file);
        category = destCat.name;
        meta.parent = undefined; // 换分类时父链断掉，子关系不能跨分类
        // 子孙跟着父亲走，不留孤儿
        const moved = new Set([e.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const x of this.entries.values()) {
            if (x.id === e.id || !x.meta.parent || !moved.has(x.meta.parent) || x.category !== prevCat) continue;
            const xf = path.join(this.root, destCat.name, path.basename(x.file));
            await this.fs.rename(x.file, xf);
            x.file = xf;
            x.category = destCat.name;
            await this.fs.writeText(xf, serializeEntry(x.meta, x.body));
            moved.add(x.id);
            grew = true;
          }
        }
      }
      await this.fs.writeText(file, serializeEntry(meta, body));
      e.meta = meta;
      e.body = body;
      e.file = file;
      e.category = category;
      return this.full(e);
    });
  }

  remove(id) {
    return this.serial(async () => {
      const e = this.entries.get(String(id));
      if (!e) throw new Error(`条目不存在：${id}`);
      // 有子条目的父条目：子条目上提一层，不能变孤儿
      for (const c of this.entries.values()) {
        if (c.meta?.parent === e.id) {
          c.meta.parent = e.meta?.parent || undefined;
          await this.fs.writeText(c.file, serializeEntry(c.meta, c.body));
        }
      }
      const dest = path.join(this.root, "_trash", e.category, path.basename(e.file));
      await this.fs.mkdir(path.dirname(dest));
      await this.fs.rename(e.file, dest);
      this.entries.delete(e.id);
      return { deleted: e.id, title: e.meta.title, trash: dest };
    });
  }

  // 彻底清空回收站：把 _trash 整个删掉。
  // remove() 只是移进回收站（还能捞回来），用户要的「清空就不再存在」
  // 指的是这一步，所以单独一个方法，不混在 remove 里。
  async purgeTrash() {
    const trashDir = path.join(this.root, "_trash");
    let removed = 0;
    try {
      const cats = await this.fs.list(trashDir);
      for (const c of cats) {
        if (!c.isDir) continue;
        const files = await this.fs.list(path.join(trashDir, c.name));
        removed += files.filter((f) => !f.isDir && f.name.endsWith(".md")).length;
      }
      await this.fs.removeDir(trashDir);
      await this.fs.mkdir(trashDir);
    } catch {
      // 回收站本来就不存在：视为空，不是错误
      try { await this.fs.mkdir(trashDir); } catch {}
    }
    return { purged: removed };
  }

  // 复制整个库到另一个存储（用于迁移位置），只复制本 App 管理的文件
  async copyTo(targetFs, targetRoot) {
    await targetFs.mkdir(targetRoot);
    let files = 0;
    await targetFs.writeText(path.join(targetRoot, META_FILE), JSON.stringify(this.meta, null, 2));
    for (const cat of this.meta.categories) await targetFs.mkdir(path.join(targetRoot, cat.name));
    for (const e of this.entries.values()) {
      await targetFs.writeText(path.join(targetRoot, e.category, path.basename(e.file)), serializeEntry(e.meta, e.body));
      files++;
    }
    return { files };
  }

  // ---------- 备份与恢复（zip 闭环） ----------
  // 导出：_vault.json + 所有 .md + _assets 全部收进一个 zip
  async exportZip() {
    return this.serial(async () => {
      const entries = [{ name: "_vault.json", data: JSON.stringify(this.meta, null, 2) }];
      for (const e of this.entries.values()) {
        entries.push({ name: e.category + "/" + path.basename(e.file), data: serializeEntry(e.meta, e.body) });
      }
      const assetsRoot = path.join(this.root, "_assets");
      if (await this.fs.exists(assetsRoot)) {
        for (const month of await this.fs.list(assetsRoot)) {
          if (!month.isDir) continue;
          for (const f of await this.fs.list(path.join(assetsRoot, month.name))) {
            if (f.isDir) continue;
            entries.push({ name: "_assets/" + month.name + "/" + f.name, data: await this.fs.readBytes(path.join(assetsRoot, month.name, f.name)) });
          }
        }
      }
      entries.push({ name: "_meta.txt", data: `app=nian-vault\nexported=${nowIso()}\nentries=${this.entries.size}\n` });
      return zipSync(entries);
    });
  }

  // 导入：重建临时库后原子换名；任何一步失败则抛错不写半截。dryRun 只统计不写。
  async importZip(zipBuffer, { dryRun = false } = {}) {
    return this.serial(async () => {
      const files = unzipSync(zipBuffer);
      const metaRaw = files.get("_vault.json");
      if (!metaRaw) throw new Error("备份包缺少 _vault.json，不是念念收藏夹的备份");
      let meta;
      try { meta = JSON.parse(metaRaw.toString("utf8")); } catch { throw new Error("备份包的 _vault.json 已损坏"); }
      if (!meta || !Array.isArray(meta.categories)) throw new Error("备份包内容不合法（分类清单缺失）");
      const mdFiles = [...files.keys()].filter((n) => n.endsWith(".md") && !n.includes("..") && !n.startsWith("_trash/"));
      if (dryRun) {
        const cats = meta.categories.map((c) => c.name);
        return { ok: true, dryRun: true, categories: cats.length, entries: mdFiles.length, assets: [...files.keys()].filter((n) => n.startsWith("_assets/")).length, categoriesList: cats };
      }
      // 先写临时目录，全部成功后换名
      const tmp = this.root + ".import-tmp";
      await this.fs.removeDir(tmp).catch(() => {});
      await this.fs.mkdir(tmp);
      await this.fs.writeText(path.join(tmp, "_vault.json"), JSON.stringify(meta, null, 2));
      for (const cat of meta.categories) await this.fs.mkdir(path.join(tmp, sanitizeName(cat.name) || cat.name));
      for (const name of mdFiles) {
        const norm = name.replace(/\\/g, "/");
        const slash = norm.indexOf("/");
        const dir = slash > 0 ? norm.slice(0, slash) : INBOX;
        await this.fs.mkdir(path.join(tmp, dir));
        await this.fs.writeText(path.join(tmp, dir, path.basename(norm)), files.get(name).toString("utf8"));
      }
      for (const [name, data] of files) {
        if (!name.startsWith("_assets/") || name.endsWith("/")) continue;
        const dest = path.join(tmp, name);
        await this.fs.mkdir(path.dirname(dest));
        await this.fs.writeBytes(dest, data);
      }
      // 换库：旧目录改名留作回滚，临时目录顶上
      const old = this.root + ".old-" + Date.now();
      await this.fs.rename(this.root, old);
      try {
        await this.fs.rename(tmp, this.root);
      } catch (err) {
        await this.fs.rename(old, this.root).catch(() => {});
        throw new Error("换库失败，原库已恢复：" + (err?.message || err));
      }
      await this.fs.removeDir(old).catch(() => {});
      await this._rescan();
      return { ok: true, categories: meta.categories.length, entries: mdFiles.length, assets: [...files.keys()].filter((n) => n.startsWith("_assets/")).length };
    });
  }

  stats() {
    return { root: this.root, backend: this.fs.kind, categories: this.meta.categories.length, entries: this.entries.size };
  }

  // ========== 首页：待办 / 最近 / 树 ==========
  todosOf(entry) {
    // 兼容内部记录 {body} 与对外 full() {content}
    const lines = String(entry.body ?? entry.content ?? "").split("\n");
    const out = [];
    let inFence = false;
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      const m = /^\s*(?:[-*•]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/.exec(line);
      if (m) out.push({ line: i, text: m[2].trim(), done: m[1] !== " " });
    });
    return out;
  }

  allTodos() {
    const groups = [];
    const hidden = [];
    for (const e of this.entries.values()) {
      const todos = this.todosOf(e);
      if (!todos.length) continue;
      if (e.meta.hideTodos) {
        hidden.push({ id: e.id, title: e.meta.title || deriveTitle(e.body), category: e.category, open: todos.filter((t) => !t.done).length, total: todos.length });
        continue;
      }
      groups.push({
        id: e.id,
        title: e.meta.title || deriveTitle(e.body),
        category: e.category,
        updated: e.meta.updated || e.meta.created,
        todos,
        open: todos.filter((t) => !t.done).length,
        total: todos.length,
      });
    }
    groups.sort((a, b) => b.open - a.open || String(b.updated).localeCompare(String(a.updated)));
    return { groups, hidden };
  }

  toggleTask(id, line) {
    return this.serial(async () => {
      const e = this.entries.get(String(id));
      if (!e) throw new Error(`条目不存在：${id}`);
      const lines = String(e.body).split("\n");
      const i = Number(line);
      if (!Number.isInteger(i) || i < 0 || i >= lines.length) throw new Error("行号越界");
      const m = /^(\s*(?:[-*•]|\d+[.)])\s+\[)([ xX])(\]\s+.*)$/.exec(lines[i]);
      if (!m) throw new Error("这一行不是任务项");
      lines[i] = m[1] + (m[2] === " " ? "x" : " ") + m[3];
      e.body = lines.join("\n");
      e.meta.updated = nowIso();
      await this.fs.writeText(e.file, serializeEntry(e.meta, e.body));
      return { line: i, done: m[2] === " " };
    });
  }

  // 把一条收藏回指到它的来源会话（收藏↔会话互指）
  attachSession(id, ref) {
    return this.serial(async () => {
      const e = this.entries.get(String(id));
      if (!e) throw new Error(`条目不存在：${id}`);
      const s = normSession(ref);
      if (!s) throw new Error("缺少 sessionId / sessionPath，无法回指会话");
      e.meta.session = s;
      e.meta.updated = nowIso();
      await this.fs.writeText(e.file, serializeEntry(e.meta, e.body));
      return this.full(e);
    });
  }

  markOpened(id) {
    return this.serial(async () => {
      const e = this.entries.get(String(id));
      if (!e) throw new Error(`条目不存在：${id}`);
      e.meta.opened = nowIsoMono();
      await this.fs.writeText(e.file, serializeEntry(e.meta, e.body));
      return { opened: e.meta.opened };
    });
  }

  recent(limit = 12) {
    return [...this.entries.values()]
      .filter((e) => e.meta.opened)
      .sort((a, b) => String(b.meta.opened).localeCompare(String(a.meta.opened)))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
      .map((e) => ({ ...this.summary(e), opened: e.meta.opened }));
  }

  setPref(id, patch = {}) {
    return this.serial(async () => {
      const e = this.entries.get(String(id));
      if (!e) throw new Error(`条目不存在：${id}`);
      if (patch.hideTodos !== undefined) e.meta.hideTodos = !!patch.hideTodos;
      await this.fs.writeText(e.file, serializeEntry(e.meta, e.body));
      return { hideTodos: !!e.meta.hideTodos };
    });
  }

  tree() {
    const byCat = new Map(this.meta.categories.map((c) => [c.name, []]));
    for (const e of this.entries.values()) {
      const list = byCat.get(e.category);
      if (list) {
        list.push({
          id: e.id,
          title: e.meta.title || deriveTitle(e.body),
          type: e.meta.type || "note",
          pinned: !!e.meta.pinned,
          parent: e.meta.parent || null,
          order: Number(e.meta.order) || 0,
          cover: e.meta.cover || null,
          opened: e.meta.opened || null,
        });
      }
    }
    const idSet = new Set(this.entries.keys());
    for (const list of byCat.values()) {
      for (const x of list) if (x.parent && idSet.has(x.parent)) { const p = list.find((y) => y.id === x.parent); if (p) p.childCount = (p.childCount || 0) + 1; }
    }
    return this.meta.categories.map((c) => {
      const entries = byCat.get(c.name) || [];
      entries.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
      return { name: c.name, description: c.description || "", count: entries.length, starred: !!c.starred, entries };
    });
  }

  starCategory(name) {
    return this.serial(async () => {
      const cat = this.findCategory(name);
      if (!cat) throw new Error(`分类不存在：${name}`);
      cat.starred = !cat.starred;
      await this.saveMeta();
      return { name: cat.name, starred: !!cat.starred };
    });
  }

  // ========== 双向链接 ==========
  // 提取 Markdown 中的 [[条目标题]] 或 [[条目标题#锚点]] 引用（跳过代码块与行内代码）
  extractLinks(content) {
    const links = [];
    const text = String(content ?? "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      .replace(/`[^`\n]*`/g, " ");
    const pattern = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?(?:#([^\]\n]+?))?\]\]/g;
    let match;
    while ((match = pattern.exec(text))) {
      links.push({ title: match[1].trim(), alias: match[2]?.trim(), anchor: match[3]?.trim() });
    }
    return links;
  }

  // 查找引用了指定条目的所有条目（反向链接）
  findBacklinks(id) {
    const target = this.entries.get(String(id));
    if (!target) return [];
    const targetTitle = target.meta.title || deriveTitle(target.body);
    const backlinks = [];
    for (const e of this.entries.values()) {
      if (e.id === id) continue;
      const links = this.extractLinks(e.body);
      for (const link of links) {
        if (link.title.toLowerCase() === targetTitle.toLowerCase()) {
          backlinks.push({
            id: e.id,
            title: e.meta.title || deriveTitle(e.body),
            category: e.category,
            anchor: link.anchor,
          });
          break;
        }
      }
    }
    return backlinks;
  }

  // 查找正文中提到了指定条目标题、但尚未加 [[双链]] 的条目（思源/Obsidian 式「未链接提及」）
  findUnlinkedMentions(id) {
    const target = this.entries.get(String(id));
    if (!target) return [];
    const targetTitle = (target.meta.title || deriveTitle(target.body)).trim();
    if (targetTitle.length < 2) return [];
    const tl = targetTitle.toLowerCase();
    const mentions = [];
    for (const e of this.entries.values()) {
      if (e.id === id) continue;
      const linked = this.extractLinks(e.body).some((l) => l.title.toLowerCase() === tl);
      if (linked) continue;
      const clean = String(e.body ?? "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/~~~[\s\S]*?~~~/g, " ")
        .replace(/`[^`\n]*`/g, " ")
        .replace(/\[\[[^\]]+\]\]/g, " ");
      const idx = clean.toLowerCase().indexOf(tl);
      if (idx >= 0) {
        const start = Math.max(0, idx - 24);
        const excerpt = (start > 0 ? "…" : "") + clean.slice(start, idx + targetTitle.length + 36).replace(/\s+/g, " ").trim();
        mentions.push({
          id: e.id,
          title: e.meta.title || deriveTitle(e.body),
          category: e.category,
          excerpt,
        });
      }
    }
    return mentions;
  }

  // 把 sourceId 笔记正文中第一次出现的裸 targetTitle 转为 [[targetTitle]]
  linkMention(sourceId, targetTitle) {
    return this.serial(async () => {
      const e = this.entries.get(String(sourceId));
      if (!e) throw new Error(`条目不存在：${sourceId}`);
      const title = String(targetTitle || "").trim();
      if (!title) throw new Error("目标标题不能为空");
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let replaced = false;
      const lines = String(e.body).split("\n");
      let inFence = false;
      const nextLines = lines.map((line) => {
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
        if (inFence || replaced) return line;
        const tokens = [];
        const masked = line.replace(/(\[\[[^\]]+\]\]|`[^`]+`)/g, (m) => {
          tokens.push(m);
          return `\u0000${tokens.length - 1}\u0000`;
        });
        const re = new RegExp(escaped, "i");
        if (!re.test(masked)) return line;
        replaced = true;
        const out = masked.replace(re, `[[${title}]]`);
        return out.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
      });
      if (!replaced) throw new Error("未在正文中找到可转换的提及文本");
      e.body = nextLines.join("\n");
      e.meta.updated = nowIso();
      await this.fs.writeText(e.file, serializeEntry(e.meta, e.body));
      return this.full(e);
    });
  }

  // 统计全库标签及频次
  listTags() {
    const counts = new Map();
    for (const e of this.entries.values()) {
      for (const t of normTags(e.meta.tags)) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }

  // 查找所有条目的双向链接关系图（用于关系图谱）
  buildLinkGraph() {
    const nodes = [];
    const edges = [];
    const titleToId = new Map();
    for (const e of this.entries.values()) {
      const title = e.meta.title || deriveTitle(e.body);
      // 同名标题只保留先建的，防止后来者劫持旧链接
      if (!titleToId.has(title.toLowerCase())) titleToId.set(title.toLowerCase(), e.id);
      nodes.push({ id: e.id, title, category: e.category });
    }
    for (const e of this.entries.values()) {
      const links = this.extractLinks(e.body);
      for (const link of links) {
        const targetId = titleToId.get(link.title.toLowerCase());
        if (targetId && targetId !== e.id) {
          edges.push({ from: e.id, to: targetId, anchor: link.anchor });
        }
      }
    }
    return { nodes, edges };
  }

  // 保存资源文件，返回相对路径（相对库根）
  saveAsset(buffer, filename) {
    return this.serial(async () => {
      const ext = String(filename).match(/\.(\w{1,8})$/)?.[1]?.toLowerCase() || "png";
      const now = new Date();
      const dir = `_assets/${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
      const base = sanitizeName(String(filename).replace(/\.\w{1,8}$/, "")) || `file_${Date.now()}`;
      const name = `${base}-${crypto.randomBytes(2).toString("hex")}.${ext}`;
      await this.fs.mkdir(path.join(this.root, dir));
      await this.fs.writeBytes(path.join(this.root, dir, name), buffer);
      return `${dir}/${name}`;
    });
  }

  // 读取资源文件（供 /asset 路由出图）
  async readAsset(relPath) {
    const clean = String(relPath).replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..");
    if (!clean.length || clean[0] !== "_assets") throw new Error("非法资源路径");
    const full = path.join(this.root, ...clean);
    if (!(await this.fs.exists(full))) throw new Error("资源不存在");
    return this.fs.readBytes(full);
  }
}
