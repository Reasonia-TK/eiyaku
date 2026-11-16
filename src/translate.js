// 翻訳エンジン: ローカル(WebLLM/WebGPU)と OpenAI互換API の2方式
// エンジンはモジュール内で共有し、実行は直列化する(訳し直し時の競合防止)

const SYSTEM_PROMPT =
  "あなたは学術論文の専門翻訳者です。ユーザーが入力する英文を、自然で正確な日本語に翻訳してください。" +
  "訳文のみを出力し、説明・注釈・原文の繰り返しは出力しないでください。" +
  "専門用語は正確に訳してください。著者名・所属・参考文献の書誌情報は原文のまま残してください。";

let sharedEngine = null;
let sharedModel = null;
let activeRunPromise = null;

function cleanOutput(s) {
  let t = (s || "").trim();
  t = t.replace(/^(訳|翻訳|日本語訳|翻訳結果)\s*[:：]\s*/, "");
  if ((t.startsWith("「") && t.endsWith("」")) || (t.startsWith('"') && t.endsWith('"'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function buildMessages(text, glossary) {
  let user = "";
  if (glossary && glossary.length) {
    user += "次の訳語は必ずこの通りに使ってください:\n" + glossary.map((g) => `- ${g.en}: ${g.ja}`).join("\n") + "\n\n";
  }
  user += "次の英文を日本語に翻訳してください:\n" + text;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

async function ensureLocalEngine(model, onStatus) {
  if (!navigator.gpu) {
    throw new Error("このブラウザは WebGPU に対応していません。Chrome / Edge の最新版を使うか、設定で「API方式」に切り替えてください。");
  }
  if (sharedEngine && sharedModel === model) return sharedEngine;
  if (sharedEngine) {
    try { await sharedEngine.unload(); } catch { /* noop */ }
    sharedEngine = null;
    sharedModel = null;
  }
  onStatus?.("翻訳モデルを読み込み中…", { indeterminate: true });
  const { CreateMLCEngine } = await import("web-llm");
  sharedEngine = await CreateMLCEngine(model, {
    initProgressCallback: (p) => {
      const pct = Math.round((p.progress || 0) * 100);
      onStatus?.(`モデル準備 ${pct}%`, { progress: p.progress, indeterminate: !p.progress });
    },
  });
  sharedModel = model;
  return sharedEngine;
}

export class Translator {
  constructor({ settings, glossary, onResult, onProgress, onStatus, onError }) {
    this.settings = settings;
    this.glossary = glossary;
    this.onResult = onResult;
    this.onProgress = onProgress;
    this.onStatus = onStatus;
    this.onError = onError;
    this.stopped = false;
    this.running = false;
  }

  async translateOne(text) {
    const messages = buildMessages(text, this.glossary);
    const maxTokens = Math.min(2048, Math.ceil(text.length * 2.2) + 80);
    if (this.settings.engine.mode === "api") {
      const { endpoint, apiModel, apiKey } = this.settings.engine;
      const base = (endpoint || "https://api.openai.com/v1").replace(/\/+$/, "");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: apiModel || "gpt-4o-mini", messages, temperature: 0.2, max_tokens: maxTokens }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`APIエラー HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      return cleanOutput(data.choices?.[0]?.message?.content);
    }
    const engine = await ensureLocalEngine(this.settings.engine.model, this.onStatus);
    const reply = await engine.chat.completions.create({
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
    });
    return cleanOutput(reply.choices?.[0]?.message?.content);
  }

  // blocks: 未訳のブロック配列 / getPriority: 小さいほど先に訳す(表示中ページ優先)
  run(blocks, getPriority) {
    const prev = activeRunPromise;
    const task = (async () => {
      if (prev) {
        try { await prev; } catch { /* noop */ }
      }
      if (this.stopped) return;
      this.running = true;
      const total = blocks.length;
      let done = 0;
      const pending = [...blocks];
      const pickNext = () => {
        let bi = 0;
        let bp = Infinity;
        for (let i = 0; i < pending.length; i++) {
          const p = getPriority ? getPriority(pending[i]) : pending[i].page;
          if (p < bp) { bp = p; bi = i; }
        }
        return pending.splice(bi, 1)[0];
      };
      const worker = async () => {
        while (!this.stopped && pending.length) {
          const block = pickNext();
          try {
            let ja = await this.translateOne(block.text);
            if (!ja && !this.stopped) ja = await this.translateOne(block.text); // 空応答は1回だけ再試行
            if (this.stopped) break;
            if (ja) this.onResult?.(block, ja);
          } catch (e) {
            if (this.stopped) break;
            this.onError?.(e, block);
            break;
          }
          done++;
          this.onProgress?.(done, total);
        }
      };
      try {
        if (this.settings.engine.mode === "api") {
          await Promise.all([worker(), worker(), worker()]);
        } else {
          await worker();
        }
      } finally {
        this.running = false;
        this.onProgress?.(done, total, true);
      }
    })();
    activeRunPromise = task;
    return task;
  }

  stop() {
    this.stopped = true;
    if (sharedEngine && sharedEngine.interruptGenerate) {
      try { sharedEngine.interruptGenerate(); } catch { /* noop */ }
    }
  }
}
