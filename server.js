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
const nodemailer = require('nodemailer');

// Email transporter — add GMAIL_USER and GMAIL_PASS to your .env
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});
/* ─────────────────────────────────────────────────────────────────────
   FIREBASE ADMIN!
───────────────────────────────────────────────────────────────────── */

// Debug — remove after confirming deploy works
console.log('[Firebase] ENV CHECK:');
console.log('  PROJECT_ID    :', process.env.FIREBASE_PROJECT_ID    ? '✅ set' : '❌ MISSING');
console.log('  CLIENT_EMAIL  :', process.env.FIREBASE_CLIENT_EMAIL  ? '✅ set' : '❌ MISSING');
console.log('  PRIVATE_KEY   :', process.env.FIREBASE_PRIVATE_KEY   ? '✅ set' : '❌ MISSING');

const firebaseCredential = {
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
};

// Extra guard — crash with a clear message instead of a cryptic one
if (!firebaseCredential.projectId || !firebaseCredential.clientEmail || !firebaseCredential.privateKey) {
  console.error('[Firebase] FATAL: One or more Firebase env vars are missing. Check Render dashboard.');
  console.error('  projectId   :', firebaseCredential.projectId   || 'MISSING');
  console.error('  clientEmail :', firebaseCredential.clientEmail || 'MISSING');
  console.error('  privateKey  :', firebaseCredential.privateKey  ? '(present)' : 'MISSING');
  process.exit(1);
}

/* ─────────────────────────────────────────────────────────────────────
   FIREBASE ADMIN — initialized from single JSON env var
───────────────────────────────────────────────────────────────────── */
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
} catch (e) {
  console.error('[Firebase] FATAL: FIREBASE_SERVICE_ACCOUNT is not valid JSON.', e.message);
  process.exit(1);
}

if (!serviceAccount.project_id) {
  console.error('[Firebase] FATAL: FIREBASE_SERVICE_ACCOUNT is missing or invalid. Check Render env vars.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log(`[Firebase] Initialised — project: ${serviceAccount.project_id}`);
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
  starter:      { name: 'Starter',       scans: 100,   price: 9.99,   type: 'scan', monthlyLimit: 0    },
  builder:      { name: 'Builder',       scans: 200,   price: 18.99,  type: 'scan', monthlyLimit: 0    },
  professional: { name: 'Professional',  scans: 300,   price: 27.99,  type: 'scan', monthlyLimit: 0    },
  master:       { name: 'Master',        scans: 500,   price: 44.99,  type: 'scan', monthlyLimit: 0    },
  pro3:         { name: '3 Months Pro',  scans: 3000,  price: 99.99,  type: 'pro',  monthlyLimit: 1000 },
  pro6:         { name: '6 Months Pro',  scans: 6000,  price: 184.99, type: 'pro',  monthlyLimit: 1000 },
  pro12:        { name: '12 Months Pro', scans: 12000, price: 274.99, type: 'pro',  monthlyLimit: 1000 },
};

/* ─────────────────────────────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────────────────────────────── */
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'OPTIONS'] }));
app.options('*', cors());
// Allow iyzipay popup to communicate with parent window
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});
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
SP   : Spelling — word is misspelled (e.g., 'beatiful' -> 'beautiful')
SVA  : Subject-Verb Agreement — verb does not match subject number (e.g., they 'is' -> there 'are' / they 'has' -> they 'have')
GR   : Grammatical Errors — Grammatically wrong sentence or part (e.g., Somethings 'have' good -> Somethings 'are' good)
T   : Verb Tense — wrong tense used (e.g., 'I go yesterday' -> 'I went yesterday')
ART  : Article — wrong/missing/extra article (is only for 'a, an, the') (e.g., 'a apple' -> 'an apple')
PREP : Preposition — wrong or missing preposition (e.g., 'depend to' -> 'depend on')
PL   : Plural/Singular — wrong noun number (e.g., 'two book' -> 'two books')
WW   : Wrong Word — wrong word used entirely (e.g., 'I did a mistake' -> 'I made a mistake')
WF   : Word Form — wrong form of the correct root word (e.g., 'He speaks good' -> 'He speaks well' / 'Me name is Halil' -> 'My name is Halil')
WO   : Word Order — words in wrong position (e.g., 'I and my friend tomorrow to the cinema will go' -> 'My friend and I will go to the cinema tomorrow')
P    : Punctuation — missing/wrong punctuation mark ONLY (Missing or wrong dots, commas etc.)
CAP  : Capitalization — wrong upper/lower case ONLY
RW   : Rewrite — The sentence is so grammatically broken or confusing that it requires a complete rewrite to be understandable. (Use ONLY as a last resort).

