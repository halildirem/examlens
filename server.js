/**
 * ExamLens — server.js (complete final version)
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static('.'));

const VALID_TEACHERS = {
  'teacher1': 'pass1234',
  'teacher2': 'english99',
};

const SYSTEM_PROMPT = `
You are an expert English language examiner for a preparatory school.
Your task is to:
  1. Carefully READ and TRANSCRIBE the handwritten English text in the provided image.
  2. IDENTIFY all language errors in the transcribed text.
  3. CATEGORISE each error using the Error Code system below.
  4. Return your findings ONLY as a valid JSON object — no extra text, no markdown fences.

ERROR CODE TAXONOMY — assign the MOST SPECIFIC matching code:
SP   : Spelling — word is misspelled (e.g. "tecnology" → "technology")
SVA  : Subject-Verb Agreement — verb does not match subject (e.g. "Everyone use" → "Everyone uses")
VT   : Verb Tense — wrong tense (e.g. "he go yesterday" → "he went")
ART  : Article — wrong/missing/extra article (e.g. "a apple" → "an apple")
PREP : Preposition — wrong or missing preposition
PL   : Plural/Singular — wrong noun number (e.g. "peoples" → "people")
PRO  : Pronoun — wrong pronoun form
WW   : Wrong Word — wrong word used entirely
WF   : Word Form — wrong form of the word (e.g. "creativity ideas" → "creative ideas")
WO   : Word Order — words in wrong position
RUN  : Run-on or broken sentence structure
P    : Punctuation — missing/wrong punctuation mark ONLY
CAP  : Capitalization — wrong upper/lower case ONLY

STRICT RULES:
- P = punctuation marks ONLY. NEVER use P for grammar errors.
- CAP = capitalization ONLY.
- SVA = subject-verb number mismatch ONLY. Never use WW for SVA errors.
- Pick the most specific code. When in doubt, be more specific.

REQUIRED JSON OUTPUT (return ONLY this, no extra text, no markdown fences):
{
  "transcribed_text": "<full transcription>",
  "total_errors": <number>,
  "summary": "<one sentence assessment>",
  "errors": [
    {
      "error_code": "<code>",
      "wrong_word":  "<incorrect word or phrase as written>",
      "correction":  "<correct word or phrase>"
    }
  ]
}

If no errors: return empty errors array and total_errors 0.
If image unreadable: return empty transcribed_text and summary explaining why.
`;

function extractJSON(raw) {
  const firstBrace = raw.indexOf('{');
  const lastBrace  = raw.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(raw.slice(firstBrace, lastBrace + 1)); } catch (_) {}
  }

  let jsonStr = firstBrace !== -1 ? raw.slice(firstBrace) : raw;
  jsonStr = jsonStr.replace(/```\s*$/, '').trim();
  jsonStr = jsonStr.replace(/,?\s*\n[^\n]*$/, '');

  let openBraces = 0, openBrackets = 0, inString = false, escape = false;
  for (const ch of jsonStr) {
    if (escape)      { escape = false; continue; }
    if (ch === '\\') { escape = true;  continue; }
    if (ch === '"')  { inString = !inString; continue; }
    if (inString)    continue;
    if      (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }

  if (inString)             jsonStr += '"';
  while (openBraces > 1)   { jsonStr += '}'; openBraces--; }
  while (openBrackets > 0) { jsonStr += ']'; openBrackets--; }
  if (openBraces > 0)       jsonStr += '}';

  const result = JSON.parse(jsonStr);
  console.log(`[extractJSON] Repaired JSON. Recovered ${result?.errors?.length ?? 0} errors.`);
  return result;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'ExamLens server is running.' });
});

app.post('/api/login', (req, res) => {
  const { id, password } = req.body;
  if (!id || !password)
    return res.status(400).json({ error: 'ID and password are required.' });
  if (VALID_TEACHERS[id] && VALID_TEACHERS[id] === password)
    return res.json({ success: true, teacher: id });
  return res.status(401).json({ error: 'Invalid credentials.' });
});

app.post('/api/grade', async (req, res) => {
  const teacherId = req.headers['x-teacher-id'];
  if (!teacherId || !VALID_TEACHERS[teacherId])
    return res.status(401).json({ error: 'Unauthorized.' });

  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: 'No image data received.' });

  const ALLOWED = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];
  const mime    = ALLOWED.includes(mimeType) ? mimeType : 'image/jpeg';

  console.log(`[${new Date().toISOString()}] /api/grade from: ${teacherId}`);

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 8192,
      system:     SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: image } },
          { type: 'text',  text:  'Transcribe and grade this exam. Return only the JSON object.' },
        ],
      }],
    });

    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    console.log(`Raw response start: ${rawText.substring(0, 200)}`);

    let parsed;
    try {
      parsed = extractJSON(rawText);
      console.log(`[parse OK] errors: ${parsed?.errors?.length ?? 0}`);
    } catch (e) {
      console.error('Parse failed:', e.message, '\nRaw:', rawText);
      return res.status(500).json({ error: 'The AI returned an unexpected format. Please try again.' });
    }

    return res.json(parsed);

  } catch (apiErr) {
    console.error('API error:', apiErr);
    const msg = apiErr.status === 401 ? 'Invalid API key.' :
                apiErr.status === 429 ? 'Rate limit hit. Wait and retry.' :
                `AI error: ${apiErr.message}`;
    return res.status(500).json({ error: msg });
  }
});

app.post('/api/regrade-text', async (req, res) => {
  const teacherId = req.headers['x-teacher-id'];
  if (!teacherId || !VALID_TEACHERS[teacherId])
    return res.status(401).json({ error: 'Unauthorized.' });

  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text received.' });
  if (text.length > 8000)    return res.status(400).json({ error: 'Text too long.' });

  console.log(`[${new Date().toISOString()}] /api/regrade-text from: ${teacherId} | chars: ${text.length}`);

  try {
    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Grade this student text. Return only the JSON object.\n\n--- STUDENT TEXT ---\n${text}\n--- END ---`,
      }],
    });

    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    let parsed;
    try {
      parsed = extractJSON(rawText);
      console.log(`[regrade OK] errors: ${parsed?.errors?.length ?? 0}`);
    } catch (e) {
      console.error('[regrade] Parse failed:', e.message);
      return res.status(500).json({ error: 'The AI returned an unexpected format. Please try again.' });
    }

    parsed.transcribed_text = text;
    return res.json(parsed);

  } catch (apiErr) {
    console.error('[regrade] API error:', apiErr);
    const msg = apiErr.status === 401 ? 'Invalid API key.' :
                apiErr.status === 429 ? 'Rate limit hit. Wait and retry.' :
                `AI error: ${apiErr.message}`;
    return res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  ExamLens Server is running           ║`);
  console.log(`║  http://localhost:${PORT}                ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  console.log(`  API Key loaded: ${process.env.ANTHROPIC_API_KEY ? '✅ Yes' : '❌ MISSING — check .env'}`);
  console.log(`  Serving index.html from current directory.\n`);
});
