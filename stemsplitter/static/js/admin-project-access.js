/* admin-project-access.js — project access overview tab */

let _paAllRows  = [];
let _paSortCol  = "project";
let _paSortDir  = "asc";
let _paRenaming = null;

function _paSortKey(p, col) {
  if (col === "project")  return (p.name || p.job_id).toLowerCase();
  if (col === "playlist") return ((p.via_all_users || [])[0] || "").toLowerCase();
  if (col === "group")    return ((p.via_groups || [])[0]?.group_name || "").toLowerCase();
  if (col === "user")     return ((p.via_users  || [])[0]?.name || (p.via_users || [])[0]?.email || "").toLowerCase();
  return "";
}

function _paSort(col) {
  if (_paSortCol === col) { _paSortDir = _paSortDir === "asc" ? "desc" : "asc"; }
  else                    { _paSortCol = col; _paSortDir = "asc"; }
  _paUpdateHeaders();
  _paApplyFilters();
}

function _paUpdateHeaders() {
  ["project","playlist","group","user"].forEach(col => {
    const th = document.getElementById(`pa-th-${col}`);
    if (!th) return;
    const arrow = th.querySelector(".pa-sort-arrow");
    if (arrow) arrow.textContent = _paSortCol === col ? (_paSortDir === "asc" ? " ▲" : " ▼") : " ⇅";
    th.style.cursor = "pointer";
    th.style.userSelect = "none";
    th.style.background = _paSortCol === col ? "rgba(0,0,0,0.04)" : "";
  });
}

async function loadProjectAccess() {
  const tbody = document.getElementById("pa-tbody");
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--subtle);padding:48px;font-size:13px;">Loading…</td></tr>';
  document.getElementById("pa-summary-line").textContent = "Loading…";
  try {
    const res  = await fetch(`${API}/projects/access-summary`);
    const data = await res.json();
    _paAllRows = data.projects || [];
    _paClearFilters();
    _paUpdateHeaders();
    _paApplyFilters();
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--err);padding:32px;">${_esc(e.message)}</td></tr>`;
    document.getElementById("pa-summary-line").textContent = "Failed to load";
  }
}

