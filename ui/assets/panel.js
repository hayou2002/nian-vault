import { hana } from "./sdk.js";
import { icon } from "./icons.js";
import { renderMarkdown, setResolveAsset } from "./markdown.js";

const API = {
  get: (path) => hana.api.fetch(path).then((r) => r.json()),
  post: (path, data) => hana.api.fetch(path, { method: "POST", body: JSON.stringify(data) }).then((r) => r.json()),
};

// 资源完整 URL。
// 关键：不能写 "../routes/_assets/xxx" 这种相对路径——浏览器会按面板自己的
// base URL 去解析，解析不到，图片就是裂的；external.open 也认不出相对路径。
// hana.api.url() 是 SDK 给的 helper，会把 API 路径拼成绝对 URL，两边都能用。
function assetUrl(rel) {
  const clean = String(rel || "").replace(/^\.?\//, "").replace(/^_assets\//, "");
  try { return hana.api.url(`/_assets/${clean}`); }
  catch { return `/_assets/${clean}`; }
}

// ---- 用系统应用打开一个本机文件 ----
// 封装原因：直接写 hana.ui.external.open 在沙箱里缺能力时会抛
// "Cannot read properties of undefined (reading 'open')"——用户看不懂。
// 这里把每种失败都翻成人话，并且退化到"复制路径"让用户自己打开。
async function openWithSystem(fp) {
  const abs = String(fp || "");
  if (!abs) return;
  // 优先 resources.open（本地文件引用，语义最正）
  try {
    const api = (typeof hana !== "undefined" && hana && hana.resources) || null;
    if (api && typeof api.open === "function") {
      const r = await api.open({ resource: { kind: "local-file", path: abs } });
      if (r && r.opened === false) throw new Error("宿主没有打开它");
      return;
    }
  } catch (e) {
    // 继续试下一种
    console.warn("[nian-vault] resources.open 失败：", e?.message || e);
  }
  // 再试 external.open
  try {
    const ext = (typeof hana !== "undefined" && hana && hana.ui && hana.ui.external) || null;
    if (ext && typeof ext.open === "function") {
      await ext.open({ path: abs });
      return;
    }
  } catch (e) {
    console.warn("[nian-vault] external.open 失败：", e?.message || e);
  }
  // 都不行：把路径给用户，并说清为什么
  try {
    await hana.ui.clipboard.writeText({ text: abs });
    toast(`这个环境打不开系统应用，已把路径复制到剪贴板：${abs.split(/[\\/]/).pop()}`, 7000);
  } catch {
    toast("这个环境打不开系统应用，也没法写剪贴板。路径：" + abs, 8000);
  }
}

// ---- 资源图片显示：blob URL（这是图片能显示的唯一正确方式）----
// 宿主给 App 的所有路由都要求凭据（surface session 头），
// 而 <img src="绝对地址"> 发请求带不了自定义头，所以必然 403 → 图片全裂。
// 正解：用 hana.api.fetch 取回二进制（它自动附凭据），转成 blob: URL 交给 <img>。
const _assetBlobCache = new Map();   // rel -> blobUrl
const _assetBlobPending = new Map(); // rel -> Promise

async function assetBlobUrl(rel) {
  const key = String(rel || "").replace(/^_assets\//, "");
  if (!key) return "";
  if (_assetBlobCache.has(key)) return _assetBlobCache.get(key);
  if (_assetBlobPending.has(key)) return _assetBlobPending.get(key);

  const task = (async () => {
    try {
      const res = await hana.api.fetch(`/_assets/${key}`);
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "无响应"}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      _assetBlobCache.set(key, url);
      return url;
    } catch (err) {
      console.warn("[nian-vault] 读取资源失败：", key, err?.message || err);
      return "";
    } finally {
      _assetBlobPending.delete(key);
    }
  })();
  _assetBlobPending.set(key, task);
  return task;
}

// 统一的媒体字节入口：库内相对路径走 /_assets/；库外绝对路径走 /external/raw。
// 不能全塞给 assetBlobUrl——它拼 /_assets/D:\... 时 SDK 见反斜杠直接抛
// Invalid plugin API path（外部视频「媒体加载失败」的根因）。
const _mediaBlobCache = new Map();    // fp -> blobUrl（完成后常驻）
const _mediaBlobPending = new Map(); // fp -> Promise（进行中去重）

// 按扩展名猜 MIME：blob 没有正确的 type 时，部分容器（mkv/avi）播放器会拒绝解码。
function guessMediaType(fp) {
  const ext = String(fp).split(".").pop().toLowerCase();
  return {
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg",
    mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", opus: "audio/opus",
  }[ext] || "";
}

// 读一个媒体文件的字节并变成 blob URL。
// onProgress(received, total)：total 为 0 表示服务端没给 Content-Length。
async function mediaBlobUrl(fp, onProgress) {
  const s = String(fp || "");
  if (!s) return "";
  if (_mediaBlobCache.has(s)) {
    const hit = _mediaBlobCache.get(s);
    onProgress?.(1, 1);
    return hit;
  }
  if (_mediaBlobPending.has(s)) return _mediaBlobPending.get(s);
  const isAbs = /^([A-Za-z]:[\\/]|\/)/.test(s);
  const url = isAbs ? `/external/raw?path=${encodeURIComponent(s)}` : `/_assets/${s.replace(/^[._]*assets[/_]/, "")}`;
  const task = (async () => {
    try {
      const res = await hana.api.fetch(url);
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "无响应"}`);
      const total = Number(res.headers.get("content-length")) || 0;
      let blob;
      if (res.body && typeof res.body.getReader === "function") {
        // 流式读，能报进度；避免 await res.blob() 期间界面完全无反馈
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          onProgress?.(received, total);
        }
        blob = new Blob(chunks, { type: guessMediaType(s) || "application/octet-stream" });
      } else {
        blob = await res.blob();
        onProgress?.(blob.size, blob.size);
      }
      const burl = URL.createObjectURL(blob);
      _mediaBlobCache.set(s, burl);
      return burl;
    } catch (err) {
      console.warn("[nian-vault] 媒体读取失败：", s, err?.message || err);
      return "";
    } finally {
      _mediaBlobPending.delete(s);
    }
  })();
  _mediaBlobPending.set(s, task);
  return task;
}

// 在线地址（http/https）直接交给浏览器：那才是真正的网络流。
function isOnlineUrl(s) {
  return /^https?:\/\//i.test(String(s || ""));
}

// 音视频填充：本地文件「取字节 → blob」，在线地址「直接给 src」。
//
// 为什么不直连本地路径：本地文件不是网址。之前几版都在拼 URL 让 <video>
// 自己去请求（Range/直连/token），本质是把磁盘文件当远程资源用，
// 一路上撞鉴权、静态目录、CSP 各种墙。自己把字节取回来最直接。
async function paintMedia(root) {
  const box = root || document;
  const els = [...box.querySelectorAll("video[data-vsrc], audio[data-vsrc]")];
  await Promise.all(els.map(async (el) => {
    const fp = el.dataset.vsrc;
    el.removeAttribute("data-vsrc");
    if (!fp) return;

    const wrap = el.closest(".fp-audio, .preview-body") || el.parentElement;
    const name = String(fp).split(/[\\/]/).pop();

    // 在线地址：真正的网络流，浏览器原生 Range 最合适
    if (isOnlineUrl(fp)) {
      el.src = fp;
      el.addEventListener("error", () => {
        const kinds = { 1: "加载被中止", 2: "网络错误", 3: "解码失败", 4: "格式不支持" };
        showMediaError(wrap, el, name, kinds[el.error?.code] || "未知", fp);
      }, { once: true });
      return;
    }

    // 本地文件：先放一个进度条，再取字节
    const bar = document.createElement("div");
    bar.className = "fp-progress";
    bar.innerHTML = `<div class="fp-progress-bar"></div><span class="fp-progress-txt">读取中…</span>`;
    wrap?.appendChild(bar);
    const fill = bar.querySelector(".fp-progress-bar");
    const txt = bar.querySelector(".fp-progress-txt");

    const blobUrl = await mediaBlobUrl(fp, (got, total) => {
      if (total > 0) {
        const pct = Math.min(100, Math.round((got / total) * 100));
        fill.style.setProperty("--w", pct + "%");
        txt.textContent = `读取中 ${pct}%（${fmtSize(got)} / ${fmtSize(total)}）`;
      } else {
        txt.textContent = `读取中 ${fmtSize(got)}`;
      }
    });
    bar.remove();

    if (!blobUrl) {
      showMediaError(wrap, el, name, "读不到文件内容", fp);
      el.remove();
      return;
    }
    el.src = blobUrl;
    el.addEventListener("error", () => {
      const kinds = { 1: "加载被中止", 2: "读取后被中断", 3: "解码失败", 4: "格式不支持" };
      showMediaError(wrap, el, name, `${kinds[el.error?.code] || "未知"}（文件可能编码特殊，建议用系统播放器）`, fp);
    }, { once: true });
  }));
}

// 统一失败面：说清是哪一步出的问题，并给出「用系统播放器打开」这条路。
function showMediaError(wrap, el, name, reason, fp) {
  if (!wrap) return;
  if (wrap.querySelector(".fp-open-sys[data-open-sys]")) return; // 不重复插
  wrap.insertAdjacentHTML("beforeend",
    `<div class="fp-err">❌ 无法播放 ${escapeHtml(name)}` +
    `<br><span class="muted">${escapeHtml(reason)}</span>` +
    `<br><button class="btn fp-open-sys" data-open-sys="${escapeAttr(fp)}">用系统播放器打开</button>` +
    `</div>`);
  const btn = wrap.querySelector(".fp-open-sys[data-open-sys]");
  btn?.addEventListener("click", () => openWithSystem(fp), { once: true });
}

// 扫一遍容器里所有 data-asset 的 <img>

// 扫一遍容器里所有 data-asset 的 <img>，把 blob URL 填进去。
// 之所以不直接在 innerHTML 里写 src：blob 是异步拿的，没法同步生成。
async function paintAssetImages(root) {
  const box = root || document;
  const imgs = [...box.querySelectorAll("img[data-asset]:not([data-asset-done])")];
  await Promise.all(imgs.map(async (img) => {
    img.dataset.assetDone = "1";
    const rel = img.dataset.asset;
    const url = await assetBlobUrl(rel);
    if (url) img.src = url;
    else {
      // 取不到就说明白，不要留一个裂图
      img.alt = (img.alt ? img.alt + " " : "") + "（读取失败）";
      img.classList.add("asset-failed");
    }
  }));
}

// 把 assetUrl 交给 markdown.js：这样笔记正文里的 ![](路径) 也能拿到绝对 URL。
// 不注册的话 markdown.js 只能退化用原路径，图片还是裂的。
setResolveAsset(assetUrl);

const $ = (id) => document.getElementById(id);
const appRoot = $("app");

let state = {
  categories: [],
  entries: [],
  tree: [],           // /home 的分类树缓存（带 parent/order），展开子收藏用它
  expanded: new Set(JSON.parse(localStorage.getItem("nv.expanded") || "[]")),
  selected: null,
  filter: { category: "", query: "", tag: "" },
  sort: "-updated",
  view: localStorage.getItem("nv.view") || "list", // list | card | compact
  root: "",
};

const TYPE_ICONS = { note: "note", text: "text", link: "link", image: "image", video: "video", audio: "note", pdf: "file", file: "file", folder: "folder", memory: "memory", experience: "experience" };
// 图标库没有 audio，用 note 顶着；显示时另外给文字区分
const TYPE_LABEL = { note: "笔记", text: "文本", link: "网页", image: "图片", video: "视频", audio: "音频", pdf: "PDF", file: "文件", folder: "文件夹", memory: "记忆", experience: "经验" };
// 与 lib/vault.js 的 EXT_TYPE 保持一致：收录时靠它判定类型
const EXT_TYPE = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", ico: "image",
  mp4: "video", mkv: "video", mov: "video", avi: "video", webm: "video", flv: "video", wmv: "video", m4v: "video",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio", aac: "audio", wma: "audio",
  pdf: "pdf", doc: "doc", docx: "doc",
  xls: "sheet", xlsx: "sheet", csv: "sheet",
  ppt: "slide", pptx: "slide",
  txt: "text", md: "text", csv: "text", json: "text",
  zip: "file", rar: "file", "7z": "file", tar: "file", gz: "file",
  exe: "file", msi: "file", apk: "file", dmg: "file",
};
const typeOfExt = (ext) => EXT_TYPE[String(ext || "").toLowerCase().replace(/^\./, "")] || "file";
const typeIcon = (t) => icon(TYPE_ICONS[t] || "note", 14);

const show = (el, v) => { if (el) el.hidden = !v; };
const setActive = (el, v) => { if (el) el.classList.toggle("active", !!v); };
function toast(text, time = 2200) {
  const t = $("toast");
  if (!t) return;
  t.textContent = text;
  show(t, true);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => show(t, false), time);
}

// 面板内的确认/输入框：iframe 沙箱里 window.prompt/confirm 可能被禁，
// 统一用自绘弹窗，避免点了没反应。
function dialog({ title, bodyHtml, okText = "确定", onOk, onMount, onClose }) {
  const modal = $("modal");
  $("m-title").textContent = title;
  $("m-body").innerHTML = bodyHtml || "";
  $("m-ok").textContent = okText;
  show(modal, true);
  const close = () => {
    show(modal, false);
    $("m-ok").onclick = null;
    $("m-cancel").onclick = null;
    onClose?.();
  };
  $("m-cancel").onclick = close;
  $("m-ok").onclick = async () => {
    let r;
    try {
      r = await onOk?.();
    } catch (err) {
      // onOk 抛异常时不能静默：否则用户点了按钮什么都没发生，还不知道为什么
      toast(`❌ 操作失败：${err?.message || err}`);
      console.error("[nian-vault] 弹窗确认操作失败", err);
      return;
    }
    if (r !== false) close();
  };
  onMount?.();
  return close;
}

// 单行输入：返回字符串，取消返回 null
function promptText(title, value = "", placeholder = "") {
  return new Promise((resolve) => {
    let settled = false;
    const once = (v) => { if (!settled) { settled = true; resolve(v); } };
    dialog({
      title,
      bodyHtml: `<input id="m-input" class="m-input" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}">`,
      okText: "确定",
      onOk: () => once($("m-input").value.trim()),
      onClose: () => once(null),
      onMount: () => {
        const i = $("m-input");
        i.focus();
        i.select();
        i.addEventListener("keydown", (e) => { if (e.key === "Enter") $("m-ok").click(); });
      },
    });
  });
}

// 危险操作确认：true = 确认，false = 取消
function confirmBox(title, bodyHtml) {
  return new Promise((resolve) => {
    let settled = false;
    const once = (v) => { if (!settled) { settled = true; resolve(v); } };
    dialog({
      title,
      bodyHtml: `<p>${escapeHtml(bodyHtml || "")}</p>`,
      okText: "删除",
      onOk: () => once(true),
      onClose: () => once(false),
    });
  });
}

// 选一个分类：返回分类名，取消返回 null
function pickCategory(current = "") {
  const opts = state.categories.map((c) =>
    `<option value="${escapeAttr(c.name)}"${c.name === current ? " selected" : ""}>${escapeHtml(c.name)}（${c.count || 0}）</option>`).join("");
  return new Promise((resolve) => {
    let settled = false;
    const once = (v) => { if (!settled) { settled = true; resolve(v); } };
    dialog({
      title: "移动到分类",
      bodyHtml: `<select id="m-cat" class="m-input">${opts}</select>`,
      okText: "移动",
      onOk: () => once($("m-cat").value),
      onClose: () => once(null),
    });
  });
}

// ---------------- 数据 ----------------
async function loadStatus() {
  const r = await API.get("/status");
  if (r.ok) {
    state.root = r.configured || r.root;
    if (r.warning) toast(`⚠ ${r.warning}`, 5000);
  }
}

async function loadCategories() {
  const r = await API.get("/categories");
  if (!r.ok) return toast(`❌ ${r.error}`);
  state.categories = r.categories || [];
  await refreshTree();
  renderCategories();
  // 资源索引也在这里刷，失败不阻塞
  refreshAssetIndex().catch(() => {});
}

// 资源索引在 loadCategories 里刷：![[名]] 卡片要靠它查文件在不在。
// 失败不影响主流程（卡片会显示"文件不存在"，但不该让面板白屏）。
// 不要放模块顶层——那时 surface 还没就绪，请求必失败。

function renameCategory(from) {
  const cur = state.categories.find((c) => c.name === from);
  dialog({
    title: `修改分类「${from}」`,
    bodyHtml: `<input id="d-name" value="${escapeAttr(from)}"${from === "收件箱" ? " disabled" : ""}><input id="d-desc" placeholder="说明" value="${escapeAttr(cur?.description || "")}">`,
    onMount: () => $("d-name").focus(),
    onOk: async () => {
      const r = await API.post("/categories/rename", { from, to: $("d-name").value.trim() || from, description: $("d-desc").value.trim() });
      if (!r.ok) { toast(`❌ ${r.error}`); return false; }
      await loadCategories();
      await selectCategory(r.name);
      toast("✓ 已保存");
    },
  });
}

function deleteCategory(name) {
  const n = state.categories.find((c) => c.name === name)?.count || 0;
  dialog({
    title: "删除分类",
    bodyHtml: `<p>删除「${escapeHtml(name)}」后，里面 ${n} 条内容会移到「收件箱」，不会被删掉。</p>`,
    okText: "删除",
    onOk: async () => {
      const r = await API.post("/categories/delete", { name });
      if (!r.ok) { toast(`❌ ${r.error}`); return false; }
      await loadCategories();
      await selectCategory("");
      toast(`✓ 已删除，${r.movedToInbox} 条移到收件箱`);
    },
  });
}

// 树的数据：/home 返回每个分类下的条目（带 parent/order）。
// 只取当前分类那棵，渲染成可展开的层级。
function kidNodes(cat, parentId, _seen) {
  // 防环 + 限深：数据里出现 parent 循环（旧版本遗留/手工改文件）时不能把页面卡死
  const seen = _seen || new Set();
  if (parentId && seen.has(parentId)) return [];
  if (parentId) seen.add(parentId);
  return (cat.entries || [])
    .filter((e) => (e.parent || null) === parentId)
    .slice(0, 500)
    .map((e) => ({ e, kids: kidNodes(cat, e.id, seen) }));
}

function treeHtml(cat) {
  const build = (node, depth) => {
    const { e, kids } = node;
    const hasKids = kids.length > 0;
    const open = state.expanded.has(e.id);
    return `<div class="kid-row${e.id === state.selected ? " active" : ""}" style="--depth:${depth}" data-kid="${e.id}" data-kids-cat="${escapeAttr(cat.name)}">` +
      (hasKids
        ? `<span class="fold kid-fold${open ? " open" : ""}" data-toggle="${e.id}">${open ? "▾" : "▸"}</span>`
        : `<span class="fold kid-fold-void"></span>`) +
      `<span class="kid-icon">${icon(TYPE_ICONS[e.type] || "note", 13)}</span>` +
      `<span class="kid-name${e.pinned ? " pin" : ""}">${escapeHtml(e.title)}</span>` +
      (hasKids ? `<span class="kid-badge">${kids.length}</span>` : "") +
      `</div>` +
      (hasKids && open ? `<div class="kid-sub">${kids.map((k) => build(k, depth + 1)).join("")}</div>` : "");
  };
  return kidNodes(cat, null).map((n) => build(n, 0)).join("");
}

// 分类列表：点标题铺出这个分类的收藏卡片墙；点左侧箭头展开/收起树。
function renderCategories() {
  const inbox = state.categories.find((c) => c.name === "收件箱");
  const treeByName = new Map(state.tree.map((c) => [c.name, c]));
  const items = state.categories.map((c) => {
      const tc = treeByName.get(c.name);
      const roots = kidNodes(tc || { entries: [] }, null);
      const arrow = roots.length ? (state.expanded.has("cat:" + c.name) ? "▾" : "▸") : "";
      const badge = c.name === "收件箱" && inbox?.count ? `<span class="badge" title="收件箱有 ${inbox.count} 条新收藏">${inbox.count}</span>` : `<span class="count">${c.count || ""}</span>`;
      return `<div class="cat-row${c.name === state.filter.category ? " active" : ""}${c.starred ? " starred" : ""}" data-cat="${escapeAttr(c.name)}">` +
        `<button class="cat" data-cat="${escapeAttr(c.name)}" title="${roots.length ? "点标题铺出这个分类的收藏卡片；点左侧箭头展开/收起树" : "点标题铺出这个分类的收藏卡片"}"><span class="fold cat-fold" data-fold="${escapeAttr(c.name)}">${arrow}</span><span class="cat-icon">${c.name === "收件箱" ? icon("inbox", 15) : icon("folder", 15)}</span><span class="cat-name">${escapeHtml(c.name)}</span>${badge}</button>` +
        `<button class="star" data-star="${escapeAttr(c.name)}" title="${c.starred ? "取消星标" : "星标分类"}">${c.starred ? "★" : "☆"}</button>` +
        `</div>` +
        `<div class="cat-kids" data-kids="${escapeAttr(c.name)}"${state.expanded.has("cat:" + c.name) ? "" : " hidden"}>${state.expanded.has("cat:" + c.name) ? (treeHtml(tc || { entries: [] }) || '<div class="kid-empty muted">暂无内容</div>') : ""}</div>`;
    });
  const box = $("cats");
  if (!box) return;
  box.innerHTML = items.join("");
  for (const b of box.querySelectorAll(".cat")) {
    b.addEventListener("click", (ev) => {
      // 点箭头只展开/收起，不进分类
      if (ev.target.classList.contains("cat-fold")) {
        ev.stopPropagation();
        const name = ev.target.dataset.fold;
        const key = "cat:" + name;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        saveExpanded();
        renderCategories();
        return;
      }
      // 点标题：铺出这个分类的收藏卡片墙；箭头只管展开树
      openWall("category", b.dataset.cat);
    });
  }
  for (const el of box.querySelectorAll(".kid-row")) {
    el.addEventListener("click", async (ev) => {
      const fold = ev.target.closest(".kid-fold");
      if (fold && !fold.classList.contains("kid-fold-void")) {
        const id = fold.dataset.toggle;
        if (state.expanded.has(id)) state.expanded.delete(id);
        else state.expanded.add(id);
        saveExpanded();
        renderCategories();
        return;
      }
      showListView();
      // selectCategory 结尾会选空条目，必须等它走完再选目标，
      // 否则后一个 selectEntry(null) 会把刚打开的详情清掉。
      await selectCategory(el.dataset.kidsCat);
      await selectEntry(el.dataset.kid);
    });
  }
  for (const b of box.querySelectorAll(".star")) {
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const r = await API.post("/categories/star", { name: b.dataset.star });
      if (!r.ok) return toast(`❌ ${r.error}`);
      await loadCategories();
     
    });
  }
 
  wireTreeMenus(box);
}

// ---- 右键菜单 ----------------------------------------------------------
// 侧栏不再常驻那些「改名/删除」按钮条了（你提的②），
// 全部收进右键菜单：分类行右键管分类，树条目右键管条目。
function treeMenu(ev, items) {
  ev.preventDefault();
  ev.stopPropagation();
  const old = document.getElementById("tree-menu");
  if (old) old.remove();
  const m = document.createElement("div");
  m.className = "tree-menu";
  m.id = "tree-menu";
  m.innerHTML = items.map((it, i) =>
    `<button data-i="${i}" class="${it.danger ? "danger" : ""}">${it.label}</button>`).join("");
  document.body.appendChild(m);
  // 贴边收一收，别让菜单跑出视口
  const r = m.getBoundingClientRect();
  const x = Math.min(ev.clientX, window.innerWidth - r.width - 8);
  const y = Math.min(ev.clientY, window.innerHeight - r.height - 8);
  m.style.left = Math.max(4, x) + "px";
  m.style.top = Math.max(4, y) + "px";
  for (const b of m.querySelectorAll("button")) {
    b.addEventListener("click", async () => {
      // 先摘监听再跑动作：跑动作时可能弹对话框，
      // 对话框上的 mousedown 会触发 off，把监听清掉
      document.removeEventListener("mousedown", off);
      m.remove();
      const it = items[Number(b.dataset.i)];
      try { await it.run(); } catch (err) { toast(`❌ ${err?.message || err}`); }
    });
  }
  // 菜单移除后这条监听必须一起走，否则每次开菜单都多留一个
  const off = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener("mousedown", off);
    }
  };
  document.addEventListener("mousedown", off);
}

function wireTreeMenus(box) {
  for (const row of box.querySelectorAll(".cat-row")) {
    const name = row.dataset.cat;
    if (!name) continue;
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const starred = !!state.categories.find((c) => c.name === name)?.starred;
      treeMenu(ev, [
        { label: "📇 铺出这个分类", run: () => openWall("category", name) },
        { label: "✨ AI 整理这个分类", run: () => organizeInboxWithAI(name) },
        { label: "✏ 改名", run: async () => {
            const nn = await promptText("重命名分类", name, "新的分类名");
            if (!nn || nn === name) return;
            const r = await API.post("/categories/rename", { from: name, to: nn });
            if (!r.ok) return toast(`❌ ${r.error}`);
            await loadCategories(); await loadEntries();
          } },
        { label: starred ? "☆ 取消星标" : "★ 星标", run: async () => {
            const r = await API.post("/categories/star", { name });
            if (!r.ok) return toast(`❌ ${r.error}`);
            await loadCategories(); await loadEntries();
          } },
        { label: "🗑 删除分类", danger: true, run: async () => {
            const cnt = state.categories.find((c) => c.name === name)?.count || 0;
            if (!(await confirmBox(`删除「${name}」？`, `这个分类下的 ${cnt} 条收藏会被移到「收件箱」，不会丢失。分类本身会被移除。`))) return;
            const r = await API.post("/categories/delete", { name });
            if (!r.ok) return toast(`❌ ${r.error}`);
            await loadCategories(); await loadEntries();
          } },
      ]);
    });
  }
  for (const row of box.querySelectorAll(".kid-row")) {
    const id = row.dataset.kid;
    const cat = row.dataset.kidsCat;
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      treeMenu(ev, [
        { label: "📖 打开", run: async () => { showWall(false); await selectCategory(cat); await selectEntry(id); } },
        { label: "⧉ 复制为新条目", run: async () => {
            const r = await API.post(`/entry/duplicate`, { id });
            if (!r.ok) return toast(`❌ ${r.error}`);
            await loadCategories(); await loadEntries();
          } },
        { label: "📦 移动到…", run: async () => {
            const to = await pickCategory(cat);
            if (!to || to === cat) return;
            const r = await API.post("/entry", { id, category: to });
            if (!r.ok) return toast(`❌ ${r.error}`);
            await loadCategories(); await loadEntries();
          } },
        { label: "✏ 重命名", run: async () => {
            const cur = (await API.get(`/entry?id=${encodeURIComponent(id)}`))?.entry?.title || "";
            const nn = await promptText("重命名", cur, "新标题");
            if (!nn || nn === cur) return;
            const r = await API.post("/entry", { id, title: nn });
            if (!r.ok) return toast(`❌ ${r.error}`);
            await loadCategories(); await loadEntries();
          } },
        { label: "📌 固定到首页", run: async () => {
            const r = await API.post("/entry", { id, homePinned: true });
            if (!r.ok) return toast(`❌ ${r.error}`);
            await loadCategories(); await loadEntries();
          } },
        { label: "🗑 删除", danger: true, run: async () => {
            if (!(await confirmBox("删除这条收藏？", "删除后无法恢复。"))) return;
            const r = await API.post("/entry/delete", { id });
            if (!r.ok) return toast(`❌ ${r.error}`);
            await loadCategories(); await loadEntries();
          } },
      ]);
    });
  }
}

