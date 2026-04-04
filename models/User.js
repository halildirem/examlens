/**
 * models/User.js
 * Mongoose schema for ExamLens users.
 * Stores credentials mirror (uid from Firebase), credits, and evaluation history.
 */

const mongoose = require('mongoose');

/* ── Embedded evaluation schema ─────────────────────────────── */
const evaluationSchema = new mongoose.Schema({
  transcribedText: { type: String, default: '' },
  errors: [{
    error_code: { type: String, default: '' },
    wrong_word:  { type: String, default: '' },
    correction:  { type: String, default: '' },
  }],
  summary:     { type: String, default: '' },
  totalErrors: { type: Number, default: 0  },
  createdAt:   { type: Date,   default: Date.now },
}, { _id: true });

/* ── User schema ─────────────────────────────────────────────── */
const userSchema = new mongoose.Schema({
  uid: {
    type: String, required: true, unique: true, index: true,
  },
  email: {
    type: String, required: true, lowercase: true, trim: true,
  },
  displayName: {
    type: String, default: '', trim: true,
  },
  credits: {
    type: Number, default: 5, min: 0,
  },
  evaluations: {
    type: [evaluationSchema], default: [],
  },
  createdAt:   { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
