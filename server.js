const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

loadEnv();

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${APP_BASE_URL}/auth/callback`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), "autoshorts-work");
const SESSION_MAX_AGE_SECONDS = Number(process.env.SESSION_MAX_AGE_SECONDS || 30 * 24 * 60 * 60);
const SESSION_COOKIE_SECURE = APP_BASE_URL.startsWith("https://");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 1024 * 1024;
const SHORT_START = process.env.SHORT_START || "00:01:00";
const SHORT_DURATION = Number(process.env.SHORT_DURATION || 45);
const SHORT_WIDTH = Number(process.env.SHORT_WIDTH || 720);
const SHORT_HEIGHT = Number(process.env.SHORT_HEIGHT || 1280);
const SHORT_PRESET = process.env.SHORT_PRESET || "veryfast";
const SHORT_CRF = process.env.SHORT_CRF || "28";
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 10 * 60 * 1000);
const UPLOAD_CHUNK_SIZE = Number(process.env.UPLOAD_CHUNK_SIZE || 8 * 1024 * 1024);
const UPLOAD_TIMEOUT_MS = Number(process.env.UPLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_SOURCE_DURATION_SECONDS = Number(process.env.MAX_SOURCE_DURATION_SECONDS || 2 * 60 * 60);
const TRANSCRIPT_LANGS = process.env.TRANSCRIPT_LANGS || "en.*,en";
const TOOL_COMMANDS = {
  ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH || "ffprobe",
  "yt-dlp": process.env.YTDLP_PATH || "yt-dlp",
};
const YTDLP_JS_RUNTIME = process.env.YTDLP_JS_RUNTIME || "node:/usr/local/bin/node";
const YTDLP_COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || "./cookies.txt";
const YTDLP_VERBOSE = String(process.env.YTDLP_VERBOSE || "").toLowerCase() === "true";
const YOUTUBE_COOKIE_NAMES = ["SID", "HSID", "SAPISID", "LOGIN_INFO", "VISITOR_INFO1_LIVE", "__Secure-1PSID", "__Secure-3PSID"];
const TOOL_VERSION_ARGS = {
  ffmpeg: ["-version"],
  ffprobe: ["-version"],
  "yt-dlp": ["--version"],
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

const oauthStates = new Map();
let store = readStore();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, APP_BASE_URL);

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const requested = path.normalize(url.pathname.replace(/^\/public\//, ""));
      const filePath = path.join(PUBLIC_DIR, requested);
      if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
      return serveFile(res, filePath, contentType(filePath));
    }

    if (req.method === "GET" && url.pathname === "/auth/google") return startGoogleAuth(req, res);
    if (req.method === "GET" && url.pathname === "/auth/callback") return finishGoogleAuth(req, res, url);
    if (req.method === "POST" && url.pathname === "/auth/logout") return logout(req, res);

    if (url.pathname.startsWith("/api/")) {
      const session = getSession(req);
      if (!session && url.pathname !== "/api/health") {
        return sendJson(res, 401, { error: "Sign in with Google first." });
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, tools: TOOL_COMMANDS });
      }

      if (req.method === "GET" && url.pathname === "/api/me") {
        return sendJson(res, 200, { user: session.user });
      }

      if (req.method === "GET" && url.pathname === "/api/jobs") {
        const jobs = store.jobs.filter((job) => job.userId === session.user.id);
        return sendJson(res, 200, { jobs });
      }

      if (req.method === "POST" && url.pathname === "/api/jobs") {
        const body = await readJsonBody(req);
        return createJob(res, session.user, body);
      }

      const runMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
      if (req.method === "POST" && runMatch) {
        const job = store.jobs.find((item) => item.id === runMatch[1] && item.userId === session.user.id);
        if (!job) return sendJson(res, 404, { error: "Job not found." });
        queueJob(job, "Manual run requested.");
        return sendJson(res, 202, { job });
      }
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AutoShorts Studio running on ${APP_BASE_URL}`);
  logToolStatus();
});

setInterval(runDueJobs, 60 * 1000);
setTimeout(runDueJobs, 2000);

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function readStore() {
  if (!fs.existsSync(STORE_PATH)) {
    return { sessions: {}, users: {}, tokens: {}, jobs: [] };
  }

  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return { sessions: {}, users: {}, tokens: {}, jobs: [] };
  }
}

function saveStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function serveFile(res, filePath, type) {
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "File not found" });
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(filePath).pipe(res);
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function getCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAge === 0) parts.push("Max-Age=0");
  if (options.maxAge && options.maxAge > 0) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.secure) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

