// 收藏候选切分：把一条消息/一段会话切成可勾选的小块，供卡片列出。
// 原则：宁可粗切，也不把原文改一个字——标题只做提取，正文原样保留。

export function splitCandidates(text, maxItems = 12) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  // 按空行断块，Markdown 标题作为强断点
  const blocks = raw.split(/\n{2,}/).flatMap((b) => splitByHeading(b)).map((s) => s.trim()).filter(Boolean);
  const merged = mergeTiny(blocks);
  const items = [];
  for (const b of merged) {
    if (items.length >= maxItems) break;
    for (const piece of chop(b, 1600)) {
      if (items.length >= maxItems) break;
      items.push({ id: `c${items.length + 1}`, title: pickTitle(piece), text: piece, chars: piece.length });
    }
  }
  // 只有一块且不长时，整条作为唯一候选
  return items.length ? items : [{ id: "c1", title: pickTitle(raw), text: raw, chars: raw.length }];
}

function splitByHeading(block) {
  if (!/^#{1,6}\s/m.test(block)) return [block];
  const out = [];
  let cur = "";
  for (const line of block.split("\n")) {
    if (/^#{1,6}\s/.test(line) && cur.trim()) { out.push(cur); cur = line + "\n"; }
    else cur += line + "\n";
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// 过短的碎块并到前一块，避免列表里出现一排三五个字的候选
function mergeTiny(blocks) {
  const out = [];
  for (const b of blocks) {
    if (out.length && b.length < 40 && !/^\s*[-*]\s/.test(b)) out[out.length - 1] += "\n\n" + b;
    else out.push(b);
  }
  return out;
}

function chop(text, size) {
  if (text.length <= size) return [text];
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.4) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function pickTitle(text) {
  const h = text.match(/^\s*#{1,6}\s*(.+)$/m);
  if (h) return clean(h[1]).slice(0, 46);
  const bold = text.match(/^\s*\*\*(.+?)\*\*/m);
  if (bold) return clean(bold[1]).slice(0, 46);
  const li = text.match(/^\s*[-*]\s+(.+)$/m);
  if (li && clean(li[1]).length > 6) return clean(li[1]).slice(0, 46);
  const line = text.split("\n").map(clean).find((l) => l.length > 4) || "内容片段";
  return line.slice(0, 46);
}

function clean(s) {
  return String(s).replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
}
