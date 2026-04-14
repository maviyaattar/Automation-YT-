'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const rateLimit = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

// ========================= MODULAR IMPORTS ===========================
// Clean-structure modules (routes, middleware, db)
const db = require('./db');
const authRouter = require('./routes/auth');
const profileRouter = require('./routes/profile');
const logsRouter = require('./routes/logs');
const generateRouter = require('./routes/generate');
const workerRouter = require('./routes/worker');

// ========================= ENV VALIDATION ============================
const REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'MONGO_URI',
  'SESSION_SECRET',
  'GROQ_API_KEY',
  'WORKER_SECRET',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ========================= CLOUDINARY INIT ===========================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ========================= EXPRESS INIT ==============================
const app = express();
const PORT = process.env.PORT || 3000;

// Critical for secure cookies behind Render proxy
app.set('trust proxy', 1);

// ========================= CORS ======================================
// Must allow credentials; origin must not be '*'.
app.use(
  cors({
    origin: true, // reflect requesting origin
    credentials: true,
  })
);

app.use(bodyParser.json({ limit: '4mb' }));

// ========================= SESSION ===================================
// Must be registered BEFORE routes.
// Cookie must be secure + sameSite none for cross-domain (Vercel <-> Render).
app.use(
  session({
    name: 'connect.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
    }),
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// ========================= RATE LIMITERS =============================
const authInitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ========================= MONGODB INIT ==============================
// Shared db module initialises the connection and exposes collection
// getters used by the modular route files.
let usersCol;
let logsCol;

(async () => {
  try {
    await db.connect();
    usersCol = db.getUsersCol();
    logsCol = db.getLogsCol();

    startScheduler();
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }
})();

// ========================= CONSTANTS =================================
const OUTPUT_DIR = path.join(__dirname, 'output');
const ASSETS_DIR = path.join(__dirname, 'assets');
const BASE_VIDEO_LOCAL = path.join(ASSETS_DIR, 'base.mp4');
const BASE_PUBLIC_ID = 'ai-reel-bot/base_template_v4';

const VIDEO_SECONDS = 20;
const MIN_BYTES_OK = 80_000;
const CANVAS_W = 1080;
const CANVAS_H = 1920;
const MAX_LINES = 5;
const FONT_NAME = 'Carrois-Gothic-SC';

const PAPER_BG_PROMPT =
  'vintage old paper parchment texture background, warm beige and cream, subtle grain, ' +
  'soft vignette edges, minimal islamic geometric border very subtle, elegant, clean, ' +
  'high resolution, no text, no letters, no watermark, vertical 9:16';

// ========================= GENERAL UTILS =============================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeTitle(t) {
  return String(t)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 80);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (code ${code}).\n${stderr}`));
    });
  });
}

// ========================= TEXT UTILS ================================
function wrapTextSmart(text) {
  const START_CHARS = 18;
  const MAX_CHARS = 34;
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  function wrapWithLimit(charLimit) {
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = (line ? line + ' ' : '') + w;
      if (next.length <= charLimit) line = next;
      else {
        if (line) lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  let limit = START_CHARS;
  let lines = wrapWithLimit(limit);
  while (lines.length > MAX_LINES && limit < MAX_CHARS) {
    limit++;
    lines = wrapWithLimit(limit);
  }
  return lines;
}

function chooseFontSize(lines) {
  const n = Math.max(1, lines.length);
  let size = 80;
  if (n === 2) size = 74;
  if (n === 3) size = 66;
  if (n === 4) size = 58;
  if (n >= 5) size = 52;
  if (lines.some((l) => l.length >= 22)) size -= 10;
  if (lines.join(' ').length >= 60) size -= 8;
  return Math.max(40, Math.min(90, size));
}

function chooseInterlineSpacing(fontSize, lineCount) {
  if (lineCount >= 5) return Math.round(fontSize * 0.18);
  if (lineCount === 4) return Math.round(fontSize * 0.22);
  return Math.round(fontSize * 0.26);
}

// ========================= LOGGING HELPER ============================
async function appendLog(userId, status, extra = {}) {
  const entry = {
    userId: typeof userId === 'string' ? new ObjectId(userId) : userId,
    status,
    videoId: extra.videoId || null,
    message: extra.message || null,
    timestamp: new Date(),
  };
  try {
    await logsCol.insertOne(entry);
  } catch (e) {
    console.error('Log insert error:', e.message);
  }
  console.log(`[LOG][${userId}] ${status}`, extra.message || '');
}

// ========================= OAUTH HELPERS =============================
function buildOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function getAuthenticatedClient(user) {
  if (!user.youtubeTokens) throw new Error('User has no linked YouTube account');
  if (!user.youtubeTokens.refresh_token) throw new Error('YouTube refresh token is missing. Please reconnect your YouTube account.');

  const oauth2Client = buildOAuth2Client();
  oauth2Client.setCredentials(user.youtubeTokens);

  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...user.youtubeTokens, ...newTokens };
    await usersCol.updateOne({ _id: user._id }, { $set: { youtubeTokens: merged } });
  });

  return oauth2Client;
}

// ========================= BOT LOGIC =================================
async function generateIslamicQuote() {
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content:
            'You write short Islamic reminders. Output ONLY the reminder text. ' +
            'No emojis. No references. No quotes.',
        },
        {
          role: 'user',
          content:
            'Write ONE Islamic reminder, maximum 10 words. Based on Quran/Hadith/Islamic values. ' +
            'Do not cite verses or invent references. Keep it gentle, motivational, and clear.',
        },
      ],
      temperature: 0.85,
      max_tokens: 40,
    },
    {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      timeout: 30_000,
    }
  );

  let quote = res?.data?.choices?.[0]?.message?.content;
  if (!quote) throw new Error('Groq returned empty quote');

  quote = String(quote).replace(/^"+|"+$/g, '').trim().replace(/\s+/g, ' ');
  const words = quote.split(' ').filter(Boolean);
  if (words.length > 10) quote = words.slice(0, 10).join(' ');
  return quote;
}

async function generatePaperBackground(outFile) {
  const url =
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(PAPER_BG_PROMPT) +
    `?width=${CANVAS_W}&height=${CANVAS_H}&seed=${Date.now()}`;

  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  await fs.writeFile(outFile, res.data);
}

async function renderTextOnImage({ text, inputPng, outputPng }) {
  const lines = wrapTextSmart(text);
  const finalText = lines.join('\n');
  const fontSize = chooseFontSize(lines);
  const interline = chooseInterlineSpacing(fontSize, lines.length);

  const textFill = '#1E120B';
  const stroke = 'rgba(255,255,255,0.35)';
  const strokeWidth = 2;

  const args = [
    inputPng,
    '-gravity',
    'center',
    '-font',
    FONT_NAME,
    '-pointsize',
    String(fontSize),
    '-interline-spacing',
    String(interline),
    '-fill',
    'rgba(0,0,0,0.25)',
    '-stroke',
    'rgba(0,0,0,0.25)',
    '-strokewidth',
    '6',
    '-annotate',
    '+3+3',
    finalText,
    '-fill',
    textFill,
    '-stroke',
    stroke,
    '-strokewidth',
    String(strokeWidth),
    '-annotate',
    '+0+0',
    finalText,
    outputPng,
  ];

  await run('magick', args);
}

async function ensureBaseVideoOnCloudinary() {
  await fs.ensureDir(ASSETS_DIR);

  try {
    const existing = await cloudinary.api.resource(BASE_PUBLIC_ID, { resource_type: 'video' });
    if (existing?.secure_url) return { publicId: BASE_PUBLIC_ID, url: existing.secure_url };
  } catch (_) {}

  if (!(await fs.pathExists(BASE_VIDEO_LOCAL))) {
    throw new Error(
      'Base video not found at assets/base.mp4. ' +
        'Please upload it to Cloudinary manually with public_id=' +
        BASE_PUBLIC_ID +
        ' or place base.mp4 in the assets/ folder before first run.'
    );
  }

  console.log('⬆️  Uploading base template video to Cloudinary (one-time)…');
  const up = await cloudinary.uploader.upload(BASE_VIDEO_LOCAL, {
    resource_type: 'video',
    public_id: BASE_PUBLIC_ID,
    overwrite: true,
  });
  return { publicId: BASE_PUBLIC_ID, url: up.secure_url };
}

async function renderFinalMp4WithOverlay({ baseVideoPublicId, overlayImagePath }) {
  const overlay = await cloudinary.uploader.upload(overlayImagePath, {
    resource_type: 'image',
    folder: 'ai-reel-bot/overlays',
    overwrite: false,
  });

  const overlayLayer = overlay.public_id.replace(/\//g, ':');

  const eager = [
    {
      width: CANVAS_W,
      height: CANVAS_H,
      crop: 'fill',
      fps: 30,
      duration: VIDEO_SECONDS,
      format: 'mp4',
      video_codec: 'h264',
      quality: 'auto:best',
      bit_rate: '1400k',
      overlay: overlayLayer,
    },
    {
      flags: 'layer_apply',
      gravity: 'center',
      width: CANVAS_W,
      height: CANVAS_H,
      crop: 'fill',
    },
  ];

  const exp = await cloudinary.uploader.explicit(baseVideoPublicId, {
    resource_type: 'video',
    type: 'upload',
    eager,
    eager_async: false,
  });

  const mp4Url = exp?.eager?.[0]?.secure_url;
  if (!mp4Url) throw new Error('Cloudinary did not return derived MP4 URL.');

  return { mp4Url, overlayPublicId: overlay.public_id };
}

async function downloadToFile(url, outPath) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 180_000 });
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('video') && !ct.includes('octet-stream')) {
    throw new Error(`Not a video response. content-type=${ct}`);
  }
  await fs.ensureDir(path.dirname(outPath));
  const writer = fs.createWriteStream(outPath);
  res.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function buildYouTubeMetadata(quote) {
  const clean = sanitizeTitle(quote);
  const title = sanitizeTitle(`${clean} | Islamic Reminder #Shorts`);
  const hashtags = '#Islam #IslamicReminder #Quran #Muslim #Dua #Iman #Shorts #IslamicShorts';
  const description = [
    clean,
    '',
    'Short Islamic reminder to strengthen your Iman.',
    'Follow for daily reminders.',
    '',
    hashtags,
  ].join('\n');
  const tags = [
    'islam',
    'islamic reminder',
    'quran',
    'muslim',
    'dua',
    'iman',
    'shorts',
    'islamic shorts',
    'allah',
  ];
  return { title, description, tags };
}