function getSession(req) {
  const sid = getCookies(req).sid;
  if (!sid || !store.sessions[sid]) return null;
  const session = store.sessions[sid];
  if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
    delete store.sessions[sid];
    saveStore();
    return null;
  }
  return session;
}

function requireConfig(keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required .env value: ${missing.join(", ")}`);
  }
}

function startGoogleAuth(req, res) {
  requireConfig(["GOOGLE_CLIENT_ID"]);
  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    state,
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ].join(" "),
  });

  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

async function finishGoogleAuth(req, res, url) {
  requireConfig(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expires = oauthStates.get(state);

  if (!code || !state || !expires || expires < Date.now()) {
    return sendJson(res, 400, { error: "Invalid or expired Google login state." });
  }

  oauthStates.delete(state);
  const token = await postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const profile = await fetchJson("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });

  const user = {
    id: profile.id,
    email: profile.email,
    name: profile.name || profile.email,
    picture: profile.picture || "",
  };

  const sid = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  store.users[user.id] = user;
  store.sessions[sid] = { user, createdAt: new Date().toISOString(), expiresAt };
  store.tokens[user.id] = normalizeToken(token);
  saveStore();

  setCookie(res, "sid", sid, { maxAge: SESSION_MAX_AGE_SECONDS, secure: SESSION_COOKIE_SECURE });
  redirect(res, "/");
}

function logout(req, res) {
  const sid = getCookies(req).sid;
  if (sid) delete store.sessions[sid];
  saveStore();
  setCookie(res, "sid", "", { maxAge: 0, secure: SESSION_COOKIE_SECURE });
  sendJson(res, 200, { ok: true });
}

function normalizeToken(token) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scope: token.scope,
    token_type: token.token_type,
    expiry_date: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
}

function createJob(res, user, body) {
  const videoUrl = String(body.videoUrl || "").trim();
  const dailyAt = String(body.dailyAt || "09:00").trim();

  if (!isSupportedSourceUrl(videoUrl)) {
    return sendJson(res, 400, { error: "Paste a valid YouTube URL or direct video file URL." });
  }

  if (!/^\d{2}:\d{2}$/.test(dailyAt)) {
    return sendJson(res, 400, { error: "Daily time must use HH:MM format." });
  }

  const job = {
    id: crypto.randomUUID(),
    userId: user.id,
    videoUrl,
    dailyAt,
    status: "scheduled",
    stage: "Queued",
    progress: 0,
    error: null,
    nextRunAt: nextDailyRun(dailyAt).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: null,
    lastUploadId: null,
    logs: ["Automation created."],
  };

  store.jobs.unshift(job);
  saveStore();
  sendJson(res, 201, { job });
}

function nextDailyRun(dailyAt, from = new Date()) {
  const [hours, minutes] = dailyAt.split(":").map(Number);
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

function runDueJobs() {
  const dueJobs = store.jobs.filter((job) => {
    return job.status === "scheduled" && new Date(job.nextRunAt).getTime() <= Date.now();
  });

  for (const job of dueJobs) queueJob(job, "Daily schedule triggered.");
}

function queueJob(job, reason) {
  if (job.status === "running") return;
  job.status = "running";
  job.stage = "Queued";
  job.progress = 1;
  job.error = null;
  job.updatedAt = new Date().toISOString();
  logJob(job, reason);
  setJobProgress(job, "Queued", 1, "Job queued.");
  saveStore();

  runPipeline(job).catch((error) => {
    job.status = "failed";
    job.stage = "Failed";
    job.progress = 100;
    job.error = friendlyPipelineError(error);
    job.updatedAt = new Date().toISOString();
    logJob(job, job.error);
    saveStore();
  });
}

async function runPipeline(job) {
  const user = store.users[job.userId];
  if (!user) throw new Error("User no longer exists.");

  const jobDir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    if (isYouTubeUrl(job.videoUrl)) {
      setJobProgress(job, "Validating cookies", 3, "Validating YouTube cookies before starting job.");
      prepareWritableCookiesFile(job, { required: true });
    }
    const scenePlan = await analyzeVideoForShort(job, jobDir);
    const assets = await prepareVideoAssets(job, scenePlan, jobDir);

    const uploadId = await uploadToYouTube(job.userId, assets.videoPath, assets.thumbnailPath, scenePlan.metadata, job);

    job.status = "scheduled";
    job.stage = "Completed";
    job.progress = 100;
    job.error = null;
    job.lastRunAt = new Date().toISOString();
    job.lastUploadId = uploadId;
    job.lastMetadata = scenePlan.metadata;
    job.lastScene = {
      start: scenePlan.start,
      duration: scenePlan.duration,
      reason: scenePlan.reason,
      fallbackUsed: scenePlan.fallbackUsed,
    };
    job.nextRunAt = nextDailyRun(job.dailyAt).toISOString();
    job.updatedAt = new Date().toISOString();
    logJob(job, `Upload complete: https://youtube.com/watch?v=${uploadId}`);
    saveStore();
  } finally {
    cleanupJobFiles(jobDir);
  }
}

