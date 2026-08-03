    const playlistBanner     = document.getElementById("playlist-banner");
    const playlistBannerMsg  = document.getElementById("playlist-banner-msg");
    const playlistPreviewBtn = document.getElementById("playlist-preview-btn");
    const playlistBannerDismiss = document.getElementById("playlist-banner-dismiss");
    const playlistPanel      = document.getElementById("playlist-panel");
    const playlistPanelTitle = document.getElementById("playlist-panel-title");
    const playlistPanelCount = document.getElementById("playlist-panel-count");
    const playlistTracksEl   = document.getElementById("playlist-tracks");
    const playlistPanelHint  = document.getElementById("playlist-panel-hint");
    const playlistSubmitBtn  = document.getElementById("playlist-submit-btn");
    const playlistCancelBtn  = document.getElementById("playlist-cancel-btn");
    let _playlistTracks = [];

    function _isPlaylistUrl(url) {
      try {
        const u = new URL(url);
        // Dedicated playlist page: youtube.com/playlist?list=...
        if (u.pathname === "/playlist") return true;
        // Watch URL with a list= param — but only if it's a real playlist.
        // Reject YouTube Radio/Mix (list starts with RD or RL) and
        // reject start_radio=1 mixes that YouTube auto-generates.
        if (u.pathname === "/watch" && u.searchParams.has("list")) {
          const listId = u.searchParams.get("list") || "";
          if (u.searchParams.get("start_radio") === "1") return false;
          if (/^(RD|RL)/i.test(listId)) return false;  // radio / related mix
          // Known real-playlist prefixes: PL, UU (uploads), FL (favorites), OLAK (YT Music album)
          return /^(PL|UU|FL|OLAK)/i.test(listId);
        }
        return false;
      } catch { return false; }
    }

    function _formatDuration(secs) {
      if (!secs) return "";
      const m = Math.floor(secs / 60);
      const s = String(secs % 60).padStart(2, "0");
      return `${m}:${s}`;
    }

    const playlistCookieStatus = document.getElementById("playlist-cookie-status");
    const playlistCookieMsg    = document.getElementById("playlist-cookie-msg");

    function _hidePlaylist() {
      playlistBanner?.classList.add("hidden");
      playlistPanel?.classList.add("hidden");
      if (playlistCookieStatus) {
        playlistCookieStatus.className = "playlist-cookie-status hidden";
      }
      _playlistTracks = [];
    }

    async function _checkPlaylistCookies() {
      if (!playlistCookieStatus || !playlistCookieMsg) return;
      // Show "checking…" state
      playlistCookieStatus.className = "playlist-cookie-status checking";
      playlistCookieMsg.textContent = "Checking cookies…";
      playlistCookieStatus.classList.remove("hidden");
      try {
        const resp = await fetch(`${API_BASE}/cookie/check`);
        const data = await resp.json().catch(() => ({}));
        const status = data.status || "none";
        const msg = data.message || "";
        const ageHours = data.cookie_age_hours;
        let ageNote = "";
        if (ageHours != null && status !== "none") {
          const ageDays = Math.floor(ageHours / 24);
          ageNote = ageDays > 0 ? ` (${ageDays}d old)` : ` (${Math.round(ageHours)}h old)`;
        }
        playlistCookieStatus.className = `playlist-cookie-status ${status}`;
        playlistCookieMsg.textContent = msg + ageNote;

        // If invalid/none, add warning style to submit button
        if (playlistSubmitBtn) {
          if (status === "invalid") {
            playlistSubmitBtn.style.background = "#dc2626";
            playlistSubmitBtn.title = "Cookies invalid — downloads will likely fail";
          } else {
            playlistSubmitBtn.style.background = "";
            playlistSubmitBtn.title = "";
          }
        }
      } catch (_) {
        playlistCookieStatus.className = "playlist-cookie-status none";
        playlistCookieMsg.textContent = "Could not check cookie status.";
      }
    }

    function _updatePlaylistSelection() {
      const cbs = playlistTracksEl ? [...playlistTracksEl.querySelectorAll(".playlist-track-cb")] : [];
      const total = cbs.length;
      const selected = cbs.filter(cb => cb.checked).length;

      // Select-all checkbox state
      const checkAllEl = document.getElementById("playlist-check-all");
      if (checkAllEl) {
        checkAllEl.checked = selected === total;
        checkAllEl.indeterminate = selected > 0 && selected < total;
      }

      // Count label
      const selCountEl = document.getElementById("playlist-sel-count");
      if (selCountEl) selCountEl.textContent = selected === total ? `All ${total} selected` : `${selected} of ${total} selected`;

      // Hint + button
      if (playlistPanelHint) {
        playlistPanelHint.textContent = selected === 0 ? "Select at least one track" : `${selected} project${selected === 1 ? "" : "s"} will be created`;
      }
      if (playlistSubmitBtn) {
        playlistSubmitBtn.disabled = selected === 0;
        playlistSubmitBtn.textContent = selected === 0 ? "Split Tracks" : `Split ${selected} Track${selected === 1 ? "" : "s"}`;
      }
    }

    function _escHtml(str) {
      return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    // ── URL dedup + playlist detection ───────────────────────────
    let _urlDedupTimer = null;
    let _urlDedupDismissed = false;
    sourceUrlInput.addEventListener("input", () => {
      clearTimeout(_urlDedupTimer);
      _urlDedupDismissed = false;
      urlDedupBanner?.classList.add("hidden");
      _hidePlaylist();
      const raw = (sourceUrlInput.value || "").trim();
      // Only handle single-URL pastes (no newlines)
      if (!raw || raw.includes("\n") || SHARE_TOKEN) return;

      // Playlist URL — show preview banner, skip dedup
      if (_isPlaylistUrl(raw)) {
        if (playlistBannerMsg) playlistBannerMsg.textContent = "Playlist detected — preview all tracks before splitting";
        playlistBanner?.classList.remove("hidden");
        return;
      }

      // Single URL — dedup check
      _urlDedupTimer = setTimeout(async () => {
        if (_urlDedupDismissed) return;
        const found = await searchProjectByUrl(raw);
        if (!found || _urlDedupDismissed) return;
        const name = found.name || found.job_id || "this project";
        if (urlDedupMsg) urlDedupMsg.textContent = `"${name}" was already split — open it?`;
        if (urlDedupOpenBtn) urlDedupOpenBtn.dataset.jobId = found.job_id;
        urlDedupBanner?.classList.remove("hidden");
      }, 600);
    });

    urlDedupDismissBtn?.addEventListener("click", () => {
      _urlDedupDismissed = true;
      urlDedupBanner?.classList.add("hidden");
    });
    urlDedupOpenBtn?.addEventListener("click", () => {
      const jobId = urlDedupOpenBtn.dataset.jobId;
      if (!jobId) return;
      urlDedupBanner?.classList.add("hidden");
      sourceUrlInput.value = "";
      updateActionButtons();
      updateUploadVisibility();
      openProject(jobId);
    });

    // Playlist: dismiss banner
    playlistBannerDismiss?.addEventListener("click", () => {
      _hidePlaylist();
    });

    // Playlist: preview tracks
    playlistPreviewBtn?.addEventListener("click", async () => {
      const url = (sourceUrlInput.value || "").trim();
      if (!url) return;
      if (playlistPreviewBtn) { playlistPreviewBtn.disabled = true; playlistPreviewBtn.textContent = "Loading…"; }
      playlistPanel?.classList.remove("hidden");
      if (playlistPanelTitle) playlistPanelTitle.textContent = "Fetching playlist…";
      if (playlistPanelCount) playlistPanelCount.textContent = "";
      if (playlistTracksEl) playlistTracksEl.innerHTML = '<div style="padding:16px;text-align:center;color:#64748b;font-size:12px">Loading tracks…</div>';
      if (playlistSubmitBtn) playlistSubmitBtn.disabled = true;
      try {
        const resp = await fetch(`${API_BASE}/playlist/info`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) throw new Error(data.error || "Could not load playlist.");
        _playlistTracks = data.tracks || [];
        if (playlistPanelTitle) playlistPanelTitle.textContent = data.title || "Playlist";
        if (playlistPanelCount) playlistPanelCount.textContent = `${data.count} track${data.count === 1 ? "" : "s"}`;
        if (playlistTracksEl) {
          const selectAllRow = `<div class="playlist-select-all-row">
            <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;font-weight:600;color:#166534">
              <input type="checkbox" id="playlist-check-all" checked style="accent-color:#16a34a;width:14px;height:14px;cursor:pointer">
              Select all
            </label>
            <span id="playlist-sel-count" style="font-size:11px;color:#64748b"></span>
          </div>`;
          const trackRows = _playlistTracks.map((t, i) =>
            `<div class="playlist-track" id="playlist-track-row-${i}">
              <input type="checkbox" class="playlist-track-cb" data-idx="${i}" checked>
              <span class="playlist-track-num">${t.index}</span>
              <span class="playlist-track-title">${_escHtml(t.title)}</span>
              ${t.duration ? `<span class="playlist-track-dur">${_formatDuration(t.duration)}</span>` : ""}
            </div>`
          ).join("");
          playlistTracksEl.innerHTML = selectAllRow + trackRows;

          // Select-all toggle
          const checkAllEl = document.getElementById("playlist-check-all");
          if (checkAllEl) {
            checkAllEl.addEventListener("change", () => {
              playlistTracksEl.querySelectorAll(".playlist-track-cb").forEach(cb => {
                cb.checked = checkAllEl.checked;
                cb.closest(".playlist-track")?.classList.toggle("unchecked", !checkAllEl.checked);
              });
              _updatePlaylistSelection();
            });
          }

          // Per-track checkboxes
          playlistTracksEl.querySelectorAll(".playlist-track-cb").forEach(cb => {
            cb.addEventListener("change", () => {
              cb.closest(".playlist-track")?.classList.toggle("unchecked", !cb.checked);
              _updatePlaylistSelection();
            });
          });

          _updatePlaylistSelection();
        }
        // Run cookie check in background while user reviews track list
        _checkPlaylistCookies();
      } catch (err) {
        if (playlistPanelTitle) playlistPanelTitle.textContent = "Failed to load playlist";
        if (playlistTracksEl) playlistTracksEl.innerHTML = `<div style="padding:16px;text-align:center;color:#dc2626;font-size:12px">${_escHtml(err.message || "Unknown error")}</div>`;
        if (playlistCookieStatus) playlistCookieStatus.classList.add("hidden");
      } finally {
        if (playlistPreviewBtn) { playlistPreviewBtn.disabled = false; playlistPreviewBtn.textContent = "Preview Tracks"; }
      }
    });

    // Playlist: cancel
    playlistCancelBtn?.addEventListener("click", () => {
      _hidePlaylist();
      sourceUrlInput.value = "";
      updateActionButtons();
      updateUploadVisibility();
    });

    // Playlist: submit selected tracks as batch
    playlistSubmitBtn?.addEventListener("click", async () => {
      if (!_playlistTracks.length) return;
      const cbs = playlistTracksEl ? [...playlistTracksEl.querySelectorAll(".playlist-track-cb")] : [];
      const entries = [];
      cbs.forEach(cb => {
        if (cb.checked) {
          const idx = parseInt(cb.dataset.idx);
          const t = _playlistTracks[idx];
          if (t) entries.push({ url: t.url, title: t.title });
        }
      });
      if (!entries.length) return;
      _hidePlaylist();
      sourceUrlInput.value = "";
      updateActionButtons();
      updateUploadVisibility();
      await submitUrlBatch(entries);
    });
    if (splitDropzone && audioFileInput) {
      splitDropzone.addEventListener("click", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest("input, textarea, button, a, label")) return;
        audioFileInput.click();
      });
      ["dragenter", "dragover"].forEach((eventName) => {
        splitDropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          splitDropzone.classList.add("drag-active");
        });
      });
      ["dragleave", "dragend"].forEach((eventName) => {
        splitDropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          const related = event.relatedTarget;
          if (related instanceof Node && splitDropzone.contains(related)) return;
          splitDropzone.classList.remove("drag-active");
        });
      });
      splitDropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        splitDropzone.classList.remove("drag-active");
        const files = event.dataTransfer?.files;
        if (!files || !files.length) return;
        const transfer = new DataTransfer();
        transfer.items.add(files[0]);
        audioFileInput.files = transfer.files;
        updateAudioDropHint();
        updateActionButtons();
      });
    }
    updateAudioDropHint();
    updateActionButtons();
    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", () => {
        const collapsed = appShell?.classList.contains("sidebar-collapsed");
        setSidebarCollapsed(!collapsed);
      });
    }
    const mobileBackBtn = document.getElementById("mobile-back-btn");
    if (mobileBackBtn) {
      mobileBackBtn.addEventListener("click", () => {
        setSidebarCollapsed(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }

    // ── New Playlist button ────────────────────────────────────────────────
    if (newFolderBtn && newFolderRow && newFolderInput) {
      newFolderBtn.addEventListener("click", () => {
        newFolderRow.style.display = "flex";
        newFolderInput.value = "";
        newFolderInput.focus();
      });
      const confirmNewPlaylist = () => {
        const name = (newFolderInput.value || "").trim();
        if (!name) { newFolderInput.focus(); return; }
        newFolderRow.style.display = "none";
        // Admins create shared playlists by default; users create personal ones
        const isShared = _isAdminUser;
        apiCreatePlaylist(name, isShared)
          .then(() => renderProjectList(allProjects))
          .catch((err) => showError(err.message || "Failed to create playlist."));
      };
      newFolderConfirm.addEventListener("click", confirmNewPlaylist);
      newFolderInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); confirmNewPlaylist(); }
        else if (e.key === "Escape") { newFolderRow.style.display = "none"; }
      });
      newFolderCancel.addEventListener("click", () => { newFolderRow.style.display = "none"; });
    }
    if (sidebarResizeHandle && appShell) {
      const endSidebarResize = (pointerId = null) => {
        appShell.classList.remove("sidebar-resizing");
        if (pointerId !== null) {
          try { sidebarResizeHandle.releasePointerCapture(pointerId); } catch (_) {}
        }
        window.removeEventListener("pointermove", onSidebarResizeMove);
        window.removeEventListener("pointerup", onSidebarResizeUp);
        window.removeEventListener("pointercancel", onSidebarResizeUp);
      };
      const onSidebarResizeMove = (event) => {
        applySidebarWidth(event.clientX);
      };
      const onSidebarResizeUp = (event) => {
        endSidebarResize(event.pointerId ?? null);
      };
      sidebarResizeHandle.addEventListener("pointerdown", (event) => {
        if (window.innerWidth <= 760) return;
        event.preventDefault();
        if (appShell.classList.contains("sidebar-collapsed")) {
          setSidebarCollapsed(false);
        }
        appShell.classList.add("sidebar-resizing");
        applySidebarWidth(event.clientX);
        try { sidebarResizeHandle.setPointerCapture(event.pointerId); } catch (_) {}
        window.addEventListener("pointermove", onSidebarResizeMove);
        window.addEventListener("pointerup", onSidebarResizeUp);
        window.addEventListener("pointercancel", onSidebarResizeUp);
      });
    }
    try {
      const savedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)) || SIDEBAR_MIN_WIDTH;
      applySidebarWidth(savedWidth, savedWidth <= SIDEBAR_MAX_WIDTH);  // re-persist only if within new cap
    } catch (_) {
      applySidebarWidth(SIDEBAR_MIN_WIDTH, false);
    }
    try {
      setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_STATE_KEY) === "1");
    } catch (_) {
      setSidebarCollapsed(false);
    }
    updateWorkspaceMode();

    // Fetch session info — get is_admin / is_contributor flags + user settings
    fetch(`${API_BASE}/auth/session`).then(r => r.json()).then(data => {
      _isAdminUser = !!(data.is_admin);
      _sessionUser = data.user || {};
      _effectiveSettings = data.settings || {};
      if (data.is_contributor && !data.is_admin) {
        document.body.classList.add("is-contributor");
      }
    }).catch(() => {});
    loadPlaylists().catch(() => {});
    loadFavorites().catch(() => {});

    // ── User Settings Modal ──────────────────────────────────────────────────
    (function () {
      const modal  = document.getElementById("user-settings-modal");
      const body   = document.getElementById("user-settings-body");
      const openBtn  = document.getElementById("user-settings-btn");
      const closeBtn = document.getElementById("user-settings-close");
      const saveBtn  = document.getElementById("user-settings-save");
      const resetBtn = document.getElementById("user-settings-reset");
      if (!modal || !openBtn) return;

      let _globalSettings = [];  // [{key, label, description, type, value, can_be_overridden}]
      let _pendingValues   = {};

      async function openSettingsModal() {
        modal.style.display = "flex";
        body.innerHTML = '<div style="color:#64748b;font-size:13px;">Loading…</div>';
        try {
          const res  = await fetch(`${API_BASE}/me/settings`);
          const data = await res.json();
          _pendingValues = Object.assign({}, data.effective || {});
          // Also fetch full setting metadata from admin endpoint (admin) or use what we have
          let metaRes, metaData;
          try {
            metaRes  = await fetch(`${API_BASE}/admin/settings`);
            metaData = await metaRes.json();
            _globalSettings = metaData.settings || [];
          } catch (_) {
            // Non-admin users won't have admin endpoint access — build basic list from effective
            _globalSettings = Object.entries(data.effective || {}).map(([key, value]) => ({
              key, value, label: key, description: "", type: typeof value === "number" ? "number" : "string",
              can_be_overridden: !!(data.can_override || {})[key],
            }));
          }
          renderSettingsBody(data);
        } catch (err) {
          body.innerHTML = `<div style="color:#dc2626;font-size:13px;">${err.message}</div>`;
        }
      }

      function renderSettingsBody(data) {
        body.innerHTML = "";
        const overrideable = _globalSettings.filter(s => s.can_be_overridden);
        if (!overrideable.length) {
          body.innerHTML = '<div style="color:#64748b;font-size:13px;">No customizable settings.</div>';
          return;
        }
        for (const s of overrideable) {
          const val = Object.prototype.hasOwnProperty.call(_pendingValues, s.key) ? _pendingValues[s.key] : s.value;
          const row = document.createElement("div");
          row.style.cssText = "display:flex;flex-direction:column;gap:4px;";
          const label = document.createElement("label");
          label.style.cssText = "font-size:13px;font-weight:600;color:#374151;";
          label.textContent = s.label || s.key;
          if (s.description) {
            const desc = document.createElement("span");
            desc.style.cssText = "font-size:11px;font-weight:400;color:#6b7280;margin-left:6px;";
            desc.textContent = s.description;
            label.appendChild(desc);
          }
          let input;
          if (s.type === "boolean") {
            input = document.createElement("select");
            input.style.cssText = "padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;";
            [["true","Yes"], ["false","No"]].forEach(([v, t]) => {
              const o = document.createElement("option");
              o.value = v; o.textContent = t;
              if (String(val) === v) o.selected = true;
              input.appendChild(o);
            });
            input.addEventListener("change", () => { _pendingValues[s.key] = input.value === "true"; });
          } else {
            input = document.createElement("input");
            input.type = s.type === "number" ? "number" : "text";
            input.style.cssText = "padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;";
            input.value = val !== undefined ? val : "";
            if (s.type === "number") input.step = "any";
            input.addEventListener("input", () => {
              _pendingValues[s.key] = s.type === "number" ? Number(input.value) : input.value;
            });
          }
          row.appendChild(label);
          row.appendChild(input);
          body.appendChild(row);
        }
      }

      openBtn.addEventListener("click", openSettingsModal);
      closeBtn?.addEventListener("click", () => { modal.style.display = "none"; });
      modal.addEventListener("click", (e) => { if (e.target === modal) modal.style.display = "none"; });

      saveBtn?.addEventListener("click", async () => {
        try {
          const res  = await fetch(`${API_BASE}/me/settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(_pendingValues),
          });
          const data = await res.json();
          _effectiveSettings = Object.assign(_effectiveSettings, data.effective || {});
          modal.style.display = "none";
        } catch (err) {
          showError(err.message || "Failed to save settings.");
        }
      });

      resetBtn?.addEventListener("click", async () => {
        try {
          // Reset all overrideable settings by deleting user overrides one by one
          for (const s of _globalSettings.filter(s => s.can_be_overridden)) {
            await fetch(`${API_BASE}/me/settings/${encodeURIComponent(s.key)}`, { method: "DELETE" });
          }
          const res  = await fetch(`${API_BASE}/me/settings`);
          const data = await res.json();
          _effectiveSettings = Object.assign(_effectiveSettings, data.effective || {});
          _pendingValues = Object.assign({}, data.effective || {});
          renderSettingsBody(data);
        } catch (err) {
          showError(err.message || "Failed to reset settings.");
        }
      });
    })();

    // Clear search box — browser may autofill it with login credentials
    const _ps = document.getElementById("project-search");
    if (_ps) _ps.value = "";

    loadProjects().catch(() => {});

    // ── Change password modal ────────────────────────────────────────────────
    window._showChangePasswordModal = function _showChangePasswordModal() {
      const modal = document.getElementById("change-pw-modal");
      if (!modal) return;
      document.getElementById("cp-current").value = "";
      document.getElementById("cp-new").value = "";
      document.getElementById("cp-confirm").value = "";
      document.getElementById("change-pw-error").style.display = "none";
      document.getElementById("change-pw-ok").style.display = "none";
      modal.style.display = "flex";
    }
    document.getElementById("cp-cancel-btn")?.addEventListener("click", () => {
      document.getElementById("change-pw-modal").style.display = "none";
    });
    document.getElementById("cp-save-btn")?.addEventListener("click", async () => {
      const errEl = document.getElementById("change-pw-error");
      const okEl  = document.getElementById("change-pw-ok");
      errEl.style.display = "none";
      okEl.style.display  = "none";
      const body = {
        current_password: document.getElementById("cp-current").value,
        new_password:     document.getElementById("cp-new").value,
        confirm_password: document.getElementById("cp-confirm").value,
      };
      try {
        const res  = await fetch(`${API_BASE}/auth/change-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.ok) {
          okEl.textContent   = data.message || "Password changed successfully.";
          okEl.style.display = "block";
          setTimeout(() => { document.getElementById("change-pw-modal").style.display = "none"; }, 1800);
        } else {
          errEl.textContent   = data.error || "Failed to change password.";
          errEl.style.display = "block";
        }
      } catch {
        errEl.textContent   = "Network error. Please try again.";
        errEl.style.display = "block";
      }
    });

    async function pollStatus(jobId) {
      const response = await fetch(`${API_BASE}/jobs/${jobId}`);
      if (!response.ok) throw new Error("Failed to fetch job status.");
      const data = await response.json();
      setSourceDownloadUrl(data.source_download_url || "");

      progressSection.classList.remove("hidden");
      const displayProgress = data.status === "completed" ? 100 : Math.max(1, data.progress || 1);
      progressFill.style.width = `${displayProgress}%`;
      progressText.textContent = `${data.message || "Processing..."} (${displayProgress}%)`;

      if (data.status === "failed") {
        setCancelBtnVisible(false);
        setSplitPanelVisible(true);
        showError(data.message || "Job failed. Check job.log in the job folder.");
        clearInterval(pollTimer);
        pollTimer = null;
      }

      if (data.status === "cancelled") {
        setCancelBtnVisible(false);
        clearInterval(pollTimer);
        pollTimer = null;
        progressSection.classList.add("hidden");
        setSplitPanelVisible(true);
        showError("Separation cancelled.");
        return;
      }

      if (data.status === "completed") {
        setCancelBtnVisible(false);
        if (data.job_type === "download_only") {
          const downloadUrl = data.source_download_url || "";
          if (downloadUrl) {
            showSuccess("MP3 download is ready. Starting download...");
            clearInterval(pollTimer);
            pollTimer = null;
            window.location.assign(downloadUrl);
            return;
          }
          showSuccess(data.message || "MP3 download is ready.");
          clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        initMixer(
          data.job_id,
          data.stem_urls,
          data.stem_download_urls,
          data.download_url || "",
          data.source_download_url || "",
          {},
          { bpm: data.bpm || null, bpmSegments: data.bpm_segments || [], key: data.key || null, keyConfidence: data.key_confidence || 0, thaat: data.thaat || null, thaatAlt: data.thaat_alt || null, noteTimeline: data.note_timeline || [] },
        ).then(() => {
          setSplitPanelVisible(false);
          progressSection.classList.add("hidden");
          loadProjects(data.job_id).catch(() => {});
        }).catch((err) => {
          showError(err.message || "Split finished but mixer could not be loaded.");
        });
        card.classList.add("expanded");
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    // ── Global keyboard shortcuts ──────────────────────────────────────
    document.addEventListener("keydown", (e) => {
      // Ignore when typing in an input/textarea
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // M — drop a marker at current playhead position on the active track
      if (e.key === "m" || e.key === "M") {
        const activeTrack = mixer.tracks && mixer.tracks.find(t => t.key === mixer.activeTrackKey)
          || (mixer.tracks && mixer.tracks[0]);
        if (activeTrack && typeof activeTrack.addMarkerAtTime === "function") {
          activeTrack.addMarkerAtTime(currentOffset());
        }
      }
    });

    // ── Lite-mode + share-mode + admin init ───────────────────────────
    if (LITE_MODE) {
      document.body.classList.add("lite-mode");
    }
    if (SHARE_TOKEN) {
      document.body.classList.add("share-mode");
    }
    if (!IS_ADMIN) {
      document.body.classList.add("non-admin");
    }
    if (IS_CONTRIBUTOR) {
      document.body.classList.add("is-contributor");
    }

    // ── Share dialog ───────────────────────────────────────────────────
    const shareDialogOverlay = document.getElementById("share-dialog-overlay");
    const shareDialogFolderName = document.getElementById("share-dialog-folder-name");
    const shareDialogUrl = document.getElementById("share-dialog-url");
    const shareCopyBtn = document.getElementById("share-copy-btn");
    const shareRevokeBtn = document.getElementById("share-revoke-btn");
    const shareCloseBtn = document.getElementById("share-close-btn");
    let shareDialogToken = "";

    function openShareDialog(folderName) {
      shareDialogFolderName.textContent = `Folder: ${folderName}`;
      shareDialogUrl.textContent = "Generating link…";
      shareDialogToken = "";
      shareDialogOverlay.style.display = "flex";
      fetch(`${API_BASE}/folders/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: folderName }),
      })
        .then(r => r.json())
        .then(data => {
          if (!data.ok) throw new Error(data.error || "Failed to create share link.");
          shareDialogToken = data.token;
          shareDialogUrl.textContent = data.share_url;
        })
        .catch(err => {
          shareDialogUrl.textContent = "Error: " + (err.message || "Failed.");
        });
    }

    function closeShareDialog() {
      shareDialogOverlay.style.display = "none";
      shareDialogToken = "";
    }

    if (shareCopyBtn) {
      shareCopyBtn.addEventListener("click", () => {
        const url = shareDialogUrl.textContent.trim();
        if (!url || url.startsWith("Error") || url.startsWith("Generating")) return;
        navigator.clipboard.writeText(url).then(() => {
          const old = shareCopyBtn.textContent;
          shareCopyBtn.textContent = "Copied!";
          setTimeout(() => { shareCopyBtn.textContent = old; }, 1500);
        }).catch(() => {});
      });
    }

    if (shareRevokeBtn) {
      shareRevokeBtn.addEventListener("click", () => {
        if (!shareDialogToken) return;
        if (!window.confirm("Revoke this share link? Anyone with the current link will lose access.")) return;
        fetch(`${API_BASE}/share/${encodeURIComponent(shareDialogToken)}`, { method: "DELETE" })
          .then(r => r.json())
          .then(() => {
            closeShareDialog();
            showSuccess("Share link revoked.");
          })
          .catch(() => showError("Failed to revoke link."));
      });
    }

    if (shareCloseBtn) shareCloseBtn.addEventListener("click", closeShareDialog);
    if (shareDialogOverlay) {
      shareDialogOverlay.addEventListener("click", (e) => {
        if (e.target === shareDialogOverlay) closeShareDialog();
      });
    }

    // ── Controls toggle (mobile) ───────────────────────────────────────
    const controlsToggleBtn = document.getElementById("controls-toggle-btn");
    const controlsPanel = document.getElementById("controls-panel");
    if (controlsToggleBtn && controlsPanel) {
      controlsToggleBtn.addEventListener("click", () => {
        const open = controlsPanel.classList.toggle("open");
        controlsToggleBtn.classList.toggle("active", open);
        controlsToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }

    // ── Mini-player (mobile sticky bar) ───────────────────────────────
    const miniPlayer = document.getElementById("mini-player");
    const miniPlayBtn = document.getElementById("mini-play-btn");
    const miniStopBtn = document.getElementById("mini-stop-btn");
    const miniSeek = document.getElementById("mini-seek");
    const miniPlayerTitle = document.getElementById("mini-player-title");
    const workspaceProjectName = document.getElementById("workspace-project-name");
    const miniPlayerTime = document.getElementById("mini-player-time");
    const miniPlayIcon = document.getElementById("mini-play-icon");
    const miniPauseIcon = document.getElementById("mini-pause-icon");

    function showMiniPlayer(title) {
      if (miniPlayerTitle) miniPlayerTitle.textContent = title || "Now playing";
      if (miniPlayer) miniPlayer.classList.remove("hidden");
      if (miniPlayBtn) miniPlayBtn.disabled = false;
      if (miniStopBtn) miniStopBtn.disabled = false;
      document.body.classList.add("mini-player-visible");
    }
    function hideMiniPlayer() {
      if (miniPlayer) miniPlayer.classList.add("hidden");
      document.body.classList.remove("mini-player-visible");
    }
    function syncMiniSeek() {
      if (!miniSeek || !mixer.duration) return;
      const pos = currentOffset();
      miniSeek.value = Math.round((pos / mixer.duration) * 1000);
      if (miniPlayerTime) {
        const fmt = (s) => {
          const m = Math.floor(s / 60), sec = Math.floor(s % 60);
          return `${m}:${sec.toString().padStart(2, "0")}`;
        };
        miniPlayerTime.textContent = `${fmt(pos)} / ${fmt(mixer.duration)}`;
      }
    }

    if (miniPlayBtn) {
      miniPlayBtn.addEventListener("click", async () => {
        if (mixer.audioContext) mixer.audioContext.resume().catch(() => {});
        _enableNoSleepFromGesture();
        if (mixer.isPlaying) {
          pausePlayback();
        } else {
          await playFrom(currentOffset()).catch(() => {});
        }
        updatePlayPauseIcon();
      });
    }
    if (miniStopBtn) {
      miniStopBtn.addEventListener("click", () => {
        stopPlayback();
        updatePlayPauseIcon();
      });
    }
    if (miniSeek) {
      miniSeek.addEventListener("pointerdown", () => { miniSeek.dataset.seeking = "1"; });
      miniSeek.addEventListener("pointercancel", () => { delete miniSeek.dataset.seeking; });
      miniSeek.addEventListener("pointerup", async () => {
        delete miniSeek.dataset.seeking;
        if (!mixer.duration) return;
        const t = (miniSeek.value / 1000) * mixer.duration;
        await seekTo(t);
        syncMiniSeek();
      });
    }


    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (urlActionInput && (!sourceUrlInput || !sourceUrlInput.value.trim())) {
        urlActionInput.value = "split";
      }
      const hasFile = !!(audioFileInput && audioFileInput.files && audioFileInput.files.length);
      const hasUrl = !!(sourceUrlInput && sourceUrlInput.value.trim());
      const urlEntries = sourceUrlInput ? parseUrlEntries(sourceUrlInput.value) : [];
      const rawUrls = urlEntries.map((entry) => entry.url);
      if (!hasFile && !hasUrl) {
        showError("Upload an audio file or paste a video URL.");
        return;
      }
      if (hasFile && hasUrl) {
        showError("Use either file upload or video URL, not both.");
        return;
      }
      if (!hasFile && rawUrls.length > 1) {
        await submitUrlBatch(urlEntries);
        return;
      }

      clearStatus();
      setActiveProject("");
      card.classList.remove("expanded");
      await resetMixer();
      progressSection.classList.remove("hidden");
      progressFill.style.width = "1%";
      const isDownloadOnly = !hasFile && !!(urlActionInput && urlActionInput.value === "download_only");
      progressText.textContent = hasFile
        ? "Uploading file..."
        : (isDownloadOnly ? "Submitting link for MP3 download..." : "Submitting link...");

      try {
        const formData = new FormData(form);
        if (!hasFile && rawUrls.length === 1) {
          formData.set("source_url", rawUrls[0]);
        }
        if (urlActionInput) {
          formData.set("url_action", urlActionInput.value);
        }
        const response = await fetch(`${API_BASE}/jobs`, { method: "POST", body: formData });
        const rawBody = await response.text();
        let data = {};
        try {
          data = rawBody ? JSON.parse(rawBody) : {};
        } catch (_) {
          data = {};
        }

        if (!response.ok || !data.ok) {
          const message = data.error || `Submission failed (${response.status}).`;
          showError(message);
          return;
        }
        if (!hasFile && urlEntries.length === 1 && urlEntries[0].title) {
          await assignProjectTitles(urlEntries, [{ ok: true, job_id: data.job_id }]);
        }

        if (pollTimer) clearInterval(pollTimer);
        currentJobId = data.job_id;
        setCancelBtnVisible(true);
        setSplitPanelVisible(false);
        await pollStatus(data.job_id);
        pollTimer = setInterval(() => {
          pollStatus(data.job_id).catch((err) => {
            showError(err.message || "Failed to check progress.");
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
          });
        }, 1500);
      } catch (err) {
        const message = err && err.message ? err.message : "Network error while submitting request.";
        showError(message);
      } finally {
        if (urlActionInput) {
          urlActionInput.value = "split";
        }
      }
    });