STRICT RULES:
- P = Strictly for marks (!.,:-). Do not use for grammar. (';' error is unnecessary, do not state it as an error, skip)
- CAP = Strictly for upper/lower case issues.
- SVA = Use ONLY for third-person singular/plural mismatches (e.g., 'She go', 'Something have', 'They is').
- WW = Use if the word exists but the meaning is incorrect in context (e.g., 'I have 20 years old' instead of 'I am').
- SP = Use ONLY for non-existent words (typos). If a word is spelled correctly but used wrongly (their vs. there), it is WW.
- Analyze the text WORD-BY-WORD. Do not skip minor errors like missing -s or incorrect articles.
- Pick the most specific code.
- CRITICAL: Only identify errors if the word is ACTUALLY incorrect. 
- Do NOT flag parts of a correct word (e.g., do NOT flag 'use' inside 'because' or 'useful'). 
- If a word is common and correctly spelled in context, leave it alone.
- Double-check the original transcription before flagging an error. If the student wrote 'because' correctly, marking 'use' inside it as SP is a hallucination and is STRICTLY FORBIDDEN.
- Every 'wrong_word' in your JSON must be the EXACT string from the transcribed_text.
- ZERO TOLERANCE FOR HALLUCINATIONS: Do NOT mark a word as incorrect if it is spelled correctly (e.g., 'successful', 'easier', 'responsibility', 'encouraging' are CORRECT. Marking them as SP or WF is a major failure).
- VERIFY BEFORE FLAGGING: If a word is correctly transcribed and makes sense in the context, it IS NOT an error. Skip it.
- PRECISE SP: Use SP only if the word is actually misspelled in the transcribed text. Do not invent spelling errors for correctly written words.
- CONTEXTUAL INTEGRITY: 'People are their and entertainment' is a valid WW (should be 'there' or 'have their...'). Focus on actual logical or grammatical gaps like this, not on perfectly fine words.
- DOUBLE-CHECK: If the 'wrong_word' and 'correction' are nearly identical, it is likely NOT an error.
- DO NOT IMPROVE STYLE: Your goal is not to make the student sound better or more professional. Your goal is only to fix clear linguistic mistakes.
- GRANULARITY: Mark only the specific word that is wrong. If the whole sentence is a disaster, mark the whole sentence and use RW (Rewrite).
- WW vs RW: If the correction requires adding NEW information or NEW verbs that were not in the original text (like adding 'interested' or 'phones'), you MUST use RW and select the ENTIRE sentence. Never use WW for full-sentence structural changes.
- HYPHEN ALERT: Missing hyphens in compound adjectives (e.g., 'face-to-face') are ALWAYS P. Using PREP for a missing hyphen is a CRITICAL ERROR.
- STRICT FIDELITY: Do not play 'editor'. If the student wrote 'People are their', do not guess their hobbies. Either change 'their' to 'there' (WW) or mark the whole thing as RW. Never invent context like 'technology' or 'interested' if it's not written.