async function uploadToYouTube(mp4Path, quote, user) {
  const oauth2Client = await getAuthenticatedClient(user);
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const st = await fs.stat(mp4Path);
  if (st.size < MIN_BYTES_OK) throw new Error(`MP4 too small (${st.size} bytes).`);

  const meta = buildYouTubeMetadata(quote);

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        categoryId: '22',
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(mp4Path) },
  });

  return res.data.id;
}

async function cleanupLocal(paths) {
  for (const p of paths) {
    try {
      if (p && (await fs.pathExists(p))) await fs.remove(p);
    } catch (_) {}
  }
}

async function deleteCloudinary(publicId, resourceType) {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (_) {}
}

// ========================= MAIN JOB RUNNER ===========================
async function runJobForUser(user) {
  await fs.ensureDir(OUTPUT_DIR);

  const t = Date.now();
  const bg = path.join(OUTPUT_DIR, `bg_${t}.png`);
  const img = path.join(OUTPUT_DIR, `img_${t}.png`);
  const mp4 = path.join(OUTPUT_DIR, `short_${t}.mp4`);
  let overlayPublicId;

  try {
    await appendLog(user._id, 'started');

    await appendLog(user._id, 'generating_quote');
    const quote = await generateIslamicQuote();
    await appendLog(user._id, 'quote_ready', { message: quote });

    await appendLog(user._id, 'generating_background');
    await generatePaperBackground(bg);

    await appendLog(user._id, 'rendering_text');
    await renderTextOnImage({ text: quote, inputPng: bg, outputPng: img });

    await appendLog(user._id, 'checking_base_video');
    const { publicId: basePublicId } = await ensureBaseVideoOnCloudinary();

    await appendLog(user._id, 'rendering_video');
    const rendered = await renderFinalMp4WithOverlay({
      baseVideoPublicId: basePublicId,
      overlayImagePath: img,
    });
    overlayPublicId = rendered.overlayPublicId;

    await appendLog(user._id, 'downloading_video');
    let lastErr;
    for (let i = 1; i <= 6; i++) {
      try {
        await downloadToFile(rendered.mp4Url, mp4);
        const st = await fs.stat(mp4);
        if (st.size >= MIN_BYTES_OK) {
          lastErr = null;
          break;
        }
        lastErr = new Error(`Downloaded file too small: ${st.size}`);
      } catch (e) {
        lastErr = e;
      }
      await sleep(4_000);
    }
    if (lastErr) throw lastErr;

    await appendLog(user._id, 'uploading_to_youtube');
    const videoId = await uploadToYouTube(mp4, quote, user);
    await appendLog(user._id, 'done', { videoId });

    await usersCol.updateOne({ _id: user._id }, { $set: { lastRun: new Date() } });

    return { success: true, videoId, quote };
  } catch (err) {
    await appendLog(user._id, 'error', { message: err.message });
    throw err;
  } finally {
    await cleanupLocal([bg, img, mp4]);
    if (overlayPublicId) await deleteCloudinary(overlayPublicId, 'image');
  }
}

