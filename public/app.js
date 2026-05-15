const authView = document.querySelector("#authView");
const appView = document.querySelector("#appView");
const jobForm = document.querySelector("#jobForm");
const jobsList = document.querySelector("#jobsList");
const formMessage = document.querySelector("#formMessage");
const refreshButton = document.querySelector("#refreshButton");
const logoutButton = document.querySelector("#logoutButton");
const userName = document.querySelector("#userName");
const avatar = document.querySelector("#avatar");
const totalJobs = document.querySelector("#totalJobs");
const runningJobs = document.querySelector("#runningJobs");
const uploadedJobs = document.querySelector("#uploadedJobs");

let jobsPoll = null;
let progressTicker = null;
let latestJobs = [];
const animatedProgress = new Map();

boot();

async function boot() {
  try {
    const me = await api("/api/me");
    showApp(me.user);
    await loadJobs();
    jobsPoll = setInterval(loadJobs, 10000);
  } catch {
    showAuth();
  }
}

function showAuth() {
  authView.classList.remove("hidden");
  appView.classList.add("hidden");
  if (jobsPoll) clearInterval(jobsPoll);
  if (progressTicker) clearInterval(progressTicker);
}

function showApp(user) {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  userName.textContent = user.name || user.email || "Creator";
  if (user.picture) {
    avatar.src = user.picture;
  } else {
    avatar.removeAttribute("src");
  }
}

jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setFormMessage("Creating automation...", "loading");

  const body = {
    videoUrl: jobForm.videoUrl.value,
    dailyAt: jobForm.dailyAt.value,
  };

  try {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    jobForm.videoUrl.value = "";
    setFormMessage("Automation created. The server will post once daily.", "success");
    await loadJobs();
  } catch (error) {
    setFormMessage(error.message, "error");
  }
});

refreshButton.addEventListener("click", loadJobs);

logoutButton.addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  showAuth();
});

async function loadJobs() {
  const data = await api("/api/jobs");
  latestJobs = data.jobs || [];
  syncAnimatedProgress(latestJobs);
  renderJobs(data.jobs || []);
  startProgressTicker();
}

function renderJobs(jobs) {
  updateStats(jobs);

  if (!jobs.length) {
    jobsList.innerHTML = '<div class="empty-state">No automations yet. Paste a video URL above to create the first one.</div>';
    return;
  }

  jobsList.innerHTML = jobs.map(renderJob).join("");
  for (const button of jobsList.querySelectorAll("[data-run-id]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Starting...";
      await api(`/api/jobs/${button.dataset.runId}/run`, { method: "POST" });
      await loadJobs();
    });
  }
}

function startProgressTicker() {
  if (progressTicker) return;
  progressTicker = setInterval(() => {
    if (!latestJobs.some((job) => job.status === "running")) return;
    advanceRunningProgress(latestJobs);
    updateVisibleProgress();
  }, 1000);
}

function syncAnimatedProgress(jobs) {
  const activeIds = new Set(jobs.map((job) => job.id));

  for (const id of animatedProgress.keys()) {
    if (!activeIds.has(id)) animatedProgress.delete(id);
  }

  for (const job of jobs) {
    const progress = getProgress(job);
    const current = animatedProgress.get(job.id);

    if (!current || job.status !== "running") {
      animatedProgress.set(job.id, progress.percent);
      continue;
    }

    animatedProgress.set(job.id, Math.max(current, progress.percent));
  }
}

function advanceRunningProgress(jobs) {
  for (const job of jobs) {
    if (job.status !== "running") continue;

    const stage = getProgress(job);
    const current = animatedProgress.get(job.id) ?? stage.percent;
    const cap = getProgressCap(stage.percent);
    const next = Math.min(cap, current + getProgressStep(stage.percent));
    animatedProgress.set(job.id, Number(next.toFixed(1)));
  }
}

function updateVisibleProgress() {
  for (const job of latestJobs) {
    const card = jobsList.querySelector(`[data-job-id="${cssEscape(job.id)}"]`);
    if (!card) continue;

    const progress = getDisplayProgress(job);
    const text = card.querySelector("[data-progress-text]");
    const fill = card.querySelector("[data-progress-fill]");

    if (text) text.textContent = `${formatPercent(progress.percent)} complete`;
    if (fill) fill.style.width = `${progress.percent}%`;
  }
}

