'use strict';

// ========================= LOGS ROUTES ==============================
// Retrieval and deletion of job logs for the authenticated user.
//
// GET    /logs → last 20 log entries (newest first)
// DELETE /logs → delete all log entries for the current user

const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { getRecentLogs, deleteUserLogs } = require('../models/Log');

const router = Router();

// GET /logs
// Returns the 20 most-recent log entries for the logged-in user.
router.get('/', apiLimiter, requireAuth, async (req, res) => {
  try {
    const logs = await getRecentLogs(req.session.userId);
    res.json({ logs });
  } catch (err) {
    console.error('GET /logs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /logs
// Permanently removes all log entries belonging to the current user.
router.delete('/', apiLimiter, requireAuth, async (req, res) => {
  try {
    const deleted = await deleteUserLogs(req.session.userId);
    res.json({ success: true, deleted });
  } catch (err) {
    console.error('DELETE /logs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
