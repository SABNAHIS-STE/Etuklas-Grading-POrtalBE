// ════════════════════════════════════════════════════
// AI grading
// ────────────────────────────────────────────────────
// REVISION NOTE (this replaces the "unchanged from original" prompt):
// the original prompt asked for a 0-25 score per criterion with NO
// description of what different score bands actually look like. Combined
// with temperature:0 and an instruction to "be consistent," the model's
// safest default was a generic ~20/25 on every criterion for nearly every
// submission -> 80/100 -> "approved" with an 8-ish score, regardless of
// actual quality. That's not the model being lazy so much as an
// underspecified rubric leaving it nothing else to anchor to.
//
// Fix: each criterion now has explicit score-band descriptions, and the
// model must write real critique (citing a specific phrase/sentence when
// the score isn't in the top band) BEFORE the number, so the score has to
// follow from something actually said about THIS text. Everything else in
// this file (JSON shape, provider chain, quota/retry logic) is unchanged —
// this is a drop-in replacement, nothing that calls reviewSection() needs
// to change.
// ════════════════════════════════════════════════════

export const SECTIONS = [
  { id: "abstract", label: "Abstract" },
  { id: "rationale", label: "Rationale / Background of the Study" },
  { id: "methodology", label: "Methodology" }
];

export const CATEGORIES = [
  "Life Science",
  "Mathematical and Computational Science",
  "Physical Science",
  "Robotics and Intelligent Machines",
  "Innovation Expo"
];

const DEFAULT_CRITERIA = `
You are the official AI reviewer for E-Tuklas, a Philippine Junior High School
(Grade 8-10) research portal. You are grading ONLY the "{SECTION_LABEL}"
section of a student research paper. This grade is shown directly to the
student and to their teacher, and the teacher may revise it afterward — so it
must be seriously honest, specific, and fair. Do not be falsely encouraging
and do not be needlessly harsh. Grade exactly what is on the page.

Score these four criteria out of 25 points each (100 total):
1. Relevance — does the content actually belong in a "{SECTION_LABEL}" section
   and address what that section is supposed to cover, for a JHS-level study?
2. Coherence & Clarity — is it written in clear, logically ordered academic
   English or Filipino prose a Grade 8-10 reader could follow?
3. Completeness — does it cover what a "{SECTION_LABEL}" section needs (not
   padded, not a one-line stub, not copy-pasted instructions)?
4. Academic Tone & Mechanics — appropriate register, grammar, and structure
   for a school research submission (not casual chat text, not obvious
   placeholder/lorem ipsum).

SCORE CALIBRATION — use the full 0-25 range on EACH criterion. A typical
first-attempt JHS submission should land in the "Adequate" band below, NOT
the "Strong" band. Do not default to a high score out of politeness — a
14/25 is a normal, non-insulting score for typical first-draft student work.
  - 22-25 "Excellent": Would need essentially no revision. Rare, even for
    strong JHS students. Every sentence earns its place.
  - 17-21 "Strong": Clearly above average, only minor/cosmetic issues.
  - 11-16 "Adequate": Meets the bare requirement but has a real, specific
    weakness for THIS criterion — e.g. vague claims, a gap in logic, thin
    coverage of something the section needs, awkward phrasing in places.
  - 5-10 "Weak": Multiple real problems — unclear purpose, significant gaps,
    hard to follow, or noticeably underdeveloped for this section.
  - 0-4 "Missing/Failing": Does not meaningfully address this section at all,
    or is placeholder/lorem-ipsum/copy-pasted instruction text.

CRITICAL RULES:
1. For every criterion scored below 22, the "note" MUST name a specific,
   concrete issue — quote or closely paraphrase the actual problematic
   phrase, sentence, or missing element from the text below. A note that
   could apply to any random submission (e.g. "could be clearer," "good
   effort") without pointing at anything specific in THIS text is not
   acceptable.
2. Two different submissions of different actual quality MUST receive
   meaningfully different scores. If your instinct is to write a generic
   positive note without being able to point to anything specific in this
   text, that is a sign to slow down and actually engage with what's
   written, not a green light to default high.
3. "note" should be 1-2 full sentences — enough room for one specific,
   actionable observation, not just a rating restated in words.

Total the four scores into scorePercent (0-100). Decide status by total:
- 80-100: "approved"
- 50-79: "needs_revision"
- 0-49: "rejected"

Respond ONLY in this exact JSON shape, no markdown fences, no preamble:
{"status":"approved" | "needs_revision" | "rejected","scorePercent":0,"criteria":[{"name":"Relevance","score":0,"max":25,"note":"specific, honest observation citing this text"},{"name":"Coherence & Clarity","score":0,"max":25,"note":"specific, honest observation citing this text"},{"name":"Completeness","score":0,"max":25,"note":"specific, honest observation citing this text"},{"name":"Academic Tone & Mechanics","score":0,"max":25,"note":"specific, honest observation citing this text"}],"remarks":"2-4 sentences: a direct, specific, honest summary of what is good and exactly what needs to change, written for a Grade 8-10 student to act on"}

scorePercent MUST equal the sum of the four criteria scores. Be consistent:
the same quality of writing should get the same grade every time — but
different quality writing MUST get different grades. Do not invent praise
that isn't earned and do not invent flaws that aren't there.

SECTION TEXT TO REVIEW:
"""
{TEXT}
"""
`.trim();