function logJob(job, message) {
  const line = `${new Date().toLocaleString()} - ${message}`;
  job.logs = [line, ...(job.logs || [])].slice(0, 50);
}

function setJobProgress(job, stage, progress, message) {
  job.stage = stage;
  job.progress = Math.max(0, Math.min(100, Number(progress) || 0));
  job.updatedAt = new Date().toISOString();
  if (message) logJob(job, message);
  saveStore();
}

async function analyzeVideoForShort(job, jobDir) {
  setJobProgress(job, "Analyzing transcript", 5, "Checking transcript/captions.");
  const transcript = await extractTranscript(job, jobDir);
  const fallback = fallbackScenePlan(job.videoUrl, transcript ? "AI scene selection failed." : "Transcript not found.");

  if (!transcript) {
    logJob(job, "Transcript not found. Fallback used: yes.");
    return fallback;
  }

  logJob(job, `Transcript found: ${transcript.entries.length} timestamped lines.`);

  if (!process.env.OPENROUTER_API_KEY) {
    logJob(job, "AI scene selection skipped: OPENROUTER_API_KEY is missing. Fallback used: yes.");
    return fallbackScenePlan(job.videoUrl, "OPENROUTER_API_KEY missing.");
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      setJobProgress(job, "Generating metadata", 12, attempt === 1 ? "AI selecting best scene and metadata." : "Retrying AI JSON response.");
      const plan = await requestAiScenePlan(job, transcript.text, attempt);
      const normalized = normalizeScenePlan(plan, job.videoUrl);
      logJob(job, `AI selected timestamp: ${normalized.start} for ${normalized.duration}s.`);
      logJob(job, `AI generated title: ${normalized.metadata.title}`);
      logJob(job, `AI generated description: ${normalized.metadata.description}`);
      logJob(job, `AI scene reason: ${normalized.reason}`);
      logJob(job, "Fallback used: no.");
      return normalized;
    } catch (error) {
      lastError = error;
      logJob(job, `AI scene selection error attempt ${attempt}: ${error.message}`);
    }
  }

  logJob(job, `AI failed after retry. Fallback used: yes. Error: ${lastError?.message || "Unknown AI error"}`);
  return fallbackScenePlan(job.videoUrl, lastError?.message || "AI failed.");
}

async function requestAiScenePlan(job, transcriptText, attempt) {
  const recentTitles = store.jobs
    .filter((item) => item.userId === job.userId && item.lastMetadata?.title)
    .slice(-10)
    .map((item) => item.lastMetadata.title);
  const uniquenessSeed = crypto.randomUUID();
  const prompt = [
    "You are selecting the best YouTube Shorts moment from a long video transcript.",
    "Find the most interesting, emotional, funny, action-heavy, surprising, or visually strong 30-45 second scene.",
    "Create fresh metadata that is specific to this video. Do not reuse generic or repeated titles.",
    "Return JSON only. No markdown. No explanation outside JSON.",
    "Required JSON shape:",
    '{"start":"00:04:50","duration":45,"title":"unique catchy title","description":"unique YouTube Shorts description","tags":["tag1","tag2","tag3"],"thumbnailText":"short catchy thumbnail text","reason":"why this scene is best"}',
    "Rules:",
    "- start must be HH:MM:SS.",
    "- duration must be between 30 and 45 seconds.",
    "- title max 90 characters and must be unique.",
    "- description must be 2-4 sentences and mention this is a short clip.",
    "- tags must be 8-15 short tags.",
    "- thumbnailText must be 2-5 punchy words.",
    `URL: ${job.videoUrl}`,
    `Avoid these recent titles: ${recentTitles.length ? recentTitles.join(" | ") : "none"}`,
    `Uniqueness seed: ${uniquenessSeed}`,
    `Attempt: ${attempt}`,
    "Transcript with timestamps:",
    transcriptText,
  ].join("\n");

  const response = await fetchJson("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": APP_BASE_URL,
      "x-title": "AutoShorts Studio",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.95,
      response_format: { type: "json_object" },
    }),
  });

  const content = response.choices?.[0]?.message?.content || "";
  const parsed = parseJsonFromText(content);
  if (!Object.keys(parsed).length) throw new Error(`AI returned invalid JSON: ${content.slice(0, 500)}`);
  return parsed;
}

function parseJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

function normalizeScenePlan(plan, videoUrl) {
  const start = normalizeTimestamp(plan.start);
  const duration = Number(plan.duration);
  if (!start) throw new Error(`AI returned invalid start timestamp: ${plan.start}`);
  if (!Number.isFinite(duration) || duration < 30 || duration > 45) {
    throw new Error(`AI returned invalid duration: ${plan.duration}`);
  }

  const fallback = fallbackMetadata(videoUrl);
  const title = clampText(plan.title || fallback.title, 90);
  if (!title) throw new Error("AI returned empty title.");

  const description = clampText(plan.description || fallback.description, 4500);
  const tags = Array.isArray(plan.tags) && plan.tags.length
    ? plan.tags.map((tag) => clampText(tag, 40)).filter(Boolean).slice(0, 15)
    : fallback.tags;

  return {
    start,
    duration: Math.round(duration),
    reason: clampText(plan.reason || "AI selected the strongest transcript moment.", 500),
    fallbackUsed: false,
    metadata: {
      title,
      description,
      tags,
      thumbnailText: clampText(plan.thumbnailText || fallback.thumbnailText, 40),
    },
  };
}

function normalizeTimestamp(value) {
  const text = String(value || "").trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(text)) return text;
  const short = text.match(/^(\d{1,2}):(\d{2})$/);
  if (short) return `00:${short[1].padStart(2, "0")}:${short[2]}`;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return secondsToTimestamp(seconds);
  return null;
}

