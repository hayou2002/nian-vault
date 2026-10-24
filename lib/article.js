// 网页正文提取 + HTML 转 Markdown。
//
// 为什么自己写不引 @mozilla/readability + turndown：
// 1) 这个 App 是纯静态 + Node 内置模块跑的，没有 package.json。
//    装第三方依赖要用下载器，而且 App 装到别处时 node_modules 会丢。
// 2) Readability 的核心算法不神秘：按标签语义给候选容器打分，取最高分那个，
//    砍掉导航/广告/侧栏/评论，再把剩下的 HTML 转 Markdown。
//    这套流程两百行内能写完，且行为可控、可测。
//
// 思路来源：Mozilla Readability 的评分模型（p/tag 密度、class/id 关键词、
// 负权词），ArchiveBox/readability-extractor 的用法，Obsidian 剪藏的输出形态
// （YAML frontmatter + 标题 + 正文 + 原文链接）。
//
// 零依赖，只用 Node 内置。

// ---------- 1. HTML 清洗与正文定位 ----------

// 先整段删掉的标签：脚本、样式，以及一眼就不是正文的容器
const DROP_TAGS = new Set([
  "script", "style", "noscript", "iframe", "svg", "canvas", "form",
  "nav", "header", "footer", "aside",
]);
// class/id 里出现这些词 → 强负权，几乎一定是导航/广告/评论/推荐
const NEGATIVE_RE = /(comment|com-|sidebar|side-|widget|banner|ad-|ads|adv|sponsor|promo|related|recommend|share|social|login|signup|subscribe|newsletter|cookie|popup|modal|nav|menu|breadcrumb|pagination|pager|footer|header|copyright|toolbar|dropdown|search|tag-list|meta|hidden|d-none|display-none)/i;
// class/id 里出现这些词 → 正权，多半是正文
const POSITIVE_RE = /(article|body|content|main|entry|post|text|story|detail|blog|news|page|container|wrap|markdown|readable|rich_media_area|zzbd)/i;

// HTML 实体解码。抓下来的页面里 &amp; &nbsp; &#8212; 这些都得还原，
// 不然正文里全是乱码一样的实体名。
function decodeEntities(s) {
  if (!s) return "";
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
    ldquo: "“", rdquo: "”", middot: "·", bull: "•", copy: "©",
    reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×",
    divide: "÷", frac12: "½", euro: "€", pound: "£", yen: "¥",
    cent: "¢", sect: "§", para: "¶", laquo: "«", raquo: "»",
    trade2: "™", dagger: "†", permil: "‰", prime: "′",
  };
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; } })
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name) => (name in named ? named[name] : m));
}

