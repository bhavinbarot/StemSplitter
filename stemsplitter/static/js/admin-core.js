/* admin-core.js — shared utilities, tab switching */

let saveTimer = null;

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isError ? "show error" : "show";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { el.className = ""; }, 2800);
}

function _esc(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function _relativeTime(isoStr) {
  try {
    const diff = Date.now() - new Date(isoStr).getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "Just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    const wk = Math.floor(day / 7);
    if (wk < 5) return `${wk}w ago`;
    const d = new Date(isoStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch(e) { return "—"; }
}

// ── Tab switching ────────────────────────────────────────────
const TABS = ["dashboard", "settings", "global-settings", "playlists", "users", "project-access", "jobs"];
let _activeTab = "dashboard";

function switchTab(name) {
  if (!TABS.includes(name)) return;
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".tab-pane").forEach(p => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
  _activeTab = name;
  if (name === "users"           && !_usersLoaded)         { loadUsers(); loadGroups(); _usersLoaded = true; }
  if (name === "jobs"            && !_jobsLoaded)          { loadJobs();  _jobsLoaded  = true; }
  if (name === "global-settings" && !_globalSettingsLoaded){ loadGlobalSettings(); _globalSettingsLoaded = true; }
  if (name === "playlists"       && !_playlistsLoaded)     { loadAdminPlaylists(); _playlistsLoaded = true; }
  if (name === "project-access"  && !_projectAccessLoaded) { loadProjectAccess(); _projectAccessLoaded = true; }
}
let _usersLoaded          = false;
let _jobsLoaded           = false;
let _globalSettingsLoaded = false;
let _playlistsLoaded      = false;
let _projectAccessLoaded  = false;

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });
});
