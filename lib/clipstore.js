// 收藏候选暂存：把消息切出的候选片段记在 App 存储里（不进 vault，不随备份走），
// 等用户在面板勾选后才真正入库。让「点了没反应」变成「看得见、可反悔」。
import { splitCandidates } from "./clip.js";

const STAGE_KEY = "clipStage";
const MAX_ITEMS = 40;

export function makeClipStore(sdk) {
  async function readRaw() {
    try {
      const v = await sdk.storage.global.get(STAGE_KEY, null);
      const parsed = typeof v === "string" ? JSON.parse(v) : v;
      return parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
    } catch {
      return { items: [] };
    }
  }

  async function writeRaw(next) {
    await sdk.storage.global.set(STAGE_KEY, next).catch(() => {});
    return next;
  }

  return {
    /** 把一段文本切成候选并压进暂存表，返回本次新增条目 */
    async stage(text, meta = {}) {
      const cands = splitCandidates(text);
      if (!cands.length) return { items: [], added: 0, total: 0 };
      const cur = await readRaw();
      const stamp = Date.now();
      const added = cands.map((c, i) => ({
        ...c,
        key: `k${stamp}_${i}`,
        at: new Date(stamp).toISOString(),
        from: meta.from || "对话",
      }));
      const items = [...added, ...cur.items].slice(0, MAX_ITEMS);
      await writeRaw({ items });
      return { items: added.map((a) => ({ key: a.key, title: a.title, chars: a.chars })), added: added.length, total: items.length };
    },

    async list() {
      const cur = await readRaw();
      return {
        items: cur.items.map((it) => ({
          key: it.key,
          title: it.title,
          chars: it.chars,
          at: it.at,
          from: it.from,
          preview: it.text.length > 160 ? `${it.text.slice(0, 160)}…` : it.text,
        })),
      };
    },

    async get(keys) {
      const cur = await readRaw();
      const set = new Set(keys || []);
      return cur.items.filter((it) => set.has(it.key));
    },

    async drop(keys) {
      const cur = await readRaw();
      const set = new Set(keys || []);
      const items = keys?.length ? cur.items.filter((it) => !set.has(it.key)) : [];
      await writeRaw({ items });
      return { total: items.length };
    },
  };
}
