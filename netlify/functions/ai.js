// Netlify Function: sends meal-estimate requests to an AI provider.
// Provider is chosen by which key you set in Netlify → Environment variables:
//   GEMINI_API_KEY    → Google Gemini (has a free tier, no card needed)
//   ANTHROPIC_API_KEY → Anthropic Claude (needs paid credits)
// If both are set, Gemini is used (override with AI_PROVIDER = "anthropic").

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const uniq = (a) => a.filter(Boolean).filter((m, i, arr) => arr.indexOf(m) === i);

// If SUPABASE_URL and SUPABASE_ANON_KEY are set, only signed-in Kalo users may call this function.
async function verifyUser(event) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return process.env.ALLOW_ANONYMOUS === "true" ? true : "misconfigured"; // fail closed unless explicitly allowed
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  if (!/^Bearer .+/.test(auth)) return false;
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/auth/v1/user", { headers: { apikey: key, Authorization: auth } });
    return r.ok;
  } catch { return false; }
}

// Both callers return { ok, status, text, detail }
let geminiCache;
async function geminiModels() {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (geminiCache) return geminiCache;
  try { // ask Google which Flash models this key can use, newest first (old ones get retired)
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } });
    if (r.ok) {
      const d = await r.json();
      const c = (d.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => { const n = m.name.replace("models/", ""); const x = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/.exec(n); return x ? { n, v: parseFloat(x[1]), lite: !!x[2] } : null; })
        .filter(Boolean)
        .sort((a, b) => b.v - a.v || a.lite - b.lite);
      if (c.length) return (geminiCache = c.slice(0, 3).map((x) => x.n));
    }
  } catch { /* fall through to defaults */ }
  return ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
}

async function callGemini(prompt, image) {
  const parts = [{ text: prompt + "\n\nReply with a single JSON object only." }];
  if (image) parts.push({ inline_data: { mime_type: "image/jpeg", data: image } });
  const send = (model, withThinking) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2500, temperature: 0.2, ...(withThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
    }),
  });
  let last;
  for (const model of await geminiModels()) {
    let res = await send(model, true);
    if (res.status === 400) res = await send(model, false); // some newer models reject thinkingBudget
    if (res.ok) {
      const d = await res.json();
      const text = ((d.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("");
      return { ok: true, status: 200, text };
    }
    const raw = await res.text().catch(() => "");
    console.error(`Gemini error ${res.status} (model ${model}):`, raw.slice(0, 500));
    let msg = ""; try { msg = JSON.parse(raw).error.message; } catch { msg = raw.slice(0, 160); }
    last = { ok: false, status: res.status, detail: msg };
    if (res.status !== 404) break; // only try the next model when this one wasn't found
  }
  return last;
}

async function callAnthropic(prompt, image, hasImage) {
  const all = uniq([process.env.ANTHROPIC_MODEL, "claude-sonnet-5-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  const models = process.env.ANTHROPIC_MODEL || hasImage ? all : uniq(["claude-haiku-4-5-20251001", ...all]); // text is simple: fast model first
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
  content.push({ type: "text", text: prompt + "\n\nReply with a single JSON object only, no other text." });
  let last;
  for (const model of models) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: "user", content }] }),
    });
    if (res.ok) {
      const d = await res.json();
      return { ok: true, status: 200, text: (d.content || []).map((c) => (c.type === "text" ? c.text : "")).join("") };
    }
    const raw = await res.text().catch(() => "");
    console.error(`Anthropic error ${res.status} (model ${model}):`, raw.slice(0, 500));
    let msg = ""; try { msg = JSON.parse(raw).error.message; } catch { msg = raw.slice(0, 160); }
    last = { ok: false, status: res.status, detail: msg };
    if (res.status !== 404) break;
  }
  return last;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const hasGemini = !!process.env.GEMINI_API_KEY, hasClaude = !!process.env.ANTHROPIC_API_KEY;
  if (!hasGemini && !hasClaude) {
    console.error("No AI key set");
    return json(500, { error: "Server not configured", detail: "Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in Netlify" });
  }
  const provider = hasGemini && hasClaude ? (process.env.AI_PROVIDER === "anthropic" ? "anthropic" : "gemini") : hasGemini ? "gemini" : "anthropic";

  const who = await verifyUser(event);
  if (who === "misconfigured") {
    console.error("SUPABASE_URL / SUPABASE_ANON_KEY missing");
    return json(500, { error: "Server not configured", detail: "SUPABASE_URL or SUPABASE_ANON_KEY is missing or misspelled in Netlify" });
  }
  if (!who) return json(401, { error: "Sign in required" });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad JSON" }); }

  const prompt = String(b.prompt || "").slice(0, 4000);
  if (!prompt) return json(400, { error: "Missing prompt" });

  const image = b.image && b.image.data ? b.image.data : null;
  if (image && image.length > 4_500_000) return json(413, { error: "Image too large" });

  let r;
  try { r = provider === "gemini" ? await callGemini(prompt, image) : await callAnthropic(prompt, image, !!image); }
  catch (e) { console.error("Upstream unreachable:", e.message); return json(502, { error: "Upstream unreachable" }); }

  if (!r.ok) {
    if (r.status === 429) return json(429, { error: "Rate limited", detail: r.detail });
    return json(502, { error: "Upstream error", status: r.status, detail: String(r.detail || "").slice(0, 200) });
  }
  const m = String(r.text).replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  try { return json(200, JSON.parse(m ? m[0] : r.text)); }
  catch { console.error("Unparseable AI reply:", String(r.text).slice(0, 300)); return json(502, { error: "Could not parse AI reply" }); }
};