function secondsToTimestamp(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function fallbackScenePlan(videoUrl, reason) {
  const metadata = fallbackMetadata(videoUrl);
  return {
    start: SHORT_START,
    duration: SHORT_DURATION,
    reason,
    fallbackUsed: true,
    metadata,
  };
}

function fallbackMetadata(videoUrl) {
  const seed = crypto.randomBytes(3).toString("hex").toUpperCase();
  return {
    title: clampText(`Must-watch short moment ${seed}`, 90),
    description: `Auto-generated short clip from ${videoUrl}.\n\nFresh highlight ID: ${seed}. Posted by the channel owner or with permission.`,
    tags: ["shorts", "viral", "trending", "highlights", "youtube shorts", "creator", "clip", "video"],
    thumbnailText: "Watch This",
  };
}

function clampText(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trim() : text;
}

async function extractTranscript(job, jobDir) {
  if (!isYouTubeUrl(job.videoUrl)) {
    logJob(job, "Transcript not found: source is not a YouTube URL.");
    return null;
  }

  try {
    await requireTool("yt-dlp");
    const transcriptBase = path.join(jobDir, "transcript");
    const args = buildYtDlpTranscriptArgs(job.videoUrl, transcriptBase, job);
    await runTool("yt-dlp", args, { timeoutMs: 2 * 60 * 1000, maxOutput: 4000 });
    const transcriptFile = findTranscriptFile(jobDir);
    if (!transcriptFile) return null;

    const entries = parseVttTranscript(fs.readFileSync(transcriptFile, "utf8"));
    if (!entries.length) return null;

    const text = buildTranscriptPromptText(entries);
    return { file: transcriptFile, entries, text };
  } catch (error) {
    logYtDlpCookieError(job, error);
    logJob(job, `Transcript extraction error: ${friendlyYtDlpError(error)}`);
    return null;
  }
}

function buildYtDlpTranscriptArgs(videoUrl, transcriptBase, job) {
  const args = [];
  const cookiesPath = prepareWritableCookiesFile(job);

  if (YTDLP_VERBOSE) args.push("-vU");

  args.push(
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    TRANSCRIPT_LANGS,
    "--sub-format",
    "vtt",
    "--convert-subs",
    "vtt",
    "--no-playlist",
    "--force-ipv4",
    "--sleep-requests",
    "8",
    "--sleep-interval",
    "8",
    "--max-sleep-interval",
    "20",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--js-runtimes",
    YTDLP_JS_RUNTIME,
    "--extractor-args",
    "youtube:player_client=android,web",
  );

  if (cookiesPath) args.push("--cookies", cookiesPath);

  args.push("-o", transcriptBase, videoUrl);
  return args;
}

function findTranscriptFile(jobDir) {
  return fs
    .readdirSync(jobDir)
    .filter((name) => /\.vtt$/i.test(name))
    .map((name) => path.join(jobDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function parseVttTranscript(content) {
  const blocks = content.replace(/\r/g, "").split(/\n{2,}/);
  const entries = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex === -1) continue;

    const timeMatch = lines[timeIndex].match(/(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/);
    if (!timeMatch) continue;

    const text = cleanCaptionText(lines.slice(timeIndex + 1).join(" "));
    if (!text) continue;

    entries.push({
      start: vttTimeToTimestamp(timeMatch[1]),
      end: vttTimeToTimestamp(timeMatch[2]),
      text,
    });
  }

  return mergeTranscriptEntries(entries);
}

function mergeTranscriptEntries(entries) {
  const merged = [];
  for (const entry of entries) {
    const previous = merged[merged.length - 1];
    if (previous && previous.start === entry.start) {
      previous.text = cleanCaptionText(`${previous.text} ${entry.text}`);
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

function cleanCaptionText(value) {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function vttTimeToTimestamp(value) {
  const parts = value.split(".");
  const clock = parts[0];
  if (/^\d{2}:\d{2}:\d{2}$/.test(clock)) return clock;
  if (/^\d{2}:\d{2}$/.test(clock)) return `00:${clock}`;
  return "00:00:00";
}

function buildTranscriptPromptText(entries) {
  const lines = entries.map((entry) => `[${entry.start}] ${entry.text}`);
  const fullTranscript = lines.join("\n");
  if (fullTranscript.length <= 16000) return fullTranscript;

  const maxLines = 220;
  const step = Math.max(1, Math.ceil(lines.length / maxLines));
  return lines.filter((_, index) => index % step === 0).join("\n").slice(0, 16000);
}

async function prepareVideoAssets(job, scenePlan, jobDir) {
  await requireTool("ffmpeg");
  await requireTool("ffprobe");

  const rawPath = path.join(jobDir, "source.mp4");
  const clipPath = path.join(jobDir, `clip-${Date.now()}.mp4`);
  const videoPath = path.join(jobDir, `short-${Date.now()}.mp4`);
  const thumbnailPath = path.join(jobDir, `thumbnail-${Date.now()}.jpg`);
  const sourceInput = isDirectVideoUrl(job.videoUrl) ? job.videoUrl : rawPath;

  try {
    if (isYouTubeUrl(job.videoUrl)) {
      await requireTool("yt-dlp");
      setJobProgress(job, "Downloading video", 10, "Downloading video source at Shorts-friendly quality.");
      await runYtDlp(job.videoUrl, rawPath, job);
    }

    const duration = await getVideoDuration(sourceInput);
    if (duration && duration > MAX_SOURCE_DURATION_SECONDS) {
      logJob(job, `Warning: source video is ${Math.round(duration / 60)} minutes long, over the 2 hour guard.`);
    }

    setJobProgress(job, "Cutting short clip", 38, `Cutting ${scenePlan.duration}s clip from ${scenePlan.start}.`);
    await runTool("ffmpeg", [
      "-y",
      "-ss",
      scenePlan.start,
      "-i",
      sourceInput,
      "-t",
      String(scenePlan.duration),
      "-c",
      "copy",
      clipPath,
    ], { timeoutMs: RENDER_TIMEOUT_MS });

    setJobProgress(job, "Rendering vertical short", 52, `Rendering ${SHORT_WIDTH}x${SHORT_HEIGHT} vertical short with Vivid Warm filter.`);
    await runTool("ffmpeg", [
      "-y",
      "-i",
      clipPath,
      "-vf",
      vividWarmVideoFilter(),
      "-c:v",
      "libx264",
      "-preset",
      SHORT_PRESET,
      "-crf",
      SHORT_CRF,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      videoPath,
    ], { timeoutMs: RENDER_TIMEOUT_MS });

    setJobProgress(job, "Rendering vertical short", 65, "Creating AI thumbnail from final short.");
    await createThumbnail(videoPath, thumbnailPath, scenePlan.metadata.thumbnailText, job);
    return { jobDir, videoPath, thumbnailPath };
  } catch (error) {
    cleanupJobFiles(jobDir);
    throw error;
  }
}

function vividWarmVideoFilter() {
  return `scale=${SHORT_WIDTH}:${SHORT_HEIGHT}:force_original_aspect_ratio=increase,crop=${SHORT_WIDTH}:${SHORT_HEIGHT},eq=saturation=1.25:contrast=1.08:brightness=0.03,colorbalance=rs=.08:gs=.03:bs=-.04`;
}

async function createThumbnail(videoPath, thumbnailPath, thumbnailText, job) {
  const safeText = escapeDrawText(thumbnailText || "Watch This");
  const filter = `${vividWarmVideoFilter()},drawbox=x=0:y=ih*0.68:w=iw:h=ih*0.20:color=black@0.45:t=fill,drawtext=text='${safeText}':fontcolor=white:fontsize=54:box=1:boxcolor=black@0.15:boxborderw=18:x=(w-text_w)/2:y=h*0.73`;
  try {
    await runTool("ffmpeg", ["-y", "-ss", "00:00:03", "-i", videoPath, "-vf", filter, "-frames:v", "1", thumbnailPath], { timeoutMs: RENDER_TIMEOUT_MS });
    logJob(job, `AI thumbnail text: ${thumbnailText || "Watch This"}`);
  } catch (error) {
    logJob(job, `AI thumbnail text overlay failed, using clean frame: ${error.message}`);
    await runTool("ffmpeg", ["-y", "-ss", "00:00:03", "-i", videoPath, "-frames:v", "1", thumbnailPath], { timeoutMs: RENDER_TIMEOUT_MS });
  }
}

function escapeDrawText(value) {
  return clampText(value, 40)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function isSupportedSourceUrl(value) {
  return isYouTubeUrl(value) || isDirectVideoUrl(value);
}

async function getVideoDuration(inputPath) {
  try {
    const output = await runTool("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ], { timeoutMs: 30 * 1000, maxOutput: 2000 });
    const duration = Number(output.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch (error) {
    console.warn(`Duration check skipped: ${error.message}`);
    return null;
  }
}

function cleanupJobFiles(jobDir) {
  try {
    if (jobDir && jobDir.startsWith(WORK_DIR) && fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`Cleanup failed: ${error.message}`);
  }
}

function isYouTubeUrl(value) {
  return /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(value);
}

function isDirectVideoUrl(value) {
  return /^https:\/\/.+\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(value);
}

function runYtDlp(videoUrl, outputPath, job) {
  const args = buildYtDlpArgs(videoUrl, outputPath, job);
  return runTool("yt-dlp", args).catch((error) => {
    logYtDlpCookieError(job, error);
    throw new Error(friendlyYtDlpError(error));
  });
}

function buildYtDlpArgs(videoUrl, outputPath, job) {
  const args = [];
  const cookiesPath = prepareWritableCookiesFile(job, { required: true });

  if (!cookiesPath) throw new Error("cookies.txt not found. Upload cookies.txt to the server root or set YTDLP_COOKIES_PATH.");

  if (YTDLP_VERBOSE) args.push("-vU");

  args.push(
    "--no-playlist",
    "--force-ipv4",
    "--sleep-requests",
    "8",
    "--sleep-interval",
    "8",
    "--max-sleep-interval",
    "20",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--js-runtimes",
    YTDLP_JS_RUNTIME,
    "--extractor-args",
    "youtube:player_client=android,web",
  );

  args.push("--cookies", cookiesPath);

  args.push(
    "-f",
    "bv*[height<=720]+ba/b[height<=720]/best[height<=720]",
    "--merge-output-format",
    "mp4",
    "--no-write-subs",
    "--no-write-auto-subs",
    "--no-write-thumbnail",
    "-o",
    outputPath,
    videoUrl,
  );
  return args;
}

function prepareWritableCookiesFile(job, options = {}) {
  const originalCookiesPath = resolveCookiesPath(YTDLP_COOKIES_PATH);
  const tempCookiesPath = path.join(os.tmpdir(), "cookies.txt");
  const originalExists = Boolean(YTDLP_COOKIES_PATH && fs.existsSync(originalCookiesPath));

  logCookieStatus(job, `cookies source path: ${originalCookiesPath}`);
  logCookieStatus(job, `cookies temp path: ${tempCookiesPath}`);
  logCookieStatus(job, `cookies source exists: ${originalExists}`);

  if (!originalExists) {
    logCookieStatus(job, "cookies validation failed: source file not found.");
    if (options.required) throw new Error("Invalid or expired cookies. Export fresh cookies.txt from logged-in YouTube browser.");
    return null;
  }

  const originalValidation = validateCookiesFile(originalCookiesPath);
  if (!originalValidation.ok) {
    logCookieStatus(job, `cookies validation failed: ${originalValidation.reason}`);
    throw new Error("Invalid or expired cookies. Export fresh cookies.txt from logged-in YouTube browser.");
  }
  logCookieStatus(job, `cookies validation passed: ${originalValidation.foundNames.join(", ")}`);

  fs.copyFileSync(originalCookiesPath, tempCookiesPath);
  const tempExists = fs.existsSync(tempCookiesPath);
  logCookieStatus(job, `cookies temp exists: ${tempExists}`);
  const tempValidation = tempExists ? validateCookiesFile(tempCookiesPath) : { ok: false, reason: "temp file not created" };
  if (!tempValidation.ok) {
    logCookieStatus(job, `cookies temp validation failed: ${tempValidation.reason}`);
    throw new Error("Invalid or expired cookies. Export fresh cookies.txt from logged-in YouTube browser.");
  }
  logCookieStatus(job, `cookies temp validation passed: ${tempValidation.foundNames.join(", ")}`);
  return tempExists ? tempCookiesPath : null;
}

function resolveCookiesPath(value) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(__dirname, value);
}

function validateCookiesFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return { ok: false, reason: "path is not a file", foundNames: [] };
    if (stats.size <= 0) return { ok: false, reason: "file is empty", foundNames: [] };

    const content = fs.readFileSync(filePath, "utf8");
    if (!/youtube\.com/i.test(content)) return { ok: false, reason: "no youtube.com cookies found", foundNames: [] };

    const foundNames = YOUTUBE_COOKIE_NAMES.filter((name) => new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s|$)`, "m").test(content));
    const hasAuthCookie = foundNames.some((name) => name !== "VISITOR_INFO1_LIVE");
    if (!hasAuthCookie) {
      return { ok: false, reason: `missing login cookies. Found: ${foundNames.join(", ") || "none"}`, foundNames };
    }

    return { ok: true, reason: "ok", foundNames };
  } catch (error) {
    return { ok: false, reason: error.message, foundNames: [] };
  }
}

function logCookieStatus(job, message) {
  console.log(`yt-dlp ${message}`);
  if (job) logJob(job, message);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function logYtDlpCookieError(job, error) {
  if (!job) return;
  const text = String(error?.message || error || "");
  if (isYtDlpCookieError(text)) {
    logJob(job, `exact yt-dlp cookie error: ${text.slice(-1000)}`);
  }
}

function friendlyPipelineError(error) {
  const message = friendlyYtDlpError(error);
  return message || error.message || "Pipeline failed.";
}

function friendlyYtDlpError(error) {
  const text = String(error?.message || error || "");
  if (/Invalid or expired cookies/i.test(text)) {
    return "Invalid or expired cookies. Export fresh cookies.txt from logged-in YouTube browser.";
  }
  if (isYtDlpCookieError(text)) {
    return "YouTube cookies expired or invalid. Export fresh cookies.txt and update Render Secret File.";
  }
  return text;
}

function isYtDlpCookieError(text) {
  return /Sign in to confirm|not a bot|HTTP Error 429|Too Many Requests|login|cookies/i.test(String(text || ""));
}

async function requireTool(name) {
  try {
    await runTool(name, TOOL_VERSION_ARGS[name] || ["--version"], { maxOutput: 2000 });
  } catch (error) {
    const configured = TOOL_COMMANDS[name] || name;
    throw new Error(
      `Missing required tool: ${name}. Expected command "${configured}". On Render, deploy with Docker and clear the build cache. Details: ${error.message}`,
    );
  }
}

function runTool(name, args, options = {}) {
  return runCommand(TOOL_COMMANDS[name] || name, args, options);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(`${command} timed out after ${Math.round(options.timeoutMs / 1000)} seconds`));
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (options.maxOutput && output.length > options.maxOutput) output = output.slice(0, options.maxOutput);
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      if (options.maxOutput && output.length > options.maxOutput) output = output.slice(0, options.maxOutput);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0) return resolve(output);
      reject(new Error(`${command} failed with code ${code}: ${output.slice(-1200)}`));
    });
  });
}

async function logToolStatus() {
  for (const name of ["ffmpeg", "ffprobe", "yt-dlp"]) {
    try {
      const output = await runTool(name, TOOL_VERSION_ARGS[name] || ["--version"], { maxOutput: 300 });
      console.log(`${name} ready: ${output.split(/\r?\n/)[0]}`);
    } catch (error) {
      console.warn(`${name} not ready: ${error.message}`);
    }
  }
}

async function uploadToYouTube(userId, videoPath, thumbnailPath, metadata, job) {
  const token = await getFreshGoogleToken(userId);
  const stats = fs.statSync(videoPath);
  const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS || "public";

  setJobProgress(job, "Uploading to YouTube", 72, "Preparing upload.");
  const initResponse = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json; charset=utf-8",
      "x-upload-content-length": String(stats.size),
      "x-upload-content-type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: {
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        categoryId: "24",
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    }),
  });

  if (!initResponse.ok) {
    throw new Error(`YouTube upload init failed: ${await initResponse.text()}`);
  }

  const uploadUrl = initResponse.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL.");

  setJobProgress(job, "Uploading to YouTube", 74, "Upload started.");
  const uploaded = await uploadVideoInChunks(uploadUrl, videoPath, stats.size, job);
  if (!uploaded.id) throw new Error(`YouTube upload completed but did not return a video id: ${JSON.stringify(uploaded).slice(0, 500)}`);
  setJobProgress(job, "Uploading to YouTube", 97, "Upload completed, setting thumbnail.");
  await uploadThumbnail(token.access_token, uploaded.id, thumbnailPath);
  return uploaded.id;
}

async function uploadVideoInChunks(uploadUrl, videoPath, totalBytes, job) {
  let start = 0;
  let lastProgress = 0;

  while (start < totalBytes) {
    const end = Math.min(start + UPLOAD_CHUNK_SIZE - 1, totalBytes - 1);
    const chunkSize = end - start + 1;
    const response = await putUploadChunkWithRetry(uploadUrl, videoPath, start, end, totalBytes, chunkSize);

    if (response.statusCode === 308) {
      start = parseUploadedRange(response.headers.range, end) + 1;
      const uploadPercent = Math.floor((start / totalBytes) * 100);
      if (uploadPercent >= lastProgress + 5 || uploadPercent === 100) {
        lastProgress = uploadPercent;
        setJobProgress(job, "Uploading to YouTube", 74 + Math.min(22, Math.floor(uploadPercent * 0.22)), `Upload progress ${uploadPercent}%.`);
      }
      continue;
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      setJobProgress(job, "Uploading to YouTube", 96, "Upload progress 100%.");
      return JSON.parse(response.body || "{}");
    }

    throw new Error(`YouTube upload failed with ${response.statusCode}: ${response.body}`);
  }

  throw new Error("YouTube upload ended before returning a video id.");
}

async function putUploadChunkWithRetry(uploadUrl, videoPath, start, end, totalBytes, chunkSize) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await putUploadChunk(uploadUrl, videoPath, start, end, totalBytes, chunkSize);
      if (response.statusCode >= 500 || response.statusCode === 429) {
        throw new Error(`retryable upload response ${response.statusCode}: ${response.body}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === 5) break;
      await delay(1000 * attempt);
    }
  }
  throw lastError;
}

function putUploadChunk(uploadUrl, videoPath, start, end, totalBytes, chunkSize) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(uploadUrl);
    const request = https.request(
      {
        method: "PUT",
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          "content-length": String(chunkSize),
          "content-type": "video/mp4",
          "content-range": `bytes ${start}-${end}/${totalBytes}`,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body }));
      },
    );

    request.setTimeout(UPLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`YouTube upload chunk timed out after ${Math.round(UPLOAD_TIMEOUT_MS / 1000)} seconds`));
    });
    request.on("error", reject);
    fs.createReadStream(videoPath, { start, end }).pipe(request);
  });
}