// 展开状态记在 localStorage，下次打开还是你展开的样子
function saveExpanded() {
  try { localStorage.setItem("nv.expanded", JSON.stringify([...state.expanded].slice(0, 500))); } catch { /* 隐私模式下存不了就算了 */ }
}

// 拉一次 /home 刷新树数据（分类数量、层级、子条目）
async function refreshTree() {
  const r = await API.get("/home");
  if (r.ok) state.tree = r.tree || [];
}

// 选中某个分类时，行尾浮出改名/删除；没选中就收起


function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

async function selectCategory(name) {
  state.filter.category = name || "";
  state.filter.query = "";
  if ($("search")) $("search").value = "";
  const cat = state.categories.find((c) => c.name === name);
  renderCategories();
  await loadEntries();
  await selectEntry(null);
  if (window.innerWidth <= 760) {
    appRoot.classList.remove("show-detail");
    appRoot.classList.add("show-side");
  }
}

async function loadEntries() {
  const q = new URLSearchParams();
  if (state.filter.category) q.set("category", state.filter.category);
  // 支持在搜索框里直接输入 #标签名 过滤
  let rawQ = state.filter.query;
  let activeTag = state.filter.tag;
  const tagMatch = /^#(\S+)\s*(.*)$/.exec(rawQ);
  if (tagMatch && !activeTag) {
    activeTag = tagMatch[1];
    rawQ = tagMatch[2];
  }
  if (rawQ) q.set("q", rawQ);
  if (activeTag) q.set("tag", activeTag);
  const r = await API.get(`/entries?${q.toString()}`);
  if (!r.ok) return toast(`❌ ${r.error}`);
  state.entries = r.entries || [];
}


// 视频/网页收藏的封面卡片。只允许 https 封面与播放器，防注入。
function renderCover(e) {
  // 封面卡在正文区顶部（detail-main 里 view 之前），不挤在标题行
  const host = $("detail-main");
  const wrap = host.querySelector(":scope > .cover-wrap");
  if (wrap) wrap.remove();
  const isMedia = e.type === "video" || e.type === "link";
  const cover = isMedia && /^https:\/\//i.test(e.cover || "") ? e.cover : null;
  const embed = isMedia && /^https:\/\/player\.bilibili\.com\//i.test(e.embed || "") ? e.embed : null;
  const href = isMedia && /^https:\/\//i.test(e.source || "") ? e.source : null;
  if (!cover) return;
  const play = embed
    ? `<button class="cover-play" id="btn-embed" title="在页内播放">▶</button>`
    : href
      ? `<a class="cover-play" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" title="打开原页">▶</a>`
      : "";
  host.insertAdjacentHTML("afterbegin",
    `<div class="cover-wrap"><div class="cover-card">${play}<img src="${escapeAttr(cover)}" alt="封面" loading="lazy" referrerpolicy="no-referrer">${embed ? `<div class="cover-embed" id="embed-box" hidden></div>` : ""}</div></div>`);
  if (embed) {
    $("btn-embed").addEventListener("click", () => {
      const box = $("embed-box");
      if (box.hidden) {
        box.innerHTML = `<iframe src="${escapeAttr(embed)}" allowfullscreen allow="autoplay; encrypted-media" sandbox="allow-scripts allow-same-origin allow-presentation" referrerpolicy="no-referrer"></iframe>`;
        box.hidden = false;
      } else {
        box.hidden = true;
        box.innerHTML = "";
      }
    });
  }
}

// 详情页：把只读复选框接成可点（改回原笔记对应行），必须在 v-body.innerHTML 渲染后调用！
function wireViewTasks(entry) {
  const boxes = $("v-body").querySelectorAll("input[type=checkbox]");
  if (!boxes.length) return;
  const todos = entry.todos || [];
  const used = new Set();
  boxes.forEach((box) => {
    const text = (box.parentElement?.textContent || "").trim();
    const t = todos.find((x, i) => !used.has(i) && x.text === text);
    if (!t) return;
    used.add(todos.indexOf(t));
    box.disabled = false;
    box.dataset.line = t.line;
    box.addEventListener("change", async () => {
      const r = await API.post("/task/toggle", { id: entry.id, line: Number(box.dataset.line) });
      if (!r.ok) { box.checked = !box.checked; return toast(`❌ ${r.error}`); }
      toast(r.done ? "✓ 已完成" : "已取消完成");
    });
  });
}

function setEditMode(editing) {
  show($("edit"), editing);
  show($("detail-main"), !editing);
  if (editing) show($("toc"), false);
}

// ---------------- 详情 ----------------
async function selectEntry(id) {
  state.selected = id || null;
  try {
  if (!id) {
    // 不选条目时，右栏留引导文案，不是一整片死白
    showView("detail");
    show($("detail-main"), true);
    show($("edit"), false);
    show($("detail-hint"), true);
    $("v-title").textContent = "";
    $("v-meta").innerHTML = "";
    $("v-body").innerHTML = "";
    $("ref-view").hidden = true;
    $("ref-view").innerHTML = "";
    appRoot.classList.remove("show-detail");
    return;
  }
  const r = await API.get(`/entry?id=${encodeURIComponent(id)}`);
  if (!r.ok) return toast(`❌ ${r.error}`);
  const e = r.entry;
  $("v-title").textContent = e.title;
  renderCover(e);
  renderMoreMenu(e);
  API.post("/entry/opened", { id: e.id }).catch(() => {});
  $("v-meta").innerHTML =
    `<strong>${escapeHtml(e.category)}</strong> · ${typeIcon(e.type)} ${escapeHtml(TYPE_LABEL[e.type] || e.type)} · ${String(e.updated || "").slice(0, 10)}` +
    (e.parentTitle ? renderMarkdown(` · 属于 [[${e.parentTitle}]]`).replace(/^<p>|<\/p>$/g, "") : "") +
    (e.source ? ` · 来源 ${
      /^(https?:\/\/)/i.test(e.source)
        ? `<a href="${escapeAttr(e.source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(e.source).slice(0, 60))}</a>`
        : `<span title="${escapeAttr(e.source)}">${escapeHtml(String(e.source).slice(0, 60))}</span>`
    }` : "") +
    (e.tags?.length ? `<br>${e.tags.map((t) => `<span class="tag" data-filter-tag="${escapeAttr(t)}">${escapeHtml(t)}</span>`).join("")}` : "") +
    (e.session ? ` <button class="link-btn" id="meta-session" title="把焦点交回这条收藏所在的对话">💬 来自对话</button>` : "");
  for (const tagEl of $("v-meta").querySelectorAll(".tag[data-filter-tag]")) {
    tagEl.addEventListener("click", () => {
      // 详情页点标签：铺出同标签的收藏卡片，方便顺藤摸瓜找别的
      state.filter.tag = tagEl.dataset.filterTag;
      openWall("tag", tagEl.dataset.filterTag);
    });
  }
  renderRefView(e);
  $("v-body").innerHTML = renderMarkdown(e.content);
  paintAssetImages($("v-body"));
  bindRefCards($("v-body"));
  show($("detail-hint"), false);
  // ★ Bug #1 修复：必须在 v-body.innerHTML 渲染完成后再绑定任务复选框点击事件
  wireViewTasks(e);

  // 文件引用条目：路径行加复制按钮
  if (e.type === "file" || e.type === "folder") {
    const codeEls = $("v-body").querySelectorAll("code");
    for (const c of codeEls) {
      const txt = c.textContent;
      if ((/^[A-Za-z]:[\\/]/.test(txt) || txt.startsWith("/")) && txt.length > 4) {
        const btn = document.createElement("button");
        btn.className = "link-btn";
        btn.textContent = "复制路径";
        btn.addEventListener("click", () => {
          navigator.clipboard?.writeText(txt).then(() => toast("✓ 路径已复制"), () => toast("复制失败，请手动选择复制"));
        });
        c.after(btn);
      }
    }
  }
  setEditMode(false);
  showView("detail");
  appRoot.classList.add("show-detail");
  appRoot.classList.remove("show-side");
  await loadBacklinks(e.id, e.title);
  buildTOC(e.content);
  } catch (err) {
    toast(`❌ 打开失败：${err?.message || err}`);
  }
}

// ---------------- 编辑器封装 ----------------
const Editor = {
  v: null,
  get value() { return this.v ? this.v.getValue() : ($("e-body")?.value ?? ""); },
  set value(text) {
    if (this.v) this.v.setValue(String(text ?? ""));
    else { const ta = $("e-body"); if (ta) ta.value = String(text ?? ""); }
  },
  insert(text) {
    if (this.v) { this.v.insertValue(String(text), { render: true }); this.v.focus(); }
    else {
      const ta = $("e-body");
      if (!ta) return;
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos);
      ta.focus();
      ta.setSelectionRange(pos + text.length, pos + text.length);
      ta.dispatchEvent(new Event("input"));
    }
  },
  focus() { if (this.v) this.v.focus(); else $("e-body")?.focus(); },
  init() {
    if (typeof Vditor === "undefined" || !$("vditor-mount")) return;
    this.v = new Vditor("vditor-mount", {
      mode: "wysiwyg",
      value: "",
      height: "100%",
      cache: { enable: false },
      counter: { enable: true },
      placeholder: "直接开始写，像 Word 一样；工具栏可切换源码模式",
      toolbar: ["headings", "bold", "italic", "strike", "|", "list", "ordered-list", "check", "|", "quote", "code", "inline-code", "link", "table", "|", "undo", "redo", "|", "edit-mode", "fullscreen"],
      lang: "zh_CN",
      // 图片上传：接已有的 POST /asset/upload（FormData）。
      // 不另造接口——文件管理器和编辑器共用一条，行为一致。
      upload: {
        // 用真实文件名，不要 Vditor 默认的随机串（用户要对得上自己传了什么）
        filename: (f) => f.name,
        handler: (files) => Promise.all([...files].map(async (f) => {
          try {
            const fd = new FormData();
            fd.append("file", f, f.name);
            // 传到编辑器当前条目所在层（filesSel 为空 = 库根资源目录）
            fd.append("subdir", filesSel ? filesSel.replace(/^_assets\//, "") : "");
            const res = await hana.api.fetch("/asset/upload", { method: "POST", body: fd });
            const j = await res.json();
            if (!j || !j.path) throw new Error(j?.error || "上传失败");
            // 成功：Vditor 会把返回的字符串当 src 插进去
            return j.path;
          } catch (err) {
            toast(`❌ 图片上传失败：${err?.message || err}`, 5000);
            // 返回空串 = Vditor 不插入，比插一张裂图好
            return "";
          }
        })),
      },
      after: () => {
        // wysiwyg 下 <img src="_assets/x.png"> 会按面板 base URL 解析，图裂。
        // 这里把已渲染出来的相对路径统一改写成 /_assets/ 前缀。
        // 只在 after 跑一次不够——内容会随输入变，所以用 MutationObserver 兜着。
        const fixImgs = (root) => {
          if (!root || !root.querySelectorAll) return;
          for (const img of root.querySelectorAll("img")) {
            // 已经处理过的不重复处理（blob URL 打上标记，避免死循环）
            if (img.dataset.blobFilled === "1") continue;
            const src = img.getAttribute("src") || "";
            // 外链和 data: 不碰
            if (/^(https?:|data:)/i.test(src)) continue;
            // 已经是 blob 了也不用管
            if (src.startsWith("blob:")) continue;
            // 库内路径（相对或已被改成 /routes/ 绝对地址）统一还原成 rel
            let rel = src;
            const m = rel.match(/\/_assets\/([^"'\s]+)$/);
            if (m) rel = "_assets/" + decodeURIComponent(m[1]);
            rel = rel.replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
            if (!rel || !/^_assets\//.test(rel)) continue;
            const key = rel.replace(/^_assets\//, "");
            img.dataset.blobFilled = "1";
            // 用 blob URL 显示：正文里存的仍是相对路径，不被污染
            assetBlobUrl(key).then((url) => {
              if (url) img.setAttribute("src", url);
              else img.classList.add("asset-failed");
            });
          }
        };
        const mount = $("vditor-mount");
        if (mount) {
          fixImgs(mount);
          const mo = new MutationObserver(() => fixImgs(mount));
          mo.observe(mount, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
        }
      },
    });
  },
};
// ---------------- ④ 附件标签页 ----------------
// 编辑器里的资源入口：上传新文件、或插入库里已有的资源。
// 插入形态由资源类型决定：
//   图片      → ![备注](路径)   直接显示
//   视频/音频 → ![备注](路径)   由 __refCard 渲染成播放器
//   其他      → [名字](路径)    普通链接
// 引用库内资源一律用 ![[名]] / [名](路径) 的真实路径，不复制文件。
const Attach = {
  open: false,
  items: [],
  // 开关：开成一个模态弹窗，不占编辑器布局。
  // （原来是内联展开面板，内容一多就把编辑器顶下去了——用户反馈的问题。）
  toggle() { this.openDialog(); },
  async openDialog() {
    // 自己建独立遮罩，不用通用 dialog()。
    // 原因：dialog() 是单例，每次打开都 m-body.innerHTML = ...，
    // 附件容器挂在里面会被别的弹窗直接冲掉。独立遮罩互不干扰。
    const old = document.getElementById("attach-overlay");
    if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "attach-overlay";
    ov.className = "attach-overlay";
    ov.innerHTML =
      `<div class="attach-modal" role="dialog" aria-label="附件">
         <div class="attach-head">
           <span class="attach-title">📎 附件</span>
           <button type="button" class="attach-close" id="attach-close" aria-label="关闭">✕</button>
         </div>
         <div class="attach-dialog-host"></div>
       </div>`;
    document.body.appendChild(ov);
    this.open = true;
    const b = $("btn-attach");
    if (b) b.setAttribute("aria-expanded", "true");
    // 先建容器，再拉数据：弹窗立刻出来，不等网络
    const box = document.createElement("div");
    box.id = "attach-panel";
    box.innerHTML =
      `<div class="attach-acts">
         <button type="button" class="small primary" id="btn-attach-upload">⬆ 上传文件</button>
         <input type="file" id="attach-file" multiple hidden>
         <input type="text" id="attach-q" placeholder="筛选资源名…" class="attach-q">
       </div>
       <div class="attach-list" id="attach-list"><div class="muted attach-loading">正在读取库内资源…</div></div>
       <div class="attach-foot">
         <span class="muted" id="attach-stat"></span>
         <button type="button" class="link-btn" id="btn-attach-refresh">↻ 刷新</button>
       </div>`;
    ov.querySelector(".attach-dialog-host").appendChild(box);
    this.wire();
    await this.refresh();
    const cleanup = () => {
      ov.remove();
      this.open = false;
      $("btn-attach")?.setAttribute("aria-expanded", "false");
      document.removeEventListener("keydown", onEsc);
    };
    const onEsc = (ev) => { if (ev.key === "Escape") cleanup(); };
    $("attach-close").addEventListener("click", cleanup);
    // 点遮罩空白处也关
    ov.addEventListener("click", (ev) => { if (ev.target === ov) cleanup(); });
    document.addEventListener("keydown", onEsc);
  },
  // 弹窗里的按钮/输入框接线（每次打开都要重接，因为容器是新的）
  wire() {
    $("btn-attach-upload")?.addEventListener("click", () => $("attach-file").click());
    $("attach-file")?.addEventListener("change", async (ev) => {
      await this.upload(ev.target.files);
      ev.target.value = "";
    });
    $("btn-attach-refresh")?.addEventListener("click", () => this.refresh());
    let t = null;
    $("attach-q")?.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => this.render(), 120);
    });
  },
  // 拉库内资源清单（复用 AI 那条索引，带缓存）
  async refresh() {
    const box = $("attach-list");
    const stat = $("attach-stat");
    if (!box) return;
    box.innerHTML = `<div class="muted attach-loading">正在读取库内资源…</div>`;
    let items = [];
    try {
      const r = await API.get("/assets/index");
      items = r.ok ? (r.items || []) : [];
    } catch { items = []; }
    this.items = items;
    if (stat) stat.textContent = `库内共 ${items.length} 项资源`;
    this.render();
  },
  render() {
    const box = $("attach-list");
    if (!box) return;
    const q = ($("attach-q")?.value || "").trim().toLowerCase();
    const list = q ? this.items.filter((x) => x.name.toLowerCase().includes(q)) : this.items;
    if (!list.length) {
      box.innerHTML = `<div class="muted attach-empty">${q ? "没有匹配的资源" : "库里还没有资源，先上传一个"}</div>`;
      return;
    }
    box.innerHTML = list.slice(0, 200).map((x) => {
      const ic = x.isDir ? "folder" : (TYPE_ICONS[x.type] || "file");
      return `<button type="button" class="attach-item" data-p="${escapeAttr(x.path)}" data-dir="${x.isDir ? "1" : "0"}" data-type="${escapeAttr(x.type || "")}">` +
        `<span class="ai-ic">${icon(ic, 16)}</span>` +
        `<span class="ai-n" title="${escapeAttr(x.path)}">${escapeHtml(x.name)}</span>` +
        `<span class="ai-t">${escapeHtml(x.isDir ? "文件夹" : TYPE_LABEL[x.type] || "文件")}</span>` +
        `</button>`;
    }).join("");
    for (const b of box.querySelectorAll(".attach-item")) {
      b.addEventListener("click", () => this.insertPath(b.dataset.p, b.dataset.dir === "1", b.dataset.type));
    }
  },
  // 把一条资源插进正文光标处
  insertPath(rel, isDir, type) {
    if (!rel) return;
    if (isDir) {
      // 文件夹没有"嵌入"可言，插入成双链形式，点击能跳到文件管理器
      Editor.insert(`[[${rel.split("/").pop()}]]`);
      toast("✓ 已插入文件夹引用", 2500);
      return;
    }
    // 用真实相对路径（_assets/...），不用 ![[名]]——
    // 同名文件多个时 ![[名]] 会猜错，路径是确定的。
    const embeddable = type === "image" || type === "video" || type === "audio";
    Editor.insert(embeddable ? `![](${rel})` : `[${rel.split("/").pop()}](${rel})`);
    toast("✓ 已插入附件", 2500);
  },
  // 上传：支持多选，逐个独立成败。
  // 走已有的 POST /asset/upload（FormData），不另造 base64 路由——
  // base64 + Array.from 会把 1MB 图片变成 100 万个数字的 JSON 数组，请求直接垮。
  // 那条路由返回 { path }（没有 ok 字段），所以判据是 path 而不是 ok。
  async upload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    // 不再在前端写死 20MB。后端上限是 50MB（routes.js 的 MAX_ASSET），
    // 前端更严只会莫名其妙拦住本来能传的文件——之前那个 20MB 就是我自己拍脑袋写的。
    // 现在只做一件事：超过后端上限的，提示改用"引用"（连引用都不搬文件）。
    const HARD = 50 * 1024 * 1024;   // 与后端 MAX_ASSET 对齐
    const SUBDIR = filesSel ? filesSel.replace(/^_assets\//, "") : "";
    let okN = 0;
    const errs = [];

    for (const f of files) {
      // 超过后端上限：不报死，改成提供两条路（引用 / 移动）。用户说过"能跳转就行"。
      if (f.size > HARD) {
        const pick = await new Promise((resolve) => {
          let done = false;
          const once = (v) => { if (!done) { done = true; resolve(v); } };
          dialog({
            title: "这个文件比较大",
            bodyHtml:
              `<p>${escapeHtml(f.name)}（${fmtSize(f.size)}）超过了直接上传的上限 50MB。</p>` +
              `<p class="muted">你可以选一种方式：</p>` +
              `<ul class="muted" style="margin:4px 0 0 16px;padding:0">` +
              `<li><b>引用它</b>：不搬文件，正文里放一个能点开的入口（推荐）</li>` +
              `<li><b>移进库</b>：把文件搬到库里再插入，占库空间</li>` +
              `<li><b>跳过</b>：不处理这个文件</li></ul>`,
            okText: "引用它",
            onOk: () => once("ref"),
            onClose: () => once("skip"),
            onMount: () => {
              // 第二个操作按钮：把 okText 之外的另一条路放出来
              const host = $("m-body");
              const bar = document.createElement("div");
              bar.style.cssText = "margin-top:10px;display:flex;gap:6px";
              const mv = document.createElement("button");
              mv.type = "button"; mv.className = "small"; mv.textContent = "移进库";
              mv.addEventListener("click", () => { once("move"); show($("modal"), false); });
              bar.appendChild(mv);
              host.appendChild(bar);
            },
          });
        });

        if (pick === "ref") {
          // 引用：选中的这个文件用"指针"方式插进正文，正文里是一个可点开的块
          const ref = await refLocalFile(f);
          if (ref) { this.insertRefBlock(ref); okN++; }
          continue;
        }
        if (pick === "move") {
          const moved = await moveLocalIntoVault(f);
          if (moved) { this.insertPath(moved, false, guessTypeOf(f.name)); okN++; }
          continue;
        }
        errs.push(`${f.name}：已跳过`);
        continue;
      }

      try {
        const fd = new FormData();
        fd.append("file", f, f.name);
        fd.append("subdir", SUBDIR);
        const res = await hana.api.fetch("/asset/upload", { method: "POST", body: fd });
        const j = await res.json();
        if (j && j.path) { okN++; this.insertPath(j.path, false, guessTypeOf(f.name)); }
        else errs.push(`${f.name}：${j?.error || "上传失败"}`);
      } catch (err) { errs.push(`${f.name}：${err?.message || err}`); }
    }
    if (okN) toast(`✓ 已上传并插入 ${okN} 个附件`, 3500);
    if (errs.length) toast(`❌ ${errs.length} 个失败：${errs[0]}`, 5000);
    this.refresh();
  },
};

// 按扩展名猜类型（上传前就要决定插入成嵌入还是链接）
function guessTypeOf(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  if (["png","jpg","jpeg","gif","webp","bmp","svg","avif"].includes(ext)) return "image";
  if (["mp4","webm","mov","mkv","avi","m4v"].includes(ext)) return "video";
  if (["mp3","wav","ogg","m4a","flac","aac"].includes(ext)) return "audio";
  if (["md","txt","markdown"].includes(ext)) return "text";
  if (["pdf"].includes(ext)) return "pdf";
  return "file";
}

// 只留触发按钮的接线；弹窗内部接线在 Attach.wire() 里做
$("btn-attach").addEventListener("click", () => Attach.toggle());
Editor.init();

// ---------------- [[ 双链自动补全 ----------------
const Wiki = {
  el: null,
  items: [],
  idx: 0,
  pool: [],
  async refreshPool() {
    try {
      const r = await API.get("/entries?limit=500");
      if (r.ok) this.pool = r.entries || [];
    } catch { /* 降级：用当前列表 */ }
  },
  open(q) {
    const src = this.pool.length ? this.pool : state.entries;
    const ql = String(q || "").toLowerCase();
    this.items = src
      .filter((e) => !ql || String(e.title || "").toLowerCase().includes(ql) || String(e.category || "").toLowerCase().includes(ql))
      .slice(0, 8);
    if (!this.items.length) return this.close();
    this.idx = 0;
    this.render();
  },
  render() {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "wiki-popup";
      document.body.appendChild(this.el);
    }
    this.el.innerHTML = this.items.map((e, i) =>
      `<button data-i="${i}" class="${i === this.idx ? "cur" : ""}"><span class="wp-icon">${typeIcon(e.type)}</span><span class="wp-title">${escapeHtml(e.title)}</span><span class="wp-cat">${escapeHtml(e.category)}</span></button>`).join("") +
      `<div class="wp-tip">↑↓ 选择 · Enter 插入 · Esc 取消</div>`;
    this.el.hidden = false;
    const pos = caretPos();
    if (pos) {
      const w = 280, h = this.el.offsetHeight || 200;
      this.el.style.left = Math.max(4, Math.min(pos.x, window.innerWidth - w - 8)) + "px";
      this.el.style.top = (pos.y + 22 + h > window.innerHeight ? Math.max(4, pos.y - h - 4) : pos.y + 22) + "px";
    }
    for (const b of this.el.querySelectorAll("button")) {
      b.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.idx = Number(b.dataset.i);
        this.pick();
      });
    }
  },
  move(d) {
    if (!this.isOpen()) return;
    this.idx = (this.idx + d + this.items.length) % this.items.length;
    this.render();
  },
  pick() {
    const e = this.items[this.idx];
    this.close();
    if (e) replaceWikiPending(`[[${e.title}]]`);
  },
  close() {
    if (this.el) this.el.hidden = true;
    this.items = [];
  },
  isOpen() { return !!this.el && !this.el.hidden; },
};

function caretPos() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if ((rect.width || rect.height || rect.left) && document.activeElement !== $("e-body")) {
      return { x: rect.left + window.scrollX, y: rect.bottom + window.scrollY };
    }
  }
  const ta = $("e-body");
  if (ta && document.activeElement === ta) {
    const r = ta.getBoundingClientRect();
    const line = ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
    return { x: r.left + 12, y: r.top + 8 + line * 22 - ta.scrollTop };
  }
  return null;
}

function replaceWikiPending(text) {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA") {
    const end = active.selectionStart;
    const m = /\[\[([^\]\n]*)$/.exec(active.value.slice(active.value.lastIndexOf("\n", end - 1) + 1, end));
    if (m) {
      active.setRangeText(text, end - m[0].length, end, "end");
      active.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
  }
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const before = (node.textContent || "").slice(0, range.startOffset);
      const m = /\[\[([^\]\n]*)$/.exec(before);
      if (m && node.nodeType === 3) {
        const r2 = document.createRange();
        r2.setStart(node, range.startOffset - m[0].length);
        r2.setEnd(node, range.startOffset);
        sel.removeAllRanges();
        sel.addRange(r2);
      }
    }
  } catch { /* 选区拿不到就直接插 */ }
  if (!document.execCommand("insertText", false, text)) Editor.insert(text);
}

(function wireWiki() {
  document.addEventListener("keydown", (ev) => {
    if (Wiki.isOpen()) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); ev.stopPropagation(); Wiki.move(1); return; }
      if (ev.key === "ArrowUp") { ev.preventDefault(); ev.stopPropagation(); Wiki.move(-1); return; }
      if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); ev.stopPropagation(); Wiki.pick(); return; }
      if (ev.key === "Tab") { ev.preventDefault(); ev.stopPropagation(); Wiki.pick(); return; }
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); Wiki.close(); return; }
    }
  }, true);
  const detect = () => {
    if (!$("edit") || $("edit").hidden) return Wiki.close();
    const ta = document.activeElement;
    let before = "";
    if (ta && ta.tagName === "TEXTAREA") {
      before = ta.value.slice(ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1, ta.selectionStart);
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (r.collapsed && r.startContainer.nodeType === 3) {
          before = (r.startContainer.textContent || "").slice(0, r.startOffset);
        }
      }
    }
    const m = /\[\[([^\]\n]{0,32})$/.exec(before);
    if (m) Wiki.open(m[1]);
    else Wiki.close();
  };
  document.addEventListener("input", () => setTimeout(detect, 30), true);
  document.addEventListener("keyup", (ev) => {
    if (["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(ev.key) || ev.key === "[") setTimeout(detect, 30);
  }, true);
  document.addEventListener("selectionchange", () => setTimeout(detect, 60));
})();

function fillEditor(e) {
  $("e-title").value = e.title || "";
  $("e-cat").value = state.categories.some((c) => c.name === e.category) ? e.category : "";
  $("e-tags").value = (e.tags || []).join(", ");
  Editor.value = e.content || "";
}

// ---------------- 操作 ----------------
async function updateEntry() {
  const body = {
    id: state.selected,
    title: $("e-title").value.trim(),
    content: Editor.value,
    tags: $("e-tags").value.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
  };
  const cat = $("e-cat").value;
  if (cat) body.category = cat;
  const r = await API.post("/entry", body);
  if (!r.ok) return toast(`❌ ${r.error}`);
  await loadCategories();
  await loadEntries();
  await selectEntry(state.selected);
  toast("✓ 已保存");
}

// ---------------- 事件绑定 ----------------
$("mi-new").addEventListener("click", () => { $("side-menu").hidden = true; newEntry(); });
$("mi-pick-file").addEventListener("click", () => { $("side-menu").hidden = true; pickAndCollect(); });
$("mi-pick-url").addEventListener("click", () => { $("side-menu").hidden = true; collectUrlFlow(); });

async function newEntry() {
  const r = await API.post("/entry", { title: "未命名笔记", content: "", category: state.filter.category });
  if (!r.ok) return toast(`❌ ${r.error}`);
  await loadCategories();
  await loadEntries();
  await selectEntry(r.entry.id);
  const e = await API.get(`/entry?id=${encodeURIComponent(r.entry.id)}`);
  if (e.ok) fillEditor(e.entry);
  setEditMode(true);
  Wiki.refreshPool();
  $("e-title").select();
}

// ---------------- 详情页 ⋯ 菜单：低频操作收进来，头部只留高频 ----------------
function renderMoreMenu(entry) {
  $("mi-pin-home").dataset.on = entry.homePinned ? "1" : "";
  $("mi-pin-home").textContent = entry.homePinned ? "📍 取消首页固定" : "📌 固定到首页";
  $("mi-pin").dataset.on = entry.pinned ? "1" : "";
  $("mi-pin").textContent = entry.pinned ? "☆ 取消置顶" : "★ 在列表置顶";
}

function toggleMoreMenu(v) {
  $("more-menu").hidden = !v;
}

$("btn-more").addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleMoreMenu($("more-menu").hidden);
});
document.addEventListener("click", (ev) => {
  if (!$("more-menu")?.hidden && !ev.target.closest(".more-wrap")) toggleMoreMenu(false);
});

$("mi-pin-home").addEventListener("click", async () => {
  toggleMoreMenu(false);
  if (!state.selected) return;
  const now = !$("mi-pin-home").dataset.on;
  const r = await API.post("/entry", { id: state.selected, homePinned: now });
  if (!r.ok) return toast(`❌ ${r.error}`);
  renderMoreMenu(r.entry);
  toast(now ? "✓ 已固定到首页" : "✓ 已从首页取消固定");
});

$("mi-pin").addEventListener("click", async () => {
  toggleMoreMenu(false);
  if (!state.selected) return;
  const now = !$("mi-pin").dataset.on;
  const r = await API.post("/entry", { id: state.selected, pinned: now });
  if (!r.ok) return toast(`❌ ${r.error}`);
  renderMoreMenu(r.entry);
  toast(now ? "★ 已置顶" : "☆ 已取消置顶");
  await loadEntries();
});

// 层1：把一条收藏钉成一张独立卡（同一条只定位同一张；可拖到黑板/工作室页面多张并排）
$("mi-board").addEventListener("click", async () => {
  toggleMoreMenu(false);
  if (!state.selected) return;
  try {
    const r = await hana.cards.open("entry", { instanceKey: `e:${state.selected}` });
    toast(r?.existing ? "已定位到那张卡" : "✓ 已钉成卡片，可拖到黑板或工作室页面");
  } catch (err) {
    toast(`❌ 钉卡失败：${err?.message || err}`, 4500);
  }
});

// 层2：回到这条收藏所在的对话
$("v-meta").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("#meta-session");
  if (!btn || !state.selected) return;
  const cur = await API.get(`/entry?id=${encodeURIComponent(state.selected)}`);
  if (!cur.ok) return toast(`❌ ${cur.error}`);
  const ref = cur.entry.session || {};
  let sid = ref.sessionId || null;
  if (!sid && ref.sessionPath) {
    const res = await API.get(`/session/resolve?path=${encodeURIComponent(ref.sessionPath)}`);
    sid = res?.session?.sessionId || null;
  }
  if (!sid) return toast("这条收藏没有可定位的来源会话", 3200);
  try {
    await hana.sessions.focus({ sessionId: sid });
  } catch (err) {
    toast(`❌ 跳转失败：${err?.message || err}`, 4200);
  }
});

$("mi-copy").addEventListener("click", async () => {
  toggleMoreMenu(false);
  if (!state.selected) return;
  const r = await API.get(`/entry?id=${encodeURIComponent(state.selected)}`);
  if (!r.ok) return toast(`❌ ${r.error}`);
  const text = `# ${r.entry.title}\n\n${r.entry.content || ""}`;
  navigator.clipboard?.writeText(text).then(() => toast("✓ 全文已复制"), () => toast("复制失败，请手动选择复制"));
});

