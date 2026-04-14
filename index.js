'use strict';
// =====================================================================
// Automation-YT SaaS Backend — index.js
// Production-ready for Render.com deployment
// All config via environment variables — NO credentials.json/token.json
// =====================================================================

require('dotenv').config();

// ========================= IMPORTS ===================================
const express      = require('express');
const cors         = require('cors');
const bodyParser   = require('body-parser');
const session      = require('express-session');
const MongoStore   = require('connect-mongo');
const rateLimit    = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');
const axios        = require('axios');
const fs           = require('fs-extra');
const path         = require('path');
const { spawn }    = require('child_process');
const { google }   = require('googleapis');
const cloudinary   = require('cloudinary').v2;

// ========================= ENV VALIDATION ============================
// All required environment variables must be set before startup.
// On Render, set these in the "Environment" tab of your web service.
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
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ========================= EXPRESS INIT ==============================
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(bodyParser.json({ limit: '4mb' }));

// Session middleware — uses MongoDB as the session store so it
// survives Render's ephemeral filesystem restarts.
app.use(
  session({
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: {
      // Render terminates TLS, so mark cookies secure in production
      secure:   process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax', // CSRF mitigation — blocks cross-origin state-changing requests
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ========================= RATE LIMITERS =============================
// Strict limit for OAuth initiation — prevents abuse of the consent redirect.
const authInitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later.' },
});

// General API limiter for authenticated routes.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later.' },
});

// ========================= MONGODB INIT ==============================
let usersCol; // Collection: users
let logsCol;  // Collection: logs

(async () => {
  try {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db(); // uses the database name from the MONGO_URI string
    usersCol = db.collection('users');
    logsCol  = db.collection('logs');

    // Indexes for performance
    await usersCol.createIndex({ email: 1 }, { unique: true });
    await logsCol.createIndex({ userId: 1 });
    await logsCol.createIndex({ timestamp: -1 });

    console.log('✅ MongoDB connected');

    // Start the scheduler only after DB is ready
    startScheduler();
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }
})();

// ========================= CONSTANTS =================================
const OUTPUT_DIR      = path.join(__dirname, 'output');
const ASSETS_DIR      = path.join(__dirname, 'assets');
const BASE_VIDEO_LOCAL = path.join(ASSETS_DIR, 'base.mp4');
const BASE_PUBLIC_ID  = 'ai-reel-bot/base_template_v4';

const VIDEO_SECONDS   = 20;
const MIN_BYTES_OK    = 80_000;
const CANVAS_W        = 1080;
const CANVAS_H        = 1920;
const MAX_LINES       = 5;
const FONT_NAME       = 'Carrois-Gothic-SC';

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

// Spawn a child process and return a promise that resolves on exit code 0.
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
  const MAX_CHARS   = 34;
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  function wrapWithLimit(charLimit) {
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = (line ? line + ' ' : '') + w;
      if (next.length <= charLimit) line = next;
      else { if (line) lines.push(line); line = w; }
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
// Persists a log entry to MongoDB and echoes it to the console.
async function appendLog(userId, status, extra = {}) {
  const entry = {
    userId:    typeof userId === 'string' ? new ObjectId(userId) : userId,
    status,
    videoId:   extra.videoId   || null,
    message:   extra.message   || null,
    timestamp: new Date(),
  };
  try {
    await logsCol.insertOne(entry);
  } catch (e) {
    // Non-fatal — don't crash the job if logging fails
    console.error('Log insert error:', e.message);
  }
  console.log(`[LOG][${userId}] ${status}`, extra.message || '');
}

// ========================= OAUTH HELPER ==============================
// Build an OAuth2 client from environment variables only.
// Tokens are stored in MongoDB, never on disk.
function buildOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Attach stored tokens and set up automatic refresh persistence.
// Returns an oauth2Client ready to use.
async function getAuthenticatedClient(user) {
  if (!user.youtubeTokens) throw new Error('User has no linked YouTube account');

  const oauth2Client = buildOAuth2Client();
  oauth2Client.setCredentials(user.youtubeTokens);

  // Whenever the library auto-refreshes the access token, persist it.
  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...user.youtubeTokens, ...newTokens };
    await usersCol.updateOne(
      { _id: user._id },
      { $set: { youtubeTokens: merged } }
    );
  });

  return oauth2Client;
}

