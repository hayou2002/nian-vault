// 轻量 Markdown 渲染器：先整体转义 HTML，再做语法替换，因此不会执行内容里的脚本。
// 支持：标题、段落、粗体/斜体/删除线、行内代码、代码块、引用、有序/无序/任务列表、表格、分割线、链接、图片、![[资源]] 卡片。

// 库内资源的绝对 URL 解析：由宿主页面注入（window.__resolveAsset）。
// 没注入时退化成原路径——宁可裂图，也不要抛异常把整个渲染打断。
function resolveAssetDefault(p) { return p; }
let resolveAsset = resolveAssetDefault;
export function setResolveAsset(fn) { resolveAsset = typeof fn === "function" ? fn : resolveAssetDefault; }

// ![alt](路径) 的块渲染钩子：由宿主页面注入（window.__refBlock）。
// 返回 HTML 表示"这个路径是库内资源，按它的真实类型渲染"；返回 null 表示不是，退回 <img>。
let refPathWarned = false;

function refBlock(path, alt) {
  const fn = (typeof window !== "undefined" && window.__refBlock) || null;
  if (typeof fn !== "function") return null;
  try {
    return fn(path, alt) || null;
  } catch (err) {
    // 不静默吞：钩子写错时如果什么都不说，界面只会表现为"文件又裂了"，
    // 排查成本极高。打出一次就够，别刷屏。
    if (!refBlock.warned) {
      refBlock.warned = true;
      console.error("[markdown] __refBlock 抛异常，已退回普通 img：", err);
    }
    return null;
  }
}

// ![[资源名]] 的卡片渲染钩子：由宿主页面注入（window.__refCard）。
// markdown.js 不依赖数据层，注入方负责查 _assets 清单并产出 HTML；
// 没注入或查不到时，走"文件不存在"的诚实占位。
function refCard(name, alias) {
  const fn = (typeof window !== "undefined" && window.__refCard) || null;
  if (typeof fn !== "function") return null;
  try {
    const html = fn(name, alias);
    return html || null;
  } catch (err) {
    if (!refCard.warned) {
      refCard.warned = true;
      console.error("[markdown] __refCard 抛异常，已退回占位：", err);
    }
    return null;
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeUrl(url) {
  const u = String(url).trim();
  if (/^(https?:|mailto:|#|\/)/i.test(u)) {
    // 协议相对地址 //host 会向外部发请求，拦截
    if (u.startsWith("//")) return "#";
    return u;
  }
  // data: 只放行安全的位图类型（svg 可以带脚本，不放行）
  if (/^data:image\/(png|jpe?g|gif|webp|bmp|ico);/i.test(u)) return u;
  return u.startsWith("_") || /\.(png|jpe?g|gif|webp|bmp|ico|svg|md|pdf|zip|txt)$/i.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : "#";
}

function inline(src) {
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  // 双向链接 [[条目标题]]、[[标题|别名]]、[[标题#锚点]]
  // ![[资源名]] → 资源卡片。必须在 [[wikilink]] 之前替换，
  // 否则 [[名]] 会先被吃掉，只剩一个光秃秃的 !。
  // 卡片内容由 refCard 提供（前端注入，避免 markdown.js 依赖数据层）。
  s = s.replace(/!\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?(?:#([^\]\n]+?))?\]\]/g, (_, name, alias) => {
    const card = typeof refCard === "function" ? refCard(name.trim(), (alias || "").trim()) : null;
    if (card) return card;
    // 找不到文件：给一个诚实的占位，不要假装有
    return `<span class="ref-missing" title="库里没有这个文件">📄 ${esc(name.trim())}（文件不存在）</span>`;
  });
  // [[@path:绝对路径|名字]] → 本机文件的引用块（不复制文件，点了打开原件）。
  // 必须在普通 [[双链]] 之前替换，否则会被当成一个笔记标题去查。
  // 由 panel.js 的 markdown 层注入 window.__refPath 产出 HTML。
  s = s.replace(/\[\[@path:([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g, (_, rawPath, alias) => {
    let abs = String(rawPath).trim();
    try { abs = decodeURIComponent(abs); } catch {}
    const name = alias || abs.split(/[\\/]/).pop() || abs;
    const fn = (typeof window !== "undefined" && window.__refPath) || null;
    let html = null;
    if (typeof fn === "function") {
      try {
        html = fn(abs, name);
      } catch (err) {
        if (!refPathWarned) { refPathWarned = true; console.error("[markdown] __refPath 抛异常：", err); }
      }
    }
    // 宿主没接这个钩子时给一个诚实的占位，别显示天书
    return html || `<span class="ref-ext" title="${esc(abs)}">🔗 ${esc(name)}</span>`;
  });

  s = s.replace(/\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?(?:#([^\]\n]+?))?\]\]/g, (_, title, alias, anchor) => {
    const display = alias || (anchor ? `${title}#${anchor}` : title);
    return `<a href="#" data-wikilink data-title="${esc(title.trim())}" ${anchor ? `data-anchor="${esc(anchor)}"` : ""}>${display}</a>`;
  });
  // ![alt](路径)：如果这个路径是库内资源（图片/视频/音频/PDF/文件），
  // 走块渲染——视频给播放器、PDF 给打开入口、图片给带说明的图。
  // 不是库内资源才退化成普通 <img>。
  // 这是「在正文里放不同类型的文件都能用」的关键：不能让视频变成一张碎图。
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => {
    const raw = url.replace(/&amp;/g, "&");
    const block = typeof refBlock === "function" ? refBlock(raw, alt) : null;
    if (block) return block;
    return `<img alt="${alt}" src="${esc(safeUrl(raw))}">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text, url) => `<a href="${esc(safeUrl(url.replace(/&amp;/g, "&")))}" data-link>${text}</a>`);
  // 库内资源路径（_assets/...）在 img/a 生成后换成绝对 URL。
  // 关键是绝对：写 "../routes/_assets/x" 这种相对路径，浏览器会按面板自己的
  // base URL 去解析，解析不到 → 图片必裂。所以这里调宿主注入的 resolveAsset()。
  // （上一轮只改了 panel.js 的 assetUrl，漏了这个文件，导致正文图片一直裂。）
  s = s.replace(/((?:src|href)=")((?:\.\/)?_assets\/[^"\s]+)/g, (_, attr, p) => {
    const clean = p.replace(/^\.\//, "");
    const abs = typeof resolveAsset === "function" ? resolveAsset(clean) : clean;
    return `${attr}${abs}`;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" data-link>${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_, pre, t) => `${pre}<em>${t}</em>`);
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

export function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };

  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line))) {
      flush();
      const fence = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[2] ? ` data-lang="${esc(m[2])}"` : ""}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push(`<h${m[1].length}>${inline(m[2].replace(/\s+#+\s*$/, ""))}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c)}</${tag}>`;
      out.push(`<table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line))) {
      flush();
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (lm && /\d/.test(lm[2]) === ordered && lm[1].length < 2) { items.push([lm[3]]); i++; continue; }
        if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) { items[items.length - 1].push(lines[i].replace(/^\s{2,4}/, "")); i++; continue; }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map(([first, ...rest]) => {
        const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
        const head = task ? `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> ${inline(task[2])}` : inline(first);
        return `<li${task ? ' class="task"' : ""}>${head}${rest.length ? renderMarkdown(rest.join("\n")) : ""}</li>`;
      }).join("")}</${tag}>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join("\n");
}