$("mi-export").addEventListener("click", async () => {
  toggleMoreMenu(false);
  if (!state.selected) return;
  const r = await API.get(`/entry?id=${encodeURIComponent(state.selected)}`);
  if (!r.ok) return toast(`❌ ${r.error}`);
  const e = r.entry;
  const meta = ["---",
    `id: ${JSON.stringify(e.id)}`,
    `title: ${JSON.stringify(e.title)}`,
    `type: ${JSON.stringify(e.type)}`,
    e.tags?.length ? `tags: ${JSON.stringify(e.tags)}` : "",
    e.source ? `source: ${JSON.stringify(e.source)}` : "",
    "---", ""].filter(Boolean).join("\n");
  const bytes = new TextEncoder().encode(meta + (e.content || ""));
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  try {
    await hana.resources.saveFile({ suggestedName: `${String(e.title).slice(0, 40) || e.id}.md`, mimeType: "text/markdown", contentBase64: btoa(bin) });
    toast("✓ 已导出为 .md 文件");
  } catch (err) {
    toast(`保存失败：${err?.message || err}`, 4500);
  }
});

$("mi-delete").addEventListener("click", () => {
  toggleMoreMenu(false);
  if (!state.selected) return;
  dialog({
    title: "删除这条收藏",
    bodyHtml: `<p>删除后文件会移到库里的 <code>_trash</code> 目录，需要时能手动找回。</p>`,
    okText: "删除",
    onOk: async () => {
      const r = await API.post("/entry/delete", { id: state.selected });
      if (!r.ok) { toast(`❌ ${r.error}`); return false; }
      await loadCategories();
      await loadEntries();
      await selectEntry(null);
      toast("✓ 已删除");
    },
  });
});

// ---------------- 侧栏顶栏菜单：低频功能收在这里，不占正文空间 ----------------
// 侧栏这个按钮现在只是「跳到首页待处理区」的快捷方式：
// 收件箱和待确认候选已经在首页合成一块了，不再有独立入口。
$("btn-clip-stage").addEventListener("click", () => { showHome(); });
$("btn-side-menu").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const m = $("side-menu");
  m.hidden = !m.hidden;
});
document.addEventListener("click", (ev) => {
  const menu = $("side-menu");
  if (menu && !menu.hidden && !ev.target.closest(".menu-wrap")) menu.hidden = true;
});
$("mi-storage").addEventListener("click", () => { $("side-menu").hidden = true; openStorageDialog(); });
$("mi-backup").addEventListener("click", () => { $("side-menu").hidden = true; openBackupDialog(); });
$("mi-settings").addEventListener("click", () => { $("side-menu").hidden = true; openAiSettings(); });
$("mi-rules").addEventListener("click", () => { $("side-menu").hidden = true; openRulesDialog(); });

$("btn-toggle").addEventListener("click", async () => {
  if ($("edit").hidden) {
    const r = await API.get(`/entry?id=${encodeURIComponent(state.selected)}`);
    if (!r.ok) return toast(`❌ ${r.error}`);
    fillEditor(r.entry);
    setEditMode(true);
    Wiki.refreshPool();
    Editor.focus();
  } else {
    setEditMode(false);
  }
});

$("btn-refresh").addEventListener("click", async () => {
  const r = await API.post("/rescan", {});
  if (!r.ok) return toast(`❌ ${r.error}`);
  await loadCategories();
  await loadEntries();
  if (state.selected) await selectEntry(state.selected);
  toast(`✓ 已重新扫描：${r.entries} 条`);
});
$("btn-back-side").addEventListener("click", () => appRoot.classList.add("show-side"));

$("btn-new-cat").addEventListener("click", () => {
  dialog({
    title: "新建分类",
    bodyHtml: `<input id="d-name" placeholder="分类名，例如 教资笔记"><input id="d-desc" placeholder="说明（可留空）">`,
    okText: "创建",
    onMount: () => $("d-name").focus(),
    onOk: async () => {
      const name = $("d-name").value.trim();
      if (!name) { toast("分类名不能为空"); return false; }
      const r = await API.post("/categories", { name, description: $("d-desc").value.trim() });
      if (!r.ok) { toast(`❌ ${r.error}`); return false; }
      await loadCategories();
      await selectCategory(r.name);
      toast(r.created ? "✓ 分类已创建" : "该分类已存在");
    },
  });
});

$("search").addEventListener("input", () => {
  state.filter.query = $("search").value.trim();
  clearTimeout($("search").timer);
  $("search").timer = setTimeout(loadEntries, 180);
});

$("edit").addEventListener("submit", async (e) => {
  e.preventDefault();
  await updateEntry();
});

$("btn-cancel").addEventListener("click", async () => {
  if (state.selected) await selectEntry(state.selected);
});

