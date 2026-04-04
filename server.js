/**
 * ═══════════════════════════════════════════════════════════════════════
 *  ExamLens — Production Backend
 *  server.js
 *
 *  Stack  : Node.js + Express
 *  Auth   : Firebase Admin SDK (token verification)
 *  DB     : MongoDB Atlas via Mongoose
 *  AI     : Anthropic Claude (Vision + Text)
 *
 *  Required environment variables (set in Render dashboard):
 *    ANTHROPIC_API_KEY     — Anthropic API key
 *    MONGODB_URI           — MongoDB Atlas connection string
 *    FIREBASE_PROJECT_ID   — Firebase project ID
 *    FIREBASE_CLIENT_EMAIL — Firebase service account email
 *    FIREBASE_PRIVATE_KEY  — Firebase service account private key
 *    PORT                  — (set automatically by Render)
 * ═══════════════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const mongoose   = require('mongoose');
const admin      = require('firebase-admin');
const Anthropic  = require('@anthropic-ai/sdk');
const pdfParse   = require('pdf-parse');
const mammoth    = require('mammoth');
const User       = require('./models/User');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────────────────────────────────────
   FIREBASE ADMIN — initialise using environment variables
   In Render: set FIREBASE_PRIVATE_KEY with the raw key including
   literal \n characters — this replace() call converts them to newlines.
───────────────────────────────────────────────────────────────────── */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});

console.log(`[Firebase Admin] Initialised for project: ${process.env.FIREBASE_PROJECT_ID}`);

/* ─────────────────────────────────────────────────────────────────────
   MONGODB — connect with retry
───────────────────────────────────────────────────────────────────── */
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS:          45000,
})
.then(() => console.log('[MongoDB] Connected to Atlas'))
.catch(err => {
  console.error('[MongoDB] Connection failed:', err.message);
  process.exit(1);
});

/* ─────────────────────────────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────────────────────────────── */
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '25mb' }));
app.use(express.static('.'));   // serves index.html, auth.js, logo etc.

