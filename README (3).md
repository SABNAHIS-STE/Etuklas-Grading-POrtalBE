# E-Tuklas Grading Server

A standalone backend that grades student research submissions using
Mistral (primary), OpenAI (fallback), and Groq (fallback), in that order.
Built to fix two problems:

1. **Keys were exposed client-side.** The grading API key lived in the
   browser (same pattern as the Research Portal's chatbot before it got a
   backend). Now it lives only in this server's environment variables.
2. **Every submission scored ~8/10 regardless of quality.** This happens
   when a model is asked for a bare number with no calibration ("rate this
   1-10") \u2014 it defaults to a polite, non-committal score. The fix is in
   `server.js`'s prompt: the model must write specific, quoted criticism
   for at least 2 rubric dimensions BEFORE it's allowed to assign a number,
   and explicit anchor descriptions tell it what a 5 vs a 9 actually looks
   like so "average student work" gets graded as average.

## \u26A0\uFE0F Cost note: OpenAI is not free

Mistral and Groq both have solid free tiers. **OpenAI does not** \u2014 new
accounts get a small trial credit, then it's pay-per-use (gpt-4o-mini is
cheap, roughly fractions of a cent per grading call, but it's not $0).
Since Mistral is tried first and Groq is the final fallback, OpenAI should
rarely actually get used in practice \u2014 only if Mistral is down or
rate-limited. If you'd rather avoid any chance of a bill, you can remove
the `callOpenAI` step from the fallback chain in `server.js` and go
straight Mistral \u2192 Groq; say the word and I'll make that edit.

## 1. Get API keys

- **Mistral**: https://console.mistral.ai \u2014 free tier
- **OpenAI**: https://platform.openai.com/api-keys \u2014 not free, see above
- **Groq**: https://console.groq.com \u2014 free tier

## 2. Run locally first

```bash
cd etuklas-grading-server
npm install
cp .env.example .env
# paste your two keys into .env
npm start
```

Test it:
```bash
curl -X POST http://localhost:3001/grade \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Effect of Light Color on Plant Growth",
    "abstract": "This study examines...",
    "methodology": "Three groups of bean plants were grown under red, blue, and white light for 14 days.",
    "category": "Biology",
    "gradeLevel": "9"
  }'
```

You should get back JSON with a `rubric` array (each with a `justification`
before its `score`), an `overallScore`, `strengths`, `weaknesses`, and a
`summary`. If every test submission still comes back 8+, paste me the raw
response and the submission you tested with \u2014 that's a sign the prompt
needs further tuning for your specific rubric expectations.

## 3. Deploy to Render

1. Push this folder to its own GitHub repo (or a subfolder of an existing
   one \u2014 in that case set Render's "Root Directory" to this folder's path)
2. Render dashboard \u2192 **New** \u2192 **Web Service** \u2192 connect the repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Under **Environment**, add `MISTRAL_API_KEY`, `OPENAI_API_KEY`, and
   `GROQ_API_KEY` (same values as your local `.env` \u2014 never commit `.env`
   itself, `.gitignore` already excludes it)
6. Deploy. Render will give you a URL like
   `https://etuklas-grading-server.onrender.com`

## 4. Point the frontend at it

Wherever E-Tuklas currently calls Gemini/Groq directly from the browser to
grade a submission, replace that with a call to this server instead:

```javascript
const res = await fetch("https://etuklas-grading-server.onrender.com/grade", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title: study.title,
    abstract: study.abstract,
    methodology: study.methodology,
    content: study.fullContent, // whatever field holds the paper text
    category: study.category,
    gradeLevel: study.gradeLevel
  })
});
const result = await res.json();
// result.overallScore, result.rubric, result.strengths, result.weaknesses, result.summary
```

I don't have the actual frontend grading code to make this edit directly
\u2014 paste it here (or tell me the file/repo) once you find it and I'll wire
this in for real instead of leaving it as a snippet.

## 5. Tuning the rubric

Open `server.js` and edit the `RUBRIC` array near the top \u2014 dimension
names, weights (must sum to 1), and the `SCORE_ANCHORS` text describing
what each score band actually looks like. If your school already has a
specific rubric document, send it over and I'll encode it exactly instead
of the generic one here.

## Note on Render free tier

Free Render web services spin down after ~15 minutes of no traffic and
take ~30-50 seconds to wake back up on the next request. If grading feels
slow the first time after a lull, that's why \u2014 not a bug. If that's a
problem for your users, Render's paid tier removes the spin-down, or you
can ping `/health` periodically from a free uptime-monitoring service to
keep it warm.