// ---------------- 存储位置与 OpenHanako AI 设置 ----------------
// ---------------- 底栏三个入口：存储 / 备份 / 设置 ----------------
function openStorageDialog() {
  const cur = state.root || "";
  dialog({
    title: "存储位置",
    bodyHtml:
      `<p class="muted">当前库的位置：<code>${escapeHtml(cur)}</code></p>` +
      `<p class="muted" style="margin-top:0">整个库就是一个文件夹，每个分类一个子文件夹，想手动备份直接拷这个文件夹也行。</p>` +
      `<input id="d-path" placeholder="绝对路径，例如 D:\\我的收藏" value="">` +
      `<div class="row" style="margin-bottom:6px"><button type="button" id="d-pick">浏览文件夹…</button><span class="grow"></span></div>` +
      `<div class="row" style="margin-bottom:8px">` +
        `<button type="button" id="d-fix-img" title="把正文里误存的宿主绝对地址还原成库内相对路径">🔧 修复图片链接</button>` +
        `<span class="grow"></span></div>` +
      `<label><input type="radio" name="d-mode" value="copy" checked> 把现有内容复制过去</label>` +
      `<label><input type="radio" name="d-mode" value="switch"> 只换位置，不复制（空库开始）</label>`,
    okText: "应用",
    onMount: () => {
      $("d-path").value = cur;
      $("d-pick").addEventListener("click", async () => {
        try {
          const picked = await hana.resources.pick({ mode: "directory" });
          const p = picked?.resources?.[0]?.path || picked?.resources?.[0]?.uri;
          if (p) $("d-path").value = String(p).replace(/^file:\/\//, "");
          else toast("没有选中文件夹");
        } catch (err) {
          toast(`打开选择器失败：${err?.message || err}`, 4000);
        }
      });
      // 老版本 bug 把 http://127.0.0.1:端口/.../_assets/x 存进了正文，
      // 端口一变就全废。这里给一个可点的修复入口。
      $("d-fix-img").addEventListener("click", async () => {
        const dry = await API.post("/assets/clean-urls", { dryRun: true });
        if (!dry.ok) return toast(`❌ ${dry.error}`, 5000);
        if (!dry.changed) return toast("✓ 正文里没有需要修的图片链接");
        const ok2 = await confirmBox(
          `发现 ${dry.changed} 篇笔记里存了宿主绝对地址`,
          `这些地址（http://127.0.0.1:端口/...）一旦端口变化就失效。` +
          `会把它们还原成库内相对路径（_assets/...）。\n\n` +
          `涉及：${(dry.titles || []).slice(0, 5).join("、")}${dry.changed > 5 ? " 等" : ""}`
        );
        if (!ok2) return;
        const r = await API.post("/assets/clean-urls", {});
        if (!r.ok) return toast(`❌ ${r.error}`, 5000);
        toast(`✓ 已修复 ${r.changed} 篇的图片链接`, 4000);
        if (state.selected) selectEntry(state.selected).catch(() => {});
      });
    },
    onOk: async () => {
      const path = $("d-path").value.trim();
      if (!path) { toast("请填写路径"); return false; }
      if (path === cur) { toast("✓ 未改动"); return; }
      const mode = document.querySelector('input[name="d-mode"]:checked')?.value || "copy";
      const r = await API.post("/location", { path, mode });
      if (!r.ok) { toast(`❌ ${r.error}`, 5000); return false; }
      state.root = r.root;
      await loadCategories();
      await selectCategory("");
      toast(r.copied ? `✓ 已搬家，复制了 ${r.copied} 条` : "✓ 已切换位置", 3500);
    },
  });
}

async function refreshClipStage() {
  const r = await Promise.resolve().then(() => API.get("/clip/stage")).catch(() => ({ items: [] }));
  const items = r.items || [];
  const badge = $("clip-stage-count");
  if (badge) { badge.textContent = items.length; badge.hidden = !items.length; }
  return items;
}

// 首页「待处理」区里的待确认候选。
// 以前它是侧栏一个独立入口、弹一个单独的对话框，和收件箱明显重复；
// 现在收件箱和候选合成一个待处理区，这里只负责渲染候选那一截。
// 空的时候整块不占位。
async function renderClipStageSlot() {
  const slot = $("clip-stage-slot");
  if (!slot) return;
  const items = await refreshClipStage();
  const sub = $("inbox-sub");
  if (sub) sub.textContent = items.length ? `待整理 · ${items.length} 条待确认` : "待整理";
  if (!items.length) { slot.innerHTML = ""; return; }
  slot.innerHTML =
    `<div class="clip-stage-box">` +
    `<div class="clip-stage-head"><span>⏳ 待确认收藏 <b>${items.length}</b></span>` +
    `<button class="link-btn" id="clip-stage-open">展开勾选 →</button></div>` +
    `<ul class="home-list">` + items.slice(0, 4).map((it) =>
      `<li><b>${escapeHtml(it.title)}</b><small>${escapeHtml(it.preview || "")}</small></li>`).join("") +
    (items.length > 4 ? `<li class="muted"><small>…还有 ${items.length - 4} 条</small></li>` : "") +
    `</ul></div>`;
  const openBtn = $("clip-stage-open");
  if (openBtn) openBtn.addEventListener("click", () => openClipStageDialog());
}

async function openClipStageDialog() {
  const items = await refreshClipStage();
  dialog({
    title: `📥 待确认收藏（${items.length}）`,
    bodyHtml: items.length ? `<div class="clip-stage-list">${items.map((it) => `<label class="clip-stage-item"><input type="checkbox" value="${escapeAttr(it.key)}" checked><span><b>${escapeHtml(it.title)}</b><small>${escapeHtml(it.preview || "")}<br>${escapeHtml(it.from || "对话")} · ${it.chars || 0} 字</small></span></label>`).join("")}</div><p class="muted">确认后 AI 会生成标题和标签，并收入「收件箱」。</p>` : `<p class="muted">暂时没有待确认内容。点击对话消息下方的「收入念念收藏夹」后，候选会出现在这里。</p>`,
    okText: "AI 整理并收入收件箱",
    onOk: async () => {
      const keys = [...$("m-body").querySelectorAll(".clip-stage-item input:checked")].map((x) => x.value);
      if (!keys.length) { toast("先勾选至少一条候选"); return false; }
      const res = await API.post("/clip/commit", { keys, category: "收件箱", auto: true });
      if (!res.ok) { toast(`❌ ${res.error}`, 4500); return false; }
      await refreshClipStage(); await loadCategories(); await loadEntries();
      toast(`✓ 已收藏 ${res.saved} 条到收件箱`);
    },
    onMount: () => {
      if (!items.length) $("m-ok").disabled = true;
      else $("m-ok").disabled = false;
    },
  });
}

// ---- 库规则（RULES.md）----
// 规则是家规：AI 按它办事。这里让人能看、能改。
async function openRulesDialog() {
  const r = await API.get("/rules");
  const rules = r.ok ? r.rules || "" : "";
  const exists = r.ok && r.exists;
  dialog({
    title: "📏 库规则",
    bodyHtml:
      (exists
        ? `<p class="muted">这些规则会随每次 AI 整理、问答一起读入。改完保存即生效。</p>`
        : `<p class="muted">这个库还没有规则文件。AI 目前自由发挥——想让它按你的规矩办事，就写一份。</p>`) +
      `<textarea id="d-rules" class="rules-editor" spellcheck="false" placeholder="# 家规&#10;&#10;比如：分类按使用场景分，不按内容类型分；标签 2~4 个；大文件只引用不复制。">${escapeHtml(rules)}</textarea>` +
      `<p class="muted" style="margin-top:6px">文件位置：<code>${escapeHtml(r.path || "RULES.md")}</code></p>`,
    okText: "保存",
    onOk: async () => {
      const txt = $("d-rules").value;
      const w = await API.post("/rules", { content: txt });
      if (!w.ok) { toast(`❌ ${w.error}`); return false; }
      toast("✓ 规则已保存，AI 下次整理就会按它办");
    },
    onMount: () => {
      const ta = $("d-rules");
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    },
  });
}

async function openBackupDialog() {
  const stat = await Promise.resolve().then(() => API.get("/status")).catch(() => ({}));
  const cloud = await Promise.resolve().then(() => API.get("/cloud/config")).catch(() => ({ config: null, spawnEnabled: false }));
  const cfg = cloud.config || { proto: "webdav", url: "", region: "", user: "", pass: "", enabled: false };
  dialog({
    title: "备份与恢复",
    bodyHtml:
      `<div class="backup-row">` +
      `<button type="button" id="btn-backup-export" class="primary">⬇ 导出备份</button>` +
      `<span class="muted">打包全部 ${(stat?.stats?.entries ?? state.categories.reduce((s, c) => s + c.count, 0))} 条收藏与图片，存成一个 .zip 到你选的位置</span>` +
      `</div>` +
      `<div class="backup-row">` +
      `<button type="button" id="btn-backup-import">⬆ 从备份恢复</button>` +
      `<span class="muted">选一个本应用导出的 .zip；恢复前会先给你看包里有什么</span>` +
      `</div>` +
      `<div class="backup-row">` +
      `<button type="button" id="btn-backup-snapshot">🗄 存一份到库内 _backup</button>` +
      `<span class="muted">不用选位置，直接落在库文件夹里，适合定期快照</span>` +
      `</div>` +
      `<details class="cloud-box"><summary>☁ WebDAV / S3 云端备份</summary>` +
      `<p class="muted">通过系统 curl 上传 zip。密码只存本机 App 设置，不写入收藏库备份。</p>` +
      `<label class="cloud-enable"><input id="cloud-enabled" type="checkbox"${cfg.enabled ? " checked" : ""}> 存快照时自动上传</label>` +
      `<select id="cloud-proto"><option value="webdav"${cfg.proto === "webdav" ? " selected" : ""}>WebDAV（坚果云 / NAS）</option><option value="s3"${cfg.proto === "s3" ? " selected" : ""}>S3 兼容（S3 / MinIO / R2）</option></select>` +
      `<input id="cloud-url" placeholder="服务地址（含桶或远程目录）" value="${escapeAttr(cfg.url || "")}">` +
      `<input id="cloud-region" placeholder="S3 区域，如 ap-east-1" value="${escapeAttr(cfg.region || "")}">` +
      `<input id="cloud-user" placeholder="账号 / Access Key" value="${escapeAttr(cfg.user || "")}">` +
      `<input id="cloud-pass" type="password" placeholder="密码 / Secret Key（留空保持原值）" value="">` +
      `<div class="backup-row"><button type="button" id="cloud-save">保存云备份设置</button><button type="button" id="cloud-upload" class="primary">立即上传</button><button type="button" id="cloud-download">下载并恢复…</button></div>` +
      `<p class="muted">${cloud.spawnEnabled ? "" : "⚠ 需要在 Hana「设置 → 安全 → 应用能力」授予 app/process.spawn，并重启 App。"}</p>` +
      `</details>` +
      `<p class="muted" style="margin-top:10px">云端恢复会先下载并预览，确认后才整体替换当前库。</p>`,
    okText: "关闭",
    onOk: () => {},
    onMount: () => {
      $("btn-backup-export").addEventListener("click", () => exportBackup());
      $("btn-backup-import").addEventListener("click", () => importBackup());
      $("btn-backup-snapshot").addEventListener("click", async () => {
        const r = await API.post("/backup/snapshot", {});
        if (!r.ok) return toast(`❌ ${r.error}`, 5000);
        toast(`✓ 已存快照：${(r.bytes / 1024).toFixed(0)}KB → ${r.path}`, 6000);
      });
      $("cloud-save").addEventListener("click", async () => {
        const oldPass = cfg.pass || "";
        const passInput = $("cloud-pass").value;
        const r = await API.post("/cloud/config", {
          enabled: $("cloud-enabled").checked,
          proto: $("cloud-proto").value,
          url: $("cloud-url").value,
          region: $("cloud-region").value,
          user: $("cloud-user").value,
          pass: passInput || (oldPass ? "••••••" : ""),
        });
        if (!r.ok) return toast(`❌ ${r.error}`, 4500);
        cfg.pass = oldPass || passInput;
        toast("✓ 云备份设置已保存");
      });
      $("cloud-upload").addEventListener("click", async () => {
        const save = await API.post("/cloud/config", {
          enabled: $("cloud-enabled").checked, proto: $("cloud-proto").value,
          url: $("cloud-url").value, region: $("cloud-region").value,
          user: $("cloud-user").value, pass: $("cloud-pass").value || (cfg.pass ? "••••••" : ""),
        });
        if (!save.ok) return toast(`❌ ${save.error}`, 4500);
        const r = await API.post("/cloud/upload", {});
        toast(r.ok ? `✓ 已上传 ${r.file}（${(r.bytes / 1024).toFixed(0)} KB）` : `❌ ${r.error}`, 5000);
      });
      $("cloud-download").addEventListener("click", async () => {
        const save = await API.post("/cloud/config", {
          enabled: $("cloud-enabled").checked, proto: $("cloud-proto").value,
          url: $("cloud-url").value, region: $("cloud-region").value,
          user: $("cloud-user").value, pass: $("cloud-pass").value || (cfg.pass ? "••••••" : ""),
        });
        if (!save.ok) return toast(`❌ ${save.error}`, 4500);
        const r = await API.post("/cloud/download", {});
        if (!r.ok) return toast(`❌ ${r.error}`, 5000);
        const pv = await API.post("/backup/import/preview", { contentBase64: r.contentBase64 });
        if (!pv.ok) return toast(`❌ 云端备份无效：${pv.error}`, 5000);
        showBackupImportPreview(r.contentBase64, pv, "云端备份");
      });
    },
  });
}

async function openAiSettings() {
  const aiRes = await API.get("/ai/status").catch(() => ({ ok: false }));
  const models = aiRes?.models || [];
  const aiSettings = aiRes?.settings || { modelPref: "auto", proactive: "high" };
  const modelOpts = [`<option value="auto"${aiSettings.modelPref === "auto" ? " selected" : ""}>✦ 自动用 OpenHanako 默认模型</option>`]
    .concat(models.map((m) => {
      const val = `${m.provider}::${m.id}`;
      return `<option value="${escapeAttr(val)}"${aiSettings.modelPref === val ? " selected" : ""}>${escapeHtml(m.provider)} / ${escapeHtml(m.name)}</option>`;
    })).join("");
  dialog({
    title: "AI 设置",
    bodyHtml:
      `<p style="font-weight:600;margin-bottom:4px">✦ 模型供应商</p>` +
      `<select data-role="ai-model" style="width:100%;margin-bottom:10px">${modelOpts}</select>` +
      `<p style="font-weight:600;margin-bottom:4px">💬 对话主动感知</p>` +
      `<select data-role="ai-proactive" style="width:100%">` +
      `<option value="high"${aiSettings.proactive === "high" ? " selected" : ""}>高：自动召回收藏 + 发现链接/干货时提醒入库</option>` +
      `<option value="normal"${aiSettings.proactive === "normal" ? " selected" : ""}>标准：仅对话前检索相关收藏作背景</option>` +
      `<option value="off"${aiSettings.proactive === "off" ? " selected" : ""}>关：仅手动收藏</option>` +
      `</select>` +
      `<p class="muted" style="margin-top:10px">“高”会把库里的标题与摘要注入对话上下文（收藏内容若含敌对文本有提示注入风险），介意请选“标准”。</p>`,
    okText: "保存",
    onOk: async () => {
      const modelSel = $("m-body").querySelector('[data-role="ai-model"]');
      const proactiveSel = $("m-body").querySelector('[data-role="ai-proactive"]');
      await API.post("/ai/settings", {
        modelPref: modelSel?.value || "auto",
        proactive: proactiveSel?.value || "high",
      }).catch(() => {});
      toast("✓ 设置已保存");
    },
  });
}

// ---------------- 备份与恢复 ----------------
async function exportBackup() {
  toast("正在打包整个库…", 3000);
  let buf;
  try {
    const res = await hana.api.fetch("/backup/export");
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `导出失败（${res.status}）`);
    buf = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return toast(`❌ ${e?.message || e}`, 4500);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `念念收藏备份-${stamp}.zip`;
  const b64 = uintToB64(buf);
  try {
    const r = await hana.resources.saveFile({ suggestedName: name, mimeType: "application/zip", contentBase64: b64 });
    const saved = r?.saved || r?.status === "saved" || r?.ok;
    if (saved) toast(`✓ 备份已导出：${name}（${(buf.length / 1024).toFixed(0)}KB）`, 4000);
    else toast(`已生成备份（${(buf.length / 1024).toFixed(0)}KB），保存结果由宿主确认`, 4000);
  } catch (e) {
    // 宿主 saveFile 不可用时降级：把包落进库旁的 _backup/ 并告知路径
    try {
      const snap = await API.post("/backup/snapshot", {});
      if (snap.ok) return toast(`⚠ 保存弹窗不可用，已存到库内：${snap.path}`, 6000);
    } catch { /* 下面统一报错 */ }
    toast(`❌ 保存失败：${e?.message || e}`, 5000);
  }
}

function uintToB64(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

async function importBackup() {
  let picked;
  try {
    picked = await hana.resources.pick({ mode: "file", accept: ["application/zip", ".zip"] });
  } catch (e) {
    return toast(`打不开文件选择器：${e?.message || e}`, 4000);
  }
  const ref = picked?.resources?.[0];
  if (!ref) return toast("没有选择文件");
  toast("读取备份包…", 2500);
  let b64 = "";
  try {
    const rd = await hana.resources.read({ resource: ref });
    const raw = rd?.contentBase64 || rd?.base64 || rd?.data;
    if (raw) b64 = raw;
    else if (typeof rd?.text === "string") {
      // 二进制读不出文本时给明确提示
      throw new Error("只读到了文本，请用本应用导出的 .zip 备份包");
    } else throw new Error("读不到文件内容");
  } catch (e) {
    return toast(`❌ 读文件失败：${e?.message || e}`, 5000);
  }
  const pv = await API.post("/backup/import/preview", { contentBase64: b64 });
  if (!pv.ok) return toast(`❌ ${pv.error}`, 5000);
  showBackupImportPreview(b64, pv, "备份");
}

function showBackupImportPreview(b64, pv, sourceLabel) {
  dialog({
    title: `确认恢复${sourceLabel}`, 
    bodyHtml:
      `<p>备份包里：</p>` +
      `<ul style="margin:4px 0 10px 18px;padding:0">` +
      `<li>分类 <strong>${pv.categories}</strong> 个：${escapeHtml((pv.categoriesList || []).join("、").slice(0, 120))}</li>` +
      `<li>条目 <strong>${pv.entries}</strong> 条${pv.assets ? `，附带图片/资源 ${pv.assets} 个` : ""}</li>` +
      `</ul>` +
      (() => {
        const nowCount = state.categories.reduce((s, c) => s + c.count, 0);
        return `<p style="color:var(--c-danger)">恢复会<strong>整体替换</strong>当前库（备份 ${pv.entries} 条 vs 现在 ${nowCount} 条）。建议先导出一份当前备份。</p>`;
      })(),
    okText: "确认恢复",
    onOk: async () => {
      const r = await API.post("/backup/import", { contentBase64: b64 });
      if (!r.ok) { toast(`❌ ${r.error}`, 5000); return false; }
      toast(`✓ 已恢复：${r.entries} 条 / ${r.categories} 个分类`, 4000);
      await loadStatus();
      await loadCategories();
      await selectCategory("");
    },
  });
}

// ---------------- ✨ AI 能力交互：单篇分析、编辑填充、收件箱整理、快速切换与问答 ----------------

// 1. 详情页「✨ AI 助手」：分析当前笔记并一键应用摘要/分类/标签/待办/双链
$("btn-ai-entry")?.addEventListener("click", async () => {
  if (!state.selected) return;
  const r = await API.get(`/entry?id=${encodeURIComponent(state.selected)}`);
  if (!r.ok) return toast(`❌ ${r.error}`);
  const e = r.entry;
  toast("✨ 正在调用 AI 分析笔记…", 4000);
  const res = await API.post("/ai/analyze", { title: e.title, content: e.content });
  if (!res.ok) return toast(`❌ ${res.error}`);

  const mergedTags = [...new Set([...(e.tags || []), ...(res.tags || [])])];
  dialog({
    title: `✨ AI 笔记助手 — 《${e.title}》`,
    bodyHtml:
      `<div class="ai-via">驱动引擎：${escapeHtml(res.via || "OpenHanako AI")}${res.warning ? `（${escapeHtml(res.warning)}）` : ""}</div>` +
      `<div class="ai-box">` +
      `<p><strong>📌 核心摘要：</strong>${escapeHtml(res.summary || "无")}</p>` +
      `<p><strong>🗂 建议分类：</strong>${escapeHtml(res.category)}　<strong>🏷 建议标签：</strong>${mergedTags.map((t) => `#${escapeHtml(t)}`).join(" ")}</p>` +
      (res.todos?.length ? `<p><strong>☑ 识别到的待办：</strong><br>${res.todos.map((t) => `• ${escapeHtml(t)}`).join("<br>")}</p>` : "") +
      (res.related?.length ? `<p><strong>🔗 关联库内笔记：</strong>${res.related.map((t) => `[[${escapeHtml(t)}]]`).join("、")}</p>` : "") +
      `</div>` +
      `<label><input type="checkbox" data-ai-opt="tags" checked> 应用推荐分类（${escapeHtml(res.category)}）与合并标签</label>` +
      `<label><input type="checkbox" data-ai-opt="summary" checked> 在正文开头插入 AI 核心摘要引用块</label>` +
      (res.todos?.length ? `<label><input type="checkbox" data-ai-opt="todos" checked> 在文末追加提取出的 ${res.todos.length} 项待办任务</label>` : "") +
      (res.related?.length ? `<label><input type="checkbox" data-ai-opt="related" checked> 在文末追加关联笔记双向链接</label>` : ""),
    okText: "一键应用所选",
    onOk: async () => {
      const box = $("m-body");
      const useTags = box.querySelector('[data-ai-opt="tags"]')?.checked;
      const useSummary = box.querySelector('[data-ai-opt="summary"]')?.checked;
      const useTodos = box.querySelector('[data-ai-opt="todos"]')?.checked;
      const useRelated = box.querySelector('[data-ai-opt="related"]')?.checked;

      let nextContent = e.content || "";
      if (useSummary && res.summary && !nextContent.includes("> **✨ AI 摘要**")) {
        nextContent = `> **✨ AI 摘要**：${res.summary}\n\n` + nextContent;
      }
      if (useTodos && res.todos?.length) {
        nextContent = nextContent.replace(/\s*$/, "") + `\n\n## AI 提取待办\n` + res.todos.map((t) => `- [ ] ${t}`).join("\n");
      }
      if (useRelated && res.related?.length) {
        nextContent = nextContent.replace(/\s*$/, "") + `\n\n**关联笔记**：` + res.related.map((t) => `[[${t}]]`).join(" · ");
      }
      const patch = { id: e.id, content: nextContent };
      if (useTags) {
        if (res.category) patch.category = res.category;
        patch.tags = mergedTags;
      }
      const u = await API.post("/entry", patch);
      if (!u.ok) { toast(`❌ 写入失败：${u.error}`); return false; }
      await loadCategories();
      await loadEntries();
      await selectEntry(e.id);
      toast("✨ 已应用 AI 整理结果");
    },
  });
});

// 2. 编辑态「✨ AI 智能填充」：根据当前草稿自动补全标题、分类、标签
$("btn-ai-edit")?.addEventListener("click", async () => {
  const curTitle = $("e-title").value.trim();
  const curBody = Editor.value;
  if (!curBody.trim() && !curTitle) return toast("请先输入一些正文内容");
  toast("✨ 正在分析草稿…", 3000);
  const res = await API.post("/ai/analyze", { title: curTitle === "未命名笔记" ? "" : curTitle, content: curBody });
  if (!res.ok) return toast(`❌ ${res.error}`);
  const existingTags = $("e-tags").value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  const merged = [...new Set([...existingTags, ...(res.tags || [])])];
  // 先把 AI 要改什么摆出来再动手：改字段是用户看不见的动作，不该一点就静悄悄生效。
  dialog({
    title: "✨ AI 智能填充",
    bodyHtml:
      `<div class="ai-via">驱动引擎：${escapeHtml(res.via || "OpenHanako AI")}</div>` +
      `<p><strong>它会改你草稿里的这几处：</strong></p>` +
      `<ul style="margin:4px 0 8px 18px;padding:0;font-size:13px">` +
      (res.title && res.title !== curTitle ? `<li>标题 → <strong>${escapeHtml(res.title)}</strong></li>` : "") +
      (res.category ? `<li>分类 → <strong>${escapeHtml(res.category)}</strong>${state.categories.some((c) => c.name === res.category) ? "" : " <span class='muted'>（库里没这个分类，保存时会新建）</span>"}</li>` : "") +
      (merged.length ? `<li>标签 → <strong>${merged.map((t) => `#${escapeHtml(t)}`).join(" ")}</strong>${existingTags.length ? " <span class='muted'>（合并你原有的）</span>" : ""}</li>` : "") +
      `</ul>` +
      `<p class="muted" style="font-size:12px">正文不会被改。填错了可以手动改，或取消不填。</p>`,
    okText: "应用",
    onOk: () => {
      if (res.title && !$("e-title").value.trim()) $("e-title").value = res.title;
      if (res.category && state.categories.some((c) => c.name === res.category)) $("e-cat").value = res.category;
      $("e-tags").value = merged.join(", ");
      toast(`✨ 已填充标题/分类/标签（${res.via || "AI"}）`);
    },
  });
});

// 3. 收件箱「✨ AI 整理收件箱」
// AI 整理：分析一个分类下的条目，给出分类/标签建议，勾选后批量归位。
// catName 传空或不传 = 收件箱（历史行为）；侧栏按钮删了以后，
// 入口改到右键菜单 + 收件箱行上的小按钮。
async function organizeInboxWithAI(catName = "") {
  const label = catName || "收件箱";
  toast(`✨ 正在分析${label}条目…`, 4000);
  const res = await API.post("/ai/organize-inbox", catName ? { category: catName } : {});
  if (!res.ok) return toast(`❌ ${res.error}`);
  const list = res.suggestions || [];
  if (!list.length) return toast(`📭 ${label}目前是空的`);

  dialog({
    title: `✨ AI 整理${label}（共 ${list.length} 条）`,
    bodyHtml:
      `<div class="ai-via">驱动引擎：${escapeHtml(res.via || "OpenHanako AI")}</div>` +
      `<div class="ai-box">` +
      list.map((s) =>
        `<div style="padding:6px 0;border-bottom:1px dashed var(--c-border)">` +
        `<label style="display:flex;gap:6px;align-items:baseline"><input type="checkbox" data-org-id="${escapeAttr(s.id)}" checked>` +
        `<span><strong>${escapeHtml(s.title)}</strong> → <span class="tag">${escapeHtml(s.category)}</span> ` +
        `${(s.tags || []).map((t) => `<span class="muted">#${escapeHtml(t)}</span>`).join(" ")}</span></label>` +
        `<div class="muted" style="font-size:11px;padding-left:20px">${escapeHtml(s.reason || "")}</div>` +
        `</div>`
      ).join("") +
      `</div>`,
    okText: "一键执行归位",
    onOk: async () => {
      const checkedIds = new Set(
        [...$("m-body").querySelectorAll("input[data-org-id]:checked")].map((el) => el.dataset.orgId)
      );
      let okCount = 0;
      for (const s of list) {
        if (!checkedIds.has(s.id)) continue;
        const u = await API.post("/entry", { id: s.id, category: s.category, tags: s.tags });
        if (u.ok) okCount++;
      }
      await loadCategories();
      await loadEntries();
      toast(`✨ 已自动归位整理 ${okCount} 条笔记`);
    },
  });
}

// ---- 收件箱动作：首页待处理区和卡片墙顶各有一份入口，逻辑共用 ----------
// 收件箱的卡片铺开就是 openWall("category","收件箱")，
// 但用户经常找不到入口，所以在两处都摆按钮。
function inboxWall() { openWall("category", "收件箱"); }

function inboxAI() { organizeInboxWithAI("收件箱"); }

async function inboxClear() {
  // 两步确认：先说明会先删条目，再说明回收站也会一起清。
  // 删其他分类时内容会回到收件箱，不清的话收件箱就成了永远清不掉的仓库。
  const inbox = state.categories.find((c) => c.name === "收件箱");
  const cnt = inbox?.count || 0;
  if (!cnt) return toast("收件箱已经是空的");
  const ok1 = await confirmBox("清空收件箱？",
    `收件箱里的 ${cnt} 条收藏会被删除。删除后会先移到库内 _trash 目录，这一步还能捞回来。`);
  if (!ok1) return;

  const r = await API.get(`/entries?category=${encodeURIComponent("收件箱")}&limit=500`);
  if (!r.ok) return toast(`❌ ${r.error}`);
  const ids = (r.entries || []).map((e) => e.id);
  if (!ids.length) return toast("收件箱已经是空的");
  const b = await API.post("/entries/batch", { op: "delete", ids });
  if (!b.ok) return toast(`❌ ${b.error}`);

  // 问一句要不要连回收站一起清。用户原话：「清空了就不再存在里面了」
  const ok2 = await confirmBox("顺便清空回收站？",
    `刚刚删的 ${b.done} 条现在在库内 _trash 目录。清空后就无法恢复了；不清的话以后还能从备份里找回来。`);
  if (ok2) {
    const p = await API.post("/trash/purge", {});
    if (!p.ok) return toast(`⚠ 已删除 ${b.done} 条，但回收站清空失败：${p.error}`);
    toast(`✓ 已清空收件箱并彻底删除 ${p.purged} 条`);
  } else {
    toast(`✓ 已清空收件箱（${b.done} 条移入回收站）`);
  }
  await loadCategories();
  await loadEntries();
  await loadHome();
  // 如果当前正停留在收件箱的墙上，把墙也刷一遍
  if (!$("wall").hidden) openWall(wallKind, wallValue);
}

// 首页那三个按钮
$("btn-inbox-wall").addEventListener("click", inboxWall);
$("btn-inbox-ai").addEventListener("click", inboxAI);
$("btn-inbox-clear").addEventListener("click", inboxClear);

// 卡片墙顶那两个（铺开卡片在墙里没意义，墙上已经有卡片了）
$("btn-wall-inbox-ai").addEventListener("click", inboxAI);
$("btn-wall-inbox-clear").addEventListener("click", inboxClear);

// ============ 资源类收藏：收录 / 显示 / 打开 ============
// 资源不复制进库，只存 meta.ref 指向原件。
// 三类入口：拖拽到面板、对话框选路径、粘贴网址。

// 把拖进来的 File 收录成一条收藏。
// 注意：浏览器给的 File 拿不到真实磁盘路径，所以这里存的是「文件名 + 大小 + mime」，
// 用户之后要用系统应用打开时，走的是 hana.resources.pick 重新定位——
// 这是 Web 环境的硬限制，不是我们偷懒。
async function collectDroppedFile(file) {
  const ext = (file.name.match(/\.(\w{1,8})$/) || [])[1] || "";
  const type = typeOfExt(ext);
  const r = await API.post("/ref/collect", {
    target: file.name,
    type,
    title: file.name,
    category: state.filter.category || "",
    content: "",
  });
  if (!r.ok) { toast(`❌ ${file.name}：${r.error}`); return null; }
  // 补上浏览器能拿到的元信息
  await API.post("/entry", {
    id: r.entry.id,
    ref: { kind: "path", target: file.name, size: file.size, mime: file.type || null },
  });
  return r.entry;
}

// 用宿主的选择器选文件/文件夹，收录进去
async function pickAndCollect() {
  let picked = null;
  try {
    picked = await hana.resources.pick({ multiple: false });
  } catch (err) {
    toast(`❌ 无法打开选择器：${err?.message || err}`, 4500);
    return;
  }
  const res = picked?.resources?.[0];
  if (!res?.path) return toast("没有选中文件");
  const r = await API.post("/ref/collect", {
    target: res.path,
    category: state.filter.category || "",
  });
  if (!r.ok) return toast(`❌ ${r.error}`);
  toast(`✓ 已收藏 ${r.entry.title}`);
  await loadCategories();
  await loadEntries();
  await refreshTree();
  renderCategories();
}

// 粘贴网址收录
async function collectUrlFlow() {
  const url = (await promptText("收藏网页", "", "https://…"))?.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) return toast("❌ 请输入以 http(s):// 开头的网址");

  // 1) 先抓正文。抓不到不阻塞——退化成只存链接，但要说清楚。
  toast("⏳ 正在抓取网页正文…", 2500);
  let ex = null;
  try {
    const r = await API.post("/article/extract", { url });
    if (r.ok) ex = r;
    else toast(`⚠ 抓不到正文：${r.error}`, 6000);
  } catch (err) { toast(`⚠ 抓取出错：${err?.message || err}`, 6000); }

  // 2) 预览 + 可编辑标题/分类/标签。用户看过内容再决定存不存。
  const catOpts = state.categories.map((x) =>
    `<option value="${escapeAttr(x.name)}"${x.name === (state.filter.category || "收件箱") ? " selected" : ""}>${escapeHtml(x.name)}</option>`).join("");
  const preview = ex
    ? `<div class="clip-meta">` +
      (ex.siteName ? `<span>来源：${escapeHtml(ex.siteName)}</span>` : "") +
      (ex.author ? `<span>作者：${escapeHtml(ex.author)}</span>` : "") +
      (ex.published ? `<span>发布：${escapeHtml(String(ex.published).slice(0, 10))}</span>` : "") +
      `<span>正文 ${ex.chars} 字${ex.truncated ? "（已截断）" : ""}</span>` +
      `</div>` +
      (ex.thin ? `<p class="clip-warn">⚠ 提取到的正文很短，可能是登录墙或动态页面——可以先存链接，再手动补内容。</p>` : "") +
      `<div class="clip-preview md">${renderMarkdown(ex.markdown.slice(0, 4000))}</div>` +
      (ex.markdown.length > 4000 ? `<p class="muted">…预览只显示前 4000 字，入库会存全文。</p>` : "")
    : `<p class="clip-warn">没能抓到正文，将只保存链接。你可以现在取消，换个时间再试。</p>`;

  const dlg = await new Promise((resolve) => {
    let settled = false;
    const once = (v) => { if (!settled) { settled = true; resolve(v); } };
    dialog({
      title: "🔗 收藏网页",
      bodyHtml:
        `<div class="clip-url">${escapeHtml(url)}</div>` + preview +
        `<div class="clip-fields">` +
        `<input id="clip-title" class="m-input" value="${escapeAttr(ex?.title || new URL(url).hostname)}" placeholder="标题">` +
        `<select id="clip-cat" class="m-input">${catOpts}</select>` +
        `<input id="clip-tags" class="m-input" placeholder="标签，逗号分隔">` +
        `</div>`,
      okText: "存入库",
      onOk: () => once({
        title: $("clip-title").value.trim(),
        category: $("clip-cat").value,
        tags: $("clip-tags").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      }),
      onClose: () => once(null),
    });
  });
  if (!dlg) return;

  // 3) 入库。有正文就走 /entry 存完整内容；抓不到才退回只存链接。
  if (ex) {
    const r = await API.post("/entry", {
      title: dlg.title || ex.title || url,
      content: buildClipBody(url, ex, dlg.tags),
      category: dlg.category || "收件箱",
      tags: dlg.tags,
      type: "link",
      source: "网页",
      extra: { ref: { kind: "url", target: url, host: new URL(url).hostname } },
    });
    if (!r.ok) return toast(`❌ ${r.error}`);
    toast(`✓ 已收藏《${r.entry.title}》，正文 ${ex.chars} 字`);
  } else {
    const r = await API.post("/ref/collect-url", { url, category: dlg.category || "", title: dlg.title, tags: dlg.tags });
    if (!r.ok) return toast(`❌ ${r.error}`);
    toast(`✓ 已收藏链接 ${r.entry.title}`);
  }
  await loadCategories();
  await loadEntries();
  renderCategories();
}

// 剪藏正文：用户备注 + 元信息 + 正文 + 原文链接。
// 和 lib/article.js 的 buildClipContent 一个形态，那边是给 Node 侧用的。
function buildClipBody(url, ex, tags) {
  const L = [];
  if (tags && tags.length) L.push(`标签：${tags.join(" / ")}`, "");
  if (ex.description) L.push(`> ${ex.description}`, "");
  const metas = [];
  if (ex.siteName) metas.push(`**来源**：${ex.siteName}`);
  if (ex.author) metas.push(`**作者**：${ex.author}`);
  if (ex.published) metas.push(`**发布时间**：${String(ex.published).slice(0, 10)}`);
  if (metas.length) L.push(metas.join(" · "), "");
  L.push("---", "", ex.markdown || "（没能提取到正文，只存了链接）", "", "---", "", `原文链接：${url}`);
  return L.join("\n");
}

// 打开原件：本地文件走宿主 external.open，网址走浏览器
async function openRef(id) {
  const r = await API.post("/ref/open", { id });
  if (!r.ok) return toast(`❌ ${r.error}`, 5000);
  try {
    if (r.url) await hana.ui.external.open({ url: r.url });
    else await hana.ui.external.open({ path: r.path });
  } catch (err) {
    toast(`❌ 打不开：${err?.message || err}`, 5000);
  }
}

// 卡片上的资源角标：按类型给一行小字，说明这是什么、多大、在哪儿
function refBadge(e) {
  const ref = e.ref;
  if (!ref) return "";
  // 引用网页：显示域名，前面标「网页」
  if (ref.kind === "url") return `🔗 网页 · ${ref.host || ""}`;
  // 本机引用：重点标出来"只是记着位置，没搬进库"
  if (ref.kind === "path") {
    if (ref.missing) return "⚠ 原件已失效（可能被移动或删除）";
    const bits = [];
    bits.push("🔗 本机引用");
    if (e.type === "folder" && ref.children) {
      bits.push(`${ref.children.count} 项`);
      if (ref.children.size) bits.push(fmtSize(ref.children.size));
    } else if (ref.size != null) bits.push(fmtSize(ref.size));
    return bits.join(" · ");
  }
  // kind 只可能是 path 或 url，走到这里说明数据形状意外，不硬编
  return "";
}

function fmtSize(n) {
  // null/undefined 是"未知大小"（外部文件 stat 失败时），不是 0 字节
  if (n === null || n === undefined || n === "") return "—";
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---- 资源查看器：按类型给不同的展示 --------------------------------
// 图片露大图，影音给播放器，文件夹列结构，网页给预览框。
// 一律带「打开原件」按钮：iframe 里放不开的东西交给系统应用。
function renderRefView(e) {
  const box = $("ref-view");
  if (!box) return;
  const ref = e.ref;
  // 非资源类或没有引用：收起，不占位
  if (!ref || !["image", "video", "audio", "folder", "file", "link"].includes(e.type)) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  const openBtn = `<button class="small" data-ref-open="${escapeAttr(e.id)}">${ref.kind === "url" ? "🌐 打开网页" : "📂 打开原件"}</button>`;
  const locLine = ref.kind === "url"
    ? `<div class="ref-loc">${escapeHtml(ref.host || "")} · <a href="${escapeAttr(ref.target)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ref.target)}</a></div>`
    : `<div class="ref-loc">${ref.missing ? "<b class=\"ref-lost\">原件已失效或已被移动</b>" : "位置"} ${ref.target ? escapeHtml(ref.target) : ""}</div>`;

  let body = "";
  if (ref.missing) {
    body = `<div class="ref-empty">${icon("trash", 22)}<p>找不到原件了。文件被移动、重命名或删除时会出现这个。</p><p class="muted">这条收藏的标题、标签、笔记都还在，只有链接失效。</p></div>`;
  } else if (e.type === "image") {
    // 库内上传的图片走 /asset 路由；本地引用的图片 iframe 读不到 file://，只能给按钮
    if (ref.target && ref.target.startsWith("_assets/")) {
      body = `<img class="ref-img" src="${assetUrl(ref.target)}" alt="${escapeAttr(e.title)}">`;
    } else {
      body = `<div class="ref-empty">${icon("image", 22)}<p>浏览器里读不到本地图片文件，点下面的按钮用系统应用打开。</p></div>`;
    }
  } else if (e.type === "video" || e.type === "audio") {
    body = `<div class="ref-empty">${icon(TYPE_ICONS[e.type] || "file", 22)}<p>${TYPE_LABEL[e.type] || "媒体"}文件在本地，${ref.size != null ? `大小 ${fmtSize(ref.size)}` : "大小未知"}。</p><p class="muted">iframe 里播放不了本地媒体文件，点下面的按钮用系统播放器打开。</p></div>`;
  } else if (e.type === "folder") {
    const c = ref.children || { count: 0, size: 0, byType: {}, children: [] };
    const dist = Object.entries(c.byType || {}).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<span class="ref-dist-item">${icon(TYPE_ICONS[t] || "file", 13)} ${escapeHtml(t)} <b>${n}</b></span>`).join("");
    const list = (c.children || []).slice(0, 60).map((k) =>
      `<li><span class="ref-k-ic">${icon(TYPE_ICONS[k.type] || "file", 13)}</span><span class="ref-k-n">${escapeHtml(k.name)}</span><span class="ref-k-s">${k.size ? fmtSize(k.size) : k.count ? `${k.count} 项` : ""}</span></li>`).join("");
    body = `<div class="ref-folder">
      <div class="ref-folder-stat"><b>${c.count}</b> 项 · ${fmtSize(c.size || 0)}<span class="grow"></span><button class="small" data-ref-restat="${escapeAttr(e.id)}">↻ 刷新结构</button></div>
      <div class="ref-dist">${dist}</div>
      <ul class="ref-kids">${list || '<li class="muted">空文件夹</li>'}</ul>
      ${(c.children || []).length > 60 ? `<p class="muted">只显示前 60 项，共 ${c.count} 项</p>` : ""}
    </div>`;
  } else if (e.type === "link") {
    body = `<div class="ref-empty">${icon("link", 22)}<p>网页收藏。点下面的按钮在浏览器里打开。</p><p class="muted">这一版只存网址和域名，还不抓标题和快照。</p></div>`;
  } else {
    body = `<div class="ref-empty">${icon("file", 22)}<p>文件${ref.size != null ? `，大小 ${fmtSize(ref.size)}` : ""}${ref.mime ? `，${escapeHtml(ref.mime)}` : ""}。</p><p class="muted">iframe 里打不开，用下面的按钮交给系统应用。</p></div>`;
  }

  box.innerHTML =
    `<div class="ref-head"><span class="ref-type">${icon(TYPE_ICONS[e.type] || "file", 15)}</span>` +
    `<span class="ref-title">${escapeHtml(e.title)}</span><span class="grow"></span>${openBtn}</div>` +
    locLine + body;

  box.querySelector("[data-ref-open]")?.addEventListener("click", () => openRef(e.id));
  box.querySelector("[data-ref-restat]")?.addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    const r = await API.post("/ref/restat", { id: e.id });
    ev.target.disabled = false;
    if (!r.ok) return toast(`❌ ${r.error}`);
    toast(`✓ 已刷新：${r.children.count} 项`);
    await selectEntry(e.id);
  });
}

// ---- 资源查看器 END ----

// ============ 资源类收藏 END ============

// ============ 文件管理器 ============
// 列表形态而非卡片墙：文件管理要的是操作密度（重命名/删除/看引用），
// 一屏 20+ 行；卡片墙一屏 6 张，找个文件要滚很久。
// 库外引用（D:\xxx）也在这里显示，标成"库外"。
let filesDir = "";        // 当前所在目录，相对 _assets，空 = 根
let filesSel = "";        // 单选选中的文件/目录 rel 路径
let filesItems = [];      // 当前层内容
let filesPicked = new Set(); // 多选：勾选的 rel 路径
let filesPickMode = false;    // 多选模式：开着时常驻显示复选框
let filesMode = localStorage.getItem("nv.filesMode") || "list"; // list | grid

// ---- 库外目录浏览：复用文件管理器自身的渲染 ----
// 关键：不另写一套 UI。外部目录的内容直接喂给 filesItems，
// 由 renderFiles 同一套代码渲染，所以卡片外观、点击、多选全都一致。
// 用户原话：要和我们自己建立的文件夹一样，点击后是正常的文件管理器行为。
let extCtx = null;   // { root, sub, path, parent } | null

async function openExtDir(root, sub = "") {
  const r = await API.get(`/assets/browse?target=${encodeURIComponent(root)}&sub=${encodeURIComponent(sub || "")}`);
  if (!r.ok) return toast(`❌ ${r.error}`, 5000);
  extCtx = { root: r.root, sub: sub || "", path: r.path, parent: r.parent };
  // 转成和库内完全一致的条目形状（path 用绝对路径，另加 external 标记）
  filesItems = (r.items || []).map((f) => ({
    name: f.name,
    path: f.path,
    isDir: !!f.isDir,
    type: f.type || (f.isDir ? "folder" : "file"),
    size: f.size ?? null,
    mtime: f.mtime || null,
    external: true,
  }));
  filesDir = "";
  filesSel = "";
  filesPicked = new Set();
  filesPickMode = false;
  showView("files");
  setActive($("btn-home"), false);
  renderFilesModeBtns();
  renderFiles();      // ← 用库内那套渲染
}

function exitExtDir() {
  extCtx = null;
  filesItems = [];
  loadFiles();
}

async function openFiles(rel = "") {
  filesDir = rel || "";
  filesSel = "";
  filesPicked = new Set();
  // 每次进文件管理器都退出多选模式。
  // 不重置的话：点过一次「☑ 多选」→ 之后无论进出多少次都还是多选态，
  // 复选框一直挂在每行上，而按钮高亮早丢了，用户以为没进多选（就是这样被反馈的）。
  filesPickMode = false;
  showView("files");
  setActive($("btn-home"), false);
  renderFilesModeBtns();
  await loadFiles();
}

async function loadFilesTo(rel) {
  filesDir = rel || "";
  filesSel = "";
  filesPicked = new Set();
  filesPickMode = false;   // 换目录同样退出多选，避免残留
  await loadFiles();
}

async function loadFiles() {
  const r = await API.get(`/assets/list?rel=${encodeURIComponent(filesDir)}`);
  if (!r.ok) { toast(`❌ ${r.error}`); return; }
  filesItems = r.items || [];
  renderFiles();
}

function renderFiles() {
  // 面包屑
  if (extCtx) {
    // 库外目录：显示「库文件 / 本机:路径/子路径」
    const segs = String(extCtx.sub || "").split("/").filter(Boolean);
    const crumbs = [`<button data-ext-exit="1">📁 库文件</button>`];
    const rootName = String(extCtx.root).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || extCtx.root;
    crumbs.push(`<span class="crumb-sep">/</span><button data-ext-root="1">💻 ${escapeHtml(rootName)}</button>`);
    let acc = "";
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : s;
      crumbs.push(`<span class="crumb-sep">/</span><button data-ext-sub="${escapeAttr(acc)}">${escapeHtml(s)}</button>`);
    }
    $("files-crumbs").innerHTML = crumbs.join("");
    const exit = $("files-crumbs").querySelector("[data-ext-exit]");
    if (exit) exit.addEventListener("click", () => exitExtDir());
    const rootB = $("files-crumbs").querySelector("[data-ext-root]");
    if (rootB) rootB.addEventListener("click", () => openExtDir(extCtx.root, ""));
    for (const b of $("files-crumbs").querySelectorAll("[data-ext-sub]")) {
      b.addEventListener("click", () => openExtDir(extCtx.root, b.dataset.extSub));
    }
    const subEl = $("files-sub");
    if (subEl) subEl.textContent = `💻 本机 · ${extCtx.path}`;
    renderFilesBody();
    return;
  }

  const parts = filesDir ? filesDir.split("/") : [];
  const crumbs = [`<button data-crumb="">📁 库文件</button>`];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    crumbs.push(`<span class="crumb-sep">/</span><button data-crumb="${escapeAttr(acc)}">${escapeHtml(p)}</button>`);
  }
  $("files-crumbs").innerHTML = crumbs.join("");
  for (const b of $("files-crumbs").querySelectorAll("[data-crumb]")) {
    b.addEventListener("click", () => loadFilesTo(b.dataset.crumb));
  }
  renderFilesBody();
}

// 真正画列表的部分（库内/库外共用）
function renderFilesBody() {

  const totalSize = filesItems.reduce((s, x) => s + (x.size || 0), 0);
  // 外部目录时保留"本机 · 路径"，别被"几项"覆盖掉
  if (!extCtx) {
    $("files-sub").textContent = filesItems.length ? `${filesItems.length} 项 · ${fmtSize(totalSize)}` : "空";
  }
  renderFilesBatchBar();
  renderFilesModeBtns();

  if (!filesItems.length) {
    $("files-list").innerHTML =
      `<div class="files-empty">${icon("folder", 30)}<p>这个文件夹是空的。</p>` +
      `<p class="muted">点右上角「🔗 引用已有」把本机的文件夹收进来，或「⬆ 上传」放新文件。</p></div>`;
    return;
  }

  const rowHtml = (f) => {
    const picked = filesPicked.has(f.path);
    const sel = f.path === filesSel ? " selected" : "";
    // 类型色带：文件夹一种色，其余按类型分。一眼分出文件和目录，不用细看图标
    const tint = f.isDir ? "dir" : String(f.type || "file");
    const ic = f.isDir ? icon("folder", 16) : icon(TYPE_ICONS[f.type] || "file", 16);
    const meta = f.isDir
      ? `${f.count ?? 0} 项`
      : `${fmtSize(f.size)}${f.mtime ? ` · ${String(f.mtime).slice(0, 10)}` : ""}`;
    const showCb = filesPickMode || picked;
    const extCls = f.external ? " frow-local" : "";
    const extMark = f.external ? ' <b class="ext-badge">本机</b>' : "";
    const extAttr = f.external ? ` data-ext="1" data-ext-id="${escapeAttr(f.extId || "")}"` : "";
    return `<div class="frow frow-${tint}${sel}${picked ? " picked" : ""}${showCb ? " cb-on" : ""}${extCls}" data-fp="${escapeAttr(f.path)}" data-dir="${f.isDir ? "1" : "0"}"${extAttr} draggable="${f.external ? "false" : "true"}">` +
      `<input type="checkbox" class="frow-cb" data-cb="${escapeAttr(f.path)}"${picked ? " checked" : ""} title="勾选后可批量操作">` +
      `<span class="frow-ic">${ic}</span>` +
      `<span class="frow-n">${escapeHtml(f.name)}${extMark}</span>` +
      `<span class="frow-t">${escapeHtml(f.isDir ? (f.external ? "本机文件夹" : "文件夹") : TYPE_LABEL[f.type] || "文件")}</span>` +
      `<span class="frow-m">${escapeHtml(meta)}</span>` +
      `<span class="frow-r" data-refs="${escapeAttr(f.path)}"></span>` +
      `</div>`;
  };

  const gridHtml = (f) => {
    const picked = filesPicked.has(f.path);
    const tint = f.isDir ? "dir" : String(f.type || "file");
    const thumb = !f.isDir && f.type === "image"
      ? `<img class="fg-thumb" data-asset="${escapeAttr(f.path)}" loading="lazy" alt="">`
      : `<span class="fg-ic">${f.isDir ? icon("folder", 26) : icon(TYPE_ICONS[f.type] || "file", 26)}</span>`;
    const showCb = filesPickMode || picked;
    const extCls = f.external ? " fgrid-local" : "";
    const extAttr = f.external ? ` data-ext="1" data-ext-id="${escapeAttr(f.extId || "")}"` : "";
    return `<div class="fgrid fgrid-${tint}${picked ? " picked" : ""}${showCb ? " cb-on" : ""}${extCls}" data-fp="${escapeAttr(f.path)}" data-dir="${f.isDir ? "1" : "0"}"${extAttr} draggable="${f.external ? "false" : "true"}">` +
      `<input type="checkbox" class="frow-cb" data-cb="${escapeAttr(f.path)}"${picked ? " checked" : ""}>` +
      thumb +
      `<span class="fg-n" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}${f.external ? ' <b class="ext-badge">本机</b>' : ""}</span>` +
      `<span class="fg-m">${f.isDir ? `${f.count ?? 0} 项` : fmtSize(f.size)}</span>` +
      `</div>`;
  };

  const box = $("files-list");
  box.className = filesMode === "grid" ? "files-list files-grid" : "files-list";
  const html = (f) => (filesMode === "grid" ? gridHtml(f) : rowHtml(f));
  box.innerHTML = filesItems.map(html).join("");
  paintAssetImages(box);

  for (const row of box.querySelectorAll("[data-fp]")) {
    const fp = row.dataset.fp;
    const isDir = row.dataset.dir === "1";
    const cb = row.querySelector(".frow-cb");
    if (cb) {
      cb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        togglePick(fp, !filesPicked.has(fp));
      });
    }
    let clickTimer = null;
    const isExternal = !!filesItems.find((x) => x.path === fp)?.external;
    row.addEventListener("click", (ev) => {
      // Ctrl/Shift 点 = 多选（外部目录不支持批量操作，直接忽略）
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
        if (isExternal) return;
        togglePick(fp, !filesPicked.has(fp));
        return;
      }
      selectFile(fp);
      if (filesPickMode) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        if (isExternal) {
          if (!isDir) {
            // 库外文件也先试面板内预览，装不下（比如 .exe）再交给系统。
            // 之前这里直接 openWithSystem，等于把预览能力关在库外了。
            const meta = filesItems.find((x) => x.path === fp);
            if (canPreviewInline(fp, meta)) { previewAsset(fp, meta); return; }
            openWithSystem(fp);
            return;
          }
          // 文件夹。两种情形：
          //   a) 已经在某个外部目录内部（extCtx 有值）→ 相对它算子路径
          //   b) 在库内根列表里点的外部快捷方式（extCtx 为 null）→ 它自己就是根
          // 之前没区分，直接读 extCtx.root 会抛 null。
          if (extCtx && extCtx.root) {
            const rootNorm = String(extCtx.root).replace(/[\\/]+$/, "").replace(/\\/g, "/");
            let rel = String(fp).replace(/\\/g, "/");
            if (rel.startsWith(rootNorm)) rel = rel.slice(rootNorm.length).replace(/^\/+/, "");
            openExtDir(extCtx.root, rel);
          } else {
            // 根列表里的外部条目：fp 就是那个引用的绝对路径
            openExtDir(fp, "");
          }
          return;
        }
        if (isDir) loadFilesTo(fp);
        else previewAsset(fp, filesItems.find((x) => x.path === fp));
      }, 180);
    });
    row.addEventListener("dblclick", () => {
      clearTimeout(clickTimer);                // 双击不重复弹
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      selectFile(fp);
      // 外部条目：菜单不一样（不能重命名/删除库里的，只能取消引用）
      const item = filesItems.find((x) => x.path === fp);
      if (item?.external) return extRowMenu(ev, item);
      fileRowMenu(ev, fp, isDir);
    });
    // 拖拽：文件行 → 文件夹行 = 移动
    row.addEventListener("dragstart", (ev) => {
      const srcs = filesPicked.size ? [...filesPicked] : [fp];
      ev.dataTransfer.setData("text/plain", JSON.stringify(srcs));
      ev.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    if (isDir) {
      row.addEventListener("dragover", (ev) => { ev.preventDefault(); row.classList.add("drop-on"); });
      row.addEventListener("dragleave", () => row.classList.remove("drop-on"));
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove("drop-on");
        let srcs = [];
        try { srcs = JSON.parse(ev.dataTransfer.getData("text/plain") || "[]"); } catch {}
        if (!srcs.length) return;
        moveAssetsFlow(srcs, fp);
      });
    }
  }

  // 空白处松开 = 移到当前层
  box.addEventListener("dragover", (ev) => ev.preventDefault());
  box.addEventListener("drop", (ev) => {
    if (ev.target !== box) return;
    ev.preventDefault();
    let srcs = [];
    try { srcs = JSON.parse(ev.dataTransfer.getData("text/plain") || "[]"); } catch {}
    if (srcs.length) moveAssetsFlow(srcs, filesDir || "_assets");
  });

  // 引用数异步填，不阻塞渲染
  for (const cell of box.querySelectorAll("[data-refs]")) {
    const pp = cell.dataset.refs;
    API.get(`/assets/refs?rel=${encodeURIComponent(pp)}`).then((r) => {
      const k = r.ok ? (r.refs || []).length : 0;
      cell.innerHTML = k ? `<button class="frow-ref" title="被 ${k} 篇笔记引用，点开看是哪几篇">📎 ${k}</button>` : "";
      const b = cell.querySelector(".frow-ref");
      if (b) b.addEventListener("click", (ev) => { ev.stopPropagation(); showRefs(pp); });
    }).catch(() => {});
  }
}

// ---- 多选 / 批量 ----
function togglePick(fp, on) {
  if (on) filesPicked.add(fp); else filesPicked.delete(fp);
  // 局部刷新勾选态，不重画整列（重画会打断拖拽和滚动）
  for (const el of $("files-list").querySelectorAll("[data-fp]")) {
    el.classList.toggle("picked", filesPicked.has(el.dataset.fp));
    const cb = el.querySelector(".frow-cb");
    if (cb) cb.checked = filesPicked.has(el.dataset.fp);
  }
  renderFilesBatchBar();
}

function renderFilesBatchBar() {
  const bar = $("files-batch");
  if (!bar) return;
  bar.hidden = filesPicked.size === 0;
  $("files-batch-n").textContent = `已选 ${filesPicked.size} 项`;
  const all = $("files-batch-all");
  if (all) all.checked = filesItems.length > 0 && filesItems.every((f) => filesPicked.has(f.path));
}

// 批量移动：选一批 → 问移到哪个文件夹 → 调 /assets/move
async function moveAssetsFlow(srcs, destRel) {
  const v = await API.get("/assets/list");
  if (!v.ok) return toast(`❌ ${v.error}`);
  // 只列文件夹当目标
  const dirs = (v.items || []).filter((x) => x.isDir);
  if (!dirs.length) return toast("库里还没有文件夹，先建一个");
  const opts = dirs.map((d) =>
    `<option value="${escapeAttr(d.path)}"${d.path === destRel ? " selected" : ""}>${escapeHtml(d.name)}（${d.count} 项）</option>`).join("");
  const sub = `<p class="muted">移动 ${srcs.length} 项到：</p><select id="m-dest" class="m-input">${opts}</select>` +
    `<p class="muted" style="margin-top:6px">正文里写死路径的引用（<code>![](_assets/旧名)</code>）会自动跟着改；<code>![[名]]</code> 按名字引用，不受影响。</p>`;
  dialog({
    title: "移动到文件夹",
    bodyHtml: sub,
    okText: "移动",
    onOk: async () => {
      const dest = $("m-dest").value;
      // 不能把文件夹移进自己/自己的子孙
      const bad = srcs.filter((s) => dest === s || dest.startsWith(s + "/"));
      if (bad.length) { toast(`❌ 不能把文件夹移进它自己里面：${bad[0].split("/").pop()}`); return false; }
      const r = await API.post("/assets/move", { paths: srcs, dest });
      if (!r.ok) { toast(`❌ ${r.error}`); return false; }
      filesPicked = new Set();
      await loadFiles();
      await refreshAssetIndex();
      const msg = [`✓ 已移动 ${r.moved} 项`];
      if (r.patched) msg.push(`${r.patched} 篇笔记的引用已跟着改`);
      if (r.failed?.length) msg.push(`${r.failed.length} 项失败`);
      toast(msg.join("，"), 4500);
      if (r.failed?.length) console.warn("[nian-vault] 移动失败明细", r.failed);
    },
  });
}

// 批量删除
async function deleteAssetsFlow(srcs) {
  const chk = await API.post("/assets/delete-batch", { paths: srcs });
  if (!chk.ok && !chk.needConfirm) return toast(`❌ ${chk.error}`);
  if (chk.needConfirm) {
    const names = (chk.refs || []).slice(0, 3).map((x) => `《${x.title}》`).join("、");
    const more = (chk.refs || []).length > 3 ? ` 等 ${chk.refs.length} 篇` : "";
    const yes = await confirmBox("删除选中的文件？",
      `其中一些被 ${names}${more} 引用着。删掉后那些笔记里的卡片会变成「文件不存在」，笔记本身不受影响。`);
    if (!yes) return;
    const r = await API.post("/assets/delete-batch", { paths: srcs, force: true });
    if (!r.ok) return toast(`❌ ${r.error}`);
    filesPicked = new Set();
    await loadFiles();
    await loadCategories();
    toast(`✓ 已删除 ${r.deleted} 项${r.failed?.length ? `，${r.failed.length} 项失败` : ""}`, 4000);
    if (r.failed?.length) console.warn("[nian-vault] 删除失败明细", r.failed);
    return;
  }
  const r = chk;
  filesPicked = new Set();
  await loadFiles();
  toast(`✓ 已删除 ${r.deleted ?? r.done?.length ?? 0} 项`, 4000);
}

// 视图切换
function renderFilesModeBtns() {
  // 按钮高亮必须和 filesPickMode 同步，否则出现"复选框显示但按钮没亮"的错位。
  $("btn-files-pick")?.classList.toggle("active", filesPickMode);

  const l = $("btn-files-list"), g = $("btn-files-grid");
  if (!l || !g) return;
  l.classList.toggle("active", filesMode !== "grid");
  g.classList.toggle("active", filesMode === "grid");
}

// 多选模式：开着时复选框常驻可见，关掉时靠悬停或 Ctrl 点。
function togglePickMode(force) {
  filesPickMode = force === undefined ? !filesPickMode : !!force;
  const b = $("btn-files-pick");
  if (b) b.classList.toggle("active", filesPickMode);
  // 关掉时清空已选，免得留着看不见的勾选让人以为还能批量操作
  if (!filesPickMode) filesPicked = new Set();
  renderFiles();
}

function setFilesMode(mode) {
  filesMode = mode;
  localStorage.setItem("nv.filesMode", mode);
  renderFiles();
}

// 引用本机已有的文件夹/文件：存引用不复制
// 问用户要引文件还是引文件夹。
// 为什么不直接让宿主选择器同时选两种：实测选目录时宿主会「进入下一级」，
// 拿不到目录本身（用户反馈的原话）。所以分开问，目录走可控的路。
function askRefKind() {
  return new Promise((resolve) => {
    let settled = false;
    const once = (v) => { if (!settled) { settled = true; resolve(v); } };
    dialog({
      title: "🔗 引用已有",
      bodyHtml:
        `<div class="refkind">
           <button type="button" class="refkind-btn" data-k="file">
             <span class="rk-ic">${icon("file", 22)}</span>
             <span class="rk-t">引用文件</span>
             <span class="rk-d">用系统选择器挑一个文件</span>
           </button>
           <button type="button" class="refkind-btn" data-k="dir">
             <span class="rk-ic">${icon("folder", 22)}</span>
             <span class="rk-t">引用文件夹</span>
             <span class="rk-d">用系统选择器挑一个目录，只记位置不复制</span>
           </button>
           <button type="button" class="refkind-btn" data-k="dirpath">
             <span class="rk-ic">${icon("folder", 22)}</span>
             <span class="rk-t">粘贴路径引用</span>
             <span class="rk-d">选择器用不了时，手动粘目录路径</span>
           </button>
           <button type="button" class="refkind-btn" data-k="vault">
             <span class="rk-ic">${icon("folder", 22)}</span>
             <span class="rk-t">引用库内文件夹</span>
             <span class="rk-d">从收藏夹自己的文件管理器里选</span>
           </button>
         </div>`,
      okText: "取消",
      onOk: () => once(null),
      onClose: () => once(null),
      onMount: () => {
        for (const b of $("m-body").querySelectorAll(".refkind-btn")) {
          b.addEventListener("click", () => { once(b.dataset.k); show($("modal"), false); });
        }
      },
    });
  });
}

// 从库内资源里挑一个文件夹引用。这条路完全可控——不依赖宿主选择器。
async function pickVaultDir() {
  let items = [];
  try {
    const r = await API.get("/assets/index");
    items = r.ok ? (r.items || []).filter((x) => x.isDir) : [];
  } catch { items = []; }
  if (!items.length) {
    toast("库里还没有文件夹，先去文件管理器建一个", 4500);
    return null;
  }
  return new Promise((resolve) => {
    let settled = false;
    const once = (v) => { if (!settled) { settled = true; resolve(v); } };
    dialog({
      title: "📂 选库内文件夹",
      bodyHtml: `<div class="refpick-list">` + items.map((x) =>
        `<button type="button" class="refpick" data-p="${escapeAttr(x.path)}">
           <span class="rp-ic">${icon("folder", 16)}</span>
           <span class="rp-n">${escapeHtml(x.name)}</span>
           <span class="rp-c">${x.count} 项</span>
         </button>`).join("") + `</div>`,
      okText: "取消",
      onOk: () => once(null),
      onClose: () => once(null),
      onMount: () => {
        for (const b of $("m-body").querySelectorAll(".refpick")) {
          b.addEventListener("click", () => {
            // 库内文件夹要走库内绝对路径，后端 collectRef 认这个
            once(b.dataset.p.replace(/^_assets\//, ""));
            show($("modal"), false);
          });
        }
      },
    });
  });
}

// ---- 本地文件的三种处理：引用 / 移进库 / 跳过 ----
// 用户的核心诉求：「不一定非要导入进去，能跳转或者打开相应文件就可以了」。
// 所以引用优先——只在正文里放一个指针，文件原地不动。

// 让用户在系统里挑一个文件，返回其绝对路径（不想用表单里的 File 对象，
// 因为 File 在 iframe 沙箱里拿不到真实路径）。
async function refLocalFile(fileObj) {
  try {
    const r = await hana.resources.pick({ mode: "file" });
    const first = r?.resources?.[0] || r?.[0] || null;
    const t = first?.path || first?.uri;
    if (!t) {
      toast("没有选中文件，已跳过", 3500);
      return null;
    }
    let out = String(t).replace(/^file:\/\//, "");
    try { out = decodeURIComponent(out); } catch {}
    return out;
  } catch (err) {
    toast(`打开选择器失败：${err?.message || err}`, 5000);
    return null;
  }
}

// 把"引用"插进正文：写成一个正文块，点了会去打开原件。
// 用自定义语法 [[@path:绝对路径]]，由 markdown 层渲染成块。
function insertRefBlock(absPath) {
  const name = String(absPath).split(/[\\/]/).pop() || absPath;
  // 记进库，才能在文件管理中心里出现（② 的要求）
  API.post("/ref/collect", {
    target: absPath,
    title: name,
    category: state.filter.category || "收件箱",
  }).then((r) => {
    if (!r.ok) toast(`⚠ 引用已插入，但没记进库：${r.error}`, 5000);
    else { loadCategories().catch(() => {}); refreshAssetIndex().catch(() => {}); }
  }).catch(() => {});
  Editor.insert(`[[@path:${absPath}|${name}]]`);
  toast(`✓ 已插入引用《${name}》（文件没搬动，点它能打开原件）`, 4000);
}

// 把文件搬到库里：走已有的上传接口（读 File 对象 → FormData）。
// 注意：File 对象拿得到内容但拿不到原路径，所以直接上传内容即可。
async function moveLocalIntoVault(fileObj) {
  try {
    const sub = filesSel ? filesSel.replace(/^_assets\//, "") : "";
    const fd = new FormData();
    fd.append("file", fileObj, fileObj.name);
    fd.append("subdir", sub);
    const res = await hana.api.fetch("/asset/upload", { method: "POST", body: fd });
    const j = await res.json();
    if (j?.path) { refreshAssetIndex().catch(() => {}); return j.path; }
    toast(`❌ 移进库失败：${j?.error || "未知原因"}`, 5000);
    return null;
  } catch (err) {
    toast(`❌ 移进库失败：${err?.message || err}`, 5000);
    return null;
  }
}

// 用宿主选择器挑目录。mode 的合法值见 SDK：
//   _ui-protocol.d.ts → PluginResourcePickInput.mode?: 'file' | 'directory' | string
// 只有 'directory' 会让选择器停在"选文件夹"而不是"进入文件夹"。
async function pickDirViaHost() {
  let lastErr = null;
  for (const arg of [{ mode: "directory" }, { mode: "directory", multiple: false }]) {
    try {
      const r = await hana.resources.pick(arg);
      const first = r?.resources?.[0] || r?.[0] || null;
      const t = first?.path || first?.uri;
      if (t) {
        let out = String(t).replace(/^file:\/\//, "");
        try { out = decodeURIComponent(out); } catch {}
        return out;
      }
      if (r) break;   // 没抛错也没选到 = 用户取消
    } catch (err) { lastErr = err; }
  }
  if (lastErr) toast(`打开选择器失败：${lastErr?.message || lastErr}，可改用「粘贴路径引用」`, 6000);
  return null;
}

async function collectExistingFlow() {
  const kind = await askRefKind();
  if (!kind) return;

  let target = "";
  if (kind === "file") {
    // 文件：走宿主选择器。mode 用 SDK 明确支持的 'file'
    // （_ui-protocol.d.ts → PluginResourcePickInput.mode?: 'file' | 'directory' | string）。
    // 不再传 {} 靠宿主默认——默认行为不确定，明确要 file 更可靠。
    let picked = null;
    let lastErr = null;
    for (const arg of [{ mode: "file" }, { mode: "file", multiple: true }]) {
      try {
        const r = await hana.resources.pick(arg);
        const first = r?.resources?.[0] || r?.[0] || null;
        const t = first?.path || first?.uri;
        if (t) { picked = r; break; }
        if (r) break; // 没抛错也没选到 = 用户取消
      } catch (err) { lastErr = err; }
    }
    if (!picked) {
      if (lastErr) toast(`打开选择器失败：${lastErr?.message || lastErr}`, 4500);
      return;
    }
    const first = picked?.resources?.[0] || picked?.[0] || null;
    const raw = first?.path || first?.uri;
    if (!raw) return toast("没有选中文件");
    // file:// URI 与裸路径都统一成裸路径
    target = String(raw).replace(/^file:\/\//, "");
    try { target = decodeURIComponent(target); } catch {}
  } else if (kind === "dir") {
    // 文件夹：SDK 的 PluginResourcePickInput 明确支持 mode:"directory"。
    // 之前一直选不了目录，是因为我在猜 mode 的值（any/file/files），全错。
    target = (await pickDirViaHost()) || "";
    if (!target) return;
  } else if (kind === "dirpath") {
    // 兜底：宿主选择器在某些环境不可用时，手动粘路径
    const v = await promptText("粘贴目录路径", "", "如 D:\\资料\\教资真题");
    if (!v) return;
    target = String(v).trim().replace(/^file:\/\//, "").replace(/^["']|["']$/g, "");
  } else {
    target = await pickVaultDir();
    if (!target) return;
  }
  if (!target) return toast("路径为空");

  // 关键改动：引用只写注册表，不创建收藏条目。
  // 以前走 /ref/collect，它内部会 create() 一条收藏 → 跑到收件箱里。
  // 用户要的是：引用文件夹直接进文件管理器，不该在笔记列表里出现。
  const name = String(target).split(/[\\/]/).filter(Boolean).pop() || target;
  const r = await API.post("/external/add", { target, title: name });
  if (!r.ok) return toast(`❌ ${r.error}`, 4500);
  const it = r.item || {};
  const kindWord = it.isDir ? "文件夹" : "文件";
  toast(`✓ 已引用${kindWord}《${it.title || name}》（只记位置，不复制）`, 4500);

  // 引用文件夹直接在文件网格里出现（和库内文件夹并排），所以刷新列表
  await loadFiles();
  if (det) {
    det.hidden = false;
    det.open = true;   // <details> 要显式展开
    det.scrollIntoView?.({ block: "nearest" });
  }
  // 文件夹直接带用户进去浏览
  if (it.isDir) await openExtDir(it.target, "");
}


// 选中一行：右侧显示操作条 + 引用数
async function selectFile(fp) {
  filesSel = fp;
  for (const row of $("files-list").querySelectorAll("[data-fp]")) {
    row.classList.toggle("selected", row.dataset.fp === fp);
  }
  // 异步填引用数，不阻塞选中反馈
  for (const cell of $("files-list").querySelectorAll("[data-refs]")) {
    const p = cell.dataset.refs;
    API.get(`/assets/refs?rel=${encodeURIComponent(p)}`).then((r) => {
      const n = r.ok ? (r.refs || []).length : 0;
      cell.innerHTML = n ? `<button class="frow-ref" title="被 ${n} 篇笔记引用，点开看是哪几篇">📎 ${n}</button>` : "";
      const b = cell.querySelector(".frow-ref");
      if (b) b.addEventListener("click", (ev) => { ev.stopPropagation(); showRefs(p); });
    }).catch(() => {});
  }
}

// 右键菜单：打开 / 插入到笔记 / 重命名 / 删除 / 建子文件夹
// 外部条目的右键菜单：只做"打开 / 打开位置 / 取消引用"
function extRowMenu(ev, item) {
  const fp = item.path;
  const items = [
    { label: item.isDir ? "📂 进入" : "📂 打开", run: async () => {
        if (item.isDir) await openExtDir(fp, "");
        else await openWithSystem(fp);
      } },
    { label: "📁 打开文件位置", run: () => revealAbsPath(fp) },
    { label: "🔗 复制路径", run: () => hana.ui.clipboard.writeText({ text: fp }) },
    { label: "🔍 诊断（为什么读不到）", run: () => showExtDiag() },
  ];
  if (item.extId) {
    items.push({ label: "🗑 取消引用", danger: true, run: async () => {
      const ok = await confirmBox("取消这条引用？", `只删除这条记录，磁盘上的文件不会被删。\n\n${fp}`);
      if (!ok) return;
      const r = await API.post("/external/remove", { id: item.extId });
      if (!r.ok) return toast(`❌ ${r.error}`, 5000);
      toast("✓ 已取消引用");
      await loadFiles();
    } });
  }
  treeMenu(ev, items);
}

// 诊断：把后端读这个路径的真实结果摆出来。
// 我前面一直在猜"是不是 stat 失败"，与其继续猜，不如让 App 自己说。
async function showExtDiag() {
  const r = await API.get("/external/diag");
  if (!r.ok) return toast(`❌ ${r.error}`, 5000);
  const esc = (s) => escapeHtml(String(s ?? ""));
  const blk = (label, val) =>
    `<div style="margin:6px 0"><b style="font-size:11.5px">${esc(label)}</b>` +
    `<pre style="margin:2px 0 0;padding:7px 9px;background:rgb(0 0 0/.04);border-radius:6px;` +
    `font-size:11px;line-height:1.5;overflow-x:auto;white-space:pre-wrap">${esc(typeof val === "string" ? val : JSON.stringify(val, null, 2))}</pre></div>`;

  const items = (r.items || []).map((it) => {
    let html = `<div style="margin:10px 0;padding-bottom:8px;border-bottom:1px solid var(--c-border)">`;
    html += `<div style="font-size:12.5px;font-weight:600;word-break:break-all">${esc(it.target)}</div>`;
    html += blk("数据库里存的", it.stored);
    if (it.fsStat !== undefined) html += blk("vault.fs.stat", it.fsStat);
    if (it.fsStatError) html += blk("vault.fs.stat 出错", it.fsStatError);
    if (it.listLen !== undefined) html += blk("能列出几项", it.listLen);
    if (it.listError) html += blk("list 出错", it.listError);
    if (it.hostStat !== undefined) html += blk("宿主 resources.stat", it.hostStat);
    if (it.hostStatError) html += blk("宿主 resources.stat 出错", it.hostStatError);
    html += `</div>`;
    return html;
  }).join("");

  dialog({
    title: "🔍 库外引用诊断",
    bodyHtml:
      `<p class="muted" style="margin:0 0 8px;font-size:11.5px">` +
      `后端：${esc(r.backend)} · 库根：${esc(r.vaultRoot)} · 共 ${r.count} 条</p>` +
      (items || `<p class="muted">没有任何库外引用</p>`),
    okText: "关闭",
    onOk: () => {},
  });
}

function fileRowMenu(ev, fp, isDir) {
  const items = isDir
    ? [
        { label: "📂 打开", run: () => loadFilesTo(fp) },
        { label: "📁 打开文件位置", run: () => revealAsset(fp) },
        { label: "✏ 重命名", run: () => renameAssetFlow(fp, true) },
        { label: "🗑 删除文件夹", danger: true, run: () => deleteAssetFlow(fp, true) },
      ]
    : [
        { label: "👁 预览", run: () => previewAsset(fp) },
        { label: "📁 打开文件位置", run: () => revealAsset(fp) },
        { label: "📎 插入到笔记…", run: () => insertAssetToNote(fp) },
        { label: "✏ 重命名", run: () => renameAssetFlow(fp, false) },
        { label: "🗑 删除", danger: true, run: () => deleteAssetFlow(fp, false) },
      ];
  treeMenu(ev, items);
}

async function renameAssetFlow(fp, isDir) {
  const cur = fp.split("/").pop();
  const nn = await promptText(isDir ? "重命名文件夹" : "重命名文件", cur.replace(/\.[^.]+$/, ""), "新名字");
  if (!nn) return;
  const r = await API.post("/assets/rename", { rel: fp, name: nn });
  if (!r.ok) return toast(`❌ ${r.error}`);
  await loadFiles();
  // 后端已经顺手把正文里的 ![[旧名]] 改成了新名，这里只需报告结果。
  // patched 是改了几篇；0 表示没有正文引用它（或引用的形态不在改写范围内）。
  if (r.patched > 0) {
    toast(`✓ 已重命名，并自动更新了 ${r.patched} 篇笔记里的引用`, 5000);
  } else {
    toast("✓ 已重命名", 3000);
  }
}

async function deleteAssetFlow(fp, isDir) {
  // 先查引用：有引用的要让用户确认，不闷声删
  const chk = await API.post("/assets/delete", { rel: fp });
  if (!chk.ok && !chk.needConfirm) return toast(`❌ ${chk.error}`);
  if (chk.needConfirm) {
    const names = (chk.refs || []).slice(0, 3).map((x) => `《${x.title}》`).join("、");
    const more = (chk.refs || []).length > 3 ? ` 等 ${chk.refs.length} 篇` : "";
    const ok = await confirmBox(`删除「${fp.split("/").pop()}」？`,
      `它被 ${names}${more} 引用着。删掉后那些笔记里的卡片会变成「文件不存在」，但笔记本身不受影响。`);
    if (!ok) return;
    const r = await API.post("/assets/delete", { rel: fp, force: true });
    if (!r.ok) return toast(`❌ ${r.error}`);
    toast(`✓ 已删除（影响了 ${r.refs} 篇笔记的卡片）`);
  } else {
    toast("✓ 已删除");
  }
  await loadFiles();
  await loadCategories();
}

// PDF：pdf.js 画到 canvas。
// iframe 这条路在 HanaAgent(Electron) 里是死的：宿主没开 PDF 插件
// （主进程 webPreferences 里没有 plugins:true），blob/http 全都白屏。
// pdf.js 在禁 Worker 的 CSP 下走 fake worker（主线程），legacy build 就是为这种环境准备的。
let _pdfjsMod = null;
async function loadPdf(scope, fp) {
  const wrap = scope.querySelector(".fp-pdf-wrap");
  if (!wrap) return;
  try {
    if (!_pdfjsMod) {
      // 先自己把 worker 模块 import 进来挂到 globalThis.pdfjsWorker：
      // pdf.js 的 fake worker 分支见到现成的 WorkerMessageHandler 直接用，
      // 不再按 workerSrc 相对解析（相对路径在 _surface/{token}/ 下必踩空）。
      if (!globalThis.pdfjsWorker) {
        globalThis.pdfjsWorker = await import("./vendor/pdf.worker.min.mjs");
      }
      _pdfjsMod = await import("./vendor/pdf.min.mjs");
      // 兜底路径：万一某版本 fake worker 仍要读 workerSrc，给按本模块
      // 位置算出的绝对 URL，不用相对路径。
      _pdfjsMod.GlobalWorkerOptions.workerSrc =
        new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
    }
    const isAbs = /^([A-Za-z]:[\\/]|\/)/.test(String(fp));
    const url = isAbs
      ? `/external/raw?path=${encodeURIComponent(fp)}`
      : `/_assets/${String(fp).replace(/^_assets\//, "")}`;
    const resp = await hana.api.fetch(url);
    if (!resp || !resp.ok) throw new Error(`HTTP ${resp ? resp.status : "无响应"}`);
    const data = new Uint8Array(await resp.arrayBuffer());
    if (!data.length) throw new Error("取回 0 字节");

    const doc = await _pdfjsMod.getDocument({
      data,
      isEvalSupported: false,      // CSP 无 unsafe-eval，走替代路径
      isOffscreenCanvasSupported: false,
    }).promise;

    // 界面：页码条 + 画布容器
    wrap.innerHTML =
      '<div class="fp-pdf-bar"><button type="button" class="small" id="pv-pdf-prev">‹ 上一页</button>' +
      '<span id="pv-pdf-pn" class="muted"></span>' +
      '<button type="button" class="small" id="pv-pdf-next">下一页 ›</button></div>' +
      '<div class="fp-pdf-canvas" id="pv-pdf-canvas"></div>';

    const canvasBox = wrap.querySelector("#pv-pdf-canvas");
    const pnEl = wrap.querySelector("#pv-pdf-pn");
    let cur = 1;
    const scale = 1.35;

    const renderPage = async () => {
      const page = await doc.getPage(cur);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvasBox.innerHTML = "";
      canvasBox.appendChild(canvas);
      pnEl.textContent = ` ${cur} / ${doc.numPages} `;
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
      }).promise;
    };

    wrap.querySelector("#pv-pdf-prev").addEventListener("click", async () => {
      if (cur > 1) { cur--; await renderPage(); }
    });
    wrap.querySelector("#pv-pdf-next").addEventListener("click", async () => {
      if (cur < doc.numPages) { cur++; await renderPage(); }
    });

    await renderPage();
  } catch (err) {
    wrap.innerHTML =
      `<div class="fp-err">❌ PDF 打不开：${escapeHtml(err?.message || String(err))}` +
      `<br><span class="muted">可以用右键「打开文件位置」交给系统阅读器。</span></div>`;
  }
}

// 这个文件能不能在面板里直接看。决定"点一下就预览"还是"交给系统程序"。
function canPreviewInline(fp, meta) {
  const name = String(fp).split(/[\\/]/).pop();
  const type = meta?.type || guessTypeOf(name);
  if (["image", "video", "audio", "pdf", "text", "md", "doc", "sheet", "slide"].includes(type)) {
    // 老 .doc / .ppt 是二进制格式，docx-preview 读不了（.xls 后端 SheetJS 能读，放行）
    if (type === "doc" && !/\.docx$/i.test(name)) return false;
    return true;
  }
  return false;
}

// 面板内预览。双击文件走这里；「用系统应用打开」仍走 openAssetFile。
// 资源 URL 统一走 /_assets/ 前缀（routes 里 /asset/* 与 /_assets/* 都注册了）。
async function previewAsset(fp, meta) {
  const name = fp.split("/").pop();
  const type = meta?.type || guessTypeOf(name);
  const size = typeof meta?.size === "number" ? fmtSize(meta.size) : "";
  const url = assetUrl(fp);
  const head = `<div class="fp-head"><span class="fp-ic">${icon(TYPE_ICONS[type] || "file", 18)}</span>` +
    `<span class="fp-name" title="${escapeAttr(fp)}">${escapeHtml(name)}</span>` +
    `<span class="fp-meta">${escapeHtml(TYPE_LABEL[type] || "文件")}${size ? ` · ${size}` : ""}</span></div>`;

  let body = "";
  if (type === "image") {
    body = `<div class="fp-img-wrap"><img class="fp-img" data-asset="${escapeAttr(fp)}" alt="${escapeAttr(name)}"></div>`;
  } else if (type === "video") {
    // 音视频和图片同理：标签带不了凭据头，绝对 URL 直连必 403。
    // 用 data-vsrc 标记，预览框挂载后异步填 blob URL（见 paintMedia）。
    body = `<video class="fp-video" data-vsrc="${escapeAttr(fp)}" data-vsize="${escapeAttr(String(meta?.size ?? ""))}" controls preload="metadata"></video>`;
  } else if (type === "audio") {
    body = `<div class="fp-audio"><div class="fp-audio-ic">${icon("audio", 40)}</div>` +
      `<audio data-vsrc="${escapeAttr(fp)}" controls preload="metadata"></audio></div>`;
  } else if (type === "text" || type === "md" || /\.(md|txt|markdown|json|csv|log|js|mjs|css|html)$/i.test(name)) {
    // 文本类：拉回来渲染。md 用 renderMarkdown（含 ![[资源]] 卡片），纯文本 <pre>
    body = `<div class="fp-text" id="pv-text"><div class="muted fp-loading">正在读取…</div></div>`;
  } else if (type === "pdf") {
    // <iframe src> 和 <img src> 一样，带不了自定义请求头 → 403 missing_credential。
    // 先用 hana.api.fetch 取回字节转 blob，再把 blob URL 交给 iframe。
    body = `<div class="fp-pdf-wrap"><div class="muted fp-loading" id="pv-pdf-load">正在载入 PDF…</div></div>`;
  } else if (type === "doc" && /\.docx$/i.test(name)) {
    // Word 预览：docx-preview（74KB 纯 JS，不用 Worker，不碰 WASM）
    // 老 .doc 是二进制格式，这个库读不了，走下面的降级分支
    body = `<div class="fp-docx" id="pv-docx"><div class="muted fp-loading">正在解析文档…</div></div>`;
  } else if (type === "sheet" && /\.(xlsx|xlsm|xlsb)$/i.test(name)) {
    // Excel：后端 SheetJS 解析（861KB 库只在后端加载，前端零依赖）
    body = `<div class="fp-sheet" id="pv-sheet"><div class="muted fp-loading">正在解析表格…</div></div>`;
  } else if (type === "sheet") {
    // 老 .xls 是二进制格式，SheetJS 也认，走同一接口（后端判断）
    body = `<div class="fp-sheet" id="pv-sheet"><div class="muted fp-loading">正在解析表格…</div></div>`;
  } else if (type === "slide" && /\.(pptx|ppsx)$/i.test(name)) {
    // PPT：后端抽每页文字大纲（保真不如真渲染，但内容可读、零依赖）
    body = `<div class="fp-slide" id="pv-slide"><div class="muted fp-loading">正在解析演示文稿…</div></div>`;
  } else {
    // 诚实降级：面板里画不出来，给图标和系统打开入口
    body = `<div class="fp-none"><div class="fp-none-ic">${icon(TYPE_ICONS[type] || "file", 46)}</div>` +
      `<p class="muted">这种文件没法在面板里直接看。</p></div>`;
  }

  // 独立遮罩，不用通用 dialog()：那个是单例，预览开着时弹别的窗会把预览冲掉。
  const oldOv = document.getElementById('preview-overlay');
  if (oldOv) oldOv.remove();
  const ov = document.createElement('div');
  ov.id = 'preview-overlay';
  ov.className = 'preview-overlay';
  ov.innerHTML =
    '<div class="preview-modal" role="dialog" aria-label="预览">' +
      '<div class="preview-head"><span class="preview-title">👁 预览</span>' +
      '<button type="button" class="preview-close" id="preview-close" aria-label="关闭">✕</button></div>' +
      '<div class="preview-body"><div class="fprev">' + head + '<div class="fp-body">' + body + '</div></div></div>' +
    '</div>';
  document.body.appendChild(ov);
  const closePreview = () => {
    ov.remove();
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (ev) => { if (ev.key === 'Escape') closePreview(); };
  document.getElementById('preview-close').addEventListener('click', closePreview);
  ov.addEventListener('click', (ev) => { if (ev.target === ov) closePreview(); });
  document.addEventListener('keydown', onEsc);
  paintAssetImages(ov);
  paintMedia(ov);
  {
      const box = $("pv-text");
      if (box) {
        // 拉文本：走 hana.api.fetch 而不是裸 fetch。
        // 裸 fetch 在沙箱里可能不存在，而且拿不到宿主鉴权；之前就是它导致
        // 文本预览直接抛 ReferenceError，弹窗里一片空白。
        Promise.resolve().then(() => {
          if (hana?.api?.fetch) return hana.api.fetch(url);
          if (typeof fetch === "function") return fetch(url);
          throw new Error("当前环境没有可用的 fetch");
        }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        }).then((txt) => {
          // 限长：超大文本全渲染会把面板卡死
          const MAX = 200000;
          const clipped = txt.length > MAX ? txt.slice(0, MAX) + "\n…（文件过长，已截断）" : txt;
          box.innerHTML = (/\.(md|markdown)$/i.test(name))
            ? `<div class="fp-md">${renderMarkdown(clipped)}</div>`
            : `<pre class="fp-pre">${escapeHtml(clipped)}</pre>`;
          bindRefCards(box);
        }).catch((err) => {
          box.innerHTML = `<div class="fp-err">❌ 读取失败：${escapeHtml(err?.message || String(err))}</div>`;
        });
      }
  }
  loadPdf(ov, fp);
  renderDocx(ov, fp);
  renderSheet(ov, fp);
  renderSlide(ov, fp);
  return closePreview;
}

// Excel 预览：后端 /sheet/preview 返回 { sheets: [{name, rows}] }，前端画表。
// 库内库外统一传原始路径，后端 readPreviewBytes 自己分辨。
let _sheetWarned = false;
async function renderSheet(scope, fp) {
  const box = scope.querySelector("#pv-sheet");
  if (!box) return;
  try {
    const r = await API.get(`/sheet/preview?path=${encodeURIComponent(fp)}`);
    if (!r || !r.ok || !r.sheets?.length) throw new Error(r?.error || "没解出工作表");
    const sheets = r.sheets;
    let cur = 0;
    const draw = () => {
      const s = sheets[cur];
      const table = s.rows.length
        ? `<table class="fp-sheet-table"><tbody>` + s.rows.map((row) =>
            `<tr>` + row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("") + `</tr>`).join("") + `</tbody></table>`
        : `<p class="muted">（空工作表）</p>`;
      box.innerHTML =
        (sheets.length > 1
          ? `<div class="fp-sheet-tabs">` + sheets.map((x, i) =>
              `<button type="button" class="small${i === cur ? " primary" : ""}" data-si="${i}">${escapeHtml(x.name)}</button>`).join("") + `</div>`
          : "") + table;
      box.querySelectorAll("[data-si]").forEach((b) => b.addEventListener("click", () => { cur = +b.dataset.si; draw(); }));
    };
    draw();
  } catch (err) {
    box.innerHTML =
      `<div class="fp-err">❌ 表格解析失败：${escapeHtml(err?.message || String(err))}` +
      `<br><span class="muted">可以用右键「打开文件位置」交给 Excel 打开。</span></div>`;
  }
}

// PPT 预览：后端 /slide/preview 返回每页文字大纲
async function renderSlide(scope, fp) {
  const box = scope.querySelector("#pv-slide");
  if (!box) return;
  try {
    const r = await API.get(`/slide/preview?path=${encodeURIComponent(fp)}`);
    if (!r || !r.ok) throw new Error(r?.error || "没解出内容");
    const slides = r.slides || [];
    if (!slides.length) {
      box.innerHTML = `<div class="fp-none"><p class="muted">这份演示文稿里没抽到文字（可能是纯图片页）。</p></div>`;
      return;
    }
    box.innerHTML = slides.map((s) =>
      `<div class="fp-slide-page"><div class="fp-slide-no">第 ${s.n} 页</div>` +
      `<pre class="fp-slide-text">${escapeHtml(s.text)}</pre></div>`).join("") +
      (r.total > slides.length ? `<p class="muted">（共 ${r.total} 页，仅显示前 ${slides.length} 页）</p>` : "");
  } catch (err) {
    box.innerHTML =
      `<div class="fp-err">❌ 演示文稿解析失败：${escapeHtml(err?.message || String(err))}` +
      `<br><span class="muted">可以用右键「打开文件位置」交给 PowerPoint 打开。</span></div>`;
  }
}

// 把 .docx 渲染进预览框。
// 三个坑都踩过了：
//   1. 沙箱禁 worker → 只能用纯 JS 版
//   2. img-src 只放 data: → 必须 useBase64URL:true，否则图片全裂
//   3. fetch 要走 hana.api（带凭据），裸 fetch 拿不到包内路由鉴权
let _docxMod = null;
async function renderDocx(scope, fp) {
  const box = scope.querySelector("#pv-docx");
  if (!box) return;
  // fp 由调用方直接传入。早先这里靠文件名反查路径，
  // 库外文件（绝对路径）根本不在 filesItems 里，必然查不到。
  if (!fp) {
    box.innerHTML = `<div class="fp-err">❌ 没有拿到文件路径</div>`;
    return;
  }
  try {
    if (!_docxMod) {
      // 顺序不能反：docx-preview.mjs 在模块顶层就读 globalThis.JSZip，
      // 而且模块求值失败会被浏览器缓存成永久失败，之后 import 永远抛同一个错。
      // 必须先把 jszip 挂上去，再第一次 import。
      if (!globalThis.JSZip) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "./assets/vendor/jszip.min.js";
          s.onload = res;
          s.onerror = () => rej(new Error("jszip.min.js 加载失败"));
          document.head.appendChild(s);
        });
      }
      _docxMod = await import("./vendor/docx-preview.mjs");
    }
    // 库内走 /asset/*（库内 fs）；库外走 /external/raw（宿主资源接口）。
    // 注意 fetch 必须传相对路径：assetUrl() 返回绝对 URL，SDK 的
    // normalizePluginApiPath 见到 http: 协议头直接抛 Invalid plugin API path。
    const isAbs = /^([A-Za-z]:[\\/]|\/)/.test(fp);
    const url = isAbs
      ? `/external/raw?path=${encodeURIComponent(fp)}`
      : `/_assets/${String(fp).replace(/^[._]*assets[/_]/, "")}`;
    const resp = await hana.api.fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    box.innerHTML = "";
    await _docxMod.renderAsync(blob, box, undefined, {
      className: "nv-docx",
      inWrapper: true,
      breakPages: true,
      ignoreWidth: false,
      ignoreHeight: false,
      useBase64URL: true,     // CSP 只认 data:，这行不能去
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
    });
    // 文档里可能夹带超链接，一律禁掉跳转（沙箱会拦，点了没反应反而更困惑）
    box.querySelectorAll("a[href]").forEach((a) => {
      a.removeAttribute("href");
      a.style.cursor = "default";
    });
  } catch (err) {
    box.innerHTML =
      `<div class="fp-err">❌ 文档渲染失败：${escapeHtml(err?.message || String(err))}` +
      `<br><span class="muted">可以用右键「打开文件位置」交给 Word 打开。</span></div>`;
  }
}