/* ─────────────────────────────────────────────────────────────────────
   SYSTEM PROMPT  ★ Paste your full grading instructions here ★
───────────────────────────────────────────────────────────────────── */
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
- SVA = subject-verb number mismatch ONLY.
- Pick the most specific code.

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
If image unreadable: return empty transcribed_text and a summary explaining why.
`;

/* ─────────────────────────────────────────────────────────────────────
   ANTHROPIC CLIENT
───────────────────────────────────────────────────────────────────── */
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* ─────────────────────────────────────────────────────────────────────
   JSON EXTRACTOR — handles truncated / fence-wrapped AI responses
───────────────────────────────────────────────────────────────────── */
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
  console.log(`[extractJSON] Repaired truncated JSON. Errors: ${result?.errors?.length ?? 0}`);
  return result;
}

/* ═══════════════════════════════════════════════════════════════════
   MIDDLEWARE — verify Firebase ID token
   Adds req.user (Firebase decoded token) and req.dbUser (Mongo doc)
═══════════════════════════════════════════════════════════════════ */
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or malformed.' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decoded;
    next();
  } catch (err) {
    console.error('[verifyToken] Failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
}

/* ─────────────────────────────────────────────────────────────────────
   HELPER — get or create MongoDB user record
───────────────────────────────────────────────────────────────────── */
async function getOrCreateUser(firebaseUser) {
  const { uid, email, name } = firebaseUser;

  let user = await User.findOne({ uid });

  if (!user) {
    // First time login — create with 5 free trial credits
    user = await User.create({
      uid,
      email:       email || '',
      displayName: name  || (email ? email.split('@')[0] : 'Educator'),
      credits:     5,
    });
    console.log(`[User] New account created: ${email} — 5 free credits`);
  } else {
    // Update last login timestamp
    user.lastLoginAt = new Date();
    await user.save();
  }

  return user;
}

/* ─────────────────────────────────────────────────────────────────────
   HELPER — save evaluation + deduct credit atomically
───────────────────────────────────────────────────────────────────── */
async function saveEvaluation(user, parsed) {
  user.credits = Math.max(0, user.credits - 1);

  // Prepend new evaluation, keep max 20
  user.evaluations.unshift({
    transcribedText: parsed.transcribed_text || '',
    errors:          parsed.errors           || [],
    summary:         parsed.summary          || '',
    totalErrors:     parsed.total_errors     || parsed.errors?.length || 0,
  });

  if (user.evaluations.length > 20) {
    user.evaluations = user.evaluations.slice(0, 20);
  }

  await user.save();
  return user.credits;
}

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Health check
   GET /api/health
═══════════════════════════════════════════════════════════════════ */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    db:     mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Get current user info (credits etc.)
   GET /api/user
   Headers: Authorization: Bearer <idToken>
═══════════════════════════════════════════════════════════════════ */
app.get('/api/user', verifyToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    return res.json({
      uid:         user.uid,
      email:       user.email,
      displayName: user.displayName,
      credits:     user.credits,
      createdAt:   user.createdAt,
    });
  } catch (err) {
    console.error('[/api/user] Error:', err);
    return res.status(500).json({ error: 'Could not load user data.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Fetch evaluation history
   GET /api/history
   Headers: Authorization: Bearer <idToken>
═══════════════════════════════════════════════════════════════════ */
app.get('/api/history', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.firebaseUser.uid })
      .select('evaluations')
      .lean();

    if (!user) return res.json({ evaluations: [] });

    // Return lightweight list for sidebar (no full transcribedText)
    const list = (user.evaluations || []).map(e => ({
      id:          e._id,
      summary:     e.summary,
      totalErrors: e.totalErrors,
      createdAt:   e.createdAt,
    }));

    return res.json({ evaluations: list });
  } catch (err) {
    console.error('[/api/history] Error:', err);
    return res.status(500).json({ error: 'Could not load history.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Fetch single evaluation detail
   GET /api/history/:id
   Headers: Authorization: Bearer <idToken>
═══════════════════════════════════════════════════════════════════ */
app.get('/api/history/:id', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.firebaseUser.uid })
      .select('evaluations')
      .lean();

    if (!user) return res.status(404).json({ error: 'User not found.' });

    const evaluation = (user.evaluations || []).find(
      e => e._id.toString() === req.params.id
    );

    if (!evaluation) return res.status(404).json({ error: 'Evaluation not found.' });

    return res.json({ evaluation });
  } catch (err) {
    console.error('[/api/history/:id] Error:', err);
    return res.status(500).json({ error: 'Could not load evaluation.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Grade exam image  ★ CORE ENDPOINT ★
   POST /api/grade
   Headers: Authorization: Bearer <idToken>
   Body:    { image: base64, mimeType: string }
═══════════════════════════════════════════════════════════════════ */
app.post('/api/grade', verifyToken, async (req, res) => {
  let user;

  try {
    user = await getOrCreateUser(req.firebaseUser);
  } catch (err) {
    return res.status(500).json({ error: 'Could not load user account.' });
  }

  /* ── Credit check ─────────────────────────────────────────── */
  if (user.credits <= 0) {
    return res.status(403).json({
      error:   'You have run out of credits. Please purchase more to continue.',
      credits: 0,
    });
  }

  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: 'No image data received.' });

  const ALLOWED = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];
  const mime    = ALLOWED.includes(mimeType) ? mimeType : 'image/jpeg';

  console.log(`[/api/grade] uid:${user.uid} | credits:${user.credits} | mime:${mime}`);

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 8192,
      system:     SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: image } },
          { type: 'text',  text: 'Transcribe and grade this exam. Return only the JSON object.' },
        ],
      }],
    });

    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    console.log(`[/api/grade] Response start: ${rawText.substring(0, 120)}`);

    let parsed;
    try {
      parsed = extractJSON(rawText);
    } catch (e) {
      console.error('[/api/grade] Parse failed:', e.message);
      return res.status(500).json({ error: 'The AI returned an unexpected format. Please try again.' });
    }

    /* ── Deduct credit & save evaluation ─────────────────────── */
    const remainingCredits = await saveEvaluation(user, parsed);
    parsed.credits = remainingCredits;

    console.log(`[/api/grade] OK — errors:${parsed.errors?.length ?? 0} | credits left:${remainingCredits}`);
    return res.json(parsed);

  } catch (apiErr) {
    console.error('[/api/grade] Anthropic error:', apiErr);
    const msg = apiErr.status === 401 ? 'Invalid API key.' :
                apiErr.status === 429 ? 'Rate limit hit. Please wait and retry.' :
                `AI error: ${apiErr.message}`;
    return res.status(500).json({ error: msg });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Grade PDF / DOCX document
   POST /api/grade-document
   Headers: Authorization: Bearer <idToken>
   Body:    { fileData: base64, mimeType: string, fileName: string }
═══════════════════════════════════════════════════════════════════ */
app.post('/api/grade-document', verifyToken, async (req, res) => {
  let user;

  try {
    user = await getOrCreateUser(req.firebaseUser);
  } catch (err) {
    return res.status(500).json({ error: 'Could not load user account.' });
  }

  if (user.credits <= 0) {
    return res.status(403).json({
      error:   'You have run out of credits. Please purchase more to continue.',
      credits: 0,
    });
  }

  const { fileData, mimeType, fileName } = req.body;
  if (!fileData) return res.status(400).json({ error: 'No file data received.' });

  console.log(`[/api/grade-document] uid:${user.uid} | file:${fileName} | type:${mimeType}`);

  const buffer = Buffer.from(fileData, 'base64');
  let extractedText = '';

  try {
    const isPDF  = mimeType === 'application/pdf' || (fileName || '').toLowerCase().endsWith('.pdf');
    const isDOCX = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                   || (fileName || '').toLowerCase().endsWith('.docx');

    if (isPDF) {
      const data   = await pdfParse(buffer);
      extractedText = data.text;
    } else if (isDOCX) {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else {
      return res.status(400).json({ error: `Unsupported file type: ${mimeType}` });
    }
  } catch (extractErr) {
    console.error('[/api/grade-document] Extraction error:', extractErr.message);
    return res.status(500).json({ error: 'Could not extract text. Ensure the file is a valid PDF or DOCX.' });
  }

  extractedText = extractedText.trim();

  if (!extractedText || extractedText.length < 10) {
    return res.status(422).json({
      error: 'No readable text found. This may be a scanned/image-based PDF — please photograph it instead.',
    });
  }

  if (extractedText.length > 12000) {
    extractedText = extractedText.slice(0, 12000);
    console.warn('[/api/grade-document] Text truncated to 12,000 chars.');
  }

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 8192,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Grade the following student text. Return only the JSON object.\n\n--- STUDENT TEXT ---\n${extractedText}\n--- END ---`,
      }],
    });

    const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    let parsed;
    try {
      parsed = extractJSON(rawText);
    } catch (e) {
      console.error('[/api/grade-document] Parse failed:', e.message);
      return res.status(500).json({ error: 'The AI returned an unexpected format. Please try again.' });
    }

    parsed.transcribed_text = extractedText;

    const remainingCredits = await saveEvaluation(user, parsed);
    parsed.credits = remainingCredits;

    console.log(`[/api/grade-document] OK — errors:${parsed.errors?.length ?? 0} | credits left:${remainingCredits}`);
    return res.json(parsed);

  } catch (apiErr) {
    console.error('[/api/grade-document] Anthropic error:', apiErr);
    const msg = apiErr.status === 401 ? 'Invalid API key.' :
                apiErr.status === 429 ? 'Rate limit hit. Please wait and retry.' :
                `AI error: ${apiErr.message}`;
    return res.status(500).json({ error: msg });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Re-grade corrected text (text-only, cheaper)
   POST /api/regrade-text
   Headers: Authorization: Bearer <idToken>
   Body:    { text: string }
═══════════════════════════════════════════════════════════════════ */
app.post('/api/regrade-text', verifyToken, async (req, res) => {
  let user;

  try {
    user = await getOrCreateUser(req.firebaseUser);
  } catch (err) {
    return res.status(500).json({ error: 'Could not load user account.' });
  }

  if (user.credits <= 0) {
    return res.status(403).json({
      error:   'You have run out of credits. Please purchase more to continue.',
      credits: 0,
    });
  }

  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text received.' });
  if (text.length > 12000)   return res.status(400).json({ error: 'Text too long (max 12,000 characters).' });

  console.log(`[/api/regrade-text] uid:${user.uid} | chars:${text.length}`);

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
    } catch (e) {
      console.error('[/api/regrade-text] Parse failed:', e.message);
      return res.status(500).json({ error: 'The AI returned an unexpected format. Please try again.' });
    }

    parsed.transcribed_text = text;

    const remainingCredits = await saveEvaluation(user, parsed);
    parsed.credits = remainingCredits;

    console.log(`[/api/regrade-text] OK — errors:${parsed.errors?.length ?? 0} | credits left:${remainingCredits}`);
    return res.json(parsed);

  } catch (apiErr) {
    console.error('[/api/regrade-text] Anthropic error:', apiErr);
    const msg = apiErr.status === 401 ? 'Invalid API key.' :
                apiErr.status === 429 ? 'Rate limit hit. Please wait and retry.' :
                `AI error: ${apiErr.message}`;
    return res.status(500).json({ error: msg });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  ExamLens Server is running           ║`);
  console.log(`║  http://localhost:${PORT}                ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  console.log(`  Anthropic key : ${process.env.ANTHROPIC_API_KEY  ? '✅' : '❌ MISSING'}`);
  console.log(`  MongoDB URI   : ${process.env.MONGODB_URI        ? '✅' : '❌ MISSING'}`);
  console.log(`  Firebase PID  : ${process.env.FIREBASE_PROJECT_ID ? '✅' : '❌ MISSING'}\n`);
});
