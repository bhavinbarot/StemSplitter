/* admin-dashboard.js — dashboard stats, settings config */

async function loadStats() {
  try {
    const r = await fetch(`${API}/stats`);
    const d = await r.json();
    document.getElementById("stat-total").textContent     = d.total_projects;
    document.getElementById("stat-completed").textContent = d.completed_projects;
    document.getElementById("stat-failed").textContent    = d.failed_projects;
    document.getElementById("stat-running").textContent   = d.running_projects;
    document.getElementById("stat-queued").textContent    = d.queued_projects;
    document.getElementById("stat-cancelled").textContent = d.cancelled_projects;
    document.getElementById("stat-storage").textContent   = `${d.disk_mb} MB`;
    document.getElementById("stat-free-disk").textContent = d.free_disk_gb != null ? `${d.free_disk_gb} GB` : "—";
    document.getElementById("stat-cache").textContent     = d.cache_entries;
    document.getElementById("stat-failed-24h").textContent = d.failed_last_24h;
    document.getElementById("stat-avg-split").textContent = d.average_split_seconds != null ? `${d.average_split_seconds}s` : "—";
    document.getElementById("stat-job-root").textContent = d.job_root || "—";
    document.getElementById("stat-job-root-type").textContent = d.job_root_storage_type || "—";
    document.getElementById("stat-job-root-source").textContent = d.job_root_config_source || "—";
    document.getElementById("stat-app-mode").textContent = d.app_mode || (d.lite_mode ? "Lite Mode" : "Full Mode");
    document.getElementById("stat-pitch-support").textContent = d.pitch_support ? "Enabled" : "Disabled";
    document.getElementById("stat-ffmpeg").textContent = d.ffmpeg_available ? (d.ffmpeg_path || "Available") : "Not available";
    document.getElementById("stat-compute-device").textContent = d.compute_device || "—";
    document.getElementById("stat-web-jobs-root").textContent = d.web_jobs_root || "—";
    document.getElementById("stat-job-root-writable").textContent = d.job_root_writable ? "Yes" : "No";
    document.getElementById("stat-ui-version").textContent = d.ui_version || "—";
    document.getElementById("stat-build-timestamp").textContent = d.build_timestamp || "—";
    document.getElementById("stat-server-pid").textContent = d.server_pid || "—";
    document.getElementById("stat-server-started").textContent = d.server_started_at || "—";
    document.getElementById("stat-server-uptime").textContent = d.server_uptime || "—";
  } catch(e) { toast("Failed to load stats", true); }
}

async function loadConfig() {
  try {
    const r = await fetch(`${API}/config`);
    const cfg = await r.json();
    document.getElementById("toggle-bpm").checked    = !!cfg.enable_bpm_detection;
    document.getElementById("toggle-key").checked    = !!cfg.enable_key_detection;
    document.getElementById("toggle-notes").checked  = !!cfg.enable_note_timeline;
    document.getElementById("toggle-auto").checked   = !!cfg.auto_analyse_on_open;
    document.getElementById("input-bpm-thresh").value   = cfg.bpm_change_threshold;
    document.getElementById("input-note-energy").value  = cfg.note_energy_threshold;
    document.getElementById("input-note-dur").value     = cfg.note_min_duration;
    document.getElementById("input-thaat-penalty").value = cfg.thaat_penalty;
  } catch(e) { toast("Failed to load config", true); }
}

