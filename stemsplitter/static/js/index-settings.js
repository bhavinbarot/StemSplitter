    // ── User / global settings ───────────────────────────────────────────────
    let _effectiveSettings = {};  // merged global + user overrides (from /api/v1/auth/session)
    function _getSetting(key, fallback) {
      return Object.prototype.hasOwnProperty.call(_effectiveSettings, key)
        ? _effectiveSettings[key] : fallback;
    }
    // Save a user setting to the server and update local cache immediately
    async function saveUserSetting(key, value) {
      _effectiveSettings[key] = value;
      try {
        await fetch(`${API_BASE}/me/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: value }),
        });
      } catch (_) {}
    }

    // ── Playlist state ───────────────────────────────────────────────────────
    let allPlaylists = [];   // [{id, name, owner_id, is_shared, project_count, ...}]
    const PLAYLIST_COLLAPSED_KEY = "stemsplitter.playlistCollapsed";
    let playlistCollapsed = {};
    try { playlistCollapsed = JSON.parse(localStorage.getItem(PLAYLIST_COLLAPSED_KEY) || "{}"); } catch {}
    function savePlaylistCollapsed() {
      localStorage.setItem(PLAYLIST_COLLAPSED_KEY, JSON.stringify(playlistCollapsed));
    }

    // ── Favorites ──────────────────────────────────────────────────────────────
    let userFavorites = new Set();  // Set of job_id strings

    async function loadFavorites() {
      if (SHARE_TOKEN) return;
      try {
        const res = await fetch(`${API_BASE}/me/favorites`);
        if (!res.ok) return;
        const data = await res.json();
        userFavorites = new Set(Array.isArray(data.favorites) ? data.favorites : []);
      } catch (_) {}
    }

    async function toggleFavorite(jobId) {
      const wasFav = userFavorites.has(jobId);
      if (wasFav) {
        userFavorites.delete(jobId);
        await fetch(`${API_BASE}/me/favorites/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      } else {
        userFavorites.add(jobId);
        await fetch(`${API_BASE}/me/favorites/${encodeURIComponent(jobId)}`, { method: "POST" });
      }
      renderProjectList(allProjects);
    }

    async function loadPlaylists() {
      if (SHARE_TOKEN) return;
      try {
        const res = await fetch(`${API_BASE}/playlists`);
        if (!res.ok) return;
        const data = await res.json();
        allPlaylists = Array.isArray(data.playlists) ? data.playlists : [];
        renderProjectList(allProjects);
      } catch (_) {}
    }

    async function apiCreatePlaylist(name, isShared = false) {
      const res = await fetch(`${API_BASE}/playlists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, is_shared: isShared }),
      });
      if (!res.ok) throw new Error("Failed to create playlist.");
      const data = await res.json();
      const pl = data.playlist;
      allPlaylists.push(pl);
      return pl;
    }

    async function apiDeletePlaylist(playlistId) {
      const res = await fetch(`${API_BASE}/playlists/${playlistId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete playlist.");
      allPlaylists = allPlaylists.filter(p => p.id !== playlistId);
      // Remove from all projects in memory
      for (const proj of allProjects) {
        if (Array.isArray(proj.playlists)) {
          proj.playlists = proj.playlists.filter(p => p.id !== playlistId);
        }
      }
    }

    async function apiRenamePlaylist(playlistId, newName) {
      const res = await fetch(`${API_BASE}/playlists/${playlistId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error("Failed to rename playlist.");
      const data = await res.json();
      const pl = allPlaylists.find(p => p.id === playlistId);
      if (pl) pl.name = newName;
      // Update project cache
      for (const proj of allProjects) {
        const ppl = (proj.playlists || []).find(p => p.id === playlistId);
        if (ppl) ppl.name = newName;
      }
      return data.playlist;
    }

    async function apiAddProjectToPlaylist(playlistId, jobId) {
      const res = await fetch(`${API_BASE}/playlists/${playlistId}/projects/${encodeURIComponent(jobId)}`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to add project to playlist.");
      // Update project cache
      const proj = allProjects.find(p => p.job_id === jobId);
      if (proj) {
        if (!Array.isArray(proj.playlists)) proj.playlists = [];
        const pl = allPlaylists.find(p => p.id === playlistId);
        if (pl && !proj.playlists.find(p => p.id === playlistId)) {
          proj.playlists.push({ id: pl.id, name: pl.name, is_shared: pl.is_shared });
        }
      }
    }

    async function apiRemoveProjectFromPlaylist(playlistId, jobId) {
      const res = await fetch(`${API_BASE}/playlists/${playlistId}/projects/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove project from playlist.");
      // Update project cache
      const proj = allProjects.find(p => p.job_id === jobId);
      if (proj && Array.isArray(proj.playlists)) {
        proj.playlists = proj.playlists.filter(p => p.id !== playlistId);
      }
    }

    // ── Legacy folder state (kept for backward compat / migration display) ──
    const FOLDER_COLLAPSED_KEY = "stemsplitter.folderCollapsed";
    const EMPTY_FOLDERS_KEY    = "stemsplitter.emptyFolders";
    let folderCollapsed = {};
    let emptyFolders    = [];
    try { folderCollapsed = JSON.parse(localStorage.getItem(FOLDER_COLLAPSED_KEY) || "{}"); } catch {}
    try { emptyFolders    = JSON.parse(localStorage.getItem(EMPTY_FOLDERS_KEY)    || "[]"); } catch {}
    function saveFolderCollapsed() {
      localStorage.setItem(FOLDER_COLLAPSED_KEY, JSON.stringify(folderCollapsed));
    }
    function saveEmptyFolders() {
      localStorage.setItem(EMPTY_FOLDERS_KEY, JSON.stringify(emptyFolders));
    }
    let _folderNameCache = [];
    let sidebarWidth = SIDEBAR_MIN_WIDTH;
    let isProjectLoading = false;
    let isStemProgress = false;
    let stemProgressPollTimer = null;
    let stemProgressJobId = null;
    let activeWorkspaceTab = "mixer";
    let lyricsKaraokeMode = false;
    let _karaokeFontSize = 20;  // px base
    let _karaokeLanguage = "both"; // "both" | "english" | "gujarati"
    let _karaokeVocalVolumeSaved = null; // saved vocal track volume before entering karaoke mode

    function _getVocalTrack() {
      return mixer.tracks.find(t => t.key === "vocals" || t.key === "no_vocals") || null;
    }
    let isPitchLoading = false;
    let pollTimer = null;
    let currentJobId = null;
    let metadataSaveTimer = null;
    let isRestoringProjectState = false;
    let sourceDownloadUrl = "";
    let redrawQueued = false;
    let mixer = {
      audioContext: null,
      tracks: [],
      duration: 0,
      isPlaying: false,
      startedAt: 0,
      pausedAt: 0,
      rafId: null,
      tempoPct: 100,
      pitchSemitones: 0,
      visibleStart: 0,
      visibleDuration: 0,
      markers: [],
      loopStart: null,
      loopEnd: null,
      loopEnabled: false,
      jobId: "",
      zipDownloadUrl: "",
      lyrics: [],
      songLyricsText: "",
    };

    function updateAudioDropHint() {
      if (!audioDropHint || !audioFileInput) return;
      const fileCount = audioFileInput.files ? audioFileInput.files.length : 0;
      if (!fileCount) {
        audioDropHint.textContent = "";
        return;
      }
      if (fileCount === 1) {
        audioDropHint.textContent = `Selected file: ${audioFileInput.files[0].name}`;
        return;
      }
      audioDropHint.textContent = `${fileCount} files selected`;
    }

    function closeProjectMenu() {
      activeProjectMenuJobId = "";
      _activePortalMenu = null;
      const portal = document.getElementById("project-menu-portal");
      if (portal) {
        while (portal.firstChild) portal.removeChild(portal.firstChild);
        portal.style.display = "none";
      }
      if (!projectListEl) return;
      for (const item of projectListEl.querySelectorAll(".project-item")) {
        item.classList.remove("menu-open");
      }
    }

    // Move the active menu into #project-menu-portal (a direct child of <body>) and
    // position it next to the trigger button.  The portal lives outside .project-sidebar
    // so backdrop-filter on the sidebar does NOT make position:fixed relative to it.
    function _positionProjectMenu() {
      const portal = document.getElementById("project-menu-portal");
      if (!portal) return;
      // Clear any previously shown menu
      while (portal.firstChild) portal.removeChild(portal.firstChild);
      portal.style.display = "none";

      if (!activeProjectMenuJobId || !_activePortalMenu || !projectListEl) return;

      const item    = projectListEl.querySelector(".project-item.menu-open");
      const trigger = item ? item.querySelector(".project-menu-trigger") : null;
      if (!trigger) return;

      // Move menu children into the portal (preserves event listeners)
      const menu = _activePortalMenu;
      _activePortalMenu = null;
      while (menu.firstChild) portal.appendChild(menu.firstChild);
      portal.style.display = "grid";
      portal.style.gap = "4px";

      // Measure after making visible so offsetWidth/Height are correct
      const rect  = trigger.getBoundingClientRect();
      const menuW = Math.max(portal.offsetWidth,  180);
      const menuH = Math.max(portal.offsetHeight, 80);
      const vw    = window.innerWidth;
      const vh    = window.innerHeight;
      const pad   = 6;

      // Horizontal: right-align with trigger, clamp inside viewport
      let left = rect.right - menuW;
      if (left < pad) left = pad;
      if (left + menuW > vw - pad) left = vw - menuW - pad;

      // Vertical: prefer below, flip above if not enough room
      let top;
      if (rect.bottom + pad + menuH <= vh - pad) {
        top = rect.bottom + pad;
      } else if (rect.top - pad - menuH >= pad) {
        top = rect.top - pad - menuH;
      } else {
        top = Math.max(pad, vh - menuH - pad);
      }

      portal.style.top  = top  + "px";
      portal.style.left = left + "px";
    }

    function cancelProjectRename() {
      if (!activeProjectRenameJobId) return;
      activeProjectRenameJobId = "";
      renderProjectList(allProjects);
    }

    function cancelFolderRename() {
      if (!activeFolderRenameName) return;
      activeFolderRenameName = "";
      renderProjectList(allProjects);
    }

    function closeFolderPicker() {
      activeFolderPickerJobId = "";
    }

    function showError(message) {
      statusErr.textContent = message;
      statusErr.classList.remove("hidden");
      statusOk.classList.add("hidden");
    }

    function showSuccess(message) {
      statusOk.textContent = message;
      statusOk.classList.remove("hidden");
      statusErr.classList.add("hidden");
    }

    function clearStatus() {
      statusErr.textContent = "";
      statusErr.classList.add("hidden");
      statusOk.textContent = "";
      statusOk.classList.add("hidden");
    }

    function setCancelBtnVisible(visible) {
      if (!cancelJobBtn) return;
      cancelJobBtn.classList.toggle("hidden", !visible);
      cancelJobBtn.classList.remove("cancelling");
      cancelJobBtn.disabled = false;
    }

    function clampSidebarWidth(value) {
      return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(value)));
    }

