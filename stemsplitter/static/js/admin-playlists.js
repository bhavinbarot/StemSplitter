/* admin-playlists.js — playlist CRUD and share modal */

let _adminPlaylists = [];
const PLAYLISTS_API = API.replace("/admin", "") + "/playlists";

async function loadAdminPlaylists() {
  const wrap = document.getElementById("playlist-admin-list");
  if (!wrap) return;
  try {
    const res  = await fetch(`${API}/playlists`);
    const data = await res.json();
    _adminPlaylists = data.playlists || [];
    renderAdminPlaylists();
  } catch(e) { wrap.innerHTML = '<p style="color:var(--err);font-size:13px;">Failed to load playlists.</p>'; }
}

function renderAdminPlaylists() {
  const wrap = document.getElementById("playlist-admin-list");
  if (!wrap) return;
  if (!_adminPlaylists.length) {
    wrap.innerHTML = '<p style="color:var(--subtle);font-size:13px;">No playlists yet.</p>';
    return;
  }
  const rows = _adminPlaylists.map(pl => {
    const icon  = pl.is_shared ? "🎵" : "🎧";
    const owner = pl.owner_name || (pl.owner_id ? pl.owner_email || pl.owner_id : "Admin");
    const sharedBadge = pl.is_shared
      ? '<span style="font-size:10px;background:#dcfce7;color:#166534;padding:2px 6px;border-radius:10px;font-weight:600;">All users</span>'
      : '<span style="font-size:10px;background:#f1f5f9;color:#64748b;padding:2px 6px;border-radius:10px;">Restricted</span>';
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:10px 8px;font-size:13px;">${icon} ${_esc(pl.name)}</td>
      <td style="padding:10px 8px;font-size:12px;color:var(--subtle);">${_esc(owner)}</td>
      <td style="padding:10px 8px;">${sharedBadge}</td>
      <td style="padding:10px 8px;font-size:12px;color:var(--subtle);text-align:center;">${pl.project_count || 0}</td>
      <td style="padding:10px 8px;text-align:right;display:flex;gap:6px;justify-content:flex-end;">
        <button class="btn btn-outline" style="padding:4px 10px;font-size:11px;" onclick="openPlsShareModal(${pl.id})">🔗 Share</button>
        <button class="btn btn-outline" style="padding:4px 10px;font-size:11px;color:var(--err);border-color:var(--err);" onclick="adminDeletePlaylist(${pl.id})">Delete</button>
      </td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="border-bottom:2px solid var(--border);">
      <th style="text-align:left;padding:8px;font-weight:600;">Name</th>
      <th style="text-align:left;padding:8px;font-weight:600;">Owner</th>
      <th style="text-align:left;padding:8px;font-weight:600;">Visibility</th>
      <th style="text-align:center;padding:8px;font-weight:600;">Projects</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function adminDeletePlaylist(id) {
  if (!confirm("Delete this playlist? Projects will not be deleted.")) return;
  try {
    const res = await fetch(`${PLAYLISTS_API}/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed");
    _adminPlaylists = _adminPlaylists.filter(p => p.id !== id);
    renderAdminPlaylists();
    toast("Playlist deleted.");
  } catch(e) { toast("Failed to delete playlist.", true); }
}

// ── Playlist Share Modal ─────────────────────────────────────
let _plsModalId = null;

function closePlsModal() {
  document.getElementById("playlist-share-modal").style.display = "none";
  _plsModalId = null;
}

async function openPlsShareModal(playlistId) {
  _plsModalId = playlistId;
  const modal = document.getElementById("playlist-share-modal");
  const body  = document.getElementById("pls-modal-body");
  const title = document.getElementById("pls-modal-title");
  modal.style.display = "flex";
  body.innerHTML = '<p style="color:var(--subtle);font-size:13px;">Loading…</p>';

  try {
    const [accessRes, usersRes] = await Promise.all([
      fetch(`${PLAYLISTS_API}/${playlistId}/access`),
      fetch(USERS_API + "?limit=200"),
    ]);
    const accessData = await accessRes.json();
    const usersData  = await usersRes.json();
    title.textContent = `Sharing: ${accessData.playlist?.name || ""}`;
    renderPlsShareModal(accessData, usersData.users || []);
  } catch(e) {
    body.innerHTML = `<p style="color:var(--err);font-size:13px;">${e.message}</p>`;
  }
}

function renderPlsShareModal(data, allUsers) {
  const body = document.getElementById("pls-modal-body");
  const pl   = data.playlist || {};
  const currentUsers  = data.users  || [];
  const currentGroups = data.groups || [];
  const allGroups     = data.all_groups || [];

  const sec = (title, content) =>
    `<div style="margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#94a3b8;letter-spacing:.06em;margin-bottom:8px;">${title}</div>
      ${content}
    </div>`;

  const allUsersRow = `
    <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 10px;border-radius:8px;background:#f8fafc;border:1px solid var(--border);">
      <input type="checkbox" id="pls-all-users" ${pl.is_shared ? "checked" : ""}
        onchange="setPlsAllUsers(${pl.id}, this.checked)"
        style="width:16px;height:16px;accent-color:#0b5cff;cursor:pointer;">
      <span>
        <span style="font-size:13px;font-weight:600;color:#0f172a;">Visible to all users</span><br>
        <span style="font-size:11px;color:#64748b;">Anyone with a login can see this playlist and its projects</span>
      </span>
    </label>`;

  const grantedGroupIds = new Set(currentGroups.map(g => g.group_id));
  const groupRows = allGroups.length
    ? allGroups.map(g => {
        const checked = grantedGroupIds.has(g.id);
        return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 8px;border-radius:6px;${checked?"background:#f0fdf4;":""}">
          <input type="checkbox" ${checked ? "checked" : ""} onchange="togglePlsGroup(${pl.id},${g.id},this.checked)"
            style="width:14px;height:14px;accent-color:#16a34a;cursor:pointer;">
          <span style="font-size:13px;color:#0f172a;">${_esc(g.name)}</span>
          <span style="font-size:11px;color:#94a3b8;">(${g.member_count||0} members)</span>
        </label>`;
      }).join("")
    : '<p style="font-size:12px;color:var(--subtle);">No groups yet.</p>';

  const grantedUserIds = new Set(currentUsers.map(u => u.user_id));
  const userItems = currentUsers.map(u =>
    `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-radius:6px;background:#f8fafc;margin-bottom:4px;">
      <span style="font-size:13px;color:#0f172a;">${_esc(u.name || u.email)}</span>
      <span style="font-size:11px;color:#94a3b8;margin-right:8px;">${_esc(u.email)}</span>
      <button onclick="removePlsUser(${pl.id},'${_esc(u.user_id)}')" style="background:none;border:none;cursor:pointer;color:#ef4444;font-size:14px;padding:2px 6px;border-radius:4px;" title="Revoke access">✕</button>
    </div>`
  ).join("");

  const availableUsers = allUsers.filter(u => {
    const uid = u.local_id ? `local:${u.local_id}` : u.id;
    return !grantedUserIds.has(uid);
  });
  const userOptions = availableUsers.map(u => {
    const uid = u.local_id ? `local:${u.local_id}` : u.id;
    return `<option value="${_esc(uid)}">${_esc(u.name||u.email||u.username)} — ${_esc(u.email||u.username||"")}</option>`;
  }).join("");
  const addUserRow = availableUsers.length
    ? `<div style="display:flex;gap:6px;margin-top:8px;">
        <select id="pls-add-user-sel" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;">
          <option value="">— select user —</option>
          ${userOptions}
        </select>
        <button class="btn btn-outline" style="padding:5px 12px;font-size:12px;" onclick="addPlsUser(${pl.id})">Add</button>
      </div>`
    : "";

  body.innerHTML =
    sec("Visibility", allUsersRow) +
    sec("Groups", `<div style="display:flex;flex-direction:column;gap:2px;">${groupRows}</div>`) +
    sec("Individual Users",
      (userItems || '<p style="font-size:12px;color:var(--subtle);">No individual users yet.</p>') +
      addUserRow
    );
}

async function setPlsAllUsers(playlistId, isShared) {
  try {
    await fetch(`${PLAYLISTS_API}/${playlistId}/sharing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_shared: isShared }),
    });
    const pl = _adminPlaylists.find(p => p.id === playlistId);
    if (pl) pl.is_shared = isShared;
    renderAdminPlaylists();
    toast(isShared ? "Visible to all users." : "Restricted to specific users/groups.");
  } catch(e) { toast("Failed: " + e.message, true); }
}

async function togglePlsGroup(playlistId, groupId, add) {
  try {
    if (add) {
      await fetch(`${PLAYLISTS_API}/${playlistId}/access/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId }),
      });
    } else {
      await fetch(`${PLAYLISTS_API}/${playlistId}/access/groups/${groupId}`, { method: "DELETE" });
    }
    await openPlsShareModal(playlistId);
  } catch(e) { toast("Failed: " + e.message, true); }
}

