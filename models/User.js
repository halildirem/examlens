/**
 * models/User.js
 * ExamLens user schema — includes profile, scan credits, evaluations, and purchase history.
 */

const mongoose = require('mongoose');

/* ── Transaction (purchase) sub-document ─────────────────────── */
const transactionSchema = new mongoose.Schema({
  planId:       { type: String, default: '' },
  planName:     { type: String, default: '' },
  scansAdded:   { type: Number, default: 0  },
  amount:       { type: Number, default: 0  },
  currency:     { type: String, default: 'USD' },
  paymentId:    { type: String, default: '' },   // iyzipay payment ID
  iyzicoToken:  { type: String, default: '' },   // iyzipay checkout token
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending',
  },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

/* ── Evaluation sub-document ─────────────────────────────────── */
const evaluationSchema = new mongoose.Schema({
  title:           { type: String, default: '' },   // user-editable display name
  transcribedText: { type: String, default: '' },
  errors: [{
    error_code: { type: String, default: '' },
    wrong_word:  { type: String, default: '' },
    correction:  { type: String, default: '' },
  }],
  summary:     { type: String, default: '' },
  totalErrors: { type: Number, default: 0  },
  createdAt:   { type: Date, default: Date.now },
}, { _id: true });

/* ── User schema ─────────────────────────────────────────────── */
const userSchema = new mongoose.Schema({
  uid:         { type: String, required: true, unique: true, index: true },
  email:       { type: String, required: true, lowercase: true, trim: true },
  displayName: { type: String, default: '', trim: true },

  /* Profile (editable) */
  schoolName:    { type: String, default: '' },
  birthDate:     { type: String, default: '' },    // stored as YYYY-MM-DD string
  teachingLevel: {
    type: String,
    enum: ['', 'Elementary', 'High School', 'University'],
    default: '',
  },

  /* Credits / Scans */
  credits: { type: Number, default: 5, min: 0 },
  monthlyLimit:     { type: Number, default: 0   },  // 0 = no pro plan active
  monthlyResetDate: { type: Date,   default: null },  // when credits refill
  planExpiry:       { type: Date,   default: null },  // when pro plan ends
  /* History */
  evaluations:  { type: [evaluationSchema],  default: [] },
  transactions: { type: [transactionSchema], default: [] },

  createdAt:   { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
