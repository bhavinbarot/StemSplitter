/* admin-jobs.js — jobs list and log viewer */

let activeJobId = null;

async function loadJobs() {
  const list = document.getElementById("job-list");
  try {
    const r = await fetch(`${API}/jobs`);
    const jobs = await r.json();
    if (!jobs.length) {
      list.innerHTML = '<p style="color:var(--subtle);font-size:13px">No jobs found.</p>';
      return;
    }
    list.innerHTML = jobs.map(j => {
      const badge = `badge-${j.status || "unknown"}`;
      const name = j.project_name || j.job_id.slice(0, 16);
      const time = j.updated_at ? j.updated_at.replace("T", " ") : "";
      return `<div>
        <div class="job-row" onclick="viewLog('${j.job_id}', this)">
          <span class="job-status-badge ${badge}">${j.status}</span>
          <span class="job-name" title="${j.job_id}">${name}</span>
          <span class="job-time">${time}</span>
          <span style="font-size:11px;color:var(--subtle);flex-shrink:0">▼</span>
        </div>
        <div id="log-${j.job_id}" class="log-viewer">
          <div id="log-content-${j.job_id}" class="log-content"></div>
          <div class="log-footer">
            <button class="log-refresh-btn" onclick="refreshLog('${j.job_id}')">↻ Refresh</button>
          </div>
        </div>
      </div>`;
    }).join("");
    activeJobId = null;
  } catch(e) { toast("Failed to load jobs", true); }
}

async function viewLog(jobId, row) {
  const viewer = document.getElementById(`log-${jobId}`);
  if (!viewer) return;
  if (activeJobId === jobId && viewer.classList.contains("open")) {
    viewer.classList.remove("open");
    activeJobId = null;
    return;
  }
  if (activeJobId) {
    const prev = document.getElementById(`log-${activeJobId}`);
    if (prev) prev.classList.remove("open");
  }
  activeJobId = jobId;
  viewer.classList.add("open");
  const content = document.getElementById(`log-content-${jobId}`);
  if (content) content.textContent = "Loading...";
  row.scrollIntoView({ behavior: "smooth", block: "start" });
  await refreshLog(jobId);
}

async function refreshLog(jobId) {
  const content = document.getElementById(`log-content-${jobId}`);
  if (!content) return;
  try {
    const r = await fetch(`${API}/jobs/${jobId}/log`);
    const d = await r.json();
    content.textContent = d.log || "(empty)";
    content.scrollTop = content.scrollHeight;
  } catch(e) { content.textContent = "Failed to load log."; }
}
