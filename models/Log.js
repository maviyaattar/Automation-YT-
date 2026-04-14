'use strict';

// ========================= LOG MODEL =================================
// Helper functions for the `logs` MongoDB collection.
// Schema:
//   userId:    ObjectId  (ref to users._id)
//   status:    String
//   message:   String | null
//   timestamp: Date

const { ObjectId } = require('mongodb');
const { getLogsCol } = require('../db');

/**
 * Insert a new log entry for a given userId.
 * @param {string|ObjectId} userId
 * @param {string} status   - e.g. 'job_requested', 'done', 'error'
 * @param {string} [message]
 */
async function insertLog(userId, status, message = null) {
  const col = getLogsCol();
  const entry = {
    userId: typeof userId === 'string' ? new ObjectId(userId) : userId,
    status,
    message,
    timestamp: new Date(),
  };
  try {
    await col.insertOne(entry);
  } catch (err) {
    console.error('Log insert error:', err.message);
  }
}

/**
 * Return the last 20 log entries for a user, newest first.
 */
async function getRecentLogs(userId) {
  const col = getLogsCol();
  return col
    .find({ userId: new ObjectId(userId) })
    .sort({ timestamp: -1 })
    .limit(20)
    .toArray();
}

/**
 * Delete all log entries for a user.
 */
async function deleteUserLogs(userId) {
  const col = getLogsCol();
  const result = await col.deleteMany({ userId: new ObjectId(userId) });
  return result.deletedCount;
}

module.exports = { insertLog, getRecentLogs, deleteUserLogs };
