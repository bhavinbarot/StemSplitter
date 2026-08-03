/* admin-users.js — users list, role/active management */

let _allUsers = [];
const _userRowMap = {};
let _openUserMenuIdx = null;

function _avatarHtml(u) {
  if (u.picture) {
    return `<img class="user-avatar" src="${u.picture}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">
            <span class="user-avatar" style="display:none">${(u.name||u.email||"?")[0].toUpperCase()}</span>`;
  }
  return `<span class="user-avatar">${(u.name||u.email||"?")[0].toUpperCase()}</span>`;
}

function _renderUsers(users) {
  const wrap = document.getElementById("user-table-wrap");
  if (!users.length) {
    wrap.innerHTML = '<p style="color:var(--subtle);font-size:13px;padding:14px 0">No users found.</p>';
    return;
  }
  Object.keys(_userRowMap).forEach(k => delete _userRowMap[k]);

  const rows = users.map((u, idx) => {
    _userRowMap[idx] = u;
    const inactiveCls = u.is_active === 0 ? " inactive" : "";
    const roleCls = u.role === 'admin' ? 'admin' : (u.role === 'contributor' ? 'contributor' : 'user');
    const roleLabel = u.role === 'admin' ? 'Admin' : (u.role === 'contributor' ? 'Contributor' : 'User');
    const authLabel = u.auth_type === 'google' ? 'Google' : 'Local';
    const lastSeen = u.last_seen ? _relativeTime(u.last_seen) : "—";

    let menuItems = '';
    if (u.role === "admin") {
      menuItems += `<button class="user-menu-item" onclick="_userAction(${idx},'demote')">👤 Make User</button>`;
    } else if (u.role === "contributor") {
      menuItems += `<button class="user-menu-item promote" onclick="_userAction(${idx},'promote')">⭐ Make Admin</button>`;
      menuItems += `<button class="user-menu-item" onclick="_userAction(${idx},'demote')">👤 Make User</button>`;
    } else {
      menuItems += `<button class="user-menu-item promote" onclick="_userAction(${idx},'promote')">⭐ Make Admin</button>`;
      menuItems += `<button class="user-menu-item success" onclick="_userAction(${idx},'make-contributor')">✦ Make Contributor</button>`;
    }
    if (u.auth_type === "local") {
      menuItems += '<div class="user-menu-divider"></div>';
      if (u.is_active === 0) {
        menuItems += `<button class="user-menu-item success" onclick="_userAction(${idx},'activate')">✓ Activate Account</button>`;
      } else {
        menuItems += `<button class="user-menu-item danger" onclick="_userAction(${idx},'deactivate')">✕ Deactivate Account</button>`;
      }
    }
    if (u.role !== "admin") {
      menuItems += '<div class="user-menu-divider"></div>';
      menuItems += `<button class="user-menu-item success" onclick="_userAction(${idx},'projects')">📁 Manage Projects</button>`;
    }

    return `<div class="user-row${inactiveCls}" id="user-row-${idx}">
      ${_avatarHtml(u)}
      <div class="user-info">
        <div class="user-name">${_esc(u.name || "—")}</div>
        <div class="user-email">${_esc(u.email || "")}</div>
      </div>
      <div class="user-badges">
        <span class="auth-badge ${u.auth_type}">${authLabel}</span>
        <span class="role-badge ${roleCls}">${roleLabel}</span>
      </div>
      <div class="user-seen">${lastSeen}</div>
      <div class="user-menu-wrap">
        <button class="user-menu-btn" onclick="_toggleUserMenu(${idx}, event)" title="Actions">···</button>
        <div class="user-menu" id="user-menu-${idx}">
          ${menuItems}
        </div>
      </div>
    </div>`;
  }).join("");

  wrap.innerHTML = `<div class="user-list">${rows}</div>`;
}

async function _userAction(idx, action) {
  if (_openUserMenuIdx !== null) {
    const m = document.getElementById(`user-menu-${_openUserMenuIdx}`);
    if (m) m.classList.remove("open");
    _openUserMenuIdx = null;
  }
  const u = _userRowMap[idx];
  if (!u) return;
  if (action === 'promote')              await setRole(u.id, 'admin');
  else if (action === 'make-contributor') await setRole(u.id, 'contributor');
  else if (action === 'demote')          await setRole(u.id, 'user');
  else if (action === 'activate')        await setActive(u.id, true);
  else if (action === 'deactivate')      await setActive(u.id, false);
  else if (action === 'projects')        await openUserProjectsModal(u.id, u.name || u.email);
}

function _toggleUserMenu(idx, event) {
  event.stopPropagation();
  const menu = document.getElementById(`user-menu-${idx}`);
  if (!menu) return;
  const isOpen = menu.classList.contains("open");
  if (_openUserMenuIdx !== null && _openUserMenuIdx !== idx) {
    const other = document.getElementById(`user-menu-${_openUserMenuIdx}`);
    if (other) other.classList.remove("open");
  }
  menu.classList.toggle("open", !isOpen);
  _openUserMenuIdx = isOpen ? null : idx;
}

document.addEventListener("pointerdown", (ev) => {
  if (_openUserMenuIdx !== null && !ev.target.closest(".user-menu-wrap")) {
    const m = document.getElementById(`user-menu-${_openUserMenuIdx}`);
    if (m) m.classList.remove("open");
    _openUserMenuIdx = null;
  }
});

async function loadUsers() {
  const wrap = document.getElementById("user-table-wrap");
  wrap.innerHTML = '<p style="color:var(--subtle);font-size:13px">Loading…</p>';
  try {
    const r = await fetch(USERS_API);
    const d = await r.json();
    if (!d.ok) { toast(d.error || "Failed to load users", true); return; }
    _allUsers = d.users || [];
    const q = document.getElementById("user-search").value;
    filterUsers(q);
  } catch(e) { toast("Failed to load users", true); }
}

function filterUsers(q) {
  const term = (q || "").toLowerCase();
  const filtered = term
    ? _allUsers.filter(u =>
        (u.name||"").toLowerCase().includes(term) ||
        (u.email||"").toLowerCase().includes(term))
    : _allUsers;
  _renderUsers(filtered);
}

async function setRole(userId, role) {
  try {
    const r = await fetch(`${USERS_API}/${encodeURIComponent(userId)}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const d = await r.json();
    if (d.ok) {
      toast(`Role updated to ${role}`);
      await loadUsers();
    } else {
      toast(d.error || "Failed to update role", true);
    }
  } catch(e) { toast("Request failed", true); }
}

async function setActive(userId, active) {
  try {
    const r = await fetch(`${USERS_API}/${encodeURIComponent(userId)}/active`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: active }),
    });
    const d = await r.json();
    if (d.ok) {
      toast(`Account ${active ? "activated" : "deactivated"}`);
      await loadUsers();
    } else {
      toast(d.error || "Failed to update status", true);
    }
  } catch(e) { toast("Request failed", true); }
}
