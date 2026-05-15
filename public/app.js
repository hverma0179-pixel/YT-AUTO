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
const failedJobs = document.querySelector("#failedJobs");
const recentUploadsBody = document.querySelector("#recentUploadsBody");
const logsList = document.querySelector("#logsList");
const searchInput = document.querySelector("#searchInput");
const toastStack = document.querySelector("#toastStack");
const pasteUrlButton = document.querySelector("#pasteUrlButton");
const uploadVideoButton = document.querySelector("#uploadVideoButton");
const syncButton = document.querySelector("#syncButton");
const quickGenerateButton = document.querySelector("#quickGenerateButton");
const quickUploadButton = document.querySelector("#quickUploadButton");
const quickSyncButton = document.querySelector("#quickSyncButton");
const viewLogsButton = document.querySelector("#viewLogsButton");
const serverStatusText = document.querySelector("#serverStatusText");
const serverStatusValue = document.querySelector("#serverStatusValue");
const youtubeStatusValue = document.querySelector("#youtubeStatusValue");
const aiStatusValue = document.querySelector("#aiStatusValue");
const uploadStatusValue = document.querySelector("#uploadStatusValue");

let jobsPoll = null;
let progressTicker = null;
let latestJobs = [];
let currentSearch = "";
const animatedProgress = new Map();

boot();

async function boot() {
  try {
    const me = await api("/api/me");
    showApp(me.user);
    await loadJobs({ silent: true });
    jobsPoll = setInterval(() => loadJobs({ silent: true }), 3000);
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
  youtubeStatusValue.textContent = "Connected";
}

jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await createAutomation(event.submitter || document.querySelector("#generateButton"));
});

refreshButton.addEventListener("click", () => loadJobs());
syncButton.addEventListener("click", () => loadJobs());
quickSyncButton.addEventListener("click", () => loadJobs());
quickGenerateButton.addEventListener("click", () => jobForm.requestSubmit());
uploadVideoButton.addEventListener("click", focusVideoInput);
quickUploadButton.addEventListener("click", focusVideoInput);
viewLogsButton.addEventListener("click", () => scrollToSection("logsSection"));

pasteUrlButton.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) throw new Error("Clipboard is empty.");
    jobForm.videoUrl.value = text.trim();
    setFormMessage("URL pasted. Choose time and generate Shorts.", "success");
    showToast("URL pasted into the creator form.", "success");
  } catch (error) {
    setFormMessage("Paste permission was blocked. Paste the URL manually.", "error");
    showToast(error.message || "Paste failed.", "error");
  }
});

logoutButton.addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  showAuth();
});

searchInput.addEventListener("input", () => {
  currentSearch = searchInput.value.trim().toLowerCase();
  renderDashboard();
});

for (const button of document.querySelectorAll("[data-scroll-target]")) {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
    scrollToSection(button.dataset.scrollTarget);
  });
}

async function createAutomation(button) {
  setFormMessage("Creating automation...", "loading");
  setButtonLoading(button, true, "Working...");

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
    setFormMessage("Automation created. The queue will update automatically.", "success");
    showToast("Automation created successfully.", "success");
    await loadJobs({ silent: true });
    scrollToSection("automationSection");
  } catch (error) {
    setFormMessage(error.message, "error");
    showToast(error.message, "error");
  } finally {
    setButtonLoading(button, false);
  }
}

async function loadJobs(options = {}) {
  setButtonLoading(refreshButton, true, "Syncing...");

  try {
    const data = await api("/api/jobs");
    latestJobs = data.jobs || [];
    syncAnimatedProgress(latestJobs);
    renderDashboard();
    startProgressTicker();
    setSystemStatus("Online", "Ready");
    if (!options.silent) showToast("Dashboard synced.", "success");
  } catch (error) {
    setSystemStatus("Issue", "Check logs");
    showToast(error.message || "Could not refresh jobs.", "error");
  } finally {
    setButtonLoading(refreshButton, false);
  }
}

function renderDashboard() {
  const jobs = getFilteredJobs();
  updateStats(latestJobs);
  renderJobs(jobs);
  renderUploads(jobs);
  renderLogs(jobs);
  updateSystemCards(latestJobs);
}

function getFilteredJobs() {
  if (!currentSearch) return latestJobs;
  return latestJobs.filter((job) => {
    const text = [job.videoUrl, job.status, job.dailyAt, ...(job.logs || [])].join(" ").toLowerCase();
    return text.includes(currentSearch);
  });
}