// ========================= BOT LOGIC =================================

// --- Quote generation via Groq ---
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
      max_tokens:  40,
    },
    {
      headers:  { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      timeout:  30_000,
    }
  );

  let quote = res?.data?.choices?.[0]?.message?.content;
  if (!quote) throw new Error('Groq returned empty quote');

  quote = String(quote).replace(/^"+|"+$/g, '').trim().replace(/\s+/g, ' ');
  const words = quote.split(' ').filter(Boolean);
  if (words.length > 10) quote = words.slice(0, 10).join(' ');
  return quote;
}

// --- Paper/parchment background via Pollinations.ai ---
async function generatePaperBackground(outFile) {
  const url =
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(PAPER_BG_PROMPT) +
    `?width=${CANVAS_W}&height=${CANVAS_H}&seed=${Date.now()}`;

  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  await fs.writeFile(outFile, res.data);
}

// --- Render Arabic/Islamic text over image using ImageMagick ---
async function renderTextOnImage({ text, inputPng, outputPng }) {
  const lines       = wrapTextSmart(text);
  const finalText   = lines.join('\n');
  const fontSize    = chooseFontSize(lines);
  const interline   = chooseInterlineSpacing(fontSize, lines.length);

  const textFill    = '#1E120B';            // deep brown on paper
  const stroke      = 'rgba(255,255,255,0.35)';
  const strokeWidth = 2;

  const args = [
    inputPng,
    '-gravity', 'center',
    '-font', FONT_NAME,
    '-pointsize', String(fontSize),
    '-interline-spacing', String(interline),
    // Shadow pass
    '-fill', 'rgba(0,0,0,0.25)',
    '-stroke', 'rgba(0,0,0,0.25)',
    '-strokewidth', '6',
    '-annotate', '+3+3', finalText,
    // Main text pass
    '-fill', textFill,
    '-stroke', stroke,
    '-strokewidth', String(strokeWidth),
    '-annotate', '+0+0', finalText,
    outputPng,
  ];

  await run('magick', args);
}

// --- Ensure base video exists in Cloudinary (one-time upload) ---
async function ensureBaseVideoOnCloudinary() {
  await fs.ensureDir(ASSETS_DIR);

  try {
    const existing = await cloudinary.api.resource(BASE_PUBLIC_ID, { resource_type: 'video' });
    if (existing?.secure_url) return { publicId: BASE_PUBLIC_ID, url: existing.secure_url };
  } catch (_) {
    // not found — upload below
  }

  if (!(await fs.pathExists(BASE_VIDEO_LOCAL))) {
    throw new Error(
      'Base video not found at assets/base.mp4. ' +
      'Please upload it to Cloudinary manually with public_id=' + BASE_PUBLIC_ID +
      ' or place base.mp4 in the assets/ folder before first run.'
    );
  }

  console.log('⬆️  Uploading base template video to Cloudinary (one-time)…');
  const up = await cloudinary.uploader.upload(BASE_VIDEO_LOCAL, {
    resource_type: 'video',
    public_id:     BASE_PUBLIC_ID,
    overwrite:     true,
  });
  return { publicId: BASE_PUBLIC_ID, url: up.secure_url };
}

// --- Compose overlay image onto base video via Cloudinary ---
async function renderFinalMp4WithOverlay({ baseVideoPublicId, overlayImagePath }) {
  const overlay = await cloudinary.uploader.upload(overlayImagePath, {
    resource_type: 'image',
    folder:        'ai-reel-bot/overlays',
    overwrite:     false,
  });

  const overlayLayer = overlay.public_id.replace(/\//g, ':');

  const eager = [
    {
      width:       CANVAS_W,
      height:      CANVAS_H,
      crop:        'fill',
      fps:         30,
      duration:    VIDEO_SECONDS,
      format:      'mp4',
      video_codec: 'h264',
      quality:     'auto:best',
      bit_rate:    '1400k',
      overlay:     overlayLayer,
    },
    {
      flags:   'layer_apply',
      gravity: 'center',
      width:   CANVAS_W,
      height:  CANVAS_H,
      crop:    'fill',
    },
  ];

  const exp = await cloudinary.uploader.explicit(baseVideoPublicId, {
    resource_type: 'video',
    type:          'upload',
    eager,
    eager_async:   false,
  });

  const mp4Url = exp?.eager?.[0]?.secure_url;
  if (!mp4Url) throw new Error('Cloudinary did not return derived MP4 URL.');

  return { mp4Url, overlayPublicId: overlay.public_id };
}

// --- Download a URL to a local file ---
async function downloadToFile(url, outPath) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 180_000 });
  const ct  = String(res.headers['content-type'] || '').toLowerCase();
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

