// 轻量 Markdown 渲染器：先整体转义 HTML，再做语法替换，因此不会执行内容里的脚本。
// 支持：标题、段落、粗体/斜体/删除线、行内代码、代码块、引用、有序/无序/任务列表、表格、分割线、链接、图片、![[资源]] 卡片。

// ![[资源名]] 的卡片渲染钩子：由宿主页面注入（window.__refCard）。
// markdown.js 不依赖数据层，注入方负责查 _assets 清单并产出 HTML；
// 没注入或查不到时，走"文件不存在"的诚实占位。
function refCard(name, alias) {
  const fn = (typeof window !== "undefined" && window.__refCard) || null;
  if (typeof fn !== "function") return null;
  try {
    const html = fn(name, alias);
    return html || null;
  } catch {
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
  s = s.replace(/\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?(?:#([^\]\n]+?))?\]\]/g, (_, title, alias, anchor) => {
    const display = alias || (anchor ? `${title}#${anchor}` : title);
    return `<a href="#" data-wikilink data-title="${esc(title.trim())}" ${anchor ? `data-anchor="${esc(anchor)}"` : ""}>${display}</a>`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => `<img alt="${alt}" src="${esc(safeUrl(url.replace(/&amp;/g, "&")))}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text, url) => `<a href="${esc(safeUrl(url.replace(/&amp;/g, "&")))}" data-link>${text}</a>`);
  // 库内资源路径（_assets/...）必须在 img/a 生成后补上 ../routes/ 前缀，才能在 iframe 里正常显示
  s = s.replace(/((?:src|href)=")((?:\.\/)?_assets\/[^"\s]+)/g, (_, attr, p) => `${attr}../routes/${p.replace(/^\.\//, "")}`);
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
