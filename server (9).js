/**
 * E-Tuklas Grading Server
 * ---------------------------------------------------------------------------
 * Standalone Render service. Purpose: move AI-grading API keys server-side
 * (they were previously used directly from the browser, same pattern as the
 * Research Portal's chatbot) AND fix the "every submission gets an 8"
 * problem, which happens when a model is asked for a bare score with no
 * calibration anchors \u2014 it defaults to a polite, non-committal number.
 *
 * Provider chain: Mistral (primary) \u2192 OpenAI (fallback) \u2192 Groq (fallback).
 *
 * The fix here is prompt structure, not a smarter model:
 *   1. The model must write out reasoning for EACH rubric dimension first.
 *   2. It must cite at least 2 concrete weaknesses with a quoted phrase or
 *      specific location in the text \u2014 "well written" is rejected.
 *   3. Only after that does it emit a number, per dimension, then an overall
 *      score is computed as a weighted average IN CODE (not by the model),
 *      so the model can't just anchor everything to a comfortable 8/10.
 *   4. Explicit anchor descriptions for what a 2, a 5, and a 9 actually look
 *      like, so "average" work is graded as average, not as "pretty good."
 *
 * Endpoints:
 *   POST /grade   { title, abstract, methodology, content, category, gradeLevel }
 *                 -> { overallScore, rubric: [{dimension, score, justification}],
 *                      strengths: [...], weaknesses: [...], summary, source }
 *   GET  /health  -> { ok: true }
 * ---------------------------------------------------------------------------
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3001;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ---------------------------------------------------------------------------
// Rubric definition \u2014 EDIT THIS to match your school's actual criteria.
// Weights must sum to 1.
// ---------------------------------------------------------------------------
const RUBRIC = [
  { key: 'clarity', label: 'Clarity & Organization', weight: 0.2 },
  { key: 'methodology', label: 'Methodology Rigor', weight: 0.25 },
  { key: 'originality', label: 'Originality & Significance', weight: 0.2 },
  { key: 'evidence', label: 'Evidence & Analysis', weight: 0.25 },
  { key: 'writing', label: 'Writing Quality', weight: 0.1 }
];

const SCORE_ANCHORS = `
Score calibration \u2014 use the FULL range, most submissions from first-time
student researchers should land in the 4-7 range, NOT 8-9:
- 9-10: Publication-quality. Rigorous methodology, original contribution,
  no significant gaps. Rare, even for strong students.
- 7-8: Solid, above-average student work. Clear methodology with only minor
  gaps, reasonably original angle, well-organized.
- 5-6: Average. Meets basic requirements but has a real, specific weakness
  \u2014 e.g. small/unclear sample, derivative topic, weak discussion of
  limitations, or unsupported claims.
- 3-4: Below average. Multiple weaknesses \u2014 unclear research question,
  methodology that can't actually answer the stated question, minimal
  original analysis.
- 1-2: Major deficiencies across most dimensions, or evidence of not
  following the assignment/research process at all.
Do NOT default to 7-8 out of politeness. A 5 is a normal, non-insulting
score for typical first-attempt student research \u2014 say so plainly.`;

function buildPrompt({ title, abstract, methodology, content, category, gradeLevel }) {
  const rubricList = RUBRIC.map((r) => `- ${r.label} (${r.key})`).join('\n');
  return `You are grading a student STEM research submission for grade level ${gradeLevel || 'unspecified'}, category: ${category || 'unspecified'}.

TITLE: ${title || '(none provided)'}

ABSTRACT: ${abstract || '(none provided)'}

METHODOLOGY: ${methodology || '(none provided)'}

FULL CONTENT (truncated if long):
${(content || '').slice(0, 6000) || '(none provided)'}

${SCORE_ANCHORS}

Grade against these rubric dimensions:
${rubricList}

CRITICAL RULES:
1. For EACH dimension, first write 1-3 sentences of genuine critique. At
   least TWO dimensions total must cite a SPECIFIC weakness \u2014 quote or
   closely paraphrase the actual problematic part of the text. Generic
   praise like "well written" or "good job" without specifics is not
   acceptable and will be treated as a failed response.
2. Only after writing the critique, assign a 0-10 score for that dimension,
   consistent with the critique you just wrote (a critique full of
   weaknesses should not receive an 8+).
3. List at least 2 concrete strengths AND at least 2 concrete weaknesses
   overall, each one specific to THIS submission, not generic.
4. Respond with ONLY valid JSON, no markdown fences, no preamble, matching
   exactly this shape:

{
  "rubric": [
    { "key": "clarity", "justification": "...", "score": 0 },
    { "key": "methodology", "justification": "...", "score": 0 },
    { "key": "originality", "justification": "...", "score": 0 },
    { "key": "evidence", "justification": "...", "score": 0 },
    { "key": "writing", "justification": "...", "score": 0 }
  ],
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "summary": "2-3 sentence overall summary for the student"
}`;
}

function computeOverallScore(rubricResult) {
  let total = 0;
  let weightSum = 0;
  for (const r of RUBRIC) {
    const found = rubricResult.find((x) => x.key === r.key);
    const score = found && typeof found.score === 'number' ? found.score : 5;
    total += score * r.weight;
    weightSum += r.weight;
  }
  return Math.round((total / weightSum) * 10) / 10;
}

function extractJSON(text) {
  const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callMistral(prompt) {
  if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY not configured');
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MISTRAL_API_KEY}`
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000
    })
  });
  if (!res.ok) throw new Error(`Mistral HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Mistral returned no text');
  return text;
}

async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000
    })
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned no text');
  return text;
}

async function callGroq(prompt) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000
    })
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned no text');
  return text;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/grade', async (req, res) => {
  const { title, abstract, methodology, content, category, gradeLevel } = req.body || {};
  if (!abstract && !content) {
    return res.status(400).json({ error: 'At least an abstract or content is required to grade.' });
  }
  const prompt = buildPrompt({ title, abstract, methodology, content, category, gradeLevel });

  let rawText, source;
  try {
    rawText = await callMistral(prompt);
    source = 'mistral';
  } catch (mistralErr) {
    console.error('Mistral failed, falling back to OpenAI:', mistralErr.message);
    try {
      rawText = await callOpenAI(prompt);
      source = 'openai';
    } catch (openaiErr) {
      console.error('OpenAI failed, falling back to Groq:', openaiErr.message);
      try {
        rawText = await callGroq(prompt);
        source = 'groq';
      } catch (groqErr) {
        console.error('Groq also failed:', groqErr.message);
        return res.status(502).json({ error: 'All three grading providers failed. Try again shortly.' });
      }
    }
  }

  let parsed;
  try {
    parsed = extractJSON(rawText);
  } catch (e) {
    console.error('Failed to parse model JSON:', e.message, '\nRaw:', rawText);
    return res.status(502).json({ error: 'Grading model returned an unparseable response. Please retry.' });
  }

  const rubricResult = Array.isArray(parsed.rubric) ? parsed.rubric : [];
  const overallScore = computeOverallScore(rubricResult);

  res.json({
    overallScore,
    rubric: rubricResult.map((r) => {
      const def = RUBRIC.find((d) => d.key === r.key);
      return { key: r.key, label: def ? def.label : r.key, score: r.score, justification: r.justification };
    }),
    strengths: parsed.strengths || [],
    weaknesses: parsed.weaknesses || [],
    summary: parsed.summary || '',
    source
  });
});

app.listen(PORT, () => {
  console.log(`E-Tuklas grading server listening on port ${PORT}`);
});
