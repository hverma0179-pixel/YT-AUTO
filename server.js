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
const STORE_PATH = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 1024 * 1024;
const SHORT_START = process.env.SHORT_START || "00:01:00";
const SHORT_DURATION = Number(process.env.SHORT_DURATION || 45);
const SHORT_WIDTH = Number(process.env.SHORT_WIDTH || 720);
const SHORT_HEIGHT = Number(process.env.SHORT_HEIGHT || 1280);
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 10 * 60 * 1000);
const UPLOAD_CHUNK_SIZE = Number(process.env.UPLOAD_CHUNK_SIZE || 8 * 1024 * 1024);
const UPLOAD_TIMEOUT_MS = Number(process.env.UPLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_SOURCE_DURATION_SECONDS = Number(process.env.MAX_SOURCE_DURATION_SECONDS || 2 * 60 * 60);
const TOOL_COMMANDS = {
  ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH || "ffprobe",
  "yt-dlp": process.env.YTDLP_PATH || "yt-dlp",
};
const YTDLP_JS_RUNTIME = process.env.YTDLP_JS_RUNTIME || "node:/usr/local/bin/node";
const YTDLP_COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || "./cookies.txt";
const YTDLP_VERBOSE = String(process.env.YTDLP_VERBOSE || "").toLowerCase() === "true";
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
  if (options.secure) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

function getSession(req) {
  const sid = getCookies(req).sid;
  if (!sid || !store.sessions[sid]) return null;
  return store.sessions[sid];
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
  store.users[user.id] = user;
  store.sessions[sid] = { user, createdAt: new Date().toISOString() };
  store.tokens[user.id] = normalizeToken(token);
  saveStore();

  setCookie(res, "sid", sid);
  redirect(res, "/");
}

function logout(req, res) {
  const sid = getCookies(req).sid;
  if (sid) delete store.sessions[sid];
  saveStore();
  setCookie(res, "sid", "", { maxAge: 0 });
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

  let assets;

  try {
    assets = await prepareVideoAssets(job);

    setJobProgress(job, "Generating metadata", 70, "Generating AI metadata.");
    const metadata = await generateMetadata(job.videoUrl);

    const uploadId = await uploadToYouTube(job.userId, assets.videoPath, assets.thumbnailPath, metadata, job);

    job.status = "scheduled";
    job.stage = "Completed";
    job.progress = 100;
    job.error = null;
    job.lastRunAt = new Date().toISOString();
    job.lastUploadId = uploadId;
    job.nextRunAt = nextDailyRun(job.dailyAt).toISOString();
    job.updatedAt = new Date().toISOString();
    logJob(job, `Upload complete: https://youtube.com/watch?v=${uploadId}`);
    saveStore();
  } finally {
    if (assets?.jobDir) cleanupJobFiles(assets.jobDir);
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

async function generateMetadata(videoUrl) {
  if (!process.env.OPENROUTER_API_KEY) {
    return fallbackMetadata(videoUrl);
  }

  const prompt = [
    "Create YouTube Shorts metadata for a vertical clip made from this long video URL.",
    "Return only valid JSON with keys: title, description, tags, thumbnailText.",
    "Rules: title max 90 characters, tags is 8-15 short strings, description includes a short rights-safe note.",
    `URL: ${videoUrl}`,
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
      temperature: 0.7,
    }),
  });

  const content = response.choices?.[0]?.message?.content || "";
  const parsed = parseJsonFromText(content);
  return {
    title: clampText(parsed.title || "New short from a long video", 90),
    description: parsed.description || "Auto-generated short. Posted by the channel owner or with permission.",
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 15).map(String) : fallbackMetadata(videoUrl).tags,
    thumbnailText: clampText(parsed.thumbnailText || "Watch This", 40),
  };
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

function fallbackMetadata(videoUrl) {
  return {
    title: "Best moment from this video",
    description: `Auto-generated short from ${videoUrl}\n\nPosted by the channel owner or with permission.`,
    tags: ["shorts", "viral", "trending", "highlights", "youtube shorts", "creator", "clip", "video"],
    thumbnailText: "Best Moment",
  };
}

function clampText(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trim() : text;
}

