'use strict';

// ========================= WORKER ROUTE =============================
// Internal endpoint consumed by the GitHub Actions / cron worker.
// Returns all users with autoMode=true including their youtubeTokens
// so the worker can post on their behalf.
//
// SECURITY: This route is protected by a shared secret (WORKER_SECRET)
// that must be set as an environment variable.  It is intentionally
// NOT protected by a user session — the worker is a machine client.
//
// GET /worker/users
//   Header: Authorization: Bearer <WORKER_SECRET>

const { Router } = require('express');
const { findAutoModeUsers } = require('../models/User');

const router = Router();

// GET /worker/users
// Validates the worker secret, then returns all autoMode=true users.
// youtubeTokens ARE included here so the worker can make YouTube API calls.
router.get('/users', async (req, res) => {
  try {
    // Validate worker secret from Authorization header
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');

    if (
      scheme !== 'Bearer' ||
      !token ||
      !process.env.WORKER_SECRET ||
      token !== process.env.WORKER_SECRET
    ) {
      return res.status(401).json({ error: 'Unauthorized. Invalid or missing worker secret.' });
    }

    const users = await findAutoModeUsers();
    res.json({ users });
  } catch (err) {
    console.error('GET /worker/users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
