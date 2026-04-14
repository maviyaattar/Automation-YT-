'use strict';

// ========================= AUTH MIDDLEWARE ===========================
// Protects routes that require an authenticated session.

/**
 * Express middleware that rejects unauthenticated requests.
 * Attach this before any route handler that needs a logged-in user.
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({
      error: 'Not authenticated. Please login via /auth/google',
    });
  }
  next();
}

module.exports = { requireAuth };