async function prepareVideoAssets(job) {
  await requireTool("ffmpeg");
  await requireTool("ffprobe");

  const jobDir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  const rawPath = path.join(jobDir, "source.mp4");
  const clipPath = path.join(jobDir, `clip-${Date.now()}.mp4`);
  const videoPath = path.join(jobDir, `short-${Date.now()}.mp4`);
  const thumbnailPath = path.join(jobDir, `thumbnail-${Date.now()}.jpg`);
  const sourceInput = isDirectVideoUrl(job.videoUrl) ? job.videoUrl : rawPath;

  try {
    if (isYouTubeUrl(job.videoUrl)) {
      await requireTool("yt-dlp");
      setJobProgress(job, "Downloading video", 10, "Downloading video source at Shorts-friendly quality.");
      await runYtDlp(job.videoUrl, rawPath);
    }

    const duration = await getVideoDuration(sourceInput);
    if (duration && duration > MAX_SOURCE_DURATION_SECONDS) {
      logJob(job, `Warning: source video is ${Math.round(duration / 60)} minutes long, over the 2 hour guard.`);
    }

    setJobProgress(job, "Cutting short clip", 38, `Cutting ${SHORT_DURATION}s clip from ${SHORT_START}.`);
    await runTool("ffmpeg", [
      "-y",
      "-ss",
      SHORT_START,
      "-i",
      sourceInput,
      "-t",
      String(SHORT_DURATION),
      "-c",
      "copy",
      clipPath,
    ], { timeoutMs: RENDER_TIMEOUT_MS });

    setJobProgress(job, "Rendering vertical short", 52, `Rendering ${SHORT_WIDTH}x${SHORT_HEIGHT} vertical short with ultrafast preset.`);
    await runTool("ffmpeg", [
      "-y",
      "-i",
      clipPath,
      "-vf",
      `scale=${SHORT_WIDTH}:${SHORT_HEIGHT}:force_original_aspect_ratio=increase,crop=${SHORT_WIDTH}:${SHORT_HEIGHT}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      videoPath,
    ], { timeoutMs: RENDER_TIMEOUT_MS });

    setJobProgress(job, "Rendering vertical short", 65, "Creating thumbnail from final short.");
    await runTool("ffmpeg", ["-y", "-ss", "00:00:03", "-i", videoPath, "-frames:v", "1", thumbnailPath], { timeoutMs: RENDER_TIMEOUT_MS });
    return { jobDir, videoPath, thumbnailPath };
  } catch (error) {
    cleanupJobFiles(jobDir);
    throw error;
  }
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

function runYtDlp(videoUrl, outputPath) {
  const args = buildYtDlpArgs(videoUrl, outputPath);
  return runTool("yt-dlp", args).catch((error) => {
    throw new Error(friendlyYtDlpError(error));
  });
}

function buildYtDlpArgs(videoUrl, outputPath) {
  const args = [];
  const cookiesPath = prepareWritableCookiesFile();

  if (!cookiesPath) throw new Error("cookies.txt not found. Upload cookies.txt to the server root or set YTDLP_COOKIES_PATH.");

  if (YTDLP_VERBOSE) args.push("-vU");

  args.push(
    "--no-playlist",
    "--force-ipv4",
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

function prepareWritableCookiesFile() {
  const originalCookiesPath = path.resolve(__dirname, YTDLP_COOKIES_PATH);
  const tempCookiesPath = path.join(os.tmpdir(), "cookies.txt");
  const originalExists = Boolean(YTDLP_COOKIES_PATH && fs.existsSync(originalCookiesPath));

  console.log(`yt-dlp cookies original path: ${originalCookiesPath}`);
  console.log(`yt-dlp cookies temp path: ${tempCookiesPath}`);
  console.log(`yt-dlp cookies original exists: ${originalExists}`);

  if (!originalExists) {
    console.log("yt-dlp cookies temp exists: false");
    return null;
  }

  fs.copyFileSync(originalCookiesPath, tempCookiesPath);
  const tempExists = fs.existsSync(tempCookiesPath);
  console.log(`yt-dlp cookies temp exists: ${tempExists}`);
  return tempExists ? tempCookiesPath : null;
}

function friendlyPipelineError(error) {
  const message = friendlyYtDlpError(error);
  return message || error.message || "Pipeline failed.";
}

function friendlyYtDlpError(error) {
  const text = String(error?.message || error || "");
  if (/429|Too Many Requests/i.test(text)) {
    return "YouTube rate limited this server/IP. Try later or use cookies.";
  }
  if (/Sign in to confirm you.?re not a bot/i.test(text)) {
    return "YouTube requires browser cookies. Add cookies.txt.";
  }
  return text;
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