// ========================= SCHEDULER =================================
const inFlightJobs = new Set();

function startScheduler() {
  console.log('⏱️  Scheduler started (1-minute tick)');

  setInterval(async () => {
    try {
      const users = await usersCol.find({ autoMode: true }).toArray();

      for (const user of users) {
        if (!user.youtubeTokens) continue;

        const userIdStr = user._id.toString();
        if (inFlightJobs.has(userIdStr)) continue;

        const intervalMs = (user.scheduleHours || 24) * 60 * 60 * 1000;
        const lastRun = user.lastRun ? new Date(user.lastRun).getTime() : 0;
        const nextRunTime = lastRun + intervalMs;

        if (Date.now() >= nextRunTime) {
          inFlightJobs.add(userIdStr);
          console.log(`⚙️  Scheduler: running job for user ${userIdStr}`);
          runJobForUser(user)
            .catch(async (e) => {
              console.error(`Scheduler job failed for ${userIdStr}:`, e.message);
              await appendLog(user._id, 'scheduler_error', { message: e.message }).catch(() => {});
            })
            .finally(() => {
              inFlightJobs.delete(userIdStr);
            });
        }
      }
    } catch (e) {
      console.error('Scheduler tick error:', e.message);
    }
  }, 60_000);
}

// ========================= AUTH MIDDLEWARE ===========================
// Kept here so the remaining legacy routes (/dashboard, /auto, /disconnect)
// can continue to use it without importing the middleware module.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated. Please login via /auth/google' });
  }
  next();
}

