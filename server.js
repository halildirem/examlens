/**
 * ═══════════════════════════════════════════════════════════════════════
 *  ExamLens — Production Backend  v3.0
 *  server.js
 *
 *  Required env vars (set in Render dashboard):
 *    ANTHROPIC_API_KEY
 *    MONGODB_URI
 *    FIREBASE_PROJECT_ID
 *    FIREBASE_CLIENT_EMAIL
 *    FIREBASE_PRIVATE_KEY
 *    IYZICO_API_KEY
 *    IYZICO_SECRET_KEY
 *    IYZICO_BASE_URL      (https://api.iyzipay.com  OR  https://sandbox-api.iyzipay.com)
 *    APP_URL              (https://your-app.onrender.com — no trailing slash)
 *    PORT                 (set automatically by Render)
 * ═══════════════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const mongoose  = require('mongoose');
const admin     = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const Iyzipay   = require('iyzipay');
const pdfParse  = require('pdf-parse');
const mammoth   = require('mammoth');
const User      = require('./models/User');
const app  = express();
const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────────────────────────────────────
   FIREBASE ADMIN
───────────────────────────────────────────────────────────────────── */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});
console.log(`[Firebase] Initialised — project: ${process.env.FIREBASE_PROJECT_ID}`);

/* ─────────────────────────────────────────────────────────────────────
   MONGODB
───────────────────────────────────────────────────────────────────── */
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('[MongoDB] Connected to Atlas'))
.catch(err => { console.error('[MongoDB] Failed:', err.message); process.exit(1); });

/* ─────────────────────────────────────────────────────────────────────
   IYZIPAY CLIENT
───────────────────────────────────────────────────────────────────── */
const iyzipay = new Iyzipay({
  apiKey:    'sandbox-9Y0h8ntSeIrKuR1JF2EwoB0Hf6ryLCIR'    || '',
  secretKey: 'sandbox-pZ4PLDrKH0a8pk6B95pFyFDFb9hFCXps' || '',
  uri:       'https://sandbox-api.iyzipay.com',
});

/* ─────────────────────────────────────────────────────────────────────
   SCAN PLANS
───────────────────────────────────────────────────────────────────── */
const PLANS = {
  starter:      { name: 'Starter',        scans: 100,   price: 9.99,   type: 'scan' },
  builder:      { name: 'Builder',        scans: 200,   price: 18.99,  type: 'scan' },
  professional: { name: 'Professional',   scans: 300,   price: 27.99,  type: 'scan' },
  master:       { name: 'Master',         scans: 500,   price: 44.99,  type: 'scan' },
  pro3:         { name: '3 Months Pro',   scans: 3000,  price: 99.99,  type: 'pro'  },
  pro6:         { name: '6 Months Pro',   scans: 6000,  price: 184.99, type: 'pro'  },
  pro12:        { name: '12 Months Pro',  scans: 12000, price: 274.99, type: 'pro'  },
};

/* ─────────────────────────────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────────────────────────────── */
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'OPTIONS'] }));
app.options('*', cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true })); // needed for iyzipay callback POST
app.use(express.static('.'));