function _paClearFilters() {
  ["pa-f-project","pa-f-playlist","pa-f-group","pa-f-user"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

function _paApplyFilters() {
  const fProject  = (document.getElementById("pa-f-project")?.value  || "").toLowerCase().trim();
  const fPlaylist = (document.getElementById("pa-f-playlist")?.value || "").toLowerCase().trim();
  const fGroup    = (document.getElementById("pa-f-group")?.value    || "").toLowerCase().trim();
  const fUser     = (document.getElementById("pa-f-user")?.value     || "").toLowerCase().trim();

  let filtered = _paAllRows.filter(p => {
    if (fProject && !(p.name || p.job_id).toLowerCase().includes(fProject)) return false;
    if (fPlaylist) {
      const names = (p.via_all_users || [])
        .concat((p.via_groups || []).filter(g => g.via === "playlist").map(g => g.via_name))
        .concat((p.via_users  || []).filter(u => u.via === "playlist").map(u => u.via_name));
      if (!names.some(n => (n || "").toLowerCase().includes(fPlaylist))) return false;
    }
    if (fGroup && !(p.via_groups || []).some(g => (g.group_name || "").toLowerCase().includes(fGroup))) return false;
    if (fUser  && !(p.via_users  || []).some(u => (u.name || "").toLowerCase().includes(fUser) || (u.email || "").toLowerCase().includes(fUser))) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const ka = _paSortKey(a, _paSortCol), kb = _paSortKey(b, _paSortCol);
    return _paSortDir === "asc" ? ka.localeCompare(kb) : kb.localeCompare(ka);
  });

  const activeBar = document.getElementById("pa-active-filters");
  const tags = [];
  if (fProject)  tags.push(`<span style="background:#e2e8f0;color:#334155;padding:2px 8px;border-radius:99px;font-size:11px;">Project: <b>${_esc(fProject)}</b></span>`);
  if (fPlaylist) tags.push(`<span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:99px;font-size:11px;">Playlist: <b>${_esc(fPlaylist)}</b></span>`);
  if (fGroup)    tags.push(`<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:99px;font-size:11px;">Group: <b>${_esc(fGroup)}</b></span>`);
  if (fUser)     tags.push(`<span style="background:#f3e8ff;color:#7e22ce;padding:2px 8px;border-radius:99px;font-size:11px;">User: <b>${_esc(fUser)}</b></span>`);
  if (tags.length) {
    activeBar.style.display = "flex";
    activeBar.innerHTML = '<span style="font-weight:600;color:#475569;">Active filters:</span> ' + tags.join(" ")
      + `<button onclick="_paClearFilters();_paApplyFilters();" style="margin-left:auto;background:none;border:none;color:#ef4444;cursor:pointer;font-size:12px;padding:0 4px;">✕ Clear all</button>`;
  } else {
    activeBar.style.display = "none";
    activeBar.innerHTML = "";
  }

  _paRenderRows(filtered);

  const total = _paAllRows.length, shown = filtered.length;
  const summaryEl = document.getElementById("pa-summary-line");
  if (summaryEl) summaryEl.textContent = tags.length ? `Showing ${shown} of ${total} projects` : `${total} project${total !== 1 ? "s" : ""} total`;
  const footer = document.getElementById("pa-footer-bar");
  if (footer) { footer.style.display = "block"; footer.textContent = `${shown} project${shown !== 1 ? "s" : ""} shown`; }
}

function _paRenderRows(rows) {
  const tbody = document.getElementById("pa-tbody");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--subtle);padding:48px;font-size:13px;">No projects match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  rows.forEach((p, idx) => {
    const tr = document.createElement("tr");
    tr.style.cssText = `background:${idx % 2 ? "#fafafa" : "#fff"};border-bottom:1px solid var(--border);`;

    const tdProj = document.createElement("td");
    tdProj.style.cssText = "padding:10px 16px;vertical-align:middle;border-right:1px solid var(--border);";

    const statusColor = p.status === "completed" ? "#22c55e" : p.status === "running" ? "#f59e0b" : "#94a3b8";
    const nameWrap = document.createElement("div");
    nameWrap.style.cssText = "display:flex;align-items:center;gap:7px;";

    const dot = document.createElement("span");
    dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;`;
    nameWrap.appendChild(dot);

    if (_paRenaming === p.job_id) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = p.name || "";
      inp.style.cssText = "flex:1;font-size:13px;font-weight:600;padding:3px 7px;border:1.5px solid #3b82f6;border-radius:6px;outline:none;";
      inp.addEventListener("keydown", async e => {
        if (e.key === "Enter") { e.preventDefault(); await _paCommitRename(p.job_id, inp.value.trim()); }
        if (e.key === "Escape") { _paRenaming = null; _paApplyFilters(); }
      });
      inp.addEventListener("blur", async () => { await _paCommitRename(p.job_id, inp.value.trim()); });
      nameWrap.appendChild(inp);
      requestAnimationFrame(() => { inp.focus(); inp.select(); });

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "✕";
      cancelBtn.title = "Cancel";
      cancelBtn.style.cssText = "background:none;border:none;cursor:pointer;color:#94a3b8;font-size:13px;padding:0 2px;";
      cancelBtn.addEventListener("mousedown", e => { e.preventDefault(); _paRenaming = null; _paApplyFilters(); });
      nameWrap.appendChild(cancelBtn);
    } else {
      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name || p.job_id;
      nameSpan.style.cssText = "font-size:13px;font-weight:600;color:#0f172a;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      nameWrap.appendChild(nameSpan);

      const editBtn = document.createElement("button");
      editBtn.title = "Rename project";
      editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
      editBtn.style.cssText = "background:none;border:none;cursor:pointer;color:#94a3b8;padding:2px 4px;border-radius:4px;display:none;flex-shrink:0;";
      editBtn.addEventListener("click", () => { _paRenaming = p.job_id; _paApplyFilters(); });
      nameWrap.appendChild(editBtn);

      tr.addEventListener("mouseenter", () => { editBtn.style.display = "inline-flex"; });
      tr.addEventListener("mouseleave", () => { editBtn.style.display = "none"; });
      nameSpan.addEventListener("dblclick", () => { _paRenaming = p.job_id; _paApplyFilters(); });
      nameSpan.title = "Double-click to rename";
    }

    tdProj.appendChild(nameWrap);
    const jobIdDiv = document.createElement("div");
    jobIdDiv.textContent = p.job_id;
    jobIdDiv.style.cssText = "font-size:10px;color:#94a3b8;margin-top:2px;padding-left:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    tdProj.appendChild(jobIdDiv);
    tr.appendChild(tdProj);

    const mkTd = (html, last) => {
      const td = document.createElement("td");
      td.style.cssText = `padding:10px 16px;vertical-align:top;${last ? "" : "border-right:1px solid var(--border);"}`;
      td.innerHTML = html || `<span style="color:#cbd5e1;font-size:12px;">—</span>`;
      return td;
    };

    const allHtml = (p.via_all_users || []).map(pl =>
      `<span class="access-badge global">🌐 ${_esc(pl)}</span>`).join("") || "";
    const grpHtml = (p.via_groups || []).map(g =>
      g.via === "playlist"
        ? `<span class="access-badge group" title="Via playlist: ${_esc(g.via_name)}">👥 ${_esc(g.group_name)}<span style="opacity:.6;font-size:10px;"> ↳ ${_esc(g.via_name)}</span></span>`
        : `<span class="access-badge group" title="Direct">👥 ${_esc(g.group_name)}</span>`).join("") || "";
    const usrHtml = (p.via_users || []).map(u =>
      u.via === "playlist"
        ? `<span class="access-badge user" title="${_esc(u.email)} — via playlist: ${_esc(u.via_name)}">👤 ${_esc(u.name || u.email)}<span style="opacity:.6;font-size:10px;"> ↳ ${_esc(u.via_name)}</span></span>`
        : `<span class="access-badge user" title="${_esc(u.email)} — direct">👤 ${_esc(u.name || u.email)}</span>`).join("") || "";

    tr.appendChild(mkTd(allHtml));
    tr.appendChild(mkTd(grpHtml));
    tr.appendChild(mkTd(usrHtml, true));
    tbody.appendChild(tr);
  });
}

async function _paCommitRename(jobId, newName) {
  _paRenaming = null;
  if (!newName) { _paApplyFilters(); return; }
  const row = _paAllRows.find(p => p.job_id === jobId);
  if (!row || row.name === newName) { _paApplyFilters(); return; }
  const oldName = row.name;
  row.name = newName;
  _paApplyFilters();
  try {
    const res = await fetch(`${API.replace("/admin", "")}/jobs/${encodeURIComponent(jobId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: newName }),
    });
    const d = await res.json();
    if (!d.ok) { row.name = oldName; _paApplyFilters(); toast(d.error || "Rename failed", true); }
    else toast("Project renamed");
  } catch(e) { row.name = oldName; _paApplyFilters(); toast("Rename failed", true); }
}
