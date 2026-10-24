// 条目文件格式：开头一段 front matter（每行 `key: <JSON 值>`，同时是合法 YAML），后面是 Markdown 正文。

const FM_KEYS = ["id", "title", "type", "tags", "source", "created", "updated", "pinned", "cover", "embed", "hideTodos", "opened", "homePinned", "parent", "order", "session"];

export function serializeEntry(meta, body) {
  const lines = ["---"];
  for (const key of FM_KEYS) {
    if (meta[key] === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(meta[key])}`);
  }
  for (const [key, value] of Object.entries(meta)) {
    if (FM_KEYS.includes(key) || value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n") + String(body ?? "").replace(/\r\n/g, "\n");
}

export function parseEntry(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return { meta: {}, body: src };
  const end = src.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: src };
  const head = src.slice(4, end);
  let rest = src.slice(end + 4);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  const meta = {};
  for (const line of head.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    try {
      meta[m[1]] = JSON.parse(raw);
    } catch {
      // 兼容手写的 YAML：`tags: [a, b]` 或裸字符串
      if (/^\[.*\]$/.test(raw)) {
        meta[m[1]] = raw.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else {
        meta[m[1]] = raw.replace(/^["']|["']$/g, "");
      }
    }
  }
  // 必须至少命中一个已知键才认作 front matter，
  // 否则「正文第一行是 ---」的普通笔记会被误吞前两段
  const known = Object.keys(meta).filter((k) => FM_KEYS.includes(k));
  if (!known.length) return { meta: {}, body: src };
  return { meta, body: rest };
}