/* ─────────────────────────────────────────────────────────────────────
   SYSTEM PROMPT
───────────────────────────────────────────────────────────────────── */
const SYSTEM_PROMPT = `
You are an expert English language examiner for a preparatory school.
Your task is to:
  1. Carefully READ and TRANSCRIBE the handwritten English text in the provided image.
  2. IDENTIFY all language errors in the transcribed text.
  3. CATEGORISE each error using the Error Code system below.
  4. Return your findings ONLY as a valid JSON object — no extra text, no markdown fences.

ERROR CODE TAXONOMY — assign the MOST SPECIFIC matching code:
SP   : Spelling — word is misspelled
SVA  : Subject-Verb Agreement — verb does not match subject number
VT   : Verb Tense — wrong tense used
ART  : Article — wrong/missing/extra article
PREP : Preposition — wrong or missing preposition
PL   : Plural/Singular — wrong noun number
PRO  : Pronoun — wrong pronoun form
WW   : Wrong Word — wrong word used entirely
WF   : Word Form — wrong form of the correct root word
WO   : Word Order — words in wrong position
RUN  : Run-on or broken sentence structure
P    : Punctuation — missing/wrong punctuation mark ONLY
CAP  : Capitalization — wrong upper/lower case ONLY

STRICT RULES:
- P = punctuation marks ONLY. NEVER use P for grammar errors.
- CAP = capitalization ONLY.
- SVA = subject-verb number mismatch ONLY.
- Pick the most specific code.

REQUIRED JSON OUTPUT (return ONLY this structure, no extra text, no markdown):
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

If no errors: empty errors array and total_errors 0.
If image unreadable: empty transcribed_text and explanatory summary.
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
  let s = firstBrace !== -1 ? raw.slice(firstBrace) : raw;
  s = s.replace(/```\s*$/, '').trim().replace(/,?\s*\n[^\n]*$/, '');
  let ob = 0, ob2 = 0, inStr = false, esc = false;
  for (const ch of s) {
    if (esc)      { esc = false; continue; }
    if (ch==='\\') { esc = true; continue; }
    if (ch==='"')  { inStr = !inStr; continue; }
    if (inStr)     continue;
    if (ch==='{') ob++; else if (ch==='}') ob--;
    else if (ch==='[') ob2++; else if (ch===']') ob2--;
  }
  if (inStr) s += '"';
  while (ob > 1)  { s += '}'; ob--; }
  while (ob2 > 0) { s += ']'; ob2--; }
  if (ob > 0) s += '}';
  return JSON.parse(s);
}

/* ═══════════════════════════════════════════════════════════════════
   AUTH MIDDLEWARE — verifies Firebase ID token
═══════════════════════════════════════════════════════════════════ */
async function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Authorization header missing.' });
  try {
    req.firebaseUser = await admin.auth().verifyIdToken(header.split('Bearer ')[1]);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
}

/* ─────────────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────────────── */
async function getOrCreateUser(firebaseUser) {
  const { uid, email, name } = firebaseUser;
  let user = await User.findOne({ uid });
  if (!user) {
    user = await User.create({
      uid, email: email || '',
      displayName: name || (email ? email.split('@')[0] : 'Educator'),
      credits: 5,
    });
    console.log(`[User] Created: ${email} — 5 free scans`);
  } else {
    user.lastLoginAt = new Date();
    await user.save();
  }
  return user;
}

