'use strict';

// ========================= GENERATE ROUTE ===========================
// Manual trigger for a video-generation job.
// The heavy processing is handled by the background worker; this
// endpoint simply logs the request and returns success so the frontend
// can show immediate feedback.
//
// POST /generate

const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { findById } = require('../models/User');
const { insertLog } = require('../models/Log');

const router = Router();

// POST /generate
// Logs a 'job_requested' entry in the database and returns success.
// The worker process polls /worker/users and performs the actual generation.
router.post('/', apiLimiter, requireAuth, async (req, res) => {
  try {
    const user = await findById(req.session.userId, { youtubeTokens: 0 });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Record the manual trigger in the log collection
    await insertLog(req.session.userId, 'job_requested', 'Manual generation triggered by user');

    res.json({ success: true, message: 'Job queued. The worker will pick it up shortly.' });
  } catch (err) {
    console.error('POST /generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
