// 念念收藏夹图标系统：内联 SVG，24 网格，1.6 圆头描边。
// 统一用 currentColor，颜色跟着父元素的 color 走，暗亮主题都不用另做一套。
// 用法：icons.note、icons.folder、icons.trash ... 或者 icons.get("note", 20)
const P = (d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;

const raw = {
  // 库与导航
  vault: P("M4 7h5l2 2h9v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z") + P("M9 7V5h6v2"),
  folder: P("M3 7h6l2 2h10v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"),
  inbox: P("M4 5h16v10h-6l-2 2-2-2H4z") + P("M4 5v11h4"),
  home: P("M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"),
  star: P("M12 4l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.8-5 2.8 1-5.6-4-3.9 5.5-.8z"),
  pin: P("M9 4h6M12 4v6M8 10h8l-1 4h-2v6M12 20l-3-4h6z"),
  tag: P("M4 11l7-7h9v9l-7 7z") + P("M15.5 7.5h.01"),
  search: P("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z") + P("M16.5 16.5L21 21"),
  filter: P("M4 6h16M7 12h10M10 18h4"),

  // 条目类型
  note: P("M6 3h9l4 4v14H6z") + P("M9 11h7M9 15h5"),
  text: P("M6 4h12M6 9h12M6 14h9M6 19h6"),
  link: P("M10 8l4-4 6 6-4 4") + P("M14 16l-4 4-6-6 4-4") + P("M9 11l6 6"),
  image: P("M4 5h16v14H4z") + P("M8 11a2 2 0 1 0 0-.01") + P("M5 18l5-5 3 3 3-3 4 4"),
  video: P("M4 6h11v12H4z") + P("M15 11l6-3v8l-6-3z"),
  file: P("M6 3h8l4 4v14H6z") + P("M14 3v4h4"),
  memory: P("M9 5h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-1l-2 3-2-3H9a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z"),
  experience: P("M14 4l6 6-3 3-2-2-7 7-3 1 1-3 7-7-2-2z"),

  // 动作
  plus: P("M12 5v14M5 12h14"),
  minus: P("M5 12h14"),
  edit: P("M5 19l1-4L16 5l3 3L9 18z") + P("M14 7l3 3"),
  trash: P("M5 7h14M10 7V5h4v2M8 7l1 13h6l1-13") + P("M11 11v6M13 11v6"),
  copy: P("M9 4h8v12H9z") + P("M15 8h2v12H7v-2"),
  check: P("M5 13l4 4 10-10"),
  close: P("M6 6l12 12M18 6L6 18"),
  refresh: P("M20 12a8 8 0 1 1-2.5-5.8") + P("M20 4v4h-4"),
  more: P("M6 12h.01M12 12h.01M18 12h.01"),
  chevronRight: P("M10 6l6 6-6 6"),
  chevronDown: P("M6 10l6 6 6-6"),
  arrowUp: P("M12 19V6M6 12l6-6 6 6"),
  arrowDown: P("M12 5v13M6 12l6 6 6-6"),
  export: P("M12 4v10M8 8l4-4 4 4") + P("M5 15v4h14v-4"),
  import: P("M12 20V10M8 14l4 4 4-4") + P("M5 7h14v4H5z"),

  // AI 与云
  sparkle: P("M12 4l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.3z") + P("M18 15l.9 2.3L21 18l-2.1.7L18 21l-.9-2.3L15 18l2.1-.7z"),
  brain: P("M12 5a3 3 0 0 0-6 0 3 3 0 0 0-1 5.8V16a3 3 0 0 0 6 1z") + P("M12 5a3 3 0 0 1 6 0 3 3 0 0 1 1 5.8V16a3 3 0 0 1-6 1z") + P("M12 5v12"),
  cloud: P("M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.5 3.5 0 0 0 7 18z"),
  database: P("M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z") + P("M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6") + P("M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"),
  gear: P("M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z") + P("M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z"),
  chat: P("M4 6h16v10H9l-5 4z") + P("M8 11h.01M12 11h.01M16 11h.01"),

  // 视图
  list: P("M4 6h2v2H4zM9 7h11M4 12h2v2H4zM9 13h11M4 18h2v2H4zM9 19h11"),
  grid: P("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"),
  compact: P("M4 7h16M4 12h16M4 17h16"),
  layers: P("M12 3l9 5-9 5-9-5z") + P("M3 13l9 5 9-5"),

  // 多选
  checkbox: P("M5 5h14v14H5z"),
  checkboxOn: P("M5 5h14v14H5z") + P("M9 12l2.5 2.5L16 10"),
  selectAll: P("M4 5h16v14H4z") + P("M8 12l3 3 5-6"),
};

// 输出一个完整的 <svg>，size 默认 16
export function icon(name, size = 16, extra = "") {
  const body = raw[name] || raw.note;
  return `<svg class="nv-ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;
}

export const icons = new Proxy(raw, {
  get: (_, k) => (typeof k === "string" ? icon(k) : undefined),
});

export const has = (name) => name in raw;
export const names = Object.keys(raw);