// ========================= MODULAR ROUTERS ===========================
// Clean-structure routes (auth, profile, logs, generate, worker).
// These replace the previously-inline versions of the same endpoints.
app.use('/auth', authRouter);
app.use('/profile', profileRouter);
app.use('/logs', logsRouter);
app.use('/generate', generateRouter);
app.use('/worker', workerRouter);

// ========================= API ROUTES ================================

app.get('/dashboard', apiLimiter, requireAuth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.youtubeTokens) return res.status(400).json({ error: 'YouTube not connected' });

    const oauth2Client = await getAuthenticatedClient(user);
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const channelRes = await youtube.channels.list({
      part: ['snippet', 'statistics', 'contentDetails'],
      mine: true,
    });
    const channel = channelRes.data.items?.[0];
    if (!channel) return res.status(404).json({ error: 'No YouTube channel found' });

    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    let recentVideos = [];
    if (uploadsPlaylistId) {
      const playlistRes = await youtube.playlistItems.list({
        part: ['snippet'],
        playlistId: uploadsPlaylistId,
        maxResults: 5,
      });
      recentVideos = (playlistRes.data.items || []).map((item) => ({
        videoId: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails?.medium?.url || null,
        uploadedAt: item.snippet.publishedAt,
      }));
    }

    res.json({
      channel: {
        id: channel.id,
        name: channel.snippet.title,
        profilePic: channel.snippet.thumbnails?.medium?.url || null,
        subscribers: channel.statistics.subscriberCount,
        totalVideos: channel.statistics.videoCount,
      },
      recentVideos,
    });
  } catch (err) {
    console.error('/dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/auto', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { enabled, scheduleHours } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: '`enabled` (boolean) is required' });
    }

    const update = {
      autoMode: enabled,
      updatedAt: new Date(),
    };
    if (typeof scheduleHours === 'number' && scheduleHours > 0) {
      update.scheduleHours = scheduleHours;
    }

    await usersCol.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: update });

    const user = await usersCol.findOne({ _id: new ObjectId(req.session.userId) });
    res.json({
      success: true,
      autoMode: user.autoMode,
      scheduleHours: user.scheduleHours,
      lastRun: user.lastRun,
      nextRun: user.lastRun
        ? new Date(new Date(user.lastRun).getTime() + user.scheduleHours * 3_600_000)
        : null,
    });
  } catch (err) {
    console.error('/auto error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/disconnect', apiLimiter, requireAuth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.youtubeTokens?.access_token) {
      try {
        const oauth2Client = buildOAuth2Client();
        oauth2Client.setCredentials(user.youtubeTokens);
        await oauth2Client.revokeCredentials();
      } catch (_) {}
    }

    await usersCol.updateOne(
      { _id: user._id },
      { $unset: { youtubeTokens: '' }, $set: { autoMode: false, updatedAt: new Date() } }
    );

    res.json({ success: true, message: 'YouTube account disconnected' });
  } catch (err) {
    console.error('/disconnect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
