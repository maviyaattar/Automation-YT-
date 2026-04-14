'use strict';

// ========================= AUTH ROUTES ==============================
// Google OAuth login flow + session management.
//
// GET  /auth/google          → redirect to Google consent screen
// GET  /auth/google/callback → exchange code for tokens, create/update user
// GET  /auth/status          → return current session state
// POST /auth/logout          → destroy session + clear cookie

const { Router } = require('express');
const { google } = require('googleapis');
const { authInitLimiter } = require('../middleware/rateLimiter');
const { upsertUser } = require('../models/User');

const router = Router();

// ----- OAuth2 client factory -----------------------------------------
function buildOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// GET /auth/google
// Redirect the user to Google's OAuth consent screen.
router.get('/google', authInitLimiter, (req, res) => {
  const oauth2Client = buildOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
  res.redirect(url);
});

// GET /auth/google/callback
// Exchange the authorization code for tokens, upsert user in MongoDB,
// then save session and redirect to the frontend.
router.get('/google/callback', authInitLimiter, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error: `Google OAuth error: ${error}` });
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  try {
    const oauth2Client = buildOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch the user's email from Google
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2Api.userinfo.get();
    const email = data.email;
    if (!email) throw new Error('Could not retrieve email from Google');

    // Persist user; tokens stored securely server-side only
    const userDoc = await upsertUser(email, tokens);
    const userId = userDoc?._id?.toString();
    if (!userId) throw new Error('Failed to resolve userId after upsert');

    // Persist session before redirecting
    req.session.userId = userId;
    req.session.email = email;

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err.message);
        return res.status(500).json({ error: 'Failed to persist session' });
      }
      const redirectUrl = process.env.FRONTEND_URL || 'https://autoyt-xi.vercel.app';
      res.redirect(redirectUrl);
    });
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/status
// Return whether the current session is authenticated and basic user info.
// NOTE: youtubeTokens are never included here.
router.get('/status', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({
      authenticated: true,
      user: {
        email: req.session.email,
        name: req.session.email?.split('@')[0] || 'User',
      },
    });
  }
  res.json({ authenticated: false });
});

// POST /auth/logout
// Destroy the server-side session and clear the session cookie.
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out' });
  });
});

module.exports = router;