// --- Build YouTube video metadata ---
function buildYouTubeMetadata(quote) {
  const clean       = sanitizeTitle(quote);
  const title       = sanitizeTitle(`${clean} | Islamic Reminder #Shorts`);
  const hashtags    = '#Islam #IslamicReminder #Quran #Muslim #Dua #Iman #Shorts #IslamicShorts';
  const description = [clean, '', 'Short Islamic reminder to strengthen your Iman.', 'Follow for daily reminders.', '', hashtags].join('\n');
  const tags        = ['islam', 'islamic reminder', 'quran', 'muslim', 'dua', 'iman', 'shorts', 'islamic shorts', 'allah'];
  return { title, description, tags };
}

// --- Upload a local MP4 to YouTube ---
async function uploadToYouTube(mp4Path, quote, user) {
  const oauth2Client = await getAuthenticatedClient(user);
  const youtube      = google.youtube({ version: 'v3', auth: oauth2Client });

  const st = await fs.stat(mp4Path);
  if (st.size < MIN_BYTES_OK) throw new Error(`MP4 too small (${st.size} bytes).`);

  const meta = buildYouTubeMetadata(quote);

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title:       meta.title,
        description: meta.description,
        tags:        meta.tags,
        categoryId:  '22',
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(mp4Path) },
  });

  return res.data.id;
}

// --- Delete local temp files ---
async function cleanupLocal(paths) {
  for (const p of paths) {
    try {
      if (p && (await fs.pathExists(p))) await fs.remove(p);
    } catch (_) {}
  }
}

// --- Delete Cloudinary asset ---
async function deleteCloudinary(publicId, resourceType) {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (_) {}
}

// ========================= MAIN JOB RUNNER ===========================
// This function orchestrates the full pipeline for one user:
//   generate quote → background → text overlay → Cloudinary MP4 → YouTube upload
// It is called by both the manual /generate endpoint and the auto scheduler.
async function runJobForUser(user) {
  await fs.ensureDir(OUTPUT_DIR);

  const t   = Date.now();
  const bg  = path.join(OUTPUT_DIR, `bg_${t}.png`);
  const img = path.join(OUTPUT_DIR, `img_${t}.png`);
  const mp4 = path.join(OUTPUT_DIR, `short_${t}.mp4`);
  let overlayPublicId;

  try {
    await appendLog(user._id, 'started');

    // 1. Generate quote
    await appendLog(user._id, 'generating_quote');
    const quote = await generateIslamicQuote();
    await appendLog(user._id, 'quote_ready', { message: quote });

    // 2. Paper background
    await appendLog(user._id, 'generating_background');
    await generatePaperBackground(bg);

    // 3. Text overlay
    await appendLog(user._id, 'rendering_text');
    await renderTextOnImage({ text: quote, inputPng: bg, outputPng: img });

    // 4. Ensure base video on Cloudinary
    await appendLog(user._id, 'checking_base_video');
    const { publicId: basePublicId } = await ensureBaseVideoOnCloudinary();

    // 5. Render final MP4 on Cloudinary
    await appendLog(user._id, 'rendering_video');
    const rendered = await renderFinalMp4WithOverlay({
      baseVideoPublicId: basePublicId,
      overlayImagePath:  img,
    });
    overlayPublicId = rendered.overlayPublicId;

    // 6. Download rendered MP4 (with retries)
    await appendLog(user._id, 'downloading_video');
    let lastErr;
    for (let i = 1; i <= 6; i++) {
      try {
        await downloadToFile(rendered.mp4Url, mp4);
        const st = await fs.stat(mp4);
        if (st.size >= MIN_BYTES_OK) { lastErr = null; break; }
        lastErr = new Error(`Downloaded file too small: ${st.size}`);
      } catch (e) {
        lastErr = e;
      }
      await sleep(4_000);
    }
    if (lastErr) throw lastErr;

    // 7. Upload to YouTube
    await appendLog(user._id, 'uploading_to_youtube');
    const videoId = await uploadToYouTube(mp4, quote, user);
    await appendLog(user._id, 'done', { videoId });

    // 8. Update lastRun timestamp in DB
    await usersCol.updateOne({ _id: user._id }, { $set: { lastRun: new Date() } });

    return { success: true, videoId, quote };

  } catch (err) {
    await appendLog(user._id, 'error', { message: err.message });
    throw err;

  } finally {
    // Always clean up temp files and Cloudinary overlay
    await cleanupLocal([bg, img, mp4]);
    if (overlayPublicId) await deleteCloudinary(overlayPublicId, 'image');
  }
}

