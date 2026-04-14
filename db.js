'use strict';

// ========================= DATABASE CONNECTION =======================
// Manages MongoDB connection and exports collection references.

const { MongoClient } = require('mongodb');

let usersCol;
let logsCol;
let client;

/**
 * Connect to MongoDB and initialise collections + indexes.
 * Must be called once at startup before any routes are registered.
 */
async function connect() {
  client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();

  usersCol = db.collection('users');
  logsCol = db.collection('logs');

  // Ensure indexes
  await usersCol.createIndex({ email: 1 }, { unique: true });
  await logsCol.createIndex({ userId: 1 });
  await logsCol.createIndex({ timestamp: -1 });

  console.log('✅ MongoDB connected');
}

function getUsersCol() {
  return usersCol;
}

function getLogsCol() {
  return logsCol;
}

module.exports = { connect, getUsersCol, getLogsCol };
