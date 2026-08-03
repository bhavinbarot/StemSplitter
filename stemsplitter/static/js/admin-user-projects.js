/* admin-user-projects.js — user project access modal */

let _modalUserId   = null;
let _modalAssigned = [];
let _modalAllJobs  = [];

async function openUserProjectsModal(userId, userName) {
  _modalUserId = userId;
  document.getElementById("modal-user-title").textContent = `Projects for ${userName}`;
  document.getElementById("modal-user-subtitle").textContent = "Loading…";
  document.getElementById("user-projects-modal").classList.remove("hidden");
  _showPanel("assigned");
  await Promise.all([_loadModalAssigned(), _loadAllJobs()]);
}

function closeUserProjectsModal() {
  document.getElementById("user-projects-modal").classList.add("hidden");
  _modalUserId = null;
  _modalAssigned = [];
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("user-projects-modal").addEventListener("click", function(e) {
    if (e.target === this) closeUserProjectsModal();
  });
});

function _showPanel(name) {
  document.getElementById("modal-assigned-panel").style.display = name === "assigned" ? "flex" : "none";
  document.getElementById("modal-add-panel").style.display      = name === "add"      ? "flex" : "none";
}

function openAddProjectsPanel() {
  _renderAddList("");
  document.getElementById("modal-add-search").value = "";
  _updateAddCount();
  _showPanel("add");
  setTimeout(() => document.getElementById("modal-add-search").focus(), 60);
}

function closeAddProjectsPanel() {
  _showPanel("assigned");
}

async function _loadModalAssigned() {
  if (!_modalUserId) return;
  const el = document.getElementById("modal-assigned-list");
  el.innerHTML = '<p style="color:var(--subtle);font-size:13px;padding:20px 0;">Loading…</p>';
  try {
    const r = await fetch(`${USERS_API}/${encodeURIComponent(_modalUserId)}/projects`);
    const d = await r.json();
    _modalAssigned = d.projects || [];
    document.getElementById("modal-user-subtitle").textContent =
      _modalAssigned.length ? `${_modalAssigned.length} project${_modalAssigned.length === 1 ? "" : "s"} directly assigned`
                            : "No projects directly assigned";
    _renderAssignedList("");
    const search = document.getElementById("modal-assign-search");
    if (search) search.value = "";
  } catch(e) {
    document.getElementById("modal-assigned-list").innerHTML = '<p style="color:var(--err);font-size:13px;">Failed to load.</p>';
  }
}

function _filterAssignedList(q) { _renderAssignedList(q); }