// 库内文件 → 交给宿主 SDK 的资源引用。
// 关键：不是 http 网址。sdk/_ui-protocol.d.ts 的 PluginResourceRef 支持
// {kind:'local-file', path} / {kind:'mount', mountId, path} / {kind:'url', url}。
// 之前传的是 assetUrl(fp)（一个 http 地址），宿主认不出那是本地文件，所以永远打不开。
function assetRef(fp) {
  const root = String(state.root || '').replace(/[\\/]+$/, '');
  if (!root) return null;
  const sep = root.includes('\\') ? '\\' : '/';
  const rel = String(fp).replace(/^_assets\//, '');
  return { kind: 'local-file', path: root + sep + '_assets' + sep + rel };
}

// 在资源管理器中定位这个文件（用户自己去双击打开）
async function revealAsset(fp) {
  const ref = assetRef(fp);
  if (!ref) return toast('还不知道库在磁盘上的位置，先打开一次设置让它记住', 5000);
  try {
    const r = await hana.resources.open({ resource: ref, mode: 'reveal' });
    if (r && r.opened === false) toast('系统没打开资源管理器，请确认文件是否还在', 5000);
  } catch (err) {
    // 退化：把路径复制到剪贴板，用户自己粘到地址栏
    try {
      await hana.ui.clipboard.writeText({ text: ref.path });
      toast('❌ 定位失败，已把文件完整路径复制到剪贴板', 6000);
    } catch {
      toast('❌ 定位失败：' + (err?.message || err), 6000);
    }
  }
}

// 交给宿主预览（宿主那套渲染比我们自绘的更完整）
async function hostPreviewAsset(fp) {
  const ref = assetRef(fp);
  if (!ref) return false;
  try {
    const r = await hana.resources.open({ resource: ref, mode: 'preview' });
    return !!(r && r.opened !== false);
  } catch {
    return false;
  }
}

// 按绝对路径在资源管理器中定位（库外文件用）
async function revealAbsPath(abs) {
  if (!abs) return;
  try {
    const r = await hana.resources.open({ resource: { kind: "local-file", path: String(abs) }, mode: "reveal" });
    if (r && r.opened === false) toast("系统没打开资源管理器，请确认文件是否还在", 5000);
  } catch (err) {
    try {
      await hana.ui.clipboard.writeText({ text: String(abs) });
      toast("❌ 定位失败，已把路径复制到剪贴板", 6000);
    } catch {
      toast(`❌ 定位失败：${err?.message || err}`, 6000);
    }
  }
}

// 兼容老调用：宿主预览不行再退回自绘
async function openAssetFile(fp) {
  if (await hostPreviewAsset(fp)) return;
  await previewAsset(fp);
}

// 显示谁引用了这个文件
async function showRefs(fp) {
  const r = await API.get(`/assets/refs?rel=${encodeURIComponent(fp)}`);
  if (!r.ok) return toast(`❌ ${r.error}`);
  const refs = r.refs || [];
  if (!refs.length) return toast("还没有笔记引用它");
  const items = refs.map((x) =>
    `<button class="ref-pick" data-id="${escapeAttr(x.id)}">` +
    `<span class="ref-pick-t">${escapeHtml(x.title)}</span>` +
    `<span class="ref-pick-c">${escapeHtml(x.category)}</span></button>`).join("");
  const close = dialog({
    title: `📎 谁引用了「${fp.split("/").pop()}」`,
    bodyHtml: `<div class="ref-pick-list">${items}</div>`,
    okText: "关闭",
    onOk: () => {},
    onMount: () => {
      for (const b of $("m-body").querySelectorAll(".ref-pick")) {
        b.addEventListener("click", async () => {
          close();
          await selectCategory("");
          await selectEntry(b.dataset.id);
        });
      }
    },
  });
}

// 插入到笔记：选一篇，把文件以 ![[名]] 追加进去。
// names 可以是单个路径或路径数组（批量栏一次插入多个）。
async function insertAssetsToNote(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  return insertAssetToNote(list[0], list);
}

async function insertAssetToNote(fp, allPaths = null) {
  // 用带路径的完整引用，不要只留文件名。
  // 只写文件名的话，文件一旦在子目录里就查不到，正文显示「文件不存在」——
  // 这是「MD 里加文件不可用」的直接原因之一。
  const names = (allPaths || [fp]).map((x) => String(x).replace(/^_assets\//, ""));
  const name = String(fp).split("/").pop();
  const r = await API.get("/entries?limit=300");
  if (!r.ok) return toast(`❌ ${r.error}`);
  const list = r.entries || [];
  const items = list.map((e) =>
    `<button class="ref-pick" data-id="${escapeAttr(e.id)}">` +
    `<span class="ref-pick-t">${escapeHtml(e.title)}</span>` +
    `<span class="ref-pick-c">${escapeHtml(e.category)}</span></button>`).join("");
  const close = dialog({
    title: `插入「${name}」到哪篇笔记？`,
    bodyHtml:
      `<div class="ref-pick-list">${items || '<p class="muted">库里还没有笔记</p>'}</div>` +
      `<button class="small" id="ref-new-note">＋ 新建一篇笔记并插入</button>`,
    okText: "取消",
    onOk: () => {},
    onMount: () => {
      for (const b of $("m-body").querySelectorAll(".ref-pick")) {
        b.addEventListener("click", () => doInsert(b.dataset.id, name, close));
      }
      $("ref-new-note").addEventListener("click", async () => {
        const t = await promptText("新笔记标题", name.replace(/\.[^.]+$/, ""), "标题");
        if (!t) return;
        const c = await API.post("/entry", { title: t, content: "", category: filesCatGuess() });
        if (!c.ok) return toast(`❌ ${c.error}`);
        await doInsert(c.entry.id, name, close);
      });
    },
  });
}

function filesCatGuess() {
  return state.filter.category || "收件箱";
}

async function doInsert(entryId, name, closeDialog, allNames = null) {
  const cur = await API.get(`/entry?id=${encodeURIComponent(entryId)}`);
  if (!cur.ok) return toast(`❌ ${cur.error}`);
  const names = allNames && allNames.length ? allNames : [name];
  const body = String(cur.entry.content || "").replace(/\s*$/, "");
  // 多个文件各占一行，读起来是一份清单，而不是挤成一团
  const block = names.map((x) => `![[${x}]]`).join("\n");
  const next = body + (body ? "\n\n" : "") + block;
  const u = await API.post("/entry", { id: entryId, content: next });
  if (!u.ok) return toast(`❌ ${u.error}`);
  closeDialog();
  toast(`✓ 已插入 ${names.length} 个文件到《${u.entry.title}》`);
  await loadCategories();
  await loadEntries();
  await loadFiles();
}

// 库外引用列表
// ---- AI 整理建议（C 批）----
// 对当前层（或勾选的）文件要一份「放哪 + 改名 + 一句话说明」的建议。
// 建议就是建议：默认什么都不勾，用户自己点要采纳的。
async function openAiOrganizeFiles() {
  const scope = filesPicked.size ? filesItems.filter((f) => filesPicked.has(f.path)) : filesItems;
  if (!scope.length) return toast("这个文件夹是空的");
  const loading = dialog({
    title: "🤖 AI 整理建议",
    bodyHtml: `<p class="muted">正在看 ${scope.length} 个文件…</p>`,
    okText: "取消",
    onOk: () => {},
  });
  let r = null;
  try {
    r = await API.post("/ai/organize-files", { items: scope });
  } catch (err) {
    loading();
    toast(`❌ AI 请求失败：${err?.message || err}`, 4500);
    return;
  }
  loading();
  if (!r || r.ok === false) { toast(`❌ ${r?.error || "AI 没返回结果"}`); return; }
  renderAiSuggestions(r);
}

function renderAiSuggestions(r) {
  const list = r.suggestions || [];
  if (!list.length) { toast("AI 没给出建议"); return; }
  const dirOpts = (r.dirs || []).map((d) => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join("");
  const rows = list.map((s, i) => {
    const dirSel = s.dir && s.dir !== "保持原位" ? ` selected` : "";
    return `<div class="ai-sug" data-i="${i}">` +
      `<label class="ai-sug-cb"><input type="checkbox" class="ai-sug-check" value="${i}"${dirSel ? " checked" : ""}></label>` +
      `<span class="ai-sug-n" title="${escapeAttr(s.path)}">${escapeHtml(s.name)}</span>` +
      `<span class="ai-sug-note">${escapeHtml(s.note || "")}</span>` +
      `<select class="ai-sug-dir" data-i="${i}">` +
      `<option value="保持原位">保持原位</option>` +
      (r.dirs || []).map((d) => `<option value="${escapeAttr(d)}"${d === s.dir ? " selected" : ""}>${escapeHtml(d)}</option>`).join("") +
      `</select>` +
      `<input class="ai-sug-name" data-i="${i}" value="${escapeAttr(s.suggest || s.name)}">` +
      `</div>`;
  }).join("");
  dialog({
    title: `🤖 AI 整理建议（${list.length} 项）`,
    bodyHtml:
      `<p class="muted">勾选要采纳的行，改完点「应用」。只移动/改名，不删任何东西。</p>` +
      (r.warning ? `<p class="muted">⚠ ${escapeHtml(String(r.warning))}</p>` : "") +
      `<div class="ai-sug-head"><span></span><span>文件</span><span>AI 的判断</span><span>移到</span><span>改成</span></div>` +
      `<div class="ai-sug-list">${rows}</div>`,
    okText: "应用所选",
    onOk: async () => {
      const picks = [...$("m-body").querySelectorAll(".ai-sug-check:checked")].map((x) => Number(x.value));
      if (!picks.length) { toast("没勾选任何一行"); return false; }
      let moved = 0, renamed = 0;
      const errs = [];
      for (const i of picks) {
        const s = list[i];
        const dirEl = $(`#m-body .ai-sug-dir[data-i="${i}"]`);
        const nameEl = $(`#m-body .ai-sug-name[data-i="${i}"]`);
        const dir = dirEl?.value || "保持原位";
        const want = (nameEl?.value || "").trim();
        // 先改名再移动：名字变了，移动用的路径也得跟着变
        let curPath = s.path;
        if (want && want !== s.name) {
          const ext = (s.name.match(/\.([^.]+)$/) || [])[1];
          const base = ext ? want.replace(new RegExp("\\." + ext + "$", "i"), "") : want;
          const rr = await API.post("/assets/rename", { rel: curPath, name: base });
          if (rr.ok) { renamed++; curPath = rr.to; }
          else errs.push(`${s.name}：${rr.error}`);
        }
        if (dir !== "保持原位") {
          const cur = curPath.split("/").slice(0, -1).join("/");
          if (dir !== cur) {
            const rr = await API.post("/assets/move", { paths: [curPath], dest: `_assets/${dir}` });
            if (rr.ok && rr.moved) moved++;
            else errs.push(`${s.name}：${rr.error || (rr.failed && rr.failed[0] && rr.failed[0].error) || "移动失败"}`);
          }
        }
      }
      await loadFiles();
      await refreshAssetIndex();
      const parts = [`✓ 已移动 ${moved} 项`, `改名 ${renamed} 项`];
      if (errs.length) parts.push(`${errs.length} 项失败`);
      toast(parts.join("，"), 4500);
      if (errs.length) console.warn("[nian-vault] AI 整理应用失败", errs);
    },
  });
}

// 上传：弹一个子目录选择，然后走隐藏的 file input
async function uploadAssetFlow() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.style.display = "none";
  document.body.appendChild(inp);
  inp.addEventListener("change", async () => {
    const files = Array.from(inp.files || []);
    inp.remove();
    if (!files.length) return;
    // 问传到哪：当前目录 or 根
    const sub = filesDir ? filesDir.replace(/^_assets\/?/, "") : "";
    let okCount = 0;
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f, f.name);
      fd.append("subdir", sub);
      try {
        const r = await hana.api.fetch("/asset/upload", { method: "POST", body: fd });
        const j = await r.json();
        if (j.ok) okCount++;
        else toast(`❌ ${f.name}：${j.error}`);
      } catch (err) {
        toast(`❌ ${f.name}：${err?.message || err}`);
      }
    }
    if (okCount) toast(`✓ 已上传 ${okCount} 个文件${sub ? `到 ${sub}` : ""}`);
    await loadFiles();
  });
  inp.click();
}

async function mkAssetDirFlow() {
  const nn = await promptText("新建文件夹", "", "文件夹名");
  if (!nn) return;
  const sub = filesDir ? filesDir.replace(/^_assets\/?/, "") : "";
  const r = await API.post("/assets/mkdir", { rel: sub, name: nn });
  if (!r.ok) return toast(`❌ ${r.error}`);
  toast("✓ 已建文件夹");
  await loadFiles();
}

$("btn-files").addEventListener("click", () => openFiles(""));
$("btn-files-back").addEventListener("click", () => { showWall(false); showHome(); });
$("btn-files-up").addEventListener("click", uploadAssetFlow);
$("btn-files-mkdir").addEventListener("click", mkAssetDirFlow);
$("btn-files-ref").addEventListener("click", collectExistingFlow);
$("btn-files-ai").addEventListener("click", openAiOrganizeFiles);
$("btn-files-pick").addEventListener("click", () => togglePickMode());
$("btn-files-list").addEventListener("click", () => setFilesMode("list"));
$("btn-files-grid").addEventListener("click", () => setFilesMode("grid"));
// 批量栏
$("files-batch-all").addEventListener("change", (ev) => {
  filesPicked = ev.target.checked ? new Set(filesItems.map((f) => f.path)) : new Set();
  renderFiles();
});
$("btn-batch-clear").addEventListener("click", () => { filesPicked = new Set(); renderFiles(); });
$("btn-batch-move").addEventListener("click", () => {
  if (!filesPicked.size) return toast("先勾选文件");
  moveAssetsFlow([...filesPicked], filesDir || "_assets");
});
$("btn-batch-del").addEventListener("click", () => {
  if (!filesPicked.size) return toast("先勾选文件");
  deleteAssetsFlow([...filesPicked]);
});
$("btn-batch-insert").addEventListener("click", () => {
  if (!filesPicked.size) return toast("先勾选文件");
  insertAssetsToNote([...filesPicked]);
});
// Esc 取消多选
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && filesPicked.size) { filesPicked = new Set(); renderFiles(); }
});

