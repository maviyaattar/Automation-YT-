'use strict';

// ========================= PROFILE ROUTES ===========================
// User settings / profile management.
//
// GET   /profile → return profile (youtubeTokens excluded)
// PATCH /profile → update contentType, bgType, postsPerDay, autoMode

const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { findById, updateProfile } = require('../models/User');

const router = Router();

// GET /profile
// Returns the user's profile document.  youtubeTokens is explicitly
// excluded so it is never leaked to the frontend.
router.get('/', apiLimiter, requireAuth, async (req, res) => {
  try {
    const user = await findById(req.session.userId, { youtubeTokens: 0 });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ profile: user });
  } catch (err) {
    console.error('GET /profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /profile
// Accepts: { contentType, bgType, postsPerDay, autoMode }
// contentType: 'islamic' | 'motivation' | 'success'
// bgType:      'paper'   | 'dark'        | 'light'
// postsPerDay: 1–8
// autoMode:    boolean
router.patch('/', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { contentType, bgType, postsPerDay, autoMode } = req.body;

    // Validate contentType if provided
    const validContentTypes = ['islamic', 'motivation', 'success'];
    if (contentType !== undefined && !validContentTypes.includes(contentType)) {
      return res.status(400).json({ error: `contentType must be one of: ${validContentTypes.join(', ')}` });
    }

    // Validate bgType if provided
    const validBgTypes = ['paper', 'dark', 'light'];
    if (bgType !== undefined && !validBgTypes.includes(bgType)) {
      return res.status(400).json({ error: `bgType must be one of: ${validBgTypes.join(', ')}` });
    }

    // Validate postsPerDay if provided
    if (postsPerDay !== undefined) {
      const n = Number(postsPerDay);
      if (!Number.isInteger(n) || n < 1 || n > 8) {
        return res.status(400).json({ error: 'postsPerDay must be an integer between 1 and 8' });
      }
    }

    // Validate autoMode if provided
    if (autoMode !== undefined && typeof autoMode !== 'boolean') {
      return res.status(400).json({ error: 'autoMode must be a boolean' });
    }

    const updated = await updateProfile(req.session.userId, req.body);
    res.json({ success: true, updated });
  } catch (err) {
    console.error('PATCH /profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