async function saveToggle(key, value) {
  try {
    await fetch(`${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    toast(`${key.replace(/_/g," ")} ${value ? "enabled" : "disabled"}`);
  } catch(e) { toast("Save failed", true); }
}

async function saveNumber(key, rawValue) {
  const value = parseFloat(rawValue);
  if (isNaN(value)) return;
  try {
    await fetch(`${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    toast("Saved");
  } catch(e) { toast("Save failed", true); }
}

async function resetDefaults() {
  if (!confirm("Reset all settings to their default values?")) return;
  try {
    await fetch(`${API}/config/reset`, { method: "POST" });
    await loadConfig();
    toast("Settings reset to defaults");
  } catch(e) { toast("Reset failed", true); }
}

async function clearCache() {
  if (!confirm("Clear the entire stem split cache?")) return;
  try {
    const r = await fetch(`${API}/cache/clear`, { method: "POST" });
    const d = await r.json();
    toast(d.ok ? "Cache cleared" : d.error, !d.ok);
    loadStats();
  } catch(e) { toast("Failed", true); }
}

async function clearFailed() {
  if (!confirm("Permanently delete all failed jobs?")) return;
  try {
    const r = await fetch(`${API}/jobs/clear-failed`, { method: "POST" });
    const d = await r.json();
    toast(`Deleted ${d.deleted} failed job${d.deleted === 1 ? "" : "s"}`);
    loadStats();
  } catch(e) { toast("Failed", true); }
}

async function resyncDb() {
  try {
    const r = await fetch(`${API}/resync-db`, { method: "POST" });
    const d = await r.json();
    if (d.ok) {
      toast("Resync started — projects missing from the database will be added. Refresh the page in a few seconds.");
    } else {
      toast(d.error || "Resync failed", true);
    }
  } catch(e) { toast("Request failed", true); }
}

// ── Global Settings ──────────────────────────────────────────
let _globalSettingsData = [];
let _globalSettingsDirty = {};

async function loadGlobalSettings() {
  const wrap = document.getElementById("global-settings-list");
  if (!wrap) return;
  try {
    const res  = await fetch(`${API}/settings`);
    const data = await res.json();
    _globalSettingsData = data.settings || [];
    _globalSettingsDirty = {};
    renderGlobalSettings();
  } catch(e) { wrap.innerHTML = '<p style="color:var(--err);font-size:13px;">Failed to load settings.</p>'; }
}

function renderGlobalSettings() {
  const wrap = document.getElementById("global-settings-list");
  if (!wrap) return;
  if (!_globalSettingsData.length) {
    wrap.innerHTML = '<p style="color:var(--subtle);font-size:13px;">No settings found.</p>';
    return;
  }
  wrap.innerHTML = _globalSettingsData.map((s, i) => `
    <div class="setting-row" style="border-bottom:1px solid var(--border);padding:14px 0;${i===0?"padding-top:0":""}">
      <div class="setting-info" style="flex:1;min-width:0;">
        <div class="setting-label">${_esc(s.label || s.key)}</div>
        <div class="setting-desc" style="font-size:11px;margin-top:2px;">${_esc(s.description || "")}</div>
        <div style="font-size:10px;color:var(--subtle);margin-top:2px;font-family:monospace;">${_esc(s.key)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
        <input type="${s.type === 'number' ? 'number' : 'text'}" id="gs-val-${i}"
          value="${_esc(String(s.value !== undefined ? s.value : ""))}"
          step="${s.type === 'number' ? 'any' : ''}"
          style="width:110px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;"
          onchange="_gsChange(${i}, this.value, ${JSON.stringify(s.type)})">
        <label title="Allow users to override this setting" style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--subtle);cursor:pointer;white-space:nowrap;">
          <input type="checkbox" id="gs-override-${i}" ${s.can_be_overridden ? "checked" : ""}
            onchange="_gsOverride(${i}, this.checked)">
          Allow override
        </label>
      </div>
    </div>
  `).join("");
}

function _gsChange(idx, val, type) {
  const s = _globalSettingsData[idx];
  if (!s) return;
  _globalSettingsDirty[s.key] = { value: type === "number" ? Number(val) : val };
}

function _gsOverride(idx, checked) {
  const s = _globalSettingsData[idx];
  if (!s) return;
  if (!_globalSettingsDirty[s.key]) _globalSettingsDirty[s.key] = { value: s.value };
  _globalSettingsDirty[s.key].can_be_overridden = checked;
}

async function saveGlobalSettings() {
  const statusEl = document.getElementById("global-settings-status");
  _globalSettingsData.forEach((s, i) => {
    const inp = document.getElementById(`gs-val-${i}`);
    const ovr = document.getElementById(`gs-override-${i}`);
    if (!inp) return;
    const val = s.type === "number" ? Number(inp.value) : inp.value;
    if (!_globalSettingsDirty[s.key]) _globalSettingsDirty[s.key] = {};
    _globalSettingsDirty[s.key].value = val;
    if (ovr) _globalSettingsDirty[s.key].can_be_overridden = ovr.checked;
  });
  if (!Object.keys(_globalSettingsDirty).length) {
    if (statusEl) statusEl.textContent = "No changes.";
    return;
  }
  try {
    const res  = await fetch(`${API}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_globalSettingsDirty),
    });
    const data = await res.json();
    if (data.ok) {
      _globalSettingsData = data.settings || _globalSettingsData;
      _globalSettingsDirty = {};
      renderGlobalSettings();
      if (statusEl) { statusEl.textContent = "Saved ✓"; setTimeout(() => { statusEl.textContent = ""; }, 3000); }
    } else {
      if (statusEl) statusEl.textContent = "Error: " + (data.error || "unknown");
    }
  } catch(e) { if (statusEl) statusEl.textContent = "Failed: " + e.message; }
}
