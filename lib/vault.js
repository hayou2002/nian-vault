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
// 收藏类型。note/text/link 是文字类；image/video/audio/file/folder 是资源类，
// 靠 meta.ref 指向原件（存引用不复制，否则视频类会让备份 zip 失控）。
const TYPES = new Set(["note", "text", "link", "image", "video", "audio", "file", "folder", "memory", "experience"]);
// 资源类的默认图标（卡片墙、树、详情页共用）
const RES_ICON = { image: "image", video: "video", audio: "audio", file: "file", folder: "folder" };
// 扩展名 → 类型，用于收录时自动判定
const EXT_TYPE = {
  // 图片
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", ico: "image",
  // 视频
  mp4: "video", mkv: "video", mov: "video", avi: "video", webm: "video", flv: "video", wmv: "video", m4v: "video",
  // 音频
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio", aac: "audio", wma: "audio",
  // 文档
  pdf: "file", doc: "file", docx: "file", xls: "file", xlsx: "file", ppt: "file", pptx: "file",
  txt: "text", md: "text", csv: "text", json: "text",
  zip: "file", rar: "file", "7z": "file", tar: "file", gz: "file",
  exe: "file", msi: "file", apk: "file", dmg: "file",
};

function typeOfExt(ext) {
  return EXT_TYPE[String(ext || "").toLowerCase().replace(/^\./, "")] || "file";
}

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