function _renderAssignedList(q) {
  const el = document.getElementById("modal-assigned-list");
  const lq = (q || "").toLowerCase();
  const filtered = lq ? _modalAssigned.filter(p => (p.name || p.job_id).toLowerCase().includes(lq)) : _modalAssigned;
  if (!filtered.length) {
    el.innerHTML = `<p style="color:var(--subtle);font-size:13px;padding:20px 0;text-align:center;">${lq ? "No matching projects." : "No projects directly assigned."}</p>`;
    return;
  }
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:2px solid var(--border);">
          <th style="text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--subtle);padding:6px 8px;">Project</th>
          <th style="text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--subtle);padding:6px 8px;width:90px;">Status</th>
          <th style="text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--subtle);padding:6px 8px;width:130px;">Granted</th>
          <th style="width:60px;"></th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(p => {
          const statusColor = p.status === "completed" ? "#22c55e" : p.status === "running" ? "#f59e0b" : "#94a3b8";
          return `<tr style="border-bottom:1px solid var(--border);" class="ap-row" data-jobid="${_esc(p.job_id)}">
            <td style="padding:10px 8px;">
              <div style="font-size:13px;font-weight:600;color:#0f172a;">${_esc(p.name || p.job_id)}</div>
              <div style="font-size:10px;color:var(--subtle);margin-top:1px;">${_esc(p.job_id)}</div>
            </td>
            <td style="padding:10px 8px;">
              <span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:${statusColor};font-weight:600;">
                <span style="width:7px;height:7px;border-radius:50%;background:${statusColor};flex-shrink:0;"></span>
                ${_esc(p.status || "—")}
              </span>
            </td>
            <td style="padding:10px 8px;font-size:11px;color:var(--subtle);">${_esc((p.granted_at || "").slice(0,10))}</td>
            <td style="padding:10px 8px;text-align:right;">
              <button onclick="revokeUserProject('${_esc(p.job_id)}')"
                style="background:none;border:1px solid #fca5a5;color:#ef4444;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-weight:600;"
                title="Remove access">Remove</button>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

async function _loadAllJobs() {
  if (_modalAllJobs.length) return;
  try {
    const r = await fetch(`${API}/jobs`);
    _modalAllJobs = (await r.json()) || [];
  } catch(e) { _modalAllJobs = []; }
}

function _filterAddList(q) { _renderAddList(q); _updateAddCount(); }

function _renderAddList(q) {
  const el = document.getElementById("modal-add-list");
  const lq = (q || "").toLowerCase();
  const assignedIds = new Set(_modalAssigned.map(p => p.job_id));
  const jobs = _modalAllJobs.filter(j => {
    const label = (j.project_name || j.job_id).toLowerCase();
    return !lq || label.includes(lq);
  });
  if (!jobs.length) {
    el.innerHTML = '<p style="color:var(--subtle);font-size:13px;padding:20px 0;text-align:center;">No projects found.</p>';
    return;
  }
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <tbody>
        ${jobs.map(j => {
          const name = j.project_name || j.job_id;
          const alreadyAssigned = assignedIds.has(j.job_id);
          const statusColor = j.status === "completed" ? "#22c55e" : j.status === "running" ? "#f59e0b" : "#94a3b8";
          return `<tr style="border-bottom:1px solid var(--border);${alreadyAssigned ? "opacity:.45;" : ""}">
            <td style="padding:8px;">
              <label style="display:flex;align-items:center;gap:10px;cursor:${alreadyAssigned ? "default" : "pointer"};">
                <input type="checkbox" class="add-proj-cb" value="${_esc(j.job_id)}"
                  ${alreadyAssigned ? "disabled checked" : ""}
                  onchange="_updateAddCount()"
                  style="width:15px;height:15px;accent-color:#0b5cff;flex-shrink:0;">
                <span style="flex:1;min-width:0;">
                  <span style="display:block;font-size:13px;font-weight:600;color:#0f172a;">${_esc(name)}</span>
                  <span style="display:block;font-size:10px;color:var(--subtle);">${_esc(j.job_id)}</span>
                </span>
                <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${statusColor};font-weight:600;white-space:nowrap;margin-right:4px;">
                  <span style="width:6px;height:6px;border-radius:50%;background:${statusColor};"></span>
                  ${alreadyAssigned ? "Already assigned" : _esc(j.status || "")}
                </span>
              </label>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

function _addSelectAll(check) {
  document.querySelectorAll(".add-proj-cb:not(:disabled)").forEach(cb => { cb.checked = check; });
  _updateAddCount();
}

function _updateAddCount() {
  const n = document.querySelectorAll(".add-proj-cb:not(:disabled):checked").length;
  const el = document.getElementById("modal-add-count");
  if (el) el.textContent = n === 0 ? "0 selected" : `${n} project${n === 1 ? "" : "s"} selected`;
}

async function grantUserProject() {
  if (!_modalUserId) return;
  const selected = Array.from(document.querySelectorAll(".add-proj-cb:not(:disabled):checked")).map(cb => cb.value);
  if (!selected.length) { toast("Select at least one project", true); return; }
  let ok = 0, fail = 0;
  for (const jobId of selected) {
    try {
      const r = await fetch(`${USERS_API}/${encodeURIComponent(_modalUserId)}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      const d = await r.json();
      d.ok ? ok++ : fail++;
    } catch(e) { fail++; }
  }
  if (ok)   toast(`${ok} project${ok > 1 ? "s" : ""} assigned`);
  if (fail) toast(`${fail} failed`, true);
  await _loadModalAssigned();
  _showPanel("assigned");
}

async function revokeUserProject(jobId) {
  if (!_modalUserId) return;
  try {
    const r = await fetch(`${USERS_API}/${encodeURIComponent(_modalUserId)}/projects/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    });
    const d = await r.json();
    if (d.ok) { toast("Project access revoked"); await _loadModalAssigned(); }
    else toast(d.error || "Failed", true);
  } catch(e) { toast("Request failed", true); }
}
