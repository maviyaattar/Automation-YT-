'use strict';

// ========================= USER MODEL ================================
// Helper functions for the `users` MongoDB collection.
// Schema:
//   email:         String  (unique)
//   youtubeTokens: Object  — NEVER expose in frontend responses
//   contentType:   String  ('islamic' | 'motivation' | 'success')
//   bgType:        String  ('paper' | 'dark' | 'light')
//   postsPerDay:   Number  (1–8)
//   autoMode:      Boolean
//   scheduleHours: Number  (derived; kept for scheduler compat)
//   lastRun:       Date
//   createdAt:     Date
//   updatedAt:     Date

const { ObjectId } = require('mongodb');
const { getUsersCol } = require('../db');

/**
 * Upsert a user by email after OAuth login.
 * Always updates youtubeTokens + updatedAt; sets defaults on first insert.
 */
async function upsertUser(email, youtubeTokens) {
  const col = getUsersCol();
  const result = await col.findOneAndUpdate(
    { email },
    {
      $set: {
        email,
        youtubeTokens,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        contentType: 'islamic',
        bgType: 'paper',
        postsPerDay: 1,
        autoMode: false,
        scheduleHours: 24,
        lastRun: null,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' }
  );
  // MongoDB driver ≥6 returns the document directly after findOneAndUpdate
  return result?.value || result;
}

/**
 * Find a user by _id string, optionally projecting out sensitive fields.
 */
async function findById(userId, projection = {}) {
  const col = getUsersCol();
  return col.findOne({ _id: new ObjectId(userId) }, { projection });
}

/**
 * Update allowed profile settings for a user.
 * Accepted fields: contentType, bgType, postsPerDay, autoMode.
 */
async function updateProfile(userId, fields) {
  const allowed = ['contentType', 'bgType', 'postsPerDay', 'autoMode'];
  const update = { updatedAt: new Date() };

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      update[key] = fields[key];
    }
  }

  const col = getUsersCol();
  await col.updateOne({ _id: new ObjectId(userId) }, { $set: update });
  return update;
}

/**
 * Return all users with autoMode=true (used by worker endpoint).
 * Includes youtubeTokens intentionally — only for internal worker use.
 */
async function findAutoModeUsers() {
  const col = getUsersCol();
  return col
    .find(
      { autoMode: true },
      {
        projection: {
          _id: 1,
          email: 1,
          youtubeTokens: 1,
          contentType: 1,
          bgType: 1,
          postsPerDay: 1,
        },
      }
    )
    .toArray();
}

module.exports = { upsertUser, findById, updateProfile, findAutoModeUsers };