// 去标签取纯文本
function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// 去掉注释和 DROP_TAGS 整段
function removeJunk(html) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  s = s.replace(/<(script|style|noscript|iframe|svg|canvas|nav|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // 自闭合残留的 <script ...>（没配对的）
  s = s.replace(/<(script|style)\b[^>]*>/gi, "");
  return s;
}

// 取出 <head> 里的元信息（标题、描述、站点名、作者）
function extractMeta(html) {
  const out = { title: "", description: "", siteName: "", author: "", published: "", lang: "" };
  const h = String(html || "");
  const pick = (re) => { const m = re.exec(h); return m ? decodeEntities(m[1] || m[2] || "").trim() : ""; };
  out.title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  out.description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  out.siteName = pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i);
  out.author = pick(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']*)["']/i);
  out.published = pick(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']*)["']/i)
    || pick(/<meta[^>]+name=["']date["'][^>]+content=["']([^"']*)["']/i);
  out.lang = pick(/<html[^>]+lang=["']([^"']*)["']/i);
  return out;
}

// Readability 风格的容器打分：找出最可能是正文的那个 div
function findMainContainer(html) {
  const cleaned = removeJunk(html);
  // 候选：所有带 id 或 class 的块级容器
  const candidates = [];
  const tagRe = /<(div|article|section|main|td)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(cleaned)) !== null) {
    const attrs = m[2] || "";
    const idM = /\bid=["']([^"']*)["']/i.exec(attrs);
    const clsM = /\bclass=["']([^"']*)["']/i.exec(attrs);
    const id = idM ? idM[1] : "";
    const cls = clsM ? clsM[1] : "";
    if (!id && !cls) continue;
    // 取这个开标签之后到下一个同级开标签之间的内容当候选正文
    const start = m.index + m[0].length;
    const nextOpen = /<(?:div|article|section|main)\b[^>]*>/gi;
    nextOpen.lastIndex = start;
    const nm = nextOpen.exec(cleaned);
    const end = nm ? nm.index : Math.min(cleaned.length, start + 60000);
    const chunk = cleaned.slice(start, end);
    const text = stripTags(chunk);
    if (text.length < 80) continue; // 太短的不可能是正文
    // 评分：文本长度为主，段落数次之
    const paras = (chunk.match(/<p\b/gi) || []).length;
    let score = text.length + paras * 25;
    // class/id 关键词加权
    const sig = `${id} ${cls}`;
    if (POSITIVE_RE.test(sig)) score *= 1.6;
    if (NEGATIVE_RE.test(sig)) score *= 0.15;
    // 标签本身加权：article/main 最可能是正文
    if (/^article$/i.test(m[1])) score *= 1.5;
    if (/^main$/i.test(m[1])) score *= 1.4;
    candidates.push({ score, html: chunk, text, id, cls, tag: m[1].toLowerCase() });
  }
  if (!candidates.length) {
    // 没有带 class/id 的容器：退化成用 <body> 全部内容
    const bodyM = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned);
    const chunk = bodyM ? bodyM[1] : cleaned;
    return { html: chunk, text: stripTags(chunk), id: "", cls: "body", tag: "body" };
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// 在选中的正文里删掉明确的噪音块（推荐、分享、广告位）
function cleanMain(html) {
  let s = String(html || "");
  // 带负权词的整块删掉
  s = s.replace(/<(div|section|ul|aside|span)\b[^>]*(?:class|id)=["'][^"']*(?:comment|sidebar|widget|banner|ad-|ads|adv|sponsor|promo|related|recommend|share|social|login|signup|subscribe|newsletter|cookie|popup|modal|breadcrumb|pagination|pager|copyright|toolbar|dropdown|tag-list)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // 空的块删掉（留着只会让转出来的 Markdown 多一堆空行）
  s = s.replace(/<(div|section|p)\b[^>]*>\s*<\/\1\s*>/gi, "");
  return s;
}

// ---------- 2. HTML → Markdown ----------

// 把一段 HTML 转成 Markdown。刻意做得很直接：
// 不追求完美还原，只求「读起来是干净的文章」。
// 图片保留 alt，链接保留文字，代码块保留内容。
export function htmlToMarkdown(html) {
  let s = String(html || "");

  // 先抽出代码块占位（里面内容不能被后面的规则破坏）
  const codes = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner) => {
    const code = inner.replace(/<code\b[^>]*>|<\/code\s*>/gi, "");
    const txt = decodeEntities(code.replace(/<[^>]*>/g, "")).replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
    const langM = /class=["'][^"']*(?:language|lang)-([\w-]+)/i.exec(inner);
    codes.push(`\n\`\`\`${langM ? langM[1] : ""}\n${txt}\n\`\`\`\n`);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  // 标题
  for (let lv = 1; lv <= 6; lv++) {
    const re = new RegExp(`<h${lv}\\b[^>]*>([\\s\\S]*?)<\\/h${lv}\\s*>`, "gi");
    s = s.replace(re, (_, inner) => `\n\n${"#".repeat(lv)} ${inlineText(inner)}\n\n`);
  }
  // 分割线
  s = s.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n");
  // 图片：![alt](src)
  s = s.replace(/<img\b([^>]*)>/gi, (_, attrs) => {
    const src = /\b(?:src|data-src)=["']([^"']*)["']/i.exec(attrs);
    const alt = /\balt=["']([^"']*)["']/i.exec(attrs);
    if (!src) return "";
    return `\n\n![${decodeEntities(alt ? alt[1] : "")}](${src[1]})\n\n`;
  });
  // 列表
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner) => `\n- ${inlineText(inner).trim()}`);
  // 引用
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_, inner) =>
    `\n\n${inlineText(inner).trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);
  // 表格：转成 Markdown 表格（列数按第一行定，缺的补空）
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi, (_, inner) => {
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
    let tm;
    while ((tm = trRe.exec(inner)) !== null) {
      const cells = [];
      const tdRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi;
      let cm;
      while ((cm = tdRe.exec(tm[1])) !== null) cells.push(inlineText(cm[1]).trim().replace(/\|/g, "\\|"));
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return "";
    const cols = Math.max(...rows.map((r) => r.length));
    const pad = (r) => { const c = r.slice(); while (c.length < cols) c.push(""); return c; };
    const lines = [`| ${pad(rows[0]).join(" | ")} |`, `| ${Array(cols).fill("---").join(" | ")} |`];
    for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(" | ")} |`);
    return `\n\n${lines.join("\n")}\n\n`;
  });
  // 段落
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi, (_, inner) => `\n\n${inlineText(inner).trim()}\n\n`);
  // br
  s = s.replace(/<br\b[^>]*>/gi, "\n");
  // 其余块级标签当分隔
  s = s.replace(/<\/(?:div|section|article|main|ul|ol|dl|figure)>/gi, "\n\n");
  // 剩下的行内标签剥掉
  s = inlineText(s);

  // 还原代码块
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codes[Number(i)] || "");

  // 收尾：压缩空行，去掉行首行尾空白
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.replace(/^\s+|\s+$/g, "");
}