function updateStats(jobs) {
  if (totalJobs) totalJobs.textContent = jobs.length;
  if (runningJobs) runningJobs.textContent = jobs.filter((job) => job.status === "running").length;
  if (uploadedJobs) uploadedJobs.textContent = jobs.filter((job) => job.lastUploadId).length;
}

function renderJob(job) {
  const logs = (job.logs || []).slice(0, 5).map((log) => `<li>${escapeHtml(log)}</li>`).join("");
  const progress = getDisplayProgress(job);
  const latestLog = (job.logs || [])[0] || "Waiting for the next scheduled run.";
  const upload = job.lastUploadId
    ? `<a class="upload-link" href="https://youtube.com/watch?v=${encodeURIComponent(job.lastUploadId)}" target="_blank" rel="noreferrer">View uploaded video</a>`
    : '<span class="pending-upload">No upload yet</span>';

  return `
    <article class="job-card" data-job-id="${escapeHtml(job.id)}">
      <div class="job-card-header">
        <div>
          <strong>Daily at ${escapeHtml(job.dailyAt)}</strong>
          <p class="job-url">${escapeHtml(job.videoUrl)}</p>
        </div>
        <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
      </div>
      <div class="progress-panel" aria-label="Job progress">
        <div class="progress-copy">
          <strong data-progress-text>${formatPercent(progress.percent)} complete</strong>
          <span>${escapeHtml(progress.label)}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${escapeHtml(job.status)}" data-progress-fill style="width: ${progress.percent}%"></div>
        </div>
        <p class="latest-log">${escapeHtml(latestLog)}</p>
      </div>
      <div class="job-meta">
        <span>Next run: ${formatDate(job.nextRunAt)}</span>
        <span>Last run: ${job.lastRunAt ? formatDate(job.lastRunAt) : "Never"}</span>
        <span>${upload}</span>
      </div>
      <div class="job-actions">
        <button class="ghost-button" type="button" data-run-id="${escapeHtml(job.id)}">Run now</button>
      </div>
      <ul class="log-list">${logs || "<li>No logs yet.</li>"}</ul>
    </article>
  `;
}

function getProgress(job) {
  const logs = (job.logs || []).join(" ").toLowerCase();

  if (job.status === "failed") {
    return { percent: 100, label: "Needs attention" };
  }

  if (job.lastUploadId || logs.includes("upload complete")) {
    return { percent: 100, label: "Uploaded to YouTube" };
  }

  if (job.status === "running") {
    if (logs.includes("uploading")) return { percent: 82, label: "Uploading video" };
    if (logs.includes("preparing") || logs.includes("vertical short") || logs.includes("thumbnail")) {
      return { percent: 58, label: "Rendering short" };
    }
    if (logs.includes("metadata")) return { percent: 32, label: "Generating title, tags, and thumbnail text" };
    return { percent: 18, label: "Starting automation" };
  }

  return { percent: 0, label: "Scheduled" };
}

function getDisplayProgress(job) {
  const progress = getProgress(job);
  if (job.status !== "running") return progress;

  const animated = animatedProgress.get(job.id) ?? progress.percent;
  return { ...progress, percent: Number(Math.max(progress.percent, animated).toFixed(1)) };
}

function getProgressCap(stagePercent) {
  if (stagePercent >= 82) return 98.7;
  if (stagePercent >= 58) return 81.9;
  if (stagePercent >= 32) return 57.9;
  return 31.9;
}

function getProgressStep(stagePercent) {
  if (stagePercent >= 82) return 0.7;
  if (stagePercent >= 58) return 1.1;
  if (stagePercent >= 32) return 1.2;
  return 1.1;
}

function formatPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "0.0%";
  return `${percent.toFixed(1)}%`;
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function setFormMessage(message, type) {
  formMessage.textContent = message;
  formMessage.className = `form-message ${type || ""}`.trim();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
