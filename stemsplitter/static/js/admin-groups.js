/* admin-groups.js — groups CRUD, member/project management, multi-select */

let _allGroups = [];

async function loadGroups() {
  const list = document.getElementById("group-list");
  try {
    const r = await fetch(GROUPS_API);
    const d = await r.json();
    if (!d.ok) { toast("Failed to load groups", true); return; }
    _allGroups = d.groups || [];
    _renderGroups();
  } catch(e) { toast("Failed to load groups", true); }
}

function _renderGroups() {
  const list = document.getElementById("group-list");
  if (!_allGroups.length) {
    list.innerHTML = '<p class="empty-hint">No groups yet. Create one above.</p>';
    return;
  }
  list.innerHTML = _allGroups.map(g => `
    <div class="group-item" id="group-item-${g.id}">
      <div class="group-item-header" onclick="toggleGroup(${g.id})">
        <span class="group-chevron">▶</span>
        <span class="group-name-label">${_esc(g.name)}</span>
        ${g.description ? `<span class="group-desc-label">${_esc(g.description)}</span>` : ""}
        <div class="group-meta">
          <span class="group-count-badge" title="Members">${g.member_count} member${g.member_count===1?"":"s"}</span>
          <span class="group-count-badge" title="Projects" style="background:#f0fdf4;color:#16a34a">${g.project_count} project${g.project_count===1?"":"s"}</span>
          <button class="btn-xs deactivate" style="padding:3px 8px" onclick="event.stopPropagation();deleteGroup(${g.id}, '${_esc(g.name)}')">✕ Delete</button>
        </div>
      </div>
      <div class="group-body" id="group-body-${g.id}">
        <div class="group-columns">
          <div class="group-col-panel">
            <div class="group-col-header">
              <p class="group-section-title">👥 Members</p>
            </div>
            <div class="group-chip-area" id="group-members-${g.id}">
              <span class="empty-hint">Loading…</span>
            </div>
            <div class="add-row">
              <div class="ms-wrap" id="user-ms-wrap-${g.id}">
                <button type="button" class="ms-trigger" id="user-ms-btn-${g.id}" onclick="toggleMs('user',${g.id})">
                  <span class="ms-trigger-label" id="user-ms-label-${g.id}">Select users to add…</span>
                  <span class="ms-chevron">▾</span>
                </button>
                <div class="ms-dropdown hidden" id="user-ms-dropdown-${g.id}">
                  <input type="text" class="ms-search" placeholder="🔍 Search users…" oninput="filterMs('user',${g.id},this.value)">
                  <div class="ms-select-all">
                    <span onclick="selectAllMs('user',${g.id},true)">Select all</span>
                    <span onclick="selectAllMs('user',${g.id},false)">Clear all</span>
                  </div>
                  <div class="ms-options" id="user-ms-options-${g.id}"></div>
                </div>
              </div>
              <div class="add-row-actions">
                <button class="btn-sm-primary" onclick="addMember(${g.id})">+ Add Members</button>
              </div>
            </div>
          </div>
          <div class="group-col-panel">
            <div class="group-col-header">
              <p class="group-section-title">📁 Assigned Projects</p>
            </div>
            <div class="group-chip-area" id="group-projects-${g.id}">
              <span class="empty-hint">Loading…</span>
            </div>
            <div class="add-row">
              <div class="ms-wrap" id="project-ms-wrap-${g.id}">
                <button type="button" class="ms-trigger" id="project-ms-btn-${g.id}" onclick="toggleMs('project',${g.id})">
                  <span class="ms-trigger-label" id="project-ms-label-${g.id}">Select projects to assign…</span>
                  <span class="ms-chevron">▾</span>
                </button>
                <div class="ms-dropdown hidden" id="project-ms-dropdown-${g.id}">
                  <input type="text" class="ms-search" placeholder="🔍 Search projects…" oninput="filterMs('project',${g.id},this.value)">
                  <div class="ms-select-all">
                    <span onclick="selectAllMs('project',${g.id},true)">Select all</span>
                    <span onclick="selectAllMs('project',${g.id},false)">Clear all</span>
                  </div>
                  <div class="ms-options" id="project-ms-options-${g.id}"></div>
                </div>
              </div>
              <div class="add-row-actions">
                <button class="btn-sm-success" onclick="assignProject(${g.id})">+ Assign Projects</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `).join("");
}

async function toggleGroup(groupId) {
  const item = document.getElementById(`group-item-${groupId}`);
  if (!item) return;
  const isOpen = item.classList.contains("open");
  document.querySelectorAll(".group-item.open").forEach(el => el.classList.remove("open"));
  if (isOpen) return;
  item.classList.add("open");
  await Promise.all([
    _loadGroupMembers(groupId),
    _loadGroupProjects(groupId),
    _populateUserSelect(groupId),
    _populateProjectSelect(groupId),
  ]);
}