FINAL SELF-CORRECTION STEP:
Before finalizing the JSON, ask yourself:
1. Did I add words that the student didn't write? If yes, is the category 'RW'? (If not, fix it).
2. Is 'face to face' marked as 'P'? (If not, fix it).
3. Is every flagged word actually an error? (If I'm correcting 'successful' or 'responsibility', DELETE that entry).


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
  // Auto-reset monthly credits if reset date has passed and plan hasn't expired
if (
  user.monthlyLimit > 0 &&
  user.monthlyResetDate &&
  new Date() >= user.monthlyResetDate &&
  user.planExpiry &&
  new Date() < user.planExpiry
) {
  user.credits          = user.monthlyLimit;
  user.monthlyResetDate = getNextMonthDate();
  await user.save();
  console.log(`[credits] Monthly reset for ${user.email} — credits restored to ${user.monthlyLimit}`);
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
      console.error('[callback] Payment failed:', err || result?.errorMessage);
      return res.redirect(`${process.env.APP_URL || ''}/?payment=failed`);
    }

    console.log('[callback] iyzipay result:', JSON.stringify({
      status: result.status,
      paymentStatus: result.paymentStatus,
      conversationId: result.conversationId,
      paymentId: result.paymentId,
      token,
    }));

    try {
      // Look up by iyzicoToken — reliable across all iyzipay environments
      const user = await User.findOne({ 'transactions.iyzicoToken': token });

      if (!user) {
        console.error('[callback] No user found for token:', token);
        return res.redirect(`${process.env.APP_URL || ''}/?payment=failed`);
      }

      // Find the specific transaction by token
      const tx = user.transactions.find(t => t.iyzicoToken === token);

      if (!tx) {
        console.error('[callback] Transaction not found for token:', token);
        return res.redirect(`${process.env.APP_URL || ''}/?payment=failed`);
      }

      if (tx.status === 'success') {
        // Already processed — idempotency guard
        return res.redirect(`${process.env.APP_URL || ''}/?payment=already`);
      }

      tx.status    = 'success';
      tx.paymentId = result.paymentId || '';

      // Handle monthly-limited pro plans vs one-time scan packs
      const plan = PLANS[tx.planId];
      if (plan && plan.type === 'pro') {
        // Pro plan: set monthly allowance instead of dumping all scans at once
        user.credits           = plan.monthlyLimit;
        user.monthlyLimit      = plan.monthlyLimit;
        user.monthlyResetDate  = getNextMonthDate();
        user.planExpiry        = getPlanExpiry(tx.planId);
      } else {
        // One-time pack: add scans directly
        user.credits += tx.scansAdded;
      }

      await user.save();

      console.log(`[callback] SUCCESS — user:${user.email} plan:${tx.planId} credits now:${user.credits}`);
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

function getNextMonthDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d;
}

function getPlanExpiry(planId) {
  const months = { pro3: 3, pro6: 6, pro12: 12 };
  const d = new Date();
  d.setMonth(d.getMonth() + (months[planId] || 1));
  return d;
}

/* ═══════════════════════════════════════════════════════════════════
   ROUTE — Contact / Feedback / Support
   POST /api/contact
   Headers: Authorization: Bearer <idToken>
   Body: { type: 'feedback'|'support', subject?: string, category?: string, message: string }
═══════════════════════════════════════════════════════════════════ */
app.post('/api/contact', verifyToken, async (req, res) => {
  const { type, subject, category, message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  let user;
  try { user = await getOrCreateUser(req.firebaseUser); }
  catch (e) { return res.status(500).json({ error: 'Could not load user.' }); }

  const userEmail   = user.email       || 'unknown@examlens.com';
  const userName    = user.displayName || 'ExamLens User';
  const isFeedback  = type === 'feedback';

  // ── Email to ExamLens team ─────────────────────────────────────
  const teamSubject = `[${type.toUpperCase()}] ${isFeedback ? subject || '(no subject)' : category || 'General'} | From: ${userEmail}`;

  const teamBody = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1b2a4a;border-bottom:2px solid #c9a84c;padding-bottom:8px;">
        ExamLens ${isFeedback ? 'Feedback' : 'Support Request'}
      </h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr><td style="padding:6px 0;color:#666;width:120px;">From</td><td><strong>${userName}</strong> (${userEmail})</td></tr>
        ${isFeedback
          ? `<tr><td style="padding:6px 0;color:#666;">Subject</td><td>${subject || '—'}</td></tr>`
          : `<tr><td style="padding:6px 0;color:#666;">Category</td><td>${category || '—'}</td></tr>`}
      </table>
      <div style="background:#f5f0e8;border-left:4px solid #c9a84c;padding:16px;border-radius:4px;">
        <p style="margin:0;line-height:1.7;color:#3a2a0e;">${message.replace(/\n/g, '<br>')}</p>
      </div>
      <p style="margin-top:16px;font-size:12px;color:#999;">Sent via ExamLens Portal · ${new Date().toLocaleString()}</p>
    </div>`;

  // ── Auto-reply to user ─────────────────────────────────────────
  const replySubject = isFeedback
    ? `We received your feedback — ExamLens`
    : `We received your support request — ExamLens`;

  const userBody = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1b2a4a;border-bottom:2px solid #c9a84c;padding-bottom:8px;">
        Thank you, ${userName} 🎓
      </h2>
      <p style="color:#3a2a0e;line-height:1.7;">
        We received your <strong>${type}</strong> request regarding
        <strong>${isFeedback ? (subject || 'your feedback') : (category || 'your issue')}</strong>.
        Our team will get back to you within <strong>24–48 hours</strong>.
      </p>
      <div style="background:#f5f0e8;border-left:4px solid #c9a84c;padding:16px;border-radius:4px;margin:20px 0;">
        <p style="margin:0;font-size:13px;color:#7a5c2a;font-style:italic;">Your message:</p>
        <p style="margin:8px 0 0;line-height:1.7;color:#3a2a0e;">${message.replace(/\n/g, '<br>')}</p>
      </div>
      <p style="color:#666;font-size:13px;">
        If this is urgent, reply directly to this email.<br><br>
        — The ExamLens Team<br>
        <a href="mailto:support@examlens.app" style="color:#c9a84c;">support@examlens.app</a>
      </p>
    </div>`;

  try {
    // Send both emails in parallel — faster than sequential awaits
    await Promise.all([
      mailer.sendMail({
        from:    `"ExamLens" <${process.env.GMAIL_USER}>`,
        to:      'examlensapp@gmail.com',
        replyTo: userEmail,                // ← click Reply goes straight to the user
        subject: teamSubject,              // ← [FEEDBACK] Subject | From: user@email.com
        html:    teamBody,
      }),
      mailer.sendMail({
        from:    `"ExamLens Support" <${process.env.SUPPORT_EMAIL}>`,
        to:      userEmail,
        subject: replySubject,
        html:    userBody,
      }),
    ]);

    console.log(`[/api/contact] ${type} from ${userEmail} — both emails sent`);
    return res.json({ success: true });

  } catch (mailErr) {
    console.error('[/api/contact] Mail error:', mailErr.message);
    return res.status(500).json({ error: 'Could not send message. Please try again.' });
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