// 把 "_assets/a/b"、"a/b"、"a\\b" 统一成 ["_assets","a","b"]。
// 调用方（前端）有时会去掉 _assets 前缀，这里两种都收。
// 把 "_assets/a/b"、"a/b"、"a\\b"、"" 统一成 _assets 下的段数组。
// 空值代表 _assets 根，必须返回 ["_assets"] 而不是 []——
// 否则 path.join(root) 会去列库根本身，把 _vault.json 和分类目录都当成资源。
function assetSegs(rel) {
  const segs = String(rel == null ? "" : rel).split(/[\\/]+/).filter((s) => s && s !== "." && s !== "..");
  if (!segs.length || segs[0] !== "_assets") segs.unshift("_assets");
  return segs;
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
      ref: e.meta.ref || null,
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

  // ---------- 资源类收藏 ----------
  // 资源不复制进库，只存引用（meta.ref）。理由：
  // 1. 用户要知道原件在哪儿；2. 视频动辄几百 MB，复制进去备份 zip 会失控。
  // ref 形状：{ kind:"path"|"url", target, size, mime, duration, pages, width, height, snapshot, missing }

  // 收录一个本地文件/文件夹：读元信息，建一条 type=image/video/... 的收藏。
  // 不校验文件是否存在（用户可能先收藏后移动），missing 在读取时才标。
  async collectRef(target, opts = {}) {
    const t = String(target || "").trim();
    if (!t) throw new Error("路径为空");
    // 先问是不是目录：文件夹往往没有扩展名，光靠扩展名猜会错成 file
    let isDir = false;
    try { isDir = !!(await this.fs.stat(t))?.isDir; } catch {}
    const type = opts.type || (isDir ? "folder" : this.guessType(t));
    if (!TYPES.has(type)) throw new Error(`不支持的类型：${type}`);
    const ref = { kind: "path", target: t };
    try {
      const st = await this.fs.stat(t);
      if (st) {
        ref.size = st.size ?? null;
        ref.mtime = st.mtime || null;
      }
    } catch { /* 文件不在也允许先存引用 */ }
    if (type === "folder") ref.children = await this.statFolder(t);
    return await this.create({
      title: opts.title || this.basename(t),
      content: opts.content || "",
      category: opts.category || INBOX,
      type,
      tags: opts.tags || [],
      source: opts.source || "本地资源",
      extra: { ref },
    });
  }

  // 收录一个网址：存 url 型 ref。元信息（标题/描述/图标）由前端抓或后续补。
  async collectUrl(url, opts = {}) {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) throw new Error("不是合法的网址");
    let host = "";
    try { host = new URL(u).hostname; } catch {}
    return await this.create({
      title: opts.title || host || u,
      content: opts.content || "",
      category: opts.category || INBOX,
      type: "link",
      tags: opts.tags || [],
      source: opts.source || "网页",
      extra: { ref: { kind: "url", target: u, host } },
    });
  }

  // 按扩展名猜类型
  guessType(p) {
    const ext = String(p).split(".").pop().toLowerCase();
    if (!ext || ext === String(p).toLowerCase()) return "file";
    return typeOfExt(ext);
  }

  basename(p) {
    const s = String(p).replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // 文件夹统计：子项数、总大小、按类型分布、前若干层结构。
  // depth 限 2 层，避免用户指着 D 盘根目录时把整棵树拉爆。
  async statFolder(dir, depth = 0) {
    const out = { count: 0, size: 0, byType: {}, children: [] };
    if (depth > 2) return out;
    let items = [];
    try { items = await this.fs.list(dir); } catch { return out; }
    for (const it of items.slice(0, 500)) {
      out.count++;
      const full = dir.replace(/[\\/]+$/, "") + (dir.includes("/") ? "/" : "\\") + it.name;
      if (it.isDir) {
        out.byType.folder = (out.byType.folder || 0) + 1;
        const sub = await this.statFolder(full, depth + 1);
        out.size += sub.size;
        out.count += sub.count;
        out.children.push({ name: it.name, type: "folder", count: sub.count, size: sub.size });
      } else {
        const t = this.guessType(it.name);
        out.byType[t] = (out.byType[t] || 0) + 1;
        let sz = 0;
        try { const st = await this.fs.stat(full); sz = st?.size || 0; } catch {}
        out.size += sz;
        out.children.push({ name: it.name, type: t, size: sz });
      }
    }
    out.children.sort((a, b) => (b.size || 0) - (a.size || 0));
    out.children = out.children.slice(0, 100);
    return out;
  }

  // 读取时校验引用是否还有效：文件被移动/删除时标 missing，界面据此提示，不崩。
  async checkRef(id) {
    const e = this.entries.get(String(id));
    if (!e) throw new Error("条目不存在");
    const ref = e.meta?.ref;
    if (!ref) return { ok: true, ref: null };
    if (ref.kind === "url") return { ok: true, ref };
    const exists = await this.fs.exists(ref.target);
    if (ref.missing === !exists) return { ok: true, ref };   // 状态没变
    ref.missing = !exists;
    await this.fs.writeText(e.file, serializeEntry(e.meta, e.body));
    return { ok: true, ref };
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
    // _assets 也要搬：以前漏了它，迁库后所有图片/文件的链接全断。
    const assetsRoot = path.join(this.root, "_assets");
    if (await this.fs.exists(assetsRoot)) {
      const walk = async (rel) => {
        const dir = path.join(assetsRoot, rel);
        await targetFs.mkdir(path.join(targetRoot, "_assets", rel));
        for (const it of await this.fs.list(dir)) {
          const full = rel ? `${rel}/${it.name}` : it.name;
          if (it.isDir) await walk(full);
          else {
            await targetFs.writeBytes(path.join(targetRoot, "_assets", full), await this.fs.readBytes(path.join(dir, it.name)));
            files++;
          }
        }
      };
      await walk("");
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
        // 递归收 _assets：现在支持任意深度子目录（图片/公开课/x.png），
        // 早先只扫两层会漏掉根下的文件和新子目录里的。
        const walk = async (rel) => {
          for (const it of await this.fs.list(path.join(assetsRoot, rel))) {
            const full = rel ? `${rel}/${it.name}` : it.name;
            if (it.isDir) await walk(full);
            else entries.push({ name: `_assets/${full}`, data: await this.fs.readBytes(path.join(assetsRoot, full)) });
          }
        };
        await walk("");
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
  // 上传资源到 _assets/。保留原文件名（用户要能看懂、能手写 ![[名]] 引用），
  // 支持传子目录（subdir），同名自动加 -1、-2 后缀。
  // 返回相对路径，如 "_assets/课标.pdf" 或 "_assets/图片/板书.png"。
  async saveAsset(buffer, filename, subdir = "") {
    return this.serial(async () => {
      const ext = String(filename).match(/\.(\w{1,8})$/)?.[1]?.toLowerCase() || "";
      const base = sanitizeName(String(filename).replace(/\.\w{1,8}$/, "")) || `file_${Date.now()}`;
      // 子目录也要清洗，防 ../ 穿越。清洗后和原意不同就拒绝，
      // 不静默改成一个奇怪的新目录（那会让用户找不到文件）。
      const subRaw = String(subdir || "").split(/[\\/]+/).filter(Boolean);
      const sub = subRaw.map((s) => sanitizeName(s)).filter(Boolean).join("/");
      if (subRaw.length && (!sub || subRaw.some((s, i) => sanitizeName(s) !== s))) {
        throw new Error(`子目录名不合法：${subdir}`);
      }
      const dir = sub ? `_assets/${sub}` : "_assets";
      await this.fs.mkdir(path.join(this.root, dir));
      // 找空位：原名、原名-1、原名-2…
      let name = ext ? `${base}.${ext}` : base;
      let n = 0;
      while (await this.fs.exists(path.join(this.root, dir, name))) {
        n++;
        name = ext ? `${base}-${n}.${ext}` : `${base}-${n}`;
        if (n > 999) { name = `${base}-${Date.now()}${ext ? "." + ext : ""}`; break; }
      }
      await this.fs.writeBytes(path.join(this.root, dir, name), buffer);
      return `${dir}/${name}`;
    });
  }

  // 列出 _assets/ 下的全部文件（文件管理器用）。
  // rel 为空 = 整棵树；给了就只列那一层。带是否目录、大小、时间。
  async listAssets(rel = "") {
    const clean = assetSegs(rel);
    const dir = path.join(this.root, ...clean);
    let items = [];
    try { items = await this.fs.list(dir); } catch { return { path: rel || "", items: [] }; }
    const out = [];
    for (const it of items) {
      const full = path.join(dir, it.name);
      const relPath = `${clean.length ? clean.join("/") : "_assets"}/${it.name}`;
      if (it.isDir) {
        // 目录：递归数一下里面有多少文件，列表上显示"N 项"
        const sub = await this.listAssets(relPath);
        out.push({ name: it.name, path: relPath, isDir: true, count: sub.items.length });
      } else {
        let size = 0, mtime = null;
        try { const st = await this.fs.stat(full); size = st?.size || 0; mtime = st?.mtime || null; } catch {}
        out.push({ name: it.name, path: relPath, isDir: false, size, mtime, type: this.guessType(it.name) });
      }
    }
    // 文件夹在前，文件在后，各自按名字排
    out.sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name, "zh"));
    return { path: rel || "", items: out };
  }

  // 重命名 _assets/ 里的文件或文件夹。返回新路径。
  // 重命名文件/文件夹。名字变了，正文里 ![[旧名]] 会断，所以顺手把引用改掉。
  // 返回 { to, patched }：to 是新路径，patched 是改了几篇正文。
  async renameAsset(rel, newName, { rewriteLinks = true } = {}) {
    const clean = assetSegs(rel);
    if (clean.length < 2) throw new Error("非法资源路径");
    const nn = sanitizeName(String(newName || ""));
    if (!nn) throw new Error("新名字不合法");
    const from = path.join(this.root, ...clean);
    // 保留原扩展名（用户可能只改了主名）
    const oldExt = (clean[clean.length - 1].match(/\.(\w{1,8})$/) || [])[1];
    const finalName = (oldExt && !nn.toLowerCase().endsWith("." + oldExt.toLowerCase())) ? `${nn}.${oldExt}` : nn;
    const to = path.join(this.root, ...clean.slice(0, -1), finalName);
    if (await this.fs.exists(to)) throw new Error(`已存在同名文件：${finalName}`);
    await this.fs.rename(from, to);
    const relNew = `${clean.slice(0, -1).join("/")}/${finalName}`;
    const result = { to: relNew, patched: 0 };
    // 名字真变了才重写。文件系统不区分大小写，但 ![[名]] 区分，所以大小写差异也要改
    if (rewriteLinks && clean[clean.length - 1] !== finalName) {
      result.patched = await this.rewriteAssetLinks([{
        from: clean.join("/"),
        to: relNew,
        fromName: clean[clean.length - 1],
        toName: finalName,
      }]);
    }
    return result;
  }

  // 删除 _assets/ 里的文件或文件夹。删除前不检查引用——
  // 调用方（路由）负责先查 refs 并提示，这里只做物理删除。
  async deleteAsset(rel) {
    const clean = assetSegs(rel);
    if (clean.length < 2) throw new Error("非法资源路径");
    const full = path.join(this.root, ...clean);
    if (!(await this.fs.exists(full))) throw new Error("文件不存在");
    const isDir = !!(await this.fs.stat(full))?.isDir;
    if (isDir) await this.fs.removeDir(full);
    else await this.fs.removeFile(full);
    return { deleted: rel };
  }

  // 把一批资源移到另一个文件夹。paths 是相对库根的路径（_assets/...）。
  // 逐条独立成败：一个失败不影响其余，最后汇总报告。
  // rewriteLinks=true 时，正文里写死的旧路径（![](_assets/旧)）一并改写，
  // ![[名]] 那种按名字引用的不受影响（名字没变）。
  async moveAssets(paths, destRel, { rewriteLinks = true } = {}) {
    const cleanDest = assetSegs(destRel);
    if (!(await this.fs.isDir(path.join(this.root, ...cleanDest)))) {
      throw new Error(`目标文件夹不存在：${destRel}`);
    }
    const dest = cleanDest.join("/");
    const done = [];
    const failed = [];
    const moved = []; // {from,to} 用于重写引用
    for (const p of (Array.isArray(paths) ? paths : [])) {
      const rel = String(p || "").replace(/\\/g, "/");
      try {
        const clean = assetSegs(rel);
        if (clean.length < 2) throw new Error("非法资源路径");
        const from = path.join(this.root, ...clean);
        const to = path.join(this.root, ...cleanDest, clean[clean.length - 1]);
        if (path.resolve(from) === path.resolve(to)) { done.push(rel); continue; }
        // 不能把文件夹移进自己或自己的子孙
        if ((await this.fs.isDir(from)) && to.startsWith(from + path.sep)) {
          throw new Error("不能把文件夹移进它自己里面");
        }
        if (await this.fs.exists(to)) throw new Error(`目标里已有同名项：${clean[clean.length - 1]}`);
        await this.fs.rename(from, to);
        done.push(rel);
        moved.push({ from: clean.join("/"), to: `${dest}/${clean[clean.length - 1]}` });
      } catch (err) {
        failed.push({ path: rel, error: String(err?.message || err) });
      }
    }
    // 引用重写：只在真移动了东西时做
    if (rewriteLinks && moved.length) {
      const patched = await this.rewriteAssetLinks(moved);
      return { moved: moved.length, done, failed, patched };
    }
    return { moved: moved.length, done, failed, patched: 0 };
  }

  // 资源路径变了，正文里写死路径的引用跟着改。
  // 只改 ![](_assets/旧) 和 [](_assets/旧) 里的路径部分，
  // ![[名]] 按名字引用，名字没动就不用管。返回改了多少篇。
  // 资源路径变了，正文里写死路径的引用跟着改。
  // 只改 ![](_assets/旧) 和 [](_assets/旧) 里的路径部分，
  // ![[名]] 按名字引用，名字没动就不用管。返回改了几篇。
  // 注意：正则必须用字面量或单层转义的 RegExp，多一层反斜杠就永远匹配不到。
  async rewriteAssetLinks(moves) {
    const touched = [];
    for (const e of this.entries.values()) {
      let body = String(e.body || "");
      let changed = false;
      for (const m of moves) {
        const fromEsc = m.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // 组1 = ![](  组2 = 可选的 ./  组3 = 路径之后到 ) 之前的部分（标题等）
        const reEmbed = new RegExp("(!\\[[^\\]\\n]*\\]\\(\\s*)(\\.\\/)?" + fromEsc + "([^)\\n]*)", "g");
        const reLink = new RegExp("(?<!!)(\\[[^\\]\\n]*\\]\\(\\s*)(\\.\\/)?" + fromEsc + "([^)\\n]*)", "g");
        const before = body;
        body = body.replace(reEmbed, (_m, pre, dot, tail) => pre + (dot || "") + m.to + tail);
        body = body.replace(reLink, (_m, pre, dot, tail) => pre + (dot || "") + m.to + tail);

        // 改名：![[旧名]] → ![[新名]]。
        // 只在 [[ ]] 内部整体替换，正文里随手写的"见图 a.png"不会被碰。
        // 带目录引的（![[子目录/旧名]]）只换尾巴的名字部分。
        if (m.fromName && m.toName && m.fromName !== m.toName) {
          const nameEsc = m.fromName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // 匹配整个 [[...]]，只处理结尾正好是旧名的（![[旧名]]、![[目录/旧名]]）
          const reName = new RegExp("\\[\\[([^\\]\\n]*?)\\]\\]", "g");
          body = body.replace(reName, (whole, inner) => {
            const idx = inner.lastIndexOf("/");
            const dirPart = idx >= 0 ? inner.slice(0, idx + 1) : "";
            const base = idx >= 0 ? inner.slice(idx + 1) : inner;
            if (base !== m.fromName) return whole;
            return "[[" + dirPart + m.toName + "]]";
          });
        }
        if (body !== before) changed = true;
      }
      if (changed) {
        e.body = body;
        touched.push(e);
      }
    }
    // 只改内存的话刷新页面就全丢，必须落盘。
    // 必须 await：调用方（改名、移动）紧接着可能去读磁盘验证，
    // fire-and-forget 会让它读到旧内容。
    // 引用跟随不动 updated 时间——这不是用户改了内容，是位置变了。
    // 逐篇 try：一篇写失败不影响其余，最后抛汇总错。
    const failed = [];
    for (const e of touched) {
      try {
        await this.fs.writeText(e.file, serializeEntry(e.meta, e.body));
      } catch (err) {
        failed.push({ file: e.file, error: String(err?.message || err) });
        console.error("[nian-vault] 引用重写落盘失败", e.file, err);
      }
    }
    if (failed.length) {
      throw new Error(`引用重写落盘失败 ${failed.length} 篇：${failed[0].error}`);
    }
    return touched.length;
  }

  // 在 _assets/ 下建子目录
  async mkAssetDir(rel, name) {
    const clean = assetSegs(rel);
    const nn = sanitizeName(String(name || ""));
    if (!nn) throw new Error("目录名不合法");
    const dir = clean.length ? path.join(this.root, ...clean, nn) : path.join(this.root, "_assets", nn);
    if (await this.fs.exists(dir)) throw new Error(`已存在：${nn}`);
    await this.fs.mkdir(dir);
    return { created: `${clean.length ? clean.join("/") : "_assets"}/${nn}` };
  }

  // 谁引用了这个资源：扫所有条目正文里的 ![[名]] 和 ![](路径)。
  // 这是文件管理器的核心价值——"删了会不会影响别的笔记"从猜变成看。
  refsOfAsset(rel) {
    const clean = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const base = clean[clean.length - 1] || "";
    const fullPath = clean.join("/");
    const used = [];
    for (const e of this.entries.values()) {
      const body = String(e.body || "");
      let hit = false;
      // ![[文件名]] 或 ![[子目录/文件名]]
      if (new RegExp(`!\\[\\[[^\\]]*${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\]]*\\]\\]`).test(body)) hit = true;
      // ![](_assets/...) 或 [](_assets/...)
      if (!hit && body.includes(fullPath)) hit = true;
      // 自身 ref 指向这个文件的资源条目
      if (!hit && e.meta?.ref?.target && String(e.meta.ref.target).replace(/\\/g, "/").endsWith(fullPath)) hit = true;
      if (hit) {
        used.push({ id: e.id, title: e.meta.title || deriveTitle(e.body), category: e.category });
      }
    }
    return used;
  }

  // 库外引用：meta.ref 指向库内 _assets/ 之外路径的条目（D:\xxx 那种）。
  // 文件管理器里要能看到它们，标成"库外"。
  // 判断依据是"是否位于本库的 _assets 目录下"，不是简单的前缀匹配——
  // 绝对路径（C:\...\库根\_assets\x.png）也得算库内。
  externalRefs() {
    const out = [];
    const rootNorm = String(this.root).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const assetRoot = `${rootNorm}/_assets/`;
    for (const e of this.entries.values()) {
      const ref = e.meta?.ref;
      if (!ref || ref.kind !== "path") continue;
      const t = String(ref.target || "").replace(/\\/g, "/");
      const tLow = t.toLowerCase();
      // 库内：相对路径以 _assets/ 开头，或绝对路径落在 <库根>/_assets/ 下
      const inAssets = tLow.startsWith("_assets/") || tLow.startsWith(assetRoot);
      if (inAssets) continue;
      out.push({
        id: e.id,
        title: e.meta.title || deriveTitle(e.body),
        type: e.meta.type || "file",
        target: ref.target,
        size: ref.size ?? null,
        missing: !!ref.missing,
      });
    }
    return out;
  }

  // 读取资源文件（供 /asset 路由出图）。支持 _assets/a/b.png 这种子目录路径。
  async readAsset(relPath) {
    const clean = assetSegs(relPath);
    if (clean.length < 2) throw new Error("非法资源路径");
    const full = path.join(this.root, ...clean);
    if (!(await this.fs.exists(full))) throw new Error("资源不存在");
    return this.fs.readBytes(full);
  }
}