async function _loadGroupMembers(groupId) {
  const wrap = document.getElementById(`group-members-${groupId}`);
  if (!wrap) return;
  try {
    const r = await fetch(`${GROUPS_API}/${groupId}/members`);
    const d = await r.json();
    const members = d.members || [];
    if (!members.length) {
      wrap.innerHTML = '<span class="empty-hint">No members yet.</span>';
      return;
    }
    const memberMap = {};
    wrap.innerHTML = members.map((m, i) => {
      memberMap[i] = m.user_id;
      return `<span class="member-chip">
        ${_esc(m.name || m.email)}
        <span class="chip-remove" title="Remove" data-gid="${groupId}" data-midx="${i}">×</span>
      </span>`;
    }).join("");
    wrap.querySelectorAll(".chip-remove").forEach(el => {
      el.addEventListener("click", () => {
        removeMember(parseInt(el.dataset.gid), memberMap[parseInt(el.dataset.midx)]);
      });
    });
  } catch(e) { wrap.innerHTML = '<span class="empty-hint">Error loading members.</span>'; }
}

async function _loadGroupProjects(groupId) {
  const wrap = document.getElementById(`group-projects-${groupId}`);
  if (!wrap) return;
  try {
    const r = await fetch(`${GROUPS_API}/${groupId}/projects`);
    const d = await r.json();
    const projects = d.projects || [];
    if (!projects.length) {
      wrap.innerHTML = '<span class="empty-hint">No projects assigned.</span>';
      return;
    }
    const projectMap = {};
    wrap.innerHTML = projects.map((p, i) => {
      projectMap[i] = p.job_id;
      return `<span class="project-chip">
        ${_esc(p.name || p.job_id.slice(0,12))}
        <span class="chip-remove" title="Remove" data-gid="${groupId}" data-pidx="${i}">×</span>
      </span>`;
    }).join("");
    wrap.querySelectorAll(".chip-remove").forEach(el => {
      el.addEventListener("click", () => {
        unassignProject(parseInt(el.dataset.gid), projectMap[parseInt(el.dataset.pidx)]);
      });
    });
  } catch(e) { wrap.innerHTML = '<span class="empty-hint">Error loading projects.</span>'; }
}

// ── Multi-select helpers ─────────────────────────────────────
function _msOptionsEl(type, groupId)  { return document.getElementById(`${type}-ms-options-${groupId}`); }
function _msBtnEl(type, groupId)      { return document.getElementById(`${type}-ms-btn-${groupId}`); }
function _msLabelEl(type, groupId)    { return document.getElementById(`${type}-ms-label-${groupId}`); }
function _msDropdownEl(type, groupId) { return document.getElementById(`${type}-ms-dropdown-${groupId}`); }

function _updateMsLabel(type, groupId) {
  const opts = _msOptionsEl(type, groupId);
  if (!opts) return;
  const checked = opts.querySelectorAll('input[type="checkbox"]:checked');
  const label = _msLabelEl(type, groupId);
  const btn = _msBtnEl(type, groupId);
  if (!label) return;
  btn && btn.querySelectorAll('.ms-badge').forEach(b => b.remove());
  if (checked.length === 0) {
    label.textContent = type === 'user' ? 'Select users to add…' : 'Select projects to assign…';
    label.classList.remove('has-selection');
  } else if (checked.length === 1) {
    label.textContent = checked[0].dataset.label;
    label.classList.add('has-selection');
  } else {
    label.textContent = `${checked.length} selected`;
    label.classList.add('has-selection');
    if (btn) {
      const badge = document.createElement('span');
      badge.className = 'ms-badge';
      badge.textContent = checked.length;
      const chevron = btn.querySelector('.ms-chevron');
      if (chevron) btn.insertBefore(badge, chevron);
    }
  }
}

function toggleMs(type, groupId) {
  const dropdown = _msDropdownEl(type, groupId);
  const btn = _msBtnEl(type, groupId);
  if (!dropdown) return;
  document.querySelectorAll('.ms-dropdown').forEach(d => { if (d !== dropdown) d.classList.add('hidden'); });
  document.querySelectorAll('.ms-trigger').forEach(b => { if (b !== btn) b.classList.remove('open'); });
  const isHidden = dropdown.classList.contains('hidden');
  dropdown.classList.toggle('hidden', !isHidden);
  btn && btn.classList.toggle('open', isHidden);
  if (isHidden) {
    const search = dropdown.querySelector('.ms-search');
    if (search) setTimeout(() => search.focus(), 50);
  }
}

function filterMs(type, groupId, query) {
  const opts = _msOptionsEl(type, groupId);
  if (!opts) return;
  const q = query.toLowerCase().trim();
  opts.querySelectorAll('.ms-option').forEach(row => {
    const text = (row.dataset.label || '').toLowerCase();
    row.style.display = !q || text.includes(q) ? '' : 'none';
  });
}

function selectAllMs(type, groupId, checked) {
  const opts = _msOptionsEl(type, groupId);
  if (!opts) return;
  opts.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (cb.closest('.ms-option').style.display !== 'none') cb.checked = checked;
  });
  _updateMsLabel(type, groupId);
}