// ---- ![[资源名]] 卡片渲染钩子（markdown.js 会调它）------------------
// 查前端缓存的 _assets 清单，按类型产出卡片。查不到返回 null，
// markdown.js 会显示"文件不存在"的占位——不假装有。
// MD 里 ![[名]] 的卡片。类型标注要一眼看得出：色带 + 类型徽章 + 大小。
// 图片直接内嵌；视频/音频给播放条；其他给"打开"入口。
// ---- ![alt](路径) 块渲染钩子（markdown.js 会调它）----
// 正文里插入的文件可能写成四种样子：
//   _assets/图.png        （库内相对）
//   ../_assets/图.png     （老写法，要兼容）
//   子目录/视频.mp4       （带子目录）
//   图.png                （只有名字）
// 全部归一化后去索引里查；查到了按真实类型渲染，查不到返回 null 让上层退回 <img>。
// ---- [[@path:绝对路径]] 的引用块 ----
// 本机文件不在库里，所以不走 __refBlock（那边查的是库内索引）。
// 这里只显示"这是个本机文件、叫什么、点什么能打开"，绝不假装它能预览。
window.__refPath = (abs, name) => {
  const ext = String(name).split(".").pop().toLowerCase();
  const type = typeOfExt(ext);
  const dir = String(abs).replace(/[\\/][^\\/]*$/, "");
  return `<span class="ref-ext" data-ext-path="${escapeAttr(abs)}" title="${escapeAttr(abs)}">` +
    `<span class="re-ic">${icon(TYPE_ICONS[type] || "file", 18)}</span>` +
    `<span class="re-b"><span class="re-t">${escapeHtml(name)}</span>` +
    `<span class="re-m">本机文件 · ${escapeHtml(TYPE_LABEL[type] || "文件")} · 不在库内</span></span>` +
    `<span class="re-x">打开 ›</span></span>`;
};

