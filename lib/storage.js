// 两种存储后端，接口一致：
//   NodeFs     —— 直接用 node:fs，只能用于 App 自己的 dataDir（沙箱唯一可写根）
//   ResourceFs —— 走宿主 ResourceIO（sdk.resources），用于用户自定义的盘外目录，
//                 需要 app/resources.read + app/resources.write 授权
// 所有路径都是绝对路径；文本一律 UTF-8。
import fs from "node:fs/promises";
import path from "node:path";

export class NodeFs {
  constructor() { this.kind = "local"; }
  async exists(p) { try { await fs.stat(p); return true; } catch { return false; } }
  // 统一返回 { size, mtime, isDir }，取不到返回 null。
  // 资源类收藏要靠它读文件大小和时间。
  async stat(p) {
    try {
      const s = await fs.stat(p);
      return { size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory() };
    } catch { return null; }
  }
  async isDir(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }
  async readText(p) { return fs.readFile(p, "utf8"); }
  async readBytes(p) { return fs.readFile(p); }
  async writeText(p, text) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, text, "utf8"); }
  async writeBytes(p, buf) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, buf); }
  async mkdir(p) { await fs.mkdir(p, { recursive: true }); }
  async list(p) {
    try {
      const items = await fs.readdir(p, { withFileTypes: true });
      return items.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch { return []; }
  }
  // 沙箱内 rmSync 会静默失效，这里用 async API 手动递归删除
  async removeFile(p) { try { await fs.unlink(p); } catch (e) { if (e.code !== "ENOENT") throw e; } }
  async removeDir(p) {
    let entries;
    try { entries = await fs.readdir(p, { withFileTypes: true }); } catch (e) { if (e.code !== "ENOENT") throw e; return; }
    for (const d of entries) {
      const full = path.join(p, d.name);
      if (d.isDirectory()) await this.removeDir(full);
      else await fs.unlink(full).catch((e) => { if (e.code !== "ENOENT") throw e; });
    }
    try { await fs.rmdir(p); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  async rename(from, to) { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to); }
  async mtime(p) { try { return (await fs.stat(p)).mtimeMs; } catch { return null; } }
}

function toBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error("ResourceIO 返回了无法识别的内容格式");
}

function asList(res) {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object") {
    for (const k of ["entries", "items", "files", "children", "results"]) if (Array.isArray(res[k])) return res[k];
  }
  return [];
}

function entryName(e) {
  if (typeof e === "string") return e;
  for (const k of ["name", "path", "file", "title"]) {
    if (e && typeof e[k] === "string") return e[k].split(/[\\/]/).filter(Boolean).pop() || "";
  }
  return "";
}

function entryIsDir(e) {
  if (e && typeof e === "object") {
    for (const k of ["isDirectory", "isDir", "directory"]) if (typeof e[k] === "boolean") return e[k];
    if (typeof e.type === "string") return /dir/i.test(e.type);
    if (typeof e.kind === "string" && /dir/i.test(e.kind)) return true;
  }
  return false;
}

// 判断宿主返回的 stat 是不是目录。
// 各家 SDK 表达方式不一样，全部试一遍，宁可多判几种也不要漏。
function detectIsDir(st) {
  if (!st || typeof st !== "object") return false;
  if (typeof st.isDir === "boolean") return st.isDir;
  if (typeof st.isDirectory === "boolean") return st.isDirectory;
  if (typeof st.type === "string" && /dir|folder/i.test(st.type)) return true;
  // POSIX 的 mode 位：目录是 0o40000
  if (typeof st.mode === "number") return (st.mode & 0o170000) === 0o040000;
  if (typeof st.isFile === "boolean" && st.isFile === false && st.size == null) return true;
  return false;
}

export class ResourceFs {
  constructor(resources) { this.r = resources; this.kind = "resource"; }
  ref(p) { return { kind: "local-file", path: p }; }
  async statOf(p) {
    try {
      const st = await this.r.stat(this.ref(p));
      if (st == null) return null;
      if (typeof st === "object" && "exists" in st && !st.exists) return null;
      return st;
    } catch { return null; }
  }
  async exists(p) { return (await this.statOf(p)) != null; }
  // 与 NodeFs 对齐的统一 stat：{ size, mtime, isDir }
  // 目录判断要容错：宿主可能用 isDir / isDirectory / type:"directory" / mode 位
  // 任一种方式表达。之前只认前两种，结果目录被当成文件（显示文档图标 + 0 B）。
  async stat(p) {
    const st = await this.statOf(p);
    if (!st) return null;
    return {
      size: st.size ?? null,
      mtime: st.mtime ? new Date(st.mtime).toISOString() : null,
      isDir: detectIsDir(st),
    };
  }
  async isDir(p) {
    const st = await this.statOf(p);
    if (!st) return false;
    return detectIsDir(st);
  }
  async readBytes(p) {
    const res = await this.r.read(this.ref(p));
    if (res && typeof res === "object" && !(res instanceof Uint8Array) && !Buffer.isBuffer(res)) {
      if (typeof res.text === "string") return Buffer.from(res.text, "utf8");
      return toBuffer(res.content ?? res.bytes ?? res.data);
    }
    return toBuffer(res);
  }
  async readText(p) { return (await this.readBytes(p)).toString("utf8"); }
  async writeText(p, text) { await this.mkdir(path.dirname(p)); await this.r.write(this.ref(p), String(text)); }
  async writeBytes(p, buf) { await this.mkdir(path.dirname(p)); await this.r.write(this.ref(p), buf); }
  async mkdir(p) { if (await this.exists(p)) return; try { await this.r.mkdir(this.ref(p)); } catch (e) { if (!(await this.exists(p))) throw e; } }
  async list(p) {
    try {
      return asList(await this.r.list(this.ref(p)))
        .map((e) => ({ name: entryName(e), isDir: entryIsDir(e) }))
        .filter((e) => e.name);
    } catch { return []; }
  }
  async removeFile(p) { if (await this.exists(p)) await this.r.delete(this.ref(p)); }
  async removeDir(p) { if (await this.exists(p)) await this.r.delete(this.ref(p)); }
  async rename(from, to) { await this.mkdir(path.dirname(to)); await this.r.move(this.ref(from), this.ref(to)); }
  async mtime(p) {
    const st = await this.statOf(p);
    if (!st) return null;
    return st.mtimeMs ?? (st.mtime ? Date.parse(st.mtime) : null) ?? null;
  }
}
