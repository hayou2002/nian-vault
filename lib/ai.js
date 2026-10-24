// 对接 OpenHanako (Hana v2 SDK) 模型运行时（sdk.models）
// 支持：1. 宿主辅助模型 (sdk.models.utility)  2. 宿主模型目录指定模型 (sdk.models.streamEvents)  3. 离线智能规则兜底
import crypto from "node:crypto";

function reqId() {
  return `nv-ai-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

export class VaultAI {
  constructor(sdk, getVault) {
    this.sdk = sdk;
    this.getVault = getVault;
    this.MODEL_PREF_KEY = "nv.aiModelPref";       // "auto" 或 "provider::modelId"
    this.PROACTIVE_KEY = "nv.proactiveMode";      // "high" | "normal" | "off"
    this._memSettings = { modelPref: "auto", proactive: "high" };
  }

  async getSettings() {
    const modelPref = await this.sdk?.storage?.global?.get(this.MODEL_PREF_KEY, this._memSettings.modelPref).catch(() => this._memSettings.modelPref);
    const proactive = await this.sdk?.storage?.global?.get(this.PROACTIVE_KEY, this._memSettings.proactive).catch(() => this._memSettings.proactive);
    return { modelPref: modelPref || "auto", proactive: proactive || "high" };
  }

  async saveSettings({ modelPref, proactive } = {}) {
    if (modelPref !== undefined) {
      this._memSettings.modelPref = String(modelPref);
      await this.sdk?.storage?.global?.set(this.MODEL_PREF_KEY, String(modelPref)).catch(() => {});
    }
    if (proactive !== undefined) {
      this._memSettings.proactive = String(proactive);
      await this.sdk?.storage?.global?.set(this.PROACTIVE_KEY, String(proactive)).catch(() => {});
    }
    return this.getSettings();
  }

  // 获取 OpenHanako 中已配置的模型供应商与模型列表
  async listHostModels() {
    if (!this.sdk?.models) return [];
    try {
      const res = await (typeof this.sdk.models.list === "function"
        ? this.sdk.models.list()
        : this.sdk.models.listAvailable?.());
      const raw = Array.isArray(res?.models) ? res.models : [];
      return raw.map((m) => ({
        provider: String(m.provider || m.providerId || "default"),
        id: String(m.id || m.modelId || m.name || ""),
        name: String(m.name || m.id || m.modelId || ""),
      })).filter((m) => m.id);
    } catch {
      return [];
    }
  }

  // 核心文本推理：优先按用户所选模型或宿主 utility 模型调用，失败时自动降级
  async chatText({ systemPrompt, userPrompt, temperature = 0.2, maxTokens = 1200 }) {
    if (!this.sdk?.models) return { ok: false, text: "", via: "local-smart", error: "宿主未提供 models 接口" };
    const { modelPref } = await this.getSettings();

    // 1. 若用户指定了具体 provider::model，优先走 streamEvents
    if (modelPref && modelPref !== "auto" && modelPref.includes("::")) {
      const [provider, model] = modelPref.split("::");
      const streamed = await this._tryStream({ provider, model, systemPrompt, userPrompt, temperature, maxTokens });
      if (streamed.ok) return streamed;
    }

    // 2. 尝试调用 OpenHanako 默认辅助模型 (sdk.models.utility)
    if (typeof this.sdk.models.utility === "function") {
      try {
        const res = await this.sdk.models.utility({
          requestId: reqId(),
          scope: "app",
          systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          temperature,
          maxTokens,
        });
        if (res && typeof res.text === "string" && res.text.trim()) {
          return { ok: true, text: res.text.trim(), via: "OpenHanako 默认模型 (utility)" };
        }
      } catch { /* 继续尝试模型列表第一个模型 */ }
    }

    // 3. 自动从 OpenHanako 模型列表挑选可用模型走 streamEvents
    const models = await this.listHostModels();
    for (const m of models.slice(0, 3)) {
      const streamed = await this._tryStream({
        provider: m.provider,
        model: m.id,
        systemPrompt,
        userPrompt,
        temperature,
        maxTokens,
      });
      if (streamed.ok) return streamed;
    }

    return {
      ok: false,
      text: "",
      via: "local-smart",
      error: "未检测到可用的宿主模型或尚未授予 app/models.infer 权限，已自动使用本地智能引擎处理",
    };
  }

  async _tryStream({ provider, model, systemPrompt, userPrompt, temperature, maxTokens }) {
    if (typeof this.sdk?.models?.streamEvents !== "function") return { ok: false };
    try {
      let buf = "";
      const stream = this.sdk.models.streamEvents({
        requestId: reqId(),
        provider,
        model,
        systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        temperature,
        maxTokens,
      });
      for await (const ev of stream) {
        if (ev.type === "text-delta" && ev.delta) buf += ev.delta;
        else if (ev.type === "done" && !buf && Array.isArray(ev.assistant?.content)) {
          buf = ev.assistant.content.filter((c) => c.type === "text").map((c) => c.text).join("");
        }
      }
      if (buf.trim()) return { ok: true, text: buf.trim(), via: `${provider}/${model}` };
    } catch { /* ignore */ }
    return { ok: false };
  }

  _parseJson(text, fallback = null) {
    if (!text) return fallback;
    const cleaned = String(text).replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/\s*```[\s\S]*$/, "").trim();
    try { return JSON.parse(cleaned); } catch {
      const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(String(text));
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      return fallback;
    }
  }

  // 本地启发式分析兜底（无模型权限或离线测试时也能秒出结果）
  _heuristicAnalyze(title, content, categories, allTitles) {
    const text = `${title || ""}\n${content || ""}`;
    let suggestedCategory = "收件箱";
    for (const c of categories) {
      if (c === "收件箱") continue;
      if (text.toLowerCase().includes(c.toLowerCase())) { suggestedCategory = c; break; }
    }
    if (suggestedCategory === "收件箱" && categories.length > 1) {
      if (/服务器|ssh|docker|linux|nginx|报错|部署|代码|api/i.test(text)) {
        suggestedCategory = categories.find((c) => /运维|技术|开发|工作|服务器/.test(c)) || categories[1];
      } else if (/教资|课标|考试|真题|复习|笔记|教学/i.test(text)) {
        suggestedCategory = categories.find((c) => /教资|学习|考试|笔记/.test(c)) || categories[1];
      }
    }
    const tags = new Set();
    const hashMatches = text.match(/#([\u4e00-\u9fa5A-Za-z0-9_-]{2,12})/g) || [];
    for (const h of hashMatches) tags.add(h.slice(1));
    const kwPool = ["服务器", "运维", "Docker", "SSH", "教资", "数学", "课标", "B站", "视频", "前端", "AI", "配置", "教程", "复盘", "待办"];
    for (const kw of kwPool) if (text.toLowerCase().includes(kw.toLowerCase())) tags.add(kw);
    if (!tags.size) {
      const words = (title || content || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w.length >= 2 && w.length <= 8);
      words.slice(0, 3).forEach((w) => tags.add(w));
    }
    const lines = String(content || "").split("\n").map((l) => l.replace(/^#+\s*|^[-*>]\s*/, "").trim()).filter(Boolean);
    const summary = lines.slice(0, 2).join("；").slice(0, 140) || title || "暂无摘要";
    const todos = [];
    for (const l of lines) {
      if (/(?:需要|待办|记得|下一步|TODO|必须|计划)[:：]?\s*(.+)/i.test(l) && !/^\[[ xX]\]/.test(l)) {
        todos.push(RegExp.$1.trim().slice(0, 60));
      }
    }
    const related = allTitles.filter((t) => t !== title && t.length >= 2 && text.toLowerCase().includes(t.toLowerCase())).slice(0, 5);
    return {
      title: title || lines[0]?.slice(0, 30) || "未命名收藏",
      category: suggestedCategory,
      tags: [...tags].slice(0, 6),
      summary,
      todos: todos.slice(0, 5),
      related,
    };
  }

  // 1. 单篇笔记/草稿 AI 深度分析（推荐分类、标签、一句话摘要、提取待办、关联双链）
  async analyzeEntry({ title = "", content = "" } = {}) {
    const v = await this.getVault();
    const cats = v.listCategories().map((c) => c.name);
    const allTitles = [...v.entries.values()].map((e) => e.meta.title).filter(Boolean);
    const fallback = this._heuristicAnalyze(title, content, cats, allTitles);

    const systemPrompt =
      "你是「念念收藏夹」的内置 AI 整理专家。请分析用户的笔记内容，严格输出一个 JSON 对象，不要包含任何多余解释。\n" +
      'JSON 格式：{"title":"优化后的简短标题","category":"推荐分类名","tags":["标签1","标签2"],"summary":"80字以内的核心摘要与要点","todos":["可执行的待办事项1"],"related":["命中的已有笔记标题"]}';
    const userPrompt =
      `现有分类：${cats.join("、") || "收件箱"}\n` +
      `库内已有笔记标题（供关联参考）：${allTitles.slice(0, 60).join("、") || "无"}\n\n` +
      `当前标题：${title}\n当前正文：\n${String(content).slice(0, 3500)}`;

    const res = await this.chatText({ systemPrompt, userPrompt });
    const parsed = this._parseJson(res.text);
    if (res.ok && parsed && typeof parsed === "object") {
      return {
        via: res.via,
        title: String(parsed.title || fallback.title).trim(),
        category: String(parsed.category || fallback.category).trim(),
        tags: Array.isArray(parsed.tags) && parsed.tags.length ? parsed.tags.map(String).slice(0, 8) : fallback.tags,
        summary: String(parsed.summary || fallback.summary).trim(),
        todos: Array.isArray(parsed.todos) ? parsed.todos.map(String).filter(Boolean).slice(0, 6) : fallback.todos,
        related: Array.isArray(parsed.related) ? parsed.related.map(String).filter((t) => allTitles.includes(t)) : fallback.related,
      };
    }
    return { via: res.via || "local-smart", warning: res.error, ...fallback };
  }

  // 2. 收件箱 AI 一键批量整理建议
  async suggestInboxOrganization() {
    const v = await this.getVault();
    const inboxItems = v.list({ category: "收件箱", limit: 50 });
    if (!inboxItems.length) return { via: "none", suggestions: [] };
    const cats = v.listCategories().map((c) => c.name).filter((n) => n !== "收件箱");
    const allTitles = [...v.entries.values()].map((e) => e.meta.title).filter(Boolean);

    const systemPrompt =
      "你是个人知识库整理专家。请将「收件箱」中的条目归类到合适的分类（优先使用现有分类，确有必要可提议 2~6 字的新分类名），并为每条补充 2~4 个精准标签。\n" +
      '严格输出 JSON 数组：[{"id":"条目id","category":"目标分类","tags":["标签1","标签2"],"reason":"简短归类理由"}]';
    const userPrompt =
      `现有非收件箱分类：${cats.join("、") || "（暂无，请根据内容创建如 工作笔记、技术运维、学习资料、生活收藏 等分类）"}\n\n` +
      `收件箱待整理条目（共 ${inboxItems.length} 条）：\n` +
      inboxItems.map((i) => `- id: ${i.id} | 标题: ${i.title} | 现有标签: ${i.tags.join(",")} | 摘要: ${i.snippet}`).join("\n");

    const res = await this.chatText({ systemPrompt, userPrompt, maxTokens: 1800 });
    const parsed = this._parseJson(res.text);
    if (res.ok && Array.isArray(parsed) && parsed.length) {
      const byId = new Map(parsed.map((x) => [String(x.id), x]));
      return {
        via: res.via,
        suggestions: inboxItems.map((item) => {
          const hit = byId.get(item.id);
          const fb = this._heuristicAnalyze(item.title, item.snippet, ["收件箱", ...cats], allTitles);
          const targetCat = (hit?.category && hit.category !== "收件箱") ? String(hit.category) : (fb.category !== "收件箱" ? fb.category : (cats[0] || "精选归档"));
          return {
            id: item.id,
            title: item.title,
            category: targetCat,
            tags: [...new Set([...(item.tags || []), ...(Array.isArray(hit?.tags) ? hit.tags.map(String) : fb.tags)])].slice(0, 6),
            reason: String(hit?.reason || "AI 语义匹配"),
          };
        }),
      };
    }

    return {
      via: "local-smart",
      warning: res.error,
      suggestions: inboxItems.map((item) => {
        const fb = this._heuristicAnalyze(item.title, item.snippet, ["收件箱", ...cats], allTitles);
        return {
          id: item.id,
          title: item.title,
          category: fb.category !== "收件箱" ? fb.category : (cats[0] || "日常笔记"),
          tags: [...new Set([...(item.tags || []), ...fb.tags])].slice(0, 6),
          reason: "基于内容关键词自动归类",
        };
      }),
    };
  }

  // 3. 库内 AI 问答（基于收藏夹内容回答用户问题）
  async askVault(question) {
    const v = await this.getVault();
    const q = String(question || "").trim();
    if (!q) throw new Error("请输入要询问的问题");
    const hits = v.list({ query: q, limit: 8 });
    const pool = hits.length ? hits : v.list({ limit: 8 });
    const fullDocs = pool.map((h) => v.get(h.id)).filter(Boolean);

    if (!fullDocs.length) {
      return { answer: "你的收藏夹目前还是空的，先收藏一些笔记或网页再来问我吧！", sources: [], via: "none" };
    }

    const contextText = fullDocs.map((d, idx) =>
      `【资料 ${idx + 1}】标题：《${d.title}》（分类：${d.category}，标签：${d.tags.join("/") || "无"}）\n内容：\n${String(d.content).slice(0, 800)}`
    ).join("\n\n---\n\n");

    const systemPrompt =
      "你是「念念收藏夹」的 AI 知识助手。请严格依据下方提供的【收藏夹资料】回答用户问题。\n" +
      "要求：1. 提及具体资料时请使用 [[资料标题]] 双链格式，方便用户点击跳转；2. 简洁、准确、条理清晰，不要说空话。";
    const userPrompt = `用户问题：${q}\n\n【收藏夹资料】：\n${contextText}`;

    const res = await this.chatText({ systemPrompt, userPrompt });
    if (res.ok && res.text) {
      return {
        answer: res.text,
        sources: fullDocs.map((d) => ({ id: d.id, title: d.title, category: d.category })),
        via: res.via,
      };
    }

    const summaryLines = fullDocs.slice(0, 4).map((d) => `- **[[${d.title}]]**（${d.category}）：${d.snippet}`);
    return {
      answer: `在收藏夹中为你找到 ${fullDocs.length} 条相关笔记：\n\n${summaryLines.join("\n")}\n\n> 💡 提示：若在 OpenHanako「设置 → 应用 → 权限」中开启本应用的模型推理权限（\`app/models.infer\`），即可直接调用你配置的模型供应商生成深度综合回答。`,
      sources: fullDocs.map((d) => ({ id: d.id, title: d.title, category: d.category })),
      via: "local-search",
    };
  }
}