window.__refBlock = (path, alt) => {
  const pool = window.__assets || {};
  // 归一化：去掉 ./ ../ ../routes/ _assets/ 这些前缀
  let key = String(path || "").trim();
  key = key.replace(/^\.\//, "").replace(/^(\.\.\/)+/, "").replace(/^routes\//, "").replace(/^_assets\//, "");
  // URL 解码：中文文件名在 Markdown 里常被编码成 %E4%B8%AD
  try { key = decodeURIComponent(key); } catch {}
  if (!key) return null;

  const f = pool[key] || pool[key.split("/").pop()];
  if (!f || f.isDir) return null;      // 目录、未知路径都交回上层，不硬造块

  const url = assetUrl(f.path);
  const label = alt || String(f.name || key).replace(/\.[^.]+$/, "");
  const size = fmtSize(f.size);

  if (f.type === "image") {
    return `<figure class="blk blk-img" data-ref-card="${escapeAttr(f.path)}">` +
      `<img data-asset="${escapeAttr(f.path)}" alt="${escapeAttr(label)}" loading="lazy">` +
      `<figcaption>${escapeHtml(label)} · ${escapeHtml(size)}</figcaption></figure>`;
  }
  if (f.type === "video") {
    return `<figure class="blk blk-media" data-ref-card="${escapeAttr(f.path)}">` +
      `<video src="${escapeAttr(url)}" controls preload="metadata"></video>` +
      `<figcaption>${escapeHtml(label)} · 视频 · ${escapeHtml(size)}</figcaption></figure>`;
  }
  if (f.type === "audio") {
    return `<figure class="blk blk-media" data-ref-card="${escapeAttr(f.path)}">` +
      `<audio src="${escapeAttr(url)}" controls preload="none"></audio>` +
      `<figcaption>${escapeHtml(label)} · 音频 · ${escapeHtml(size)}</figcaption></figure>`;
  }
  // PDF / Office / 压缩包 / 其他：给一个能点的文件条，点了在弹窗里预览
  const isPdf = /\.pdf$/i.test(f.path);
  return `<span class="blk blk-file" data-tint="${escapeAttr(f.type || "file")}" data-ref-card="${escapeAttr(f.path)}">` +
    `<span class="blk-ic">${icon(TYPE_ICONS[f.type] || "file", 18)}</span>` +
    `<span class="blk-b"><span class="blk-t">${escapeHtml(label)}</span>` +
    `<span class="blk-m">${escapeHtml(TYPE_LABEL[f.type] || (isPdf ? "PDF" : "文件"))} · ${escapeHtml(size)}</span></span>` +
    `<span class="blk-x">打开 ›</span></span>`;
};

window.__refCard = (name, alias) => {
  const key = String(name || "").replace(/^\.\//, "");
  const pool = window.__assets || {};
  const f = pool[key] || pool[key.split("/").pop()];
  const label = alias || key;
  if (!f) return null;
  const url = assetUrl(f.path);
  const tint = f.isDir ? "dir" : String(f.type || "file");
  const badge = f.isDir ? "文件夹" : (TYPE_LABEL[f.type] || "文件");
  const meta = f.isDir ? `${f.count ?? 0} 项` : fmtSize(f.size);

  if (f.isDir) {
    return `<span class="ref-card ref-card-dir" data-tint="${tint}" data-ref-card="${escapeAttr(f.path)}">` +
      `<span class="rc-ic">${icon("folder", 18)}</span>` +
      `<span class="rc-b"><span class="rc-t">${escapeHtml(label)}</span>` +
      `<span class="rc-m"><b class="rc-badge">${badge}</b> ${escapeHtml(meta)}</span></span>` +
      `<span class="rc-x">打开 ›</span></span>`;
  }

  if (f.type === "image") {
    // 用 data-asset 而不是 src：宿主要求凭据，img 直连会 403。
    return `<span class="ref-card ref-card-img" data-tint="${tint}" data-ref-card="${escapeAttr(f.path)}">` +
      `<img class="rc-img" data-asset="${escapeAttr(f.path)}" alt="${escapeAttr(label)}" loading="lazy">` +
      `<span class="rc-cap"><b class="rc-badge">图片</b> ${escapeHtml(label)} · ${escapeHtml(fmtSize(f.size))}</span></span>`;
  }

  // 视频/音频：给原生播放器，不用另外打开
  if (f.type === "video") {
    return `<span class="ref-card ref-card-media" data-tint="${tint}" data-ref-card="${escapeAttr(f.path)}">` +
      `<video class="rc-video" src="${escapeAttr(url)}" controls preload="metadata"></video>` +
      `<span class="rc-b"><span class="rc-t">${escapeHtml(label)}</span>` +
      `<span class="rc-m"><b class="rc-badge">视频</b> ${escapeHtml(fmtSize(f.size))}</span></span></span>`;
  }
  if (f.type === "audio") {
    return `<span class="ref-card ref-card-media" data-tint="${tint}" data-ref-card="${escapeAttr(f.path)}">` +
      `<span class="rc-ic">${icon("note", 18)}</span>` +
      `<span class="rc-b"><span class="rc-t">${escapeHtml(label)}</span>` +
      `<span class="rc-m"><b class="rc-badge">音频</b> ${escapeHtml(fmtSize(f.size))}</span>` +
      `<audio class="rc-audio" src="${escapeAttr(url)}" controls preload="none"></audio></span></span>`;
  }

  // 其他文件：图标 + 类型徽章 + 大小 + 打开入口
  return `<span class="ref-card" data-tint="${tint}" data-ref-card="${escapeAttr(f.path)}">` +
    `<span class="rc-ic">${icon(TYPE_ICONS[f.type] || "file", 18)}</span>` +
    `<span class="rc-b"><span class="rc-t">${escapeHtml(label)}</span>` +
    `<span class="rc-m"><b class="rc-badge">${escapeHtml(badge)}</b> ${escapeHtml(meta)}</span></span>` +
    `<span class="rc-x">打开 ›</span></span>`;
};

// ============ 文件管理器 END ============

// 4. 快速切换器与 AI 知识库问答（Ctrl+K / Ctrl+O）
async function openQuickSwitcher(initialAskMode = false) {
  const r = await API.get("/entries?limit=300");
  const pool = r.ok ? (r.entries || []) : state.entries;
  dialog({
    title: "✨ 快速跳转与 AI 知识库问答",
    bodyHtml:
      `<div class="row" style="gap:6px;margin-bottom:6px">` +
      `<input data-role="qs-input" placeholder="输入关键词秒跳笔记，或输入问题点右侧「问 AI」…" style="margin:0;flex:1">` +
      `<button type="button" class="ai-pill small" data-role="qs-ask-btn">✨ 问 AI</button>` +
      `</div>` +
      `<div data-role="qs-answer" class="ai-box" hidden></div>` +
      `<ul class="qs-list" data-role="qs-list"></ul>`,
    okText: "关闭",
    onMount: () => {
      const box = $("m-body");
      const inp = box.querySelector('[data-role="qs-input"]');
      const askBtn = box.querySelector('[data-role="qs-ask-btn"]');
      const ansBox = box.querySelector('[data-role="qs-answer"]');
      const listEl = box.querySelector('[data-role="qs-list"]');

      const renderList = () => {
        const q = inp.value.trim().toLowerCase();
        const hits = pool.filter((e) =>
          !q ||
          String(e.title || "").toLowerCase().includes(q) ||
          String(e.category || "").toLowerCase().includes(q) ||
          (e.tags || []).some((t) => t.toLowerCase().includes(q)) ||
          String(e.snippet || "").toLowerCase().includes(q)
        ).slice(0, 15);
        listEl.innerHTML = hits.length
          ? hits.map((e, i) =>
              `<li data-qid="${escapeAttr(e.id)}" class="${i === 0 ? "active" : ""}">` +
              `<span>${typeIcon(e.type)} <strong>${escapeHtml(e.title)}</strong></span>` +
              `<span class="muted">${escapeHtml(e.category)}</span></li>`
            ).join("")
          : `<li class="muted">无直接匹配笔记，可点右上角「✨ 问 AI」检索全库解答</li>`;
        for (const li of listEl.querySelectorAll("li[data-qid]")) {
          li.addEventListener("click", async () => {
            show($("modal"), false);
            showListView();
            await selectEntry(li.dataset.qid);
          });
        }
      };

      const runAsk = async () => {
        const q = inp.value.trim();
        if (!q) return toast("请先输入你的问题");
        ansBox.hidden = false;
        ansBox.innerHTML = `<span class="muted">✨ 正在检索收藏夹并调用 OpenHanako 模型思考…</span>`;
        const res = await API.post("/ai/ask", { question: q });
        if (!res.ok) {
          ansBox.innerHTML = `<span style="color:var(--c-danger)">❌ ${escapeHtml(res.error)}</span>`;
          return;
        }
        ansBox.innerHTML =
          `<div class="ai-via">回答引擎：${escapeHtml(res.via || "AI")}</div>` +
          `<div class="md">${renderMarkdown(res.answer)}</div>`;
        for (const a of ansBox.querySelectorAll("a[data-wikilink]")) {
          a.addEventListener("click", () => { show($("modal"), false); });
        }
      };

      inp.addEventListener("input", renderList);
      inp.addEventListener("keydown", async (ev) => {
        if (ev.key === "Enter" && !ev.isComposing) {
          ev.preventDefault();
          if (ev.shiftKey || initialAskMode) {
            await runAsk();
          } else {
            const first = listEl.querySelector("li[data-qid]");
            if (first) first.click();
            else await runAsk();
          }
        }
      });
      askBtn.addEventListener("click", runAsk);
      renderList();
      inp.focus();
    },
  });
}

$("btn-quick-ai")?.addEventListener("click", () => openQuickSwitcher(false));
$("btn-home-ai-ask")?.addEventListener("click", () => openQuickSwitcher(true));

// 全局快捷键（统一分层，绝不打架）：
// 1. Ctrl/Cmd + S：编辑态下立即保存
// 2. Ctrl/Cmd + K 或 Ctrl/Cmd + O：打开快速切换与 AI 问答
// 3. Escape：优先关 Wiki 补全 -> 关弹窗 -> 退出编辑态
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    if ($("edit") && !$("edit").hidden) {
      e.preventDefault();
      updateEntry();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "o")) {
    e.preventDefault();
    openQuickSwitcher(false);
    return;
  }
  if (e.key === "Escape") {
    if (Wiki.isOpen()) { Wiki.close(); return; }
    if ($("modal") && !$("modal").hidden) { $("m-cancel").click(); return; }
    if (clearWallPicked()) return;
    if ($("edit") && !$("edit").hidden) { setEditMode(false); }
  }
});

// ---------------- 首页总览 ----------------

// ---- 视图切换的唯一入口 ------------------------------------------------
// 右侧主区有三个互斥的 section：home（总览）/ wall（卡片墙）/ detail（详情）。
// 以前每个函数只管自己显隐，结果点树上收藏时 wall 还开着，
// 两个 section 同时显示，布局塌到左下。现在一律走 showView(name)：
// 它先把三个全关掉，再只开点名的那一个。
// 注意：edit（编辑器）不是这一层的，它在 detail 内部，由 setEditMode 管。
const VIEWS = ["home", "wall", "detail", "files"];
function showView(name) {
  for (const v of VIEWS) show($(v), v === name);
}

function showHome() {
  showView("home");
  show($("detail-hint"), false);
  state.selected = null;
  setActive($("btn-home"), true);
  // loadHome 是 async，必须接 .catch：
  // try 包不住 floating promise 的 rejection，那会把整个进程带走。
  Promise.resolve(loadHome()).catch((err) => {
    console.warn("[nian-vault] 首页数据加载失败：", err);
  });
  fitHomeToViewport();
}

function showListView() {
  setActive($("btn-home"), false);
  if (!state.selected) showView("detail");
}

// ---------------- 分栏把手：拖动改宽度，记在 localStorage ----------------
// 拖过之后下次打开还是你习惯的宽度；双击把手恢复默认。
(function wireSplitter() {
  const bar = $("splitter");
  const root = $("app");
  if (!bar || !root) return;
  const KEY = "nv.paneLeft";
  const DEF = 420, MIN = 280, MAX = 720;
  const read = () => Math.min(MAX, Math.max(MIN, Number(localStorage.getItem(KEY)) || DEF));
  const apply = (px, save) => {
    const w = Math.min(MAX, Math.max(MIN, Math.round(px)));
    root.style.setProperty("--pane-left", `${w}px`);
    if (save) localStorage.setItem(KEY, String(w));
    return w;
  };
  apply(read(), false);

  let dragging = false;
  bar.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    dragging = true;
    bar.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  const current = () => {
    const raw = getComputedStyle(root).getPropertyValue("--pane-left").trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : DEF;
  };
  window.addEventListener("mousemove", (ev) => { if (dragging) apply(ev.clientX - root.getBoundingClientRect().left, false); });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove("dragging");
    document.body.classList.remove("resizing");
    apply(current(), true);
  });
  bar.addEventListener("dblclick", () => { localStorage.removeItem(KEY); apply(DEF, false); });
  // 键盘也能调，不只靠鼠标
  bar.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 40 : 12;
    if (ev.key === "ArrowLeft") { ev.preventDefault(); apply(read() - step, true); }
    if (ev.key === "ArrowRight") { ev.preventDefault(); apply(read() + step, true); }
  });
})();

async function loadHome() {
  let r;
  try {
    r = await API.get("/home");
  } catch (err) {
    // 拉不到数据就保持首页的空态，不抛——抛出去会把调用方带崩
    console.warn("[nian-vault] /home 请求失败：", err?.message || err);
    return;
  }
  if (!r.ok) { toast(`❌ ${r.error}`); return; }
  const { todos = [], hiddenTodos = [], recent = [], homePinned = [], inbox = [], tree = [], tags = [], categories = [] } = r;
  const openCount = todos.reduce((s, g) => s + g.open, 0);
  const total = categories.reduce((s, c) => s + (c.count || 0), 0);
  $("home-stats").textContent = `${total} 条收藏 · ${todos.length} 篇有待办 · 未完成 ${openCount} 项`;
  // 每块单独渲染：某块数据畸形只该让那一块空着，不该让整个首页消失
  const blocks = [
    () => renderHomeEntries("home-inbox", inbox, "收件箱是空的，也没有待确认的收藏。对话里点「📥 收入念念收藏夹」可先挑选内容。"),
    () => { const inboxCount = inbox.length || state.categories.find((c) => c.name === "收件箱")?.count || 0; show($("inbox-acts"), inboxCount > 0); },
    () => renderClipStageSlot().catch(() => {}),
    () => renderHomeTodos(todos, hiddenTodos),
    () => renderHomeEntries("home-pinned", homePinned, "还没有固定内容：打开一条笔记，点顶栏的 📌"),
    () => renderRecentCapped(recent),
    () => renderTagCloud(tags),
    () => renderCatBars(categories, total),
  ];
  for (const b of blocks) {
    try { b(); } catch (err) { console.warn("[nian-vault] 首页某块渲染失败：", err); }
  }
}

// 最近打开：默认只显示 8 条，剩下的收在「展开全部」后面，不撑爆容器
function renderRecentCapped(recent) {
  const CAP = 8;
  const box = $("home-recent");
  const more = $("btn-recent-more");
  const shown = recent.slice(0, CAP);
  renderHomeEntries("home-recent", shown, "还没有打开记录", (e) => (e.opened ? String(e.opened).slice(5, 10) : ""));
  const rest = recent.slice(CAP);
  more.hidden = rest.length === 0;
  more.textContent = `展开其余 ${rest.length} 条 →`;
  more.onclick = () => {
    renderHomeEntries("home-recent", recent, "还没有打开记录", (e) => (e.opened ? String(e.opened).slice(5, 10) : ""));
    more.hidden = true;
  };
}

// 标签云：字号随数量浮动，点一下直接按标签筛选
// 卡片墙：点分类标题或点标签，把相关收藏横向铺在右侧空白区。
// 「上一条/下一条」在同一批结果里跳，不用退回墙；「←」回到总览。
// 排序按需切，记住上次选的那个。
let wallList = [];
let wallIndex = -1;
let wallKind = "";
let wallValue = "";
let wallSort = localStorage.getItem("nv.wallSort") || "updated";