function buildPrompt(sectionLabel, text) {
  return DEFAULT_CRITERIA
    .replaceAll("{SECTION_LABEL}", sectionLabel)
    .replace("{TEXT}", text.slice(0, 12000));
}

function parseVerdict(raw) {
  let cleaned = raw.trim()
    .replace(/^```json\s*|^```\s*|```$/g, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.status || typeof parsed.scorePercent !== "number" || !Array.isArray(parsed.criteria)) {
    throw new Error("AI verdict missing required fields");
  }
  return parsed;
}

// ── Shared helper for OpenAI-compatible chat/completions endpoints ──
// Groq, OpenAI, Mistral, Cerebras, and OpenRouter all speak this same
// request/response shape, so one helper covers all of them.
async function callOpenAICompatible({ url, apiKey, model, prompt, extraHeaders, providerLabel }) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...(extraHeaders || {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) {
    let bodyText = "";
    try { bodyText = await res.text(); } catch (e) {}
    console.error(`[${providerLabel}] request failed (${res.status}):`, bodyText);
    const err = new Error(`${providerLabel} request failed (${res.status}): ${bodyText}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return parseVerdict(text);
}

async function callGemini(prompt, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 }
      })
    }
  );
  if (!res.ok) {
    const err = new Error(`Gemini request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseVerdict(text);
}

async function callGroq(prompt, apiKey) {
  return callOpenAICompatible({
    url: "https://api.groq.com/openai/v1/chat/completions",
    apiKey,
    model: "llama-3.3-70b-versatile",
    prompt,
    providerLabel: "Groq"
  });
}

async function callOpenAI(prompt, apiKey) {
  return callOpenAICompatible({
    url: "https://api.openai.com/v1/chat/completions",
    apiKey,
    model: "gpt-4o-mini",
    prompt,
    providerLabel: "OpenAI"
  });
}

async function callMistral(prompt, apiKey) {
  return callOpenAICompatible({
    url: "https://api.mistral.ai/v1/chat/completions",
    apiKey,
    // "mistral-small-latest" is the current lightweight tier on the free
    // "Experiment" plan. Check console.mistral.ai if this model is retired.
    model: "mistral-small-latest",
    prompt,
    providerLabel: "Mistral"
  });
}

async function callCerebras(prompt, apiKey) {
  return callOpenAICompatible({
    url: "https://api.cerebras.ai/v1/chat/completions",
    apiKey,
    // Cerebras's free-tier model catalog changes without much notice —
    // verify this model is still active at cloud.cerebras.ai if you start
    // seeing 404s instead of the usual 429/403 quota errors.
    model: "llama-3.3-70b",
    prompt,
    providerLabel: "Cerebras"
  });
}

async function callOpenRouter(prompt, apiKey) {
  return callOpenAICompatible({
    url: "https://openrouter.ai/api/v1/chat/completions",
    apiKey,
    // The ":free" suffix routes to OpenRouter's no-cost model pool.
    // Swap this if the specific model is deprecated — check openrouter.ai/models.
    model: "meta-llama/llama-3.3-70b-instruct:free",
    prompt,
    // OpenRouter asks for these to attribute/rank free-tier traffic; not
    // strictly required but recommended so your app doesn't get deprioritized.
    extraHeaders: {
      "HTTP-Referer": "https://sabnahis-ste.github.io",
      "X-Title": "E-Tuklas Online Checker"
    },
    providerLabel: "OpenRouter"
  });
}

const isQuotaError = (err) => err.status === 429 || err.status === 403;

const PROVIDERS = {
  gemini: { call: callGemini, keyEnv: "GEMINI_API_KEY" },
  groq: { call: callGroq, keyEnv: "GROQ_API_KEY" },
  openai: { call: callOpenAI, keyEnv: "OPENAI_API_KEY" },
  mistral: { call: callMistral, keyEnv: "MISTRAL_API_KEY" },
  cerebras: { call: callCerebras, keyEnv: "CEREBRAS_API_KEY" },
  openrouter: { call: callOpenRouter, keyEnv: "OPENROUTER_API_KEY" }
};

// Order used to fill out the rest of the chain after primary/fallback.
// Free-tier friendly providers first, since those are most likely to be
// the ones actually configured with a key.
const DEFAULT_CHAIN_ORDER = ["gemini", "groq", "openrouter", "mistral", "cerebras", "openai"];

/**
 * Grades a section by walking an ordered chain of providers, moving to the
 * next provider only on a quota/rate-limit error (429/403) — an
 * arbitrary-failure fallback would silently swap models mid-stream and
 * reintroduce "same abstract, different score" inconsistency. On any other
 * error it retries the same provider with backoff before giving up on it.
 *
 * config: { primary: providerName, fallback: providerName, chain: [providerName, ...] }
 * - If config.chain is given, it's used as-is (only known provider names, keys present).
 * - Otherwise the chain is built from config.primary + config.fallback, followed by
 *   any remaining known providers in DEFAULT_CHAIN_ORDER, so a single provider's
 *   outage never fully stalls grading as long as ANY key is configured.
 * - Providers without an API key set in the environment are skipped entirely.
 */
export async function reviewSection(sectionLabel, text, config) {
  const prompt = buildPrompt(sectionLabel, text);

  let chain;
  if (Array.isArray(config?.chain) && config.chain.length) {
    chain = config.chain.filter(name => PROVIDERS[name]);
  } else {
    const primaryName = config?.primary && PROVIDERS[config.primary] ? config.primary : "gemini";
    const fallbackName = config?.fallback && PROVIDERS[config.fallback] ? config.fallback : "groq";
    const rest = DEFAULT_CHAIN_ORDER.filter(name => name !== primaryName && name !== fallbackName);
    chain = [primaryName, fallbackName, ...rest];
  }

  // Only attempt providers that actually have a key configured.
  chain = chain.filter(name => process.env[PROVIDERS[name].keyEnv]);
  if (!chain.length) {
    throw new Error("No AI provider API keys are configured");
  }

  let lastErr;
  for (const providerName of chain) {
    const provider = PROVIDERS[providerName];
    const apiKey = process.env[provider.keyEnv];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const verdict = await provider.call(prompt, apiKey);
        return { ...verdict, provider: providerName };
      } catch (e) {
        lastErr = e;
        if (isQuotaError(e)) break; // don't waste a retry on this provider, move to the next
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    // Loop continues to the next provider in the chain regardless of why
    // this one failed (quota exhausted OR repeated non-quota errors).
  }

  throw lastErr;
}