async function saveEvaluation(user, parsed) {
  user.credits = Math.max(0, user.credits - 1);
  user.evaluations.unshift({
    transcribedText: parsed.transcribed_text || '',
    errors:          parsed.errors           || [],
    summary:         parsed.summary          || '',
    totalErrors:     parsed.total_errors     || parsed.errors?.length || 0,
  });
  if (user.evaluations.length > 20) user.evaluations = user.evaluations.slice(0, 20);
  await user.save();
  return user.credits;
}

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Health check
═══════════════════════════════════════════════════════════════════ */
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
}));

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Get current user (credits, profile)
═══════════════════════════════════════════════════════════════════ */
app.get('/api/user', verifyToken, async (req, res) => {
  try {
    const user = await getOrCreateUser(req.firebaseUser);
    return res.json({
      uid:          user.uid,
      email:        user.email,
      displayName:  user.displayName,
      credits:      user.credits,
      schoolName:   user.schoolName,
      birthDate:    user.birthDate,
      teachingLevel:user.teachingLevel,
      createdAt:    user.createdAt,
    });
  } catch (e) {
    console.error('[/api/user]', e);
    return res.status(500).json({ error: 'Could not load user data.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Update profile
   PUT /api/user/profile
═══════════════════════════════════════════════════════════════════ */
app.put('/api/user/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.firebaseUser.uid });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const allowed = ['schoolName', 'birthDate', 'teachingLevel'];
    allowed.forEach(field => {
      if (req.body[field] !== undefined) user[field] = req.body[field];
    });
    await user.save();
    return res.json({ success: true, schoolName: user.schoolName, birthDate: user.birthDate, teachingLevel: user.teachingLevel });
  } catch (e) {
    console.error('[/api/user/profile]', e);
    return res.status(500).json({ error: 'Could not update profile.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Evaluation history
═══════════════════════════════════════════════════════════════════ */
app.get('/api/history', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.firebaseUser.uid }).select('evaluations').lean();
    if (!user) return res.json({ evaluations: [] });
    const list = (user.evaluations || []).map(e => ({
      id: e._id, summary: e.summary, totalErrors: e.totalErrors, createdAt: e.createdAt,
    }));
    return res.json({ evaluations: list });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load history.' });
  }
});

app.get('/api/history/:id', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.firebaseUser.uid }).select('evaluations').lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const evaluation = (user.evaluations || []).find(e => e._id.toString() === req.params.id);
    if (!evaluation) return res.status(404).json({ error: 'Evaluation not found.' });
    return res.json({ evaluation });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load evaluation.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Purchase history
   GET /api/transactions
═══════════════════════════════════════════════════════════════════ */
app.get('/api/transactions', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.firebaseUser.uid }).select('transactions').lean();
    if (!user) return res.json({ transactions: [] });
    return res.json({ transactions: (user.transactions || []).filter(t => t.status === 'success') });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load transactions.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Create iyzico checkout form
   POST /api/payments/create-checkout
   Body: { planId: string }
═══════════════════════════════════════════════════════════════════ */
app.post('/api/payments/create-checkout', verifyToken, async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Invalid plan selected.' });

  let user;
  try { user = await getOrCreateUser(req.firebaseUser); }
  catch (e) { return res.status(500).json({ error: 'Could not load user.' }); }

  /* Create a pending transaction record first to get the ID */
  user.transactions.unshift({
    planId, planName: plan.name, scansAdded: plan.scans,
    amount: plan.price, currency: 'TRY', status: 'pending',
  });
  await user.save();
  const transaction = user.transactions[0];
  const conversationId = transaction._id.toString();

  const priceStr = plan.price.toFixed(2).toString().replace(',', '.');
  const callbackUrl = `${process.env.APP_URL || 'http://localhost:3000'}/api/payments/callback`;

  const nameParts  = (user.displayName || 'ExamLens User').split(' ');
  const buyerName  = nameParts[0] || 'ExamLens';
  const buyerSurname = nameParts.slice(1).join(' ') || 'User';

  const request = {
    locale:             Iyzipay.LOCALE.EN,
    conversationId,
    price:              priceStr,
    paidPrice:          priceStr,
    currency:           Iyzipay.CURRENCY.TRY,
    basketId:           conversationId,
    paymentGroup:       Iyzipay.PAYMENT_GROUP.PRODUCT,
    callbackUrl,
    enabledInstallments: [1, 2, 3, 6, 9],
    buyer: {
    id: user.uid,
    name: buyerName || 'Halil',
    surname: buyerSurname || 'Direm',
    gsmNumber: '+905320000000', 
    email: user.email || 'teacher@examlens.com',
    identityNumber: '11111111111', 
    registrationAddress: 'Kadikoy Merkez Mahallesi Ataturk Caddesi No:123', // BURAYI UZATTIK
    ip: req.ip || '85.34.78.112',
    city: 'Istanbul',
    country: 'Turkey',
    zipCode: '34732',
},
shippingAddress: {
    contactName: `${buyerName} ${buyerSurname}`,
    city: 'Istanbul', 
    country: 'Turkey',
    address: 'Kadikoy Merkez Mahallesi Ataturk Caddesi No:123', // BURAYI DA UZATTIK
    zipCode: '34732',
},
billingAddress: {
    contactName: `${buyerName} ${buyerSurname}`,
    city: 'Istanbul', 
    country: 'Turkey',
    address: 'Kadikoy Merkez Mahallesi Ataturk Caddesi No:123', // VE BURAYI DA
    zipCode: '34732',
},
    basketItems: [{
      id:        planId,
      name:      plan.name,
      category1: 'Scan Credits',
      itemType:  Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
      price:     priceStr,
    }],
  };

  iyzipay.checkoutFormInitialize.create(request, (err, result) => {
    if (err || result.status !== 'success') {
      console.error('[iyzipay] Checkout init failed:', err || result);
      return res.status(500).json({ error: 'Payment initialisation failed. Please try again.' });
    }
    /* Save the iyzipay token to the transaction */
    User.findOneAndUpdate(
      { uid: user.uid, 'transactions._id': transaction._id },
      { $set: { 'transactions.$.iyzicoToken': result.token } }
    ).catch(console.error);

    console.log(`[iyzipay] Checkout created — plan:${planId} price:$${plan.price} user:${user.email}`);
    return res.json({
      checkoutFormContent: result.checkoutFormContent,
      token:               result.token,
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — iyzico payment callback (browser redirect after payment)
   POST /api/payments/callback
═══════════════════════════════════════════════════════════════════ */
app.post('/api/payments/callback', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.redirect(`${process.env.APP_URL || ''}/?payment=failed`);

  iyzipay.checkoutForm.retrieve({ locale: Iyzipay.LOCALE.EN, token }, async (err, result) => {
    if (err || result.status !== 'success' || result.paymentStatus !== 'SUCCESS') {
      console.error('[iyzipay] Payment failed:', err || result?.errorMessage);
      return res.redirect(`${process.env.APP_URL || ''}/?payment=failed`);
    }

    const conversationId = result.conversationId;

    try {
      const user = await User.findOne({ 'transactions._id': conversationId });
      if (!user) {
        console.error('[callback] Transaction not found:', conversationId);
        return res.redirect(`${process.env.APP_URL || ''}/?payment=failed`);
      }

      const tx = user.transactions.id(conversationId);
      if (!tx || tx.status === 'success') {
        /* Already processed — idempotency guard */
        return res.redirect(`${process.env.APP_URL || ''}/?payment=already`);
      }

      tx.status    = 'success';
      tx.paymentId = result.paymentId || '';
      user.credits += tx.scansAdded;
      await user.save();

      console.log(`[iyzipay] Payment SUCCESS — user:${user.email} plan:${tx.planId} +${tx.scansAdded} scans`);
      return res.redirect(`${process.env.APP_URL || ''}/?payment=success&scans=${tx.scansAdded}`);

    } catch (dbErr) {
      console.error('[callback] DB error:', dbErr);
      return res.redirect(`${process.env.APP_URL || ''}/?payment=failed`);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Evaluate image  ★ MAIN ENDPOINT ★
   POST /api/evaluate
═══════════════════════════════════════════════════════════════════ */
app.post('/api/evaluate', verifyToken, async (req, res) => {
  let user;
  try { user = await getOrCreateUser(req.firebaseUser); }
  catch (e) { return res.status(500).json({ error: 'Could not load user account.' }); }

  if (user.credits <= 0)
    return res.status(403).json({ error: 'You have run out of Scans. Please purchase more to continue.', credits: 0 });

  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: 'No image data received.' });

  const ALLOWED = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];
  const mime    = ALLOWED.includes(mimeType) ? mimeType : 'image/jpeg';
  console.log(`[/api/evaluate] uid:${user.uid} | scans:${user.credits}`);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 8192, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: image } },
        { type: 'text',  text: 'Transcribe and grade this exam. Return only the JSON object.' },
      ]}],
    });
    const rawText = response.content.filter(b => b.type==='text').map(b => b.text).join('');
    let parsed;
    try { parsed = extractJSON(rawText); }
    catch (e) {
      console.error('[/api/evaluate] Parse failed:', e.message);
      return res.status(500).json({ error: 'The AI returned an unexpected format. Please try again.' });
    }
    const remaining = await saveEvaluation(user, parsed);
    parsed.credits = remaining;
    return res.json(parsed);
  } catch (apiErr) {
    console.error('[/api/evaluate] AI error:', apiErr);
    return res.status(500).json({ error: `AI error: ${apiErr.message}` });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Evaluate document (PDF / DOCX)
   POST /api/evaluate-document
═══════════════════════════════════════════════════════════════════ */
app.post('/api/evaluate-document', verifyToken, async (req, res) => {
  let user;
  try { user = await getOrCreateUser(req.firebaseUser); }
  catch (e) { return res.status(500).json({ error: 'Could not load user account.' }); }

  if (user.credits <= 0)
    return res.status(403).json({ error: 'You have run out of Scans. Please purchase more to continue.', credits: 0 });

  const { fileData, mimeType, fileName } = req.body;
  if (!fileData) return res.status(400).json({ error: 'No file data received.' });

  const buffer = Buffer.from(fileData, 'base64');
  let extractedText = '';

  try {
    const isPDF  = mimeType === 'application/pdf' || (fileName||'').toLowerCase().endsWith('.pdf');
    const isDOCX = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                   || (fileName||'').toLowerCase().endsWith('.docx');
    if (isPDF)       { const d = await pdfParse(buffer); extractedText = d.text; }
    else if (isDOCX) { const r = await mammoth.extractRawText({ buffer }); extractedText = r.value; }
    else return res.status(400).json({ error: `Unsupported file type: ${mimeType}` });
  } catch (e) {
    return res.status(500).json({ error: 'Could not extract text from this file.' });
  }

  extractedText = extractedText.trim();
  if (!extractedText || extractedText.length < 10)
    return res.status(422).json({ error: 'No readable text found. This may be a scanned PDF — please photograph it instead.' });
  if (extractedText.length > 12000) extractedText = extractedText.slice(0, 12000);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 8192, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Grade this student text. Return only the JSON object.\n\n--- STUDENT TEXT ---\n${extractedText}\n--- END ---` }],
    });
    const rawText = response.content.filter(b => b.type==='text').map(b => b.text).join('');
    let parsed;
    try { parsed = extractJSON(rawText); }
    catch (e) { return res.status(500).json({ error: 'The AI returned an unexpected format. Please try again.' }); }
    parsed.transcribed_text = extractedText;
    const remaining = await saveEvaluation(user, parsed);
    parsed.credits = remaining;
    return res.json(parsed);
  } catch (apiErr) {
    return res.status(500).json({ error: `AI error: ${apiErr.message}` });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Re-evaluate corrected text
   POST /api/reevaluate
═══════════════════════════════════════════════════════════════════ */
app.post('/api/reevaluate', verifyToken, async (req, res) => {
  let user;
  try { user = await getOrCreateUser(req.firebaseUser); }
  catch (e) { return res.status(500).json({ error: 'Could not load user account.' }); }

  if (user.credits <= 0)
    return res.status(403).json({ error: 'You have run out of Scans. Please purchase more to continue.', credits: 0 });

  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text received.' });
  if (text.length > 12000)   return res.status(400).json({ error: 'Text too long (max 12,000 characters).' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 8192, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Grade this student text. Return only the JSON object.\n\n--- STUDENT TEXT ---\n${text}\n--- END ---` }],
    });
    const rawText = response.content.filter(b => b.type==='text').map(b => b.text).join('');
    let parsed;
    try { parsed = extractJSON(rawText); }
    catch (e) { return res.status(500).json({ error: 'Unexpected format. Please try again.' }); }
    parsed.transcribed_text = text;
    const remaining = await saveEvaluation(user, parsed);
    parsed.credits = remaining;
    return res.json(parsed);
  } catch (apiErr) {
    return res.status(500).json({ error: `AI error: ${apiErr.message}` });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   START
───────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  ExamLens v3.0  http://localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  console.log(`  Anthropic   : ${process.env.ANTHROPIC_API_KEY    ? '✅' : '❌ MISSING'}`);
  console.log(`  MongoDB     : ${process.env.MONGODB_URI          ? '✅' : '❌ MISSING'}`);
  console.log(`  Firebase    : ${process.env.FIREBASE_PROJECT_ID  ? '✅' : '❌ MISSING'}`);
  console.log(`  Iyzico      : ${process.env.IYZICO_API_KEY       ? '✅' : '❌ MISSING'}`);
  console.log(`  App URL     : ${process.env.APP_URL              || '⚠️  Not set (needed for payment callback)'}\n`);
});