function renderJobs(jobs) {
  if (!jobs.length) {
    jobsList.innerHTML = '<div class="empty-state">No matching automations. Paste a source URL above to create one.</div>';
    return;
  }

  jobsList.innerHTML = jobs.map(renderJob).join("");
  for (const button of jobsList.querySelectorAll("[data-run-id]")) {
    button.addEventListener("click", async () => {
      setButtonLoading(button, true, "Starting...");
      try {
        await api(`/api/jobs/${button.dataset.runId}/run`, { method: "POST" });
        showToast("Manual run started.", "success");
        await loadJobs({ silent: true });
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });
  }
}

function renderJob(job) {
  const progress = getDisplayProgress(job);
  const stage = getStage(job);
  const latestLog = (job.logs || [])[0] || "Waiting for the next scheduled run.";
  const upload = job.lastUploadId
    ? `<a class="upload-link" href="https://youtube.com/watch?v=${encodeURIComponent(job.lastUploadId)}" target="_blank" rel="noreferrer">View uploaded video</a>`
    : '<span class="pending-upload">No upload yet</span>';
  const logs = (job.logs || []).slice(0, 3).map((log) => `<li>${escapeHtml(log)}</li>`).join("");

  return `
    <article class="job-card" data-job-id="${escapeHtml(job.id)}">
      <div class="job-card-header">
        <div>
          <strong>Daily at ${escapeHtml(job.dailyAt)}</strong>
          <p class="job-url">${escapeHtml(job.videoUrl)}</p>
        </div>
        <span class="status-pill ${escapeHtml(getStatusClass(job))}">${escapeHtml(stage.statusText)}</span>
      </div>
      <div class="progress-panel" aria-label="Job progress">
        <div class="progress-copy">
          <strong data-progress-text>${formatPercent(progress.percent)} complete</strong>
          <span data-stage-text>${escapeHtml(stage.label)}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${escapeHtml(job.status)}" data-progress-fill style="width: ${progress.percent}%"></div>
        </div>
        <p class="latest-log">${escapeHtml(latestLog)}</p>
      </div>
      <div class="job-meta">
        <span>Next: ${formatDate(job.nextRunAt)}</span>
        <span>Last: ${job.lastRunAt ? formatDate(job.lastRunAt) : "Never"}</span>
        <span>${upload}</span>
      </div>
      <div class="job-actions">
        <button class="soft-button" type="button" data-run-id="${escapeHtml(job.id)}">Run now</button>
      </div>
      <ul class="log-list">${logs || "<li>No logs yet.</li>"}</ul>
    </article>
  `;
}

function renderUploads(jobs) {
  if (!recentUploadsBody) return;

  if (!jobs.length) {
    recentUploadsBody.innerHTML = '<tr><td colspan="5" class="table-empty">No recent videos yet.</td></tr>';
    return;
  }

  recentUploadsBody.innerHTML = jobs
    .slice(0, 8)
    .map((job) => {
      const progress = getDisplayProgress(job);
      const title = job.lastUploadId ? "Uploaded short" : "Automation clip";
      const statusClass = getStatusClass(job);
      const uploadedAt = job.lastRunAt ? formatDate(job.lastRunAt) : "Pending";

      return `
        <tr>
          <td><strong>${title}</strong><small>${escapeHtml(job.id.slice(0, 8))}</small></td>
          <td><span class="status-pill ${statusClass}">${getStage(job).statusText}</span></td>
          <td>
            <div class="mini-progress"><span style="width: ${progress.percent}%"></span></div>
            <small>${formatPercent(progress.percent)}</small>
          </td>
          <td>${uploadedAt}</td>
          <td><span class="source-url">${escapeHtml(job.videoUrl)}</span></td>
        </tr>
      `;
    })
    .join("");
}

function renderLogs(jobs) {
  const entries = jobs.flatMap((job) => (job.logs || []).map((log) => ({ job, log }))).slice(0, 12);

  if (!entries.length) {
    logsList.innerHTML = '<div class="empty-state">No logs yet. Run an automation to see activity here.</div>';
    return;
  }

  logsList.innerHTML = entries
    .map(({ job, log }) => {
      const level = getLogLevel(log, job.status);
      return `
        <div class="log-row ${level}">
          <span></span>
          <p>${escapeHtml(log)}</p>
        </div>
      `;
    })
    .join("");
}

function updateStats(jobs) {
  totalJobs.textContent = jobs.length;
  runningJobs.textContent = jobs.filter((job) => job.status === "running").length;
  uploadedJobs.textContent = jobs.filter((job) => job.lastUploadId).length;
  failedJobs.textContent = jobs.filter((job) => job.status === "failed").length;
}

function updateSystemCards(jobs) {
  const running = jobs.some((job) => job.status === "running");
  const failed = jobs.some((job) => job.status === "failed");
  aiStatusValue.textContent = running ? "Working" : "Ready";
  uploadStatusValue.textContent = failed ? "Needs check" : running ? "Processing" : "Idle";
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
    animatedProgress.set(job.id, !current || job.status !== "running" ? progress.percent : Math.max(current, progress.percent));
  }
}

