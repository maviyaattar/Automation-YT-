'use strict';

// ========================= RATE LIMITERS ============================
// Configures express-rate-limit instances used across the app.

const rateLimit = require('express-rate-limit');

/**
 * Strict limiter for OAuth initiation endpoints (20 req / 15 min).
 * Prevents auth-flood abuse.
 */
const authInitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

/**
 * General API limiter (60 req / min).
 * Applied to all authenticated API routes.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

module.exports = { authInitLimiter, apiLimiter };