async function addPlsUser(playlistId) {
  const sel = document.getElementById("pls-add-user-sel");
  const userId = sel?.value;
  if (!userId) return;
  try {
    await fetch(`${PLAYLISTS_API}/${playlistId}/access/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    await openPlsShareModal(playlistId);
  } catch(e) { toast("Failed: " + e.message, true); }
}

async function removePlsUser(playlistId, userId) {
  try {
    await fetch(`${PLAYLISTS_API}/${playlistId}/access/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
    await openPlsShareModal(playlistId);
  } catch(e) { toast("Failed: " + e.message, true); }
}

async function exportPlaylists() {
  try {
    const res  = await fetch(`${API}/playlists/export`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `playlists_export_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Export downloaded.");
  } catch(e) { toast("Export failed: " + e.message, true); }
}

async function importPlaylists(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const body = data.playlists ? data : (data.export || data);
    const res  = await fetch(`${API}/playlists/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ export: body }),
    });
    const result = await res.json();
    if (result.ok) {
      toast(`Import done: ${result.created} created, ${result.skipped} skipped, ${result.projects_added} memberships added.`);
      _playlistsLoaded = false;
      loadAdminPlaylists();
    } else {
      toast("Import failed: " + (result.error || "unknown"), true);
    }
  } catch(e) { toast("Import failed: " + e.message, true); }
  input.value = "";
}
