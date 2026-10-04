// Netlify Function: proxies meal-estimate requests to the Anthropic API.
// Set ANTHROPIC_API_KEY in Netlify → Site configuration → Environment variables.
const MODELS = [process.env.ANTHROPIC_MODEL, "claude-sonnet-5-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]
  .filter(Boolean)
  .filter((m, i, a) => a.indexOf(m) === i);

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

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    return json(500, { error: "Server not configured", detail: "ANTHROPIC_API_KEY is missing in Netlify" });
  }

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

  const content = [];
  if (b.image && b.image.data) {
    if (b.image.data.length > 4_500_000) return json(413, { error: "Image too large" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.image.data } });
  }
  content.push({ type: "text", text: prompt + "\n\nReply with a single JSON object only, no other text." });

  const hasImage = !!(b.image && b.image.data);
  const list = process.env.ANTHROPIC_MODEL || hasImage
    ? MODELS
    : ["claude-haiku-4-5-20251001", ...MODELS].filter((m, i, arr) => arr.indexOf(m) === i); // text is simple: use the fast model first
  let res, detail = "";
  for (const model of list) {
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: "user", content }] }),
      });
    } catch (e) {
      console.error("Anthropic unreachable:", e.message);
      return json(502, { error: "Upstream unreachable" });
    }
    if (res.ok) break;
    detail = await res.text().catch(() => "");
    console.error(`Anthropic error ${res.status} (model ${model}):`, detail.slice(0, 500));
    if (res.status !== 404) break; // only try the next model when this one wasn't found
  }

  if (res.status === 429) return json(429, { error: "Rate limited" });
  if (!res.ok) {
    let msg = "";
    try { msg = JSON.parse(detail).error.message; } catch { msg = String(detail).slice(0, 160); }
    return json(502, { error: "Upstream error", status: res.status, detail: String(msg).slice(0, 200) });
  }

  const data = await res.json();
  const text = (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
  const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  try { return json(200, JSON.parse(m ? m[0] : text)); }
  catch { console.error("Unparseable AI reply:", text.slice(0, 300)); return json(502, { error: "Could not parse AI reply" }); }
};