function _buildMsOptions(type, groupId, items) {
  const opts = _msOptionsEl(type, groupId);
  if (!opts) return;
  if (!items.length) {
    opts.innerHTML = '<div class="ms-empty">No options available.</div>';
    return;
  }
  opts.innerHTML = items.map((item, i) => `
    <label class="ms-option" data-label="${_esc(item.label)}">
      <input type="checkbox" value="${_esc(item.value)}" data-label="${_esc(item.label)}">
      <span>${_esc(item.label)}</span>
    </label>
  `).join('');
  opts.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => _updateMsLabel(type, groupId));
  });
}

function _getMsSelected(type, groupId) {
  const opts = _msOptionsEl(type, groupId);
  if (!opts) return [];
  return Array.from(opts.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

function _clearMs(type, groupId) {
  const opts = _msOptionsEl(type, groupId);
  if (opts) opts.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  const search = _msDropdownEl(type, groupId)?.querySelector('.ms-search');
  if (search) { search.value = ''; filterMs(type, groupId, ''); }
  _updateMsLabel(type, groupId);
  _msDropdownEl(type, groupId)?.classList.add('hidden');
  _msBtnEl(type, groupId)?.classList.remove('open');
}

document.addEventListener('pointerdown', (ev) => {
  if (!ev.target.closest('.ms-wrap')) {
    document.querySelectorAll('.ms-dropdown').forEach(d => d.classList.add('hidden'));
    document.querySelectorAll('.ms-trigger').forEach(b => b.classList.remove('open'));
  }
});

async function _populateUserSelect(groupId) {
  const users = _allUsers.length ? _allUsers : await (async () => {
    const r = await fetch(USERS_API); const d = await r.json(); return d.users || [];
  })();
  _buildMsOptions('user', groupId, users.map(u => ({
    value: u.id,
    label: `${u.name || u.email} (${u.auth_type})`,
  })));
}

async function _populateProjectSelect(groupId) {
  try {
    const r = await fetch(`${API}/jobs`);
    const jobs = await r.json();
    _buildMsOptions('project', groupId, jobs.map(j => ({
      value: j.job_id,
      label: j.project_name || j.job_id.slice(0, 40),
    })));
  } catch(e) { /* ignore */ }
}

async function createGroup() {
  const name = document.getElementById("new-group-name").value.trim();
  const desc = document.getElementById("new-group-desc").value.trim();
  if (!name) { toast("Group name is required", true); return; }
  try {
    const r = await fetch(GROUPS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc }),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById("new-group-name").value = "";
      document.getElementById("new-group-desc").value = "";
      toast(`Group "${name}" created`);
      await loadGroups();
    } else {
      toast(d.error || "Failed to create group", true);
    }
  } catch(e) { toast("Request failed", true); }
}

async function deleteGroup(groupId, name) {
  if (!confirm(`Delete group "${name}"? This cannot be undone.`)) return;
  try {
    const r = await fetch(`${GROUPS_API}/${groupId}`, { method: "DELETE" });
    const d = await r.json();
    if (d.ok) { toast("Group deleted"); await loadGroups(); }
    else toast(d.error || "Failed", true);
  } catch(e) { toast("Request failed", true); }
}

async function addMember(groupId) {
  const userIds = _getMsSelected('user', groupId);
  if (!userIds.length) { toast("Select at least one user", true); return; }
  let added = 0, failed = 0;
  for (const userId of userIds) {
    try {
      const r = await fetch(`${GROUPS_API}/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      const d = await r.json();
      if (d.ok) added++; else failed++;
    } catch(e) { failed++; }
  }
  _clearMs('user', groupId);
  if (added) toast(`${added} member${added>1?'s':''} added`);
  if (failed) toast(`${failed} failed to add`, true);
  await _loadGroupMembers(groupId);
  await loadGroups();
}

async function removeMember(groupId, userId) {
  try {
    const r = await fetch(`${GROUPS_API}/${groupId}/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
    const d = await r.json();
    if (d.ok) { toast("Member removed"); await _loadGroupMembers(groupId); await loadGroups(); }
    else toast(d.error || "Failed", true);
  } catch(e) { toast("Request failed", true); }
}

async function assignProject(groupId) {
  const jobIds = _getMsSelected('project', groupId);
  if (!jobIds.length) { toast("Select at least one project", true); return; }
  let assigned = 0, failed = 0;
  for (const jobId of jobIds) {
    try {
      const r = await fetch(`${GROUPS_API}/${groupId}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      const d = await r.json();
      if (d.ok) assigned++; else failed++;
    } catch(e) { failed++; }
  }
  _clearMs('project', groupId);
  if (assigned) toast(`${assigned} project${assigned>1?'s':''} assigned`);
  if (failed) toast(`${failed} failed to assign`, true);
  await _loadGroupProjects(groupId);
  await loadGroups();
}

async function unassignProject(groupId, jobId) {
  try {
    const r = await fetch(`${GROUPS_API}/${groupId}/projects/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    });
    const d = await r.json();
    if (d.ok) { toast("Project removed from group"); await _loadGroupProjects(groupId); await loadGroups(); }
    else toast(d.error || "Failed", true);
  } catch(e) { toast("Request failed", true); }
}