function advanceRunningProgress(jobs) {
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const stage = getProgress(job);
    const current = animatedProgress.get(job.id) ?? stage.percent;
    const next = Math.min(getProgressCap(stage.percent), current + getProgressStep(stage.percent));
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

function getStage(job) {
  const logs = (job.logs || []).join(" ").toLowerCase();
  if (job.status === "failed") return { label: "Failed", statusText: "Failed" };
  if (job.lastUploadId || logs.includes("upload complete")) return { label: "Completed", statusText: "Published" };
  if (job.status === "running") {
    if (isLongRunning(job)) return { label: "Taking longer than 10 minutes - check server logs", statusText: "Processing" };
    if (logs.includes("uploading")) return { label: "Uploading to YouTube", statusText: "Processing" };
    if (logs.includes("cutting") || logs.includes("clip")) return { label: "Cutting short clip", statusText: "Processing" };
    if (logs.includes("rendering") || logs.includes("preparing") || logs.includes("vertical short") || logs.includes("thumbnail")) {
      return { label: "Rendering vertical short", statusText: "Processing" };
    }
    if (logs.includes("metadata")) return { label: "Generating AI metadata", statusText: "Processing" };
    if (logs.includes("download") || logs.includes("yt-dlp")) return { label: "Downloading video", statusText: "Processing" };
    return { label: "Starting", statusText: "Processing" };
  }
  return { label: "Scheduled", statusText: "Scheduled" };
}

function getProgress(job) {
  const stage = getStage(job).label;
  if (stage === "Failed") return { percent: 100, label: stage };
  if (stage === "Completed") return { percent: 100, label: stage };
  if (stage === "Uploading to YouTube") return { percent: 82, label: stage };
  if (stage === "Rendering vertical short") return { percent: 58, label: stage };
  if (stage === "Cutting short clip") return { percent: 46, label: stage };
  if (stage === "Generating AI metadata") return { percent: 32, label: stage };
  if (stage === "Downloading video") return { percent: 18, label: stage };
  if (stage === "Starting") return { percent: 8, label: stage };
  if (stage.includes("Taking longer")) return { percent: 98.7, label: stage };
  return { percent: 0, label: stage };
}

function isLongRunning(job) {
  if (job.status !== "running") return false;
  const newestLog = (job.logs || [])[0];
  if (!newestLog) return false;
  const timestamp = newestLog.split(" - ")[0];
  const logTime = new Date(timestamp).getTime();
  if (!Number.isFinite(logTime)) return false;
  return Date.now() - logTime > 10 * 60 * 1000;
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
  if (stagePercent >= 18) return 31.9;
  return 17.9;
}

function getProgressStep(stagePercent) {
  if (stagePercent >= 82) return 0.7;
  if (stagePercent >= 58) return 1.1;
  if (stagePercent >= 32) return 1.2;
  return 1.1;
}

function getStatusClass(job) {
  if (job.status === "failed") return "failed";
  if (job.lastUploadId) return "published";
  if (job.status === "running") return "processing";
  return "scheduled";
}

function getLogLevel(log, status) {
  if (status === "failed" || /error|failed|missing|not found/i.test(log)) return "error";
  if (/warning|rate|cookies|retry/i.test(log)) return "warning";
  if (/complete|created|upload/i.test(log)) return "success";
  return "info";
}

function setFormMessage(message, type) {
  formMessage.textContent = message;
  formMessage.className = `form-message ${type || ""}`.trim();
}

function setButtonLoading(button, isLoading, loadingText) {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText || "Working...";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    delete button.dataset.originalText;
  }
}

function focusVideoInput() {
  scrollToSection("dashboardSection");
  jobForm.videoUrl.focus();
  setFormMessage("Paste a YouTube URL or direct video file URL to upload through the existing automation.", "loading");
  showToast("Upload uses the existing URL automation flow.", "info");
}

function scrollToSection(id) {
  document.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setSystemStatus(chipText, cardText) {
  serverStatusText.textContent = chipText;
  serverStatusValue.textContent = cardText;
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastStack.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
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

function formatPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "0.0%";
  return `${percent.toFixed(1)}%`;
}

function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