// ========================= SCHEDULER =================================
// Every minute, check all users with autoMode:true and run their job
// if enough time has elapsed since lastRun based on their schedule interval.
// inFlightJobs tracks user IDs with an active run to prevent overlapping executions.
const inFlightJobs = new Set();

function startScheduler() {
  console.log('⏱️  Scheduler started (1-minute tick)');

  setInterval(async () => {
    try {
      const users = await usersCol.find({ autoMode: true }).toArray();

      for (const user of users) {
        // Skip if no YouTube tokens linked
        if (!user.youtubeTokens) continue;

        // Skip if this user already has a job in progress
        const userIdStr = user._id.toString();
        if (inFlightJobs.has(userIdStr)) continue;

        const intervalMs   = (user.scheduleHours || 24) * 60 * 60 * 1000;
        const lastRun      = user.lastRun ? new Date(user.lastRun).getTime() : 0;
        const nextRunTime  = lastRun + intervalMs;

        if (Date.now() >= nextRunTime) {
          inFlightJobs.add(userIdStr);
          console.log(`⚙️  Scheduler: running job for user ${userIdStr}`);
          runJobForUser(user)
            .catch(async (e) => {
              console.error(`Scheduler job failed for ${userIdStr}:`, e.message);
              // Persist failure so it appears in /logs for the user
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
  }, 60_000); // tick every 60 seconds
}

// ========================= AUTH MIDDLEWARE ===========================
// Protects API routes — requires a valid session with userId set.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated. Please login via /auth/google' });
  }
  next();
}

// ========================= OAUTH ROUTES ==============================

// GET /auth/google
// Redirects the user to Google's consent screen.
// Query param `email` is stored in session so we can upsert the user on callback.
// ========================= OAUTH ROUTES ==============================

// GET /auth/google
app.get('/auth/google', authInitLimiter, (req, res) => {
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
app.get('/auth/google/callback', authInitLimiter, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error: `Google OAuth error: ${error}` });
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  try {
    const oauth2Client = buildOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch email
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2Api.userinfo.get();
    const email = data.email;
    if (!email) throw new Error('Could not retrieve email from Google');

    // Save user
    const result = await usersCol.findOneAndUpdate(
      { email },
      {
        $set: {
          email,
          youtubeTokens: tokens,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          defaultTopic: 'islamic',
          defaultTheme: 'paper',
          autoMode: false,
          scheduleHours: 24,
          lastRun: null,
          createdAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    const userId = result._id.toString();
    req.session.userId = userId;
    req.session.email = email;

    // ✅ FIX: Redirect instead of JSON
    res.redirect('autoyt-xi.vercel.app');

  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/status
app.get('/auth/status', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({
      authenticated: true,
      user: {
        email: req.session.email,
        name: req.session.email?.split('@')[0] || 'User',
        avatar: null
      }
    });
  } else {
    res.json({ authenticated: false });
  }
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out' });
  });
});

// ========================= API ROUTES ================================

// --------------- GET /dashboard ---------------
// Returns YouTube channel info (name, profile pic, subscribers, total videos)
// and the last 5 uploaded video details.
app.get('/dashboard', apiLimiter, requireAuth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.youtubeTokens) return res.status(400).json({ error: 'YouTube not connected' });

    const oauth2Client = await getAuthenticatedClient(user);
    const youtube      = google.youtube({ version: 'v3', auth: oauth2Client });

    // Channel info
    const channelRes = await youtube.channels.list({
      part: ['snippet', 'statistics', 'contentDetails'],
      mine: true,
    });
    const channel    = channelRes.data.items?.[0];
    if (!channel) return res.status(404).json({ error: 'No YouTube channel found' });

    // Last 5 uploads
    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    let recentVideos = [];
    if (uploadsPlaylistId) {
      const playlistRes = await youtube.playlistItems.list({
        part:       ['snippet'],
        playlistId: uploadsPlaylistId,
        maxResults: 5,
      });
      recentVideos = (playlistRes.data.items || []).map((item) => ({
        videoId:    item.snippet.resourceId.videoId,
        title:      item.snippet.title,
        thumbnail:  item.snippet.thumbnails?.medium?.url || null,
        uploadedAt: item.snippet.publishedAt,
      }));
    }

    res.json({
      channel: {
        id:          channel.id,
        name:        channel.snippet.title,
        profilePic:  channel.snippet.thumbnails?.medium?.url || null,
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

// --------------- GET /logs ---------------
// Returns the last 20 log entries for the authenticated user.
app.get('/logs', apiLimiter, requireAuth, async (req, res) => {
  try {
    const userId = new ObjectId(req.session.userId);
    const logs   = await logsCol
      .find({ userId })
      .sort({ timestamp: -1 })
      .limit(20)
      .toArray();

    res.json({ logs });
  } catch (err) {
    console.error('/logs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------- POST /generate ---------------
// Manually trigger one video generation + YouTube upload for the logged-in user.
// Runs synchronously so the client gets the result (or error) in the response.
app.post('/generate', apiLimiter, requireAuth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user)               return res.status(404).json({ error: 'User not found' });
    if (!user.youtubeTokens) return res.status(400).json({ error: 'YouTube not connected. Link your account first.' });

    const result = await runJobForUser(user);
    res.json({ success: true, videoId: result.videoId, quote: result.quote });
  } catch (err) {
    console.error('/generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------- POST /auto ---------------
// Enable or disable auto mode and set the schedule interval.
// Body: { enabled: boolean, scheduleHours: number (e.g. 1, 3, 24) }
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
      success:      true,
      autoMode:     user.autoMode,
      scheduleHours: user.scheduleHours,
      lastRun:      user.lastRun,
      nextRun:      user.lastRun
        ? new Date(new Date(user.lastRun).getTime() + user.scheduleHours * 3_600_000)
        : null,
    });
  } catch (err) {
    console.error('/auto error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------- POST /disconnect ---------------
// Revoke the YouTube OAuth tokens and remove them from the DB.
// The session remains active but the user must re-link YouTube to generate videos.
app.post('/disconnect', apiLimiter, requireAuth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Revoke access token at Google
    if (user.youtubeTokens?.access_token) {
      try {
        const oauth2Client = buildOAuth2Client();
        oauth2Client.setCredentials(user.youtubeTokens);
        await oauth2Client.revokeCredentials();
      } catch (_) {
        // Revocation failure is non-fatal — still remove tokens from DB
      }
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

// --------------- GET /profile ---------------
// Return current user settings (defaultTopic, defaultTheme, autoMode, scheduleHours).
app.get('/profile', apiLimiter, requireAuth, async (req, res) => {
  try {
    const user = await usersCol.findOne(
      { _id: new ObjectId(req.session.userId) },
      { projection: { youtubeTokens: 0 } } // never expose raw tokens
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ profile: user });
  } catch (err) {
    console.error('/profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------- PATCH /profile ---------------
// Update editable user settings.
// Body (all optional): { defaultTopic, defaultTheme, scheduleHours }
app.patch('/profile', apiLimiter, requireAuth, async (req, res) => {
  try {
    const allowed = ['defaultTopic', 'defaultTheme', 'scheduleHours'];
    const update  = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    update.updatedAt = new Date();

    await usersCol.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: update });
    res.json({ success: true, updated: update });
  } catch (err) {
    console.error('PATCH /profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------- DELETE /logs ---------------
// Clear all logs for the current user.
app.delete('/logs', apiLimiter, requireAuth, async (req, res) => {
  try {
    const result = await logsCol.deleteMany({ userId: new ObjectId(req.session.userId) });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    console.error('DELETE /logs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========================= HEALTH CHECK ==============================
// Render uses this to verify the service is alive.
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ========================= START SERVER ==============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