// 行内文本：保留链接和强调，其余标签剥掉
function inlineText(html) {
  let s = String(html || "");
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs, inner) => {
    const href = /\bhref=["']([^"']*)["']/i.exec(attrs);
    const text = stripTags(inner).trim();
    if (!href || /^javascript:/i.test(href[1])) return text;
    return `[${text}](${href[1]})`;
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _t, inner) => `**${stripTags(inner).trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _t, inner) => `*${stripTags(inner).trim()}*`);
  s = s.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _t, inner) => `~~${stripTags(inner).trim()}~~`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner) => `\`${stripTags(inner).trim()}\``);
  s = s.replace(/<[^>]*>/g, "");
  return decodeEntities(s).replace(/[ \t]{2,}/g, " ");
}

// ---------- 3. 对外主入口 ----------

// 抓一个网页，返回 { title, markdown, text, meta, chars, truncated }
// 抓不到正文时不抛错，返回降级结果（至少有标题和链接）——调用方要能诚实告知用户。
export async function extractArticle(url, {
  timeoutMs = 15000,
  maxBytes = 3 * 1024 * 1024,
  maxChars = 60000,
  fetchImpl = null,
} = {}) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw new Error("不是合法的网址");
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("当前环境没有 fetch，无法抓取网页");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let html = "";
  try {
    const res = await doFetch(u, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        // 伪装成浏览器：很多站点不给裸 UA 返回正文，只返回验证页
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "无响应"}`);
    const ct = String(res.headers?.get?.("content-type") || "");
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) {
      throw new Error(`不是网页（${ct.split(";")[0]}）`);
    }
    // 限量读：防止一个巨大页面把内存吃光
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error(`页面超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
    html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } finally {
    clearTimeout(timer);
  }

  const meta = extractMeta(html);
  const main = findMainContainer(html);
  const cleaned = cleanMain(main.html);
  const markdown = htmlToMarkdown(cleaned);
  const text = stripTags(cleaned);

  let body = markdown || text;
  let truncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars) + `\n\n…（正文过长，已截断；原文共约 ${body.length} 字）`;
    truncated = true;
  }

  return {
    url: u,
    title: meta.title || stripTags(main.text).slice(0, 60) || u,
    description: meta.description,
    siteName: meta.siteName,
    author: meta.author,
    published: meta.published,
    lang: meta.lang,
    markdown: body,
    text,
    chars: body.length,
    truncated,
    // 调试/自检用：正文定位到哪个容器了
    selector: main.tag + (main.id ? `#${main.id}` : "") + (main.cls ? `.${String(main.cls).split(/\s+/)[0]}` : ""),
  };
}

// 生成剪藏条目的正文（Obsidian 剪藏风格：元信息 + 正文 + 原文链接）
export function buildClipContent(a, note = "") {
  const lines = [];
  if (note && note.trim()) { lines.push(note.trim(), ""); }
  if (a.description) { lines.push(`> ${a.description}`, ""); }
  const metas = [];
  if (a.siteName) metas.push(`**来源**：${a.siteName}`);
  if (a.author) metas.push(`**作者**：${a.author}`);
  if (a.published) metas.push(`**发布时间**：${String(a.published).slice(0, 10)}`);
  if (a.siteName || a.author || a.published) { lines.push(metas.join(" · "), ""); }
  lines.push("---", "", a.markdown || "（没能提取到正文，只存了链接）", "");
  lines.push("---", "", `原文链接：${a.url}`);
  return lines.join("\n");
}