function parseUploadedRange(rangeHeader, fallbackEnd) {
  const match = String(rangeHeader || "").match(/bytes=0-(\d+)/);
  return match ? Number(match[1]) : fallbackEnd;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadThumbnail(accessToken, videoId, thumbnailPath) {
  if (!fs.existsSync(thumbnailPath)) return;
  const body = fs.readFileSync(thumbnailPath);
  const response = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "image/jpeg",
      "content-length": String(body.length),
    },
    body,
  });

  if (!response.ok) {
    console.warn(`Thumbnail upload failed: ${await response.text()}`);
  }
}

async function getFreshGoogleToken(userId) {
  const token = store.tokens[userId];
  if (!token) throw new Error("Google token not found. Sign in again.");

  if (token.expiry_date && token.expiry_date > Date.now() + 60 * 1000) return token;
  if (!token.refresh_token) throw new Error("Missing refresh token. Sign out and sign in again with consent.");

  requireConfig(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  const refreshed = await postForm("https://oauth2.googleapis.com/token", {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token",
  });

  const merged = { ...token, ...normalizeToken({ ...refreshed, refresh_token: token.refresh_token }) };
  store.tokens[userId] = merged;
  saveStore();
  return merged;
}

async function postForm(url, values) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = {};

  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(json).slice(0, 1200)}`);
  }

  return json;
}
