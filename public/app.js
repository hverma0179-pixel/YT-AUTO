const authView = document.querySelector("#authView");
const appView = document.querySelector("#appView");
const jobForm = document.querySelector("#jobForm");
const jobsList = document.querySelector("#jobsList");
const formMessage = document.querySelector("#formMessage");
const refreshButton = document.querySelector("#refreshButton");
const logoutButton = document.querySelector("#logoutButton");
const userName = document.querySelector("#userName");
const avatar = document.querySelector("#avatar");

let jobsPoll = null;

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
  formMessage.textContent = "Creating automation...";

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
    formMessage.textContent = "Automation created. The server will post once daily.";
    await loadJobs();
  } catch (error) {
    formMessage.textContent = error.message;
  }
});

refreshButton.addEventListener("click", loadJobs);

logoutButton.addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  showAuth();
});

async function loadJobs() {
  const data = await api("/api/jobs");
  renderJobs(data.jobs || []);
}

function renderJobs(jobs) {
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

function renderJob(job) {
  const logs = (job.logs || []).slice(0, 5).map((log) => `<li>${escapeHtml(log)}</li>`).join("");
  const upload = job.lastUploadId
    ? `<a href="https://youtube.com/watch?v=${encodeURIComponent(job.lastUploadId)}" target="_blank" rel="noreferrer">Last upload</a>`
    : "No upload yet";

  return `
    <article class="job-card">
      <div class="job-card-header">
        <div>
          <strong>Daily at ${escapeHtml(job.dailyAt)}</strong>
          <p class="job-url">${escapeHtml(job.videoUrl)}</p>
        </div>
        <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
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