const WALL_SORTS = {
  updated: (a, b) => String(b.updated || "").localeCompare(String(a.updated || "")),
  created: (a, b) => String(b.created || b.updated || "").localeCompare(String(a.created || a.updated || "")),
  title: (a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh"),
  pinned: (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.updated || "").localeCompare(String(a.updated || "")),
  // 「常读」按最近一次打开的时间排：库里只记 opened 时间戳，没有次数统计，
  // 所以叫「常读优先」名不副实，改成最近读过
  reads: (a, b) => String(b.opened || "").localeCompare(String(a.opened || "")),
};

// kind: "category" | "tag"；value: 分类名或标签名
async function openWall(kind, value) {
  const q = kind === "tag"
    ? `/entries?tag=${encodeURIComponent(value)}&limit=300`
    : `/entries?category=${encodeURIComponent(value)}&limit=300`;
  const r = await API.get(q);
  if (!r.ok) return toast(`❌ ${r.error}`);
  wallList = [...(r.entries || [])];
  if (!wallList.length) {
    toast(kind === "tag" ? `「#${value}」下还没有收藏` : `「${value}」还是空的`);
    return;
  }
  wallKind = kind;
  wallValue = value;
  wallIndex = 0;
  wallPicked.clear();   // 换分类/标签时上一批勾选作废
  wallSelectMode = false;
  renderWall();
  showWall(true);
}

function renderWall() {
  const name = wallKind === "tag" ? `#${wallValue}` : wallValue;
  const sorter = WALL_SORTS[wallSort] || WALL_SORTS.updated;
  const list = [...wallList].sort(sorter);
  // 排序后 index 可能指向别的条目，按 id 记住当前那张
  const curId = wallList[wallIndex]?.id;
  wallList = list;
  wallIndex = Math.max(0, list.findIndex((e) => e.id === curId));
  $("wall-name").textContent = name;
  $("wall-count").textContent = `${wallList.length} 条`;
  // 收件箱专属动作只在看收件箱时露出来
  show($("wall-inbox-acts"), wallKind === "category" && wallValue === "收件箱");
  // 多选态：进了多选就只显示勾选框，普通点击变成勾选/取消。
  // 这个 class 是复选框显隐的唯一开关（CSS 里 .wall-cards.wall-multi .wcard-check）。
  const multi = wallSelectMode || wallPicked.size > 0;
  $("wall-cards").classList.toggle("wall-multi", multi);
  $("wall-cards").innerHTML = wallList.map((e, i) => {
    const picked = wallPicked.has(e.id);
    // 库内上传的图片直接露封面；本地引用的图 iframe 读不到，只给角标
    const cover = (e.type === "image" && e.ref?.target?.startsWith("_assets/"))
      ? `<img class="wcard-cover" src="${assetUrl(e.ref.target)}" alt="" loading="lazy">`
      : "";
    return `<button class="wcard${i === wallIndex ? " active" : ""}${picked ? " picked" : ""}${cover ? " has-cover" : ""}" data-i="${i}" data-id="${e.id}">
      <span class="wcard-check" data-check="1">${picked ? "✓" : ""}</span>
      ${cover || `<span class="wcard-type">${icon(TYPE_ICONS[e.type] || "note", 13)}</span>`}
      <span class="wcard-body">
        <span class="wcard-title">${escapeHtml(e.title)}</span>
        <span class="wcard-snippet">${escapeHtml(e.snippet || e.content || "").slice(0, 90)}</span>
        <span class="wcard-meta">${wallKind === "tag" ? escapeHtml(e.category) : (e.tags || []).map((t) => `#${escapeHtml(t)}`).join(" ") || escapeHtml(e.category)}${e.parentTitle ? ` ↳ ${escapeHtml(e.parentTitle)}` : ""}${refBadge(e) ? ` · ${escapeHtml(refBadge(e))}` : ""}</span>
      </span>
      ${e.pinned ? '<span class="wcard-pin" title="已置顶">★</span>' : ""}
    </button>`;
  }).join("");
  for (const b of $("wall-cards").querySelectorAll(".wcard")) {
    // 右键菜单：卡片墙上每张卡都能右键，动作与顶栏 ⋯ 一致（先选中再点 mi-*）
    b.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const id = b.dataset.id;
      const e = wallList.find((x) => x.id === id);
      if (!e) return;
      const act = (btnId) => async () => {
        await selectCategory(wallKind === "category" ? wallValue : "");
        await selectEntry(id);
        $(btnId)?.click();
      };
      treeMenu(ev, [
        { label: "📖 打开", run: async () => {
            showWall(false);
            if (wallKind === "category") await selectCategory(wallValue);
            else await selectCategory("");
            await selectEntry(id);
          } },
        { label: e.pinned ? "☆ 取消置顶" : "★ 置顶", run: async () => {
            const r = await API.post("/entry", { id, pinned: !e.pinned });
            if (!r.ok) return toast(`❌ ${r.error}`);
            toast(!e.pinned ? "★ 已置顶" : "☆ 已取消置顶");
            await loadEntries(); renderWall();
          } },
        { label: "📌 钉成卡片", run: act("mi-board") },
        { label: "⧉ 复制全文", run: act("mi-copy") },
        { label: "⬇ 导出为 .md", run: act("mi-export") },
        { label: "☑ 加入多选", run: () => { wallSelectMode = true; wallPicked.add(id); renderWall(); } },
        { label: "🗑 删除", danger: true, run: act("mi-delete") },
      ]);
    });
    b.addEventListener("click", async (ev) => {
      const id = b.dataset.id;
      // 多选态：点卡片 = 勾选/取消；Ctrl/Shift 点 = 加入多选
      // 普通点击（没进多选、也没按修饰键）= 打开详情
      const wantMulti = wallSelectMode || wallPicked.size > 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey;
      if (wantMulti) {
        if (wallPicked.has(id)) wallPicked.delete(id);
        else wallPicked.add(id);
        wallIndex = Number(b.dataset.i);
        renderWall();
        renderWallBatchBar();
        return;
      }
      wallIndex = Number(b.dataset.i);
      for (const x of $("wall-cards").querySelectorAll(".wcard")) x.classList.remove("active");
      b.classList.add("active");
      showWall(false);
      // 关墙后紧接着开详情：selectCategory/selectEntry 内部都会
      // 走 showView，所以这里不用自己开。
      if (wallKind === "category") await selectCategory(wallValue);
      else await selectCategory("");
      await selectEntry(b.dataset.id);
    });
  }
  $("btn-wall-prev").disabled = wallIndex <= 0;
  $("btn-wall-next").disabled = wallIndex >= wallList.length - 1;
  $("wall-cards").querySelector(".wcard.active")?.scrollIntoView?.({ block: "nearest" });
  renderWallBatchBar();
}

// 多选集合：墙内勾了哪些条目
let wallPicked = new Set();
// 多选态：进了多选就显示勾选框（但一张都没勾），由用户自己点
let wallSelectMode = false;

// 批量操作栏：进了多选态就出现（哪怕一张都没勾），
// 没进多选时藏起来。全选/取消全选是同一个按钮，文字跟着状态变。
function renderWallBatchBar() {
  const bar = $("wall-batch");
  if (!bar) return;
  if (!wallSelectMode && !wallPicked.size) { bar.hidden = true; bar.innerHTML = ""; return; }
  const allPicked = wallList.length > 0 && wallPicked.size === wallList.length;
  bar.hidden = false;
  bar.innerHTML =
    `<span class="batch-n">已选 <b>${wallPicked.size}</b> / ${wallList.length}</span>` +
    `<button data-op="toggle-all">${allPicked ? "取消全选" : "全选"}</button>` +
    `<button data-op="move">📦 移动到…</button>` +
    `<button data-op="tag">🏷 加标签</button>` +
    `<button data-op="pin">★ 置顶</button>` +
    `<button data-op="homePin">📌 固定到首页</button>` +
    `<button data-op="delete" class="danger">🗑 删除</button>` +
    `<span class="grow"></span>` +
    `<button data-op="clear">退出多选</button>`;
  for (const btn of bar.querySelectorAll("button")) {
    btn.addEventListener("click", () => wallBatch(btn.dataset.op));
  }
}

async function wallBatch(op) {
  if (op === "clear") { wallPicked.clear(); wallSelectMode = false; renderWall(); return; }
  if (op === "toggle-all") {
    if (wallPicked.size === wallList.length) wallPicked.clear();
    else for (const e of wallList) wallPicked.add(e.id);
    renderWall();
    return;
  }
  const ids = [...wallPicked];
  if (!ids.length) return toast("先勾选要操作的收藏");

  if (op === "move") {
    const to = await pickCategory(wallKind === "category" ? wallValue : "");
    if (!to) return;
    await runBatch("move", ids, { category: to }, `已移动 ${ids.length} 条到「${to}」`);
    return;
  }
  if (op === "tag") {
    const raw = await promptText("添加标签", "", "多个标签用逗号分隔");
    if (!raw) return;
    const tags = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!tags.length) return toast("没解析出标签");
    await runBatch("tag", ids, { tags }, `已给 ${ids.length} 条加上 ${tags.length} 个标签`);
    return;
  }
  if (op === "delete") {
    const label = wallKind === "tag" ? `#${wallValue}` : wallValue;
    const ok = await confirmBox(`删除选中的 ${ids.length} 条收藏？`,
      `这些是「${label}」下你勾选的条目。删除后会进回收目录，无法直接恢复。`);
    if (!ok) return;
    await runBatch("delete", ids, {}, `已删除 ${ids.length} 条`);
    return;
  }
  const verb = op === "pin" ? "置顶" : "固定到首页";
  await runBatch(op, ids, {}, `已把 ${ids.length} 条${verb}`);
}

async function runBatch(op, ids, extra, successMsg) {
  const r = await API.post("/entries/batch", { op, ids, ...extra });
  if (!r.ok) return toast(`❌ ${r.error}`);
  // 有失败就如实说，不拿"成功了一部分"糊弄
  if (r.failed && r.failed.length) {
    toast(`⚠ ${successMsg}；${r.failed.length} 条失败：${r.failed[0].error}`, 6000);
  } else {
    toast(`✓ ${successMsg}`);
  }
  wallPicked.clear();
  wallSelectMode = false;
  await loadCategories();
  await loadEntries();
  // 重新拉这批数据，墙要反映最新状态
  await openWall(wallKind, wallValue);
}

function showWall(on) {
  // 关墙时不自动开首页：墙内点卡片要接着开详情，
  // 只有「←」按钮那一处才显式回首页。
  if (on) {
    showView("wall");
    setActive($("btn-home"), false);
  }
}

function wallStep(delta) {
  const next = wallIndex + delta;
  if (next < 0 || next >= wallList.length) return;
  wallIndex = next;
  renderWall();
}

$("btn-wall-back").addEventListener("click", () => { showWall(false); showHome(); });
$("btn-wall-prev").addEventListener("click", () => wallStep(-1));
$("btn-wall-next").addEventListener("click", () => wallStep(1));
$("wall-sort").addEventListener("change", (ev) => {
  wallSort = ev.target.value;
  try { localStorage.setItem("nv.wallSort", wallSort); } catch {}
  renderWall();
});
$("wall-sort").value = wallSort;

// 「☑ 多选」按钮：进入多选态（只显示勾选框，不替用户勾任何东西），
// 再点一次退出。全选/取消全选交给批量栏里的按钮，由用户自己决定。
$("btn-wall-select").addEventListener("click", () => {
  if (wallPicked.size) {
    wallPicked.clear();
    renderWall();
    return;
  }
  // 进多选态：用一个哨兵让 renderWall 知道该显示勾选框，
  // 但 wallPicked 仍是空的，一张都没勾
  wallSelectMode = true;
  renderWall();
  toast("多选模式：点卡片勾选，批量栏里可全选");
});

// Esc 退出多选
function clearWallPicked() {
  if (!wallPicked.size && !wallSelectMode) return false;
  wallPicked.clear();
  wallSelectMode = false;
  renderWall();
  return true;
}

function renderTagCloud(tags) {
  const box = $("home-tags");
  if (!tags.length) {
    box.innerHTML = `<span class="muted empty-hint">还没有标签。</span>`;
    return;
  }
  const max = Math.max(...tags.map((t) => t.count || 0), 1);
  const min = Math.min(...tags.map((t) => t.count || 0));
  box.innerHTML = tags.slice(0, 40).map((t) => {
    const c = t.count || 0;
    const w = max === min ? 1 : (c - min) / (max - min);
    const size = (12 + w * 5).toFixed(1);
    const weight = w > 0.6 ? 650 : w > 0.3 ? 550 : 450;
    return `<button class="tag-chip" style="font-size:${size}px;font-weight:${weight}" data-tag="${escapeAttr(t.name)}" title="${c} 条收藏">#${escapeHtml(t.name)}<span class="tag-n">${c}</span></button>`;
  }).join("");
  for (const b of box.querySelectorAll(".tag-chip")) {
    b.addEventListener("click", () => {
      // 再点一次同一个标签 = 收起
      const tag = b.dataset.tag;
      if (!$("wall").hidden && wallKind === "tag" && wallValue === tag) {
        showWall(false);
        showHome();
        return;
      }
      state.filter.tag = tag;
      openWall("tag", tag);
    });
  }
}

// 分类占比：横向条，一眼看出收藏都堆在哪
function renderCatBars(categories, total) {
  const box = $("home-catbars");
  const rows = categories.filter((c) => (c.count || 0) > 0).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 8);
  if (!rows.length || !total) {
    box.innerHTML = `<span class="muted empty-hint">还没有收藏。</span>`;
    return;
  }
  const palette = ["nv-c1", "nv-c2", "nv-c3", "nv-c4", "nv-c5", "nv-c6"];
  box.innerHTML = rows.map((c, i) => {
    const pct = Math.round(((c.count || 0) / total) * 100);
    return `<button class="catbar" data-cat="${escapeAttr(c.name)}" title="${c.count} 条 · 点进去看看">` +
      `<span class="catbar-name">${escapeHtml(c.name)}</span>` +
      `<span class="catbar-track"><span class="catbar-fill ${palette[i % palette.length]}" style="width:${Math.max(3, pct)}%"></span></span>` +
      `<span class="catbar-n">${c.count}</span></button>`;
  }).join("");
  for (const b of box.querySelectorAll(".catbar")) {
    b.addEventListener("click", async () => {
      showListView();
      await selectCategory(b.dataset.cat);
    });
  }
}

function renderHomeTodos(groups, hidden) {
  const box = $("home-todos");
  if (!groups.length && !hidden.length) {
    box.innerHTML = `<div class="muted empty-hint">还没有待办。在笔记里输 <code>- [ ] 事项</code>（或点详情页「✨ AI 助手」提取待办），就会出现在这里。</div>`;
    return;
  }
  // 只展开第一个还有未完成项的组，其余收起——否则一屏全是待办，别的内容被挤没了
  const firstOpen = groups.findIndex((g) => g.open > 0);
  box.innerHTML =
    groups.map((g, i) =>
    `<details class="todo-group"${i === firstOpen ? " open" : ""}>
      <summary>
        <span class="tg-title">${escapeHtml(g.title)}</span>
        <span class="tg-cat">${escapeHtml(g.category)}</span>
        <span class="tg-count">${g.open}/${g.total}</span>
      </summary>
      <div class="tg-jump"><button class="link-btn" data-open="${g.id}">打开笔记</button><button class="link-btn" data-hide="${g.id}">不显示此篇</button></div>
      <ul class="task-list">
        ${g.todos.map((t) =>
          `<li><label><input type="checkbox" data-task data-id="${g.id}" data-line="${t.line}"${t.done ? " checked" : ""}><span class="tx${t.done ? " done" : ""}">${escapeHtml(t.text)}</span></label></li>`
        ).join("")}
      </ul>
    </details>`).join("") +
    (hidden.length
      ? `<details class="todo-group todo-hidden"><summary><span class="tg-title">已隐藏 ${hidden.length} 篇</span><span class="tg-count">点开可恢复</span></summary>
         <ul class="task-list">${hidden.map((h) => `<li><button class="link-btn" data-show="${h.id}">恢复</button> ${escapeHtml(h.title)} <span class="muted">(${h.open}/${h.total})</span></li>`).join("")}</ul></details>`
      : "");
  for (const cb of box.querySelectorAll("input[data-task]")) {
    cb.addEventListener("change", async () => {
      const res = await API.post("/task/toggle", { id: cb.dataset.id, line: Number(cb.dataset.line) });
      if (!res.ok) { cb.checked = !cb.checked; return toast(`❌ ${res.error}`); }
      cb.closest("label").querySelector(".tx").classList.toggle("done", cb.checked);
      const grp = cb.closest(".todo-group");
      const cnt = grp.querySelector(".tg-count");
      const left = [...grp.querySelectorAll("input[data-task]")].filter((x) => !x.checked).length;
      cnt.textContent = `${left}/${grp.querySelectorAll("input[data-task]").length}`;
      if (cb.checked) toast("✓ 已完成一项");
    });
  }
  for (const b of box.querySelectorAll("[data-open]")) {
    b.addEventListener("click", async () => { showListView(); await selectCategory(""); await selectEntry(b.dataset.open); });
  }
  for (const b of box.querySelectorAll("[data-hide]")) {
    b.addEventListener("click", async () => {
      await API.post("/entry/pref", { id: b.dataset.hide, hideTodos: true });
      toast("✓ 已隐藏，可在首页「已隐藏」区恢复");
      loadHome();
    });
  }
  for (const b of box.querySelectorAll("[data-show]")) {
    b.addEventListener("click", async () => {
      await API.post("/entry/pref", { id: b.dataset.show, hideTodos: false });
      toast("✓ 已恢复显示");
      loadHome();
    });
  }
}

function renderHomeEntries(boxId, items, emptyText, extra) {
  const box = $(boxId);
  if (!items.length) {
    box.innerHTML = `<li class="muted empty-hint">${escapeHtml(emptyText)}</li>`;
    return;
  }
  box.innerHTML = items.map((e) =>
    `<li class="hl" data-id="${e.id}">
      <span class="hl-t">${escapeHtml(e.title)}</span>
      <span class="hl-c">${escapeHtml(e.category)}</span>
      ${extra ? `<span class="hl-d">${escapeHtml(extra(e))}</span>` : ""}
    </li>`).join("");
  for (const li of box.querySelectorAll(".hl")) {
    li.addEventListener("click", async () => { showListView(); await selectCategory(""); await selectEntry(li.dataset.id); });
    // 右键菜单：和文件管理器、侧栏一套行为。
    // 做法是复用顶栏 ⋯ 菜单已有的动作——先选中这条，再点对应的 mi-* 按钮，
    // 不另写一套复制/固定/导出/删除（写了就会两边行为不一致）。
    li.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const e = items.find((x) => x.id === li.dataset.id);
      if (!e) return;
      const act = (btnId) => async () => {
        await selectCategory("");
        await selectEntry(e.id);
        $(btnId)?.click();
      };
      treeMenu(ev, [
        { label: "📖 打开", run: async () => { await selectCategory(""); await selectEntry(e.id); } },
        { label: "📌 钉成卡片", run: act("mi-board") },
        { label: "⧉ 复制全文", run: act("mi-copy") },
        { label: "⬇ 导出为 .md", run: act("mi-export") },
        { label: "🗑 删除", danger: true, run: act("mi-delete") },
      ]);
    });
  }
}

$("btn-home").addEventListener("click", showHome);

// 反向链接 + 未链接提及（思源/Obsidian 风格，支持一键把提及转为 [[双链]]）
async function loadBacklinks(entryId, entryTitle) {
  const r = await API.get(`/entry/backlinks?id=${encodeURIComponent(entryId)}`);
  const links = r.backlinks || [];
  const mentions = r.mentions || [];
  const panel = $("backlinks");
  const list = $("bl-list");
  const count = $("bl-count");
  if (!links.length && !mentions.length) {
    show(panel, false);
    return;
  }
  count.textContent = `(${links.length}${mentions.length ? ` + 提及 ${mentions.length}` : ""})`;
  const linkHtml = links.map((link) =>
    `<li>🔗 <a href="#" data-id="${escapeAttr(link.id)}">${escapeHtml(link.title)}</a><span class="muted"> — ${escapeHtml(link.category)}</span></li>`
  ).join("");
  const mentionHtml = mentions.length
    ? `<li class="muted" style="margin-top:8px;font-weight:600">💡 提及但未加双链：</li>` +
      mentions.map((m) =>
        `<li><a href="#" data-id="${escapeAttr(m.id)}">${escapeHtml(m.title)}</a> <span class="muted">(${escapeHtml(m.category)})：${escapeHtml(m.excerpt)}</span> ` +
        `<button type="button" class="link-btn" data-link-mention="${escapeAttr(m.id)}" data-target-title="${escapeAttr(entryTitle)}">[🔗 转为双链]</button></li>`
      ).join("")
    : "";
  list.innerHTML = linkHtml + mentionHtml;
  show(panel, true);
  for (const a of list.querySelectorAll("a[data-id]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      selectEntry(a.dataset.id);
    });
  }
  for (const btn of list.querySelectorAll("button[data-link-mention]")) {
    btn.addEventListener("click", async () => {
      const res = await API.post("/entry/link-mention", {
        sourceId: btn.dataset.linkMention,
        targetTitle: btn.dataset.targetTitle,
      });
      if (!res.ok) return toast(`❌ ${res.error}`);
      toast("✓ 已将该处提及转为双向链接");
      await loadBacklinks(entryId, entryTitle);
    });
  }
}

// 本页目录改成按需浮层：左侧树负责条目导航，目录只负责本文标题跳转。
$("btn-toc-toggle").addEventListener("click", () => show($("toc"), $("toc").hidden));
$("btn-toc-fold").addEventListener("click", () => show($("toc"), false));
$("btn-toc-unfold").addEventListener("click", () => show($("toc"), true));

function buildTOC(content) {
  const toc = $("toc");
  const tocList = $("toc-list");
  const lines = String(content || "").split("\n");
  const headings = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), idx: headings.length });
  }
  if (!headings.length) {
    show(toc, false);
    show($("btn-toc-toggle"), false);
    show($("btn-toc-unfold"), false);
    return;
  }
  tocList.innerHTML = headings.map((h) =>
    `<li class="toc-level-${h.level}"><a href="#" data-hidx="${h.idx}">${escapeHtml(h.text)}</a></li>`
  ).join("");
  show(toc, false);
  show($("btn-toc-toggle"), true);
  for (const a of tocList.querySelectorAll("a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = $("v-body").querySelectorAll("h1, h2, h3, h4, h5, h6")[Number(a.dataset.hidx)];
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      show(toc, false);
    });
  }
}

// 监听 [[wiki-link]] 点击
document.addEventListener("click", async (e) => {
  const link = e.target.closest("a[data-wikilink]");
  if (!link) return;
  e.preventDefault();
  const title = link.dataset.title;
  if (!title) return;
  const r = await API.get(`/entries?q=${encodeURIComponent(title)}`);
  if (!r.ok) return toast(`❓ ${r.error}`);
  const found = (r.entries || []).find((e) => e.title.toLowerCase() === title.toLowerCase());
  if (found) {
    await selectEntry(found.id);
  } else {
    dialog({
      title: `创建「${title}」？`,
      bodyHtml: `<p>没有找到名为「${escapeHtml(title)}」的笔记。要在当前分类下新建一条吗？</p>`,
      okText: "新建",
      onOk: async () => {
        const create = await API.post("/entry", { title, content: "", category: state.filter.category || "" });
        if (!create.ok) return toast(`❌ ${create.error}`);
        await loadCategories();
        await loadEntries();
        await selectEntry(create.entry.id);
      },
    });
  }
});

// ---------------- 图片与文件上传 + 树节点拖入编辑器生成双链 ----------------
async function uploadAsset(file, fallbackName) {
  const formData = new FormData();
  formData.append("file", file, file.name || fallbackName || "clipboard.png");
  const r = await hana.api.fetch("/asset/upload", { method: "POST", body: formData });
  return r.json();
}

$("vditor-mount")?.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      e.preventDefault();
      e.stopPropagation();
      const file = item.getAsFile();
      if (!file) continue;
      const json = await uploadAsset(file);
      if (json.ok) {
        Editor.insert(`![](${json.path})`);
        toast("✓ 图片已上传");
      } else {
        toast(`❌ ${json.error}`);
      }
    }
  }
}, true);

$("vditor-mount")?.addEventListener("drop", async (e) => {
  // 1. 若是从左侧树拖过来的笔记节点，直接在光标处插入 [[条目标题]] 双链
  const nvTitle = e.dataTransfer?.getData("text/nv-title");
  if (nvTitle) {
    e.preventDefault();
    e.stopPropagation();
    Editor.insert(`[[${nvTitle}]]`);
    toast(`✓ 已插入双链 [[${nvTitle}]]`);
    return;
  }
  // 2. 若是外部文件，执行资源上传
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  for (const file of files) {
    const isImg = file.type.startsWith("image/");
    const json = await uploadAsset(file);
    if (!json.ok) { toast(`❌ ${file.name}：${json.error}`); continue; }
    Editor.insert(isImg ? `![${file.name}](${json.path})` : `[${file.name}](${json.path})`);
    toast(`✓ ${file.name} 已复制进库`);
  }
}, true);

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

// 屏幕适配：把视口高度写进 CSS 变量，各栏据此分配可滚高度。
// 一屏装下总览；内容超了在栏内滚，不把整页拉长。
function fitHomeToViewport() {
  const home = $("home");
  if (!home || home.hidden) return;
  const h = window.innerHeight;
  // 高度分档：首页可用高度占视口的比例
  const budget = h <= 620 ? 0.62 : h <= 800 ? 0.70 : h <= 1000 ? 0.74 : 0.78;
  document.documentElement.style.setProperty("--home-budget", String(budget));
  // 标记当前高度档，CSS 按档微调
  document.body.dataset.homeH = h <= 620 ? "xs" : h <= 800 ? "s" : h <= 1000 ? "m" : "l";
}
window.addEventListener("resize", fitHomeToViewport);

// 首次加载与窗口重新聚焦时刷新候选数量，不用常驻轮询。
refreshClipStage();
window.addEventListener("focus", refreshClipStage);

// ---------------- 启动 ----------------
// 铁律：界面必须先出来，数据后到。
// 以前 loadStatus() 在链首，它一抛（surface 未就绪、权限没批、库路径失效）
// 整个 try 中断，showHome() 永远不执行 → 用户看到一片空白加一行红字。
// 现在反过来：先画骨架，再逐项拉数据，每项单独容错。
showView("detail");
show($("detail-hint"), true);
$("v-title").textContent = "";
$("v-meta").innerHTML = "";

(async () => {
  const steps = [
    ["状态", loadStatus],
    ["分类", loadCategories],
  ];
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      // 单项失败只报告那一项，不阻塞后面的，更不阻塞界面
      console.warn(`[nian-vault] ${label}加载失败：`, err?.message || err);
      toast(`⚠ ${label}没加载出来：${err?.message || err}`, 5000);
    }
  }
  // 最后一定落到总览：哪怕上面全挂，首页的壳子和空态提示也在
  try {
    showHome();
  } catch (err) {
    console.warn("[nian-vault] 首页渲染失败：", err);
    $("home").hidden = false;
  }
})();

hana.ready().then(() => {
  // 握手完成后重拉一次：启动时 surface 可能还没就绪，那批请求全失败了
  loadStatus().catch(() => {});
  loadCategories().catch(() => {});
}).catch(() => {});

// 拉 _assets 全量扁平索引，供 refCard 查。
// 用 /assets/index 而不是自己递归 /assets/list：
//   - 后端一次给全、带 mtime 指纹缓存，不会像前端递归那样被深度上限截断
//   - 前端递归在深目录/多文件时会打出几十个请求，慢且容易漏
async function refreshAssetIndex() {
  const idx = {};
  try {
    const r = await API.get("/assets/index");
    if (r.ok) {
      for (const f of r.items || []) {
        idx[f.name] = f;
        idx[f.path] = f;
        // 不带扩展名的相对路径也建一份索引：![[子目录/名字]] 这种写法能查到
        const noExt = f.path.replace(/\.[^./]+$/, "");
        if (noExt !== f.path) idx[noExt] = f;
      }
    }
  } catch { /* 索引拉不到时 refCard 会显示"文件不存在"，不崩 */ }
  window.__assets = idx;
  // 有索引了就立刻重绘一次正文，否则首页那些早渲染好的笔记还是"文件不存在"
  try { if (typeof rerenderOpenEntry === "function") rerenderOpenEntry(); } catch {}
  return idx;
}

// 资源有变动（上传/删除/改名/移动）后，正文里的卡片要跟着刷新。
// 做法是重新 selectEntry 一次——它内部会拉最新数据并重绘，不用另写一套。
// 只在查看模式触发：编辑中重绘会把用户正在打的字冲掉。
function rerenderOpenEntry() {
  if (!state.selected) return;
  if (!$("edit")?.hidden) return;              // 正在编辑，不打扰
  if (!$("detail")?.hidden) return;            // 不在详情页
  selectEntry(state.selected).catch(() => {});
}

// 卡片点击：跳到文件管理器并选中
function bindRefCards(root) {
  for (const c of (root || document).querySelectorAll("[data-ref-card], [data-ext-path]")) {
    if (c.__bound) continue;
    c.__bound = true;
    // 视频/音频本身有控件，点播放器不该跳走
    if (c.querySelector("video, audio")) continue;
    // 本机文件引用：点击直接用系统应用打开原件（不预览，因为文件不在库内）
    if (c.classList.contains("ref-ext") || c.dataset.extPath) {
      c.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const abs = c.dataset.extPath;
        if (!abs) return;
        await openWithSystem(abs);
      });
      continue;
    }
    c.addEventListener("click", () => {
      const fp = c.dataset.refCard;
      // 只有"真的是图片块"才走灯箱。
      // 不能用「里面有 img 标签」来判断——PDF/视频块里也可能有占位图，
      // 那样会被误判成图片、永远进不了预览。
      const isImgBlock = c.classList.contains("blk-img") || c.classList.contains("ref-card-img");
      if (isImgBlock) return lightbox(assetUrl(fp), fp.split("/").pop());
      return previewAsset(fp);
    });
  }
}

// 图片放大：点一下看大图，再点关掉。比"跳去文件管理器"直接得多。
function lightbox(url, name) {
  const old = document.getElementById("lightbox");
  if (old) old.remove();
  const box = document.createElement("div");
  box.id = "lightbox";
  box.className = "lightbox";
  box.innerHTML =
    `<img src="${escapeAttr(url)}" alt="${escapeAttr(name || "")}">` +
    `<div class="lb-cap">${escapeHtml(name || "")}</div>`;
  document.body.appendChild(box);
  const close = () => { box.remove(); document.removeEventListener("keydown", onEsc); };
  const onEsc = (ev) => { if (ev.key === "Escape") close(); };
  box.addEventListener("click", close);
  document.addEventListener("keydown", onEsc);
}
