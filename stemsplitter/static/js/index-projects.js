    // ── Auto Marker Detection ───────────────────────────────────────────────
    // Labels that were auto-generated — matching ones are removed on revert
    const _AUTO_MARKER_RE = /^(Vocals In|Music Starts|Drums In|Bass In|Vocal \d+|Music \d+|Drums \d+|Bass \d+)$/;

    function _hasAutoMarkers() {
      return mixer.tracks.some(t => (t.markers || []).some(m => _AUTO_MARKER_RE.test(m.label)));
    }

    function _updateRevertBtn() {
      const btn = document.getElementById("revert-auto-markers-btn");
      if (btn) btn.style.display = _hasAutoMarkers() ? "flex" : "none";
    }

    document.getElementById("revert-auto-markers-btn").addEventListener("click", function() {
      let removed = 0;
      for (const track of mixer.tracks) {
        const before = (track.markers || []).length;
        track.markers = (track.markers || []).filter(m => !_AUTO_MARKER_RE.test(m.label));
        removed += before - track.markers.length;
      }
      if (removed > 0) {
        redrawAllWaveforms();
        renderMarkerChips();
        scheduleSaveProjectMetadata();
      }
      _updateRevertBtn();
    });

    // ── Auto Markers popover ─────────────────────────────────────────────────
    const _amBtn        = document.getElementById("auto-markers-btn");
    const _amPopover    = document.getElementById("auto-markers-popover");
    const _amGenerateBtn= document.getElementById("am-generate-btn");
    const _amResetBtn   = document.getElementById("am-reset-btn");
    const _amSilenceSlider  = document.getElementById("am-silence-db");
    const _amDurationSlider = document.getElementById("am-min-duration");
    const _amGapSlider      = document.getElementById("am-min-gap");
    const _amSilenceVal  = document.getElementById("am-silence-val");
    const _amDurationVal = document.getElementById("am-duration-val");
    const _amGapVal      = document.getElementById("am-gap-val");

    const _AM_DEFAULTS = { silence: 40, duration: 2, gap: 0.75 };

    function _amUpdateLabels() {
      if (_amSilenceVal)  _amSilenceVal.textContent  = `${_amSilenceSlider.value} dB`;
      if (_amDurationVal) _amDurationVal.textContent = `${parseFloat(_amDurationSlider.value).toFixed(1)} s`;
      if (_amGapVal)      _amGapVal.textContent      = `${parseFloat(_amGapSlider.value).toFixed(2)} s`;
    }

    if (_amSilenceSlider)  _amSilenceSlider.addEventListener("input",  _amUpdateLabels);
    if (_amDurationSlider) _amDurationSlider.addEventListener("input", _amUpdateLabels);
    if (_amGapSlider)      _amGapSlider.addEventListener("input",      _amUpdateLabels);

    if (_amResetBtn) _amResetBtn.addEventListener("click", () => {
      _amSilenceSlider.value  = _AM_DEFAULTS.silence;
      _amDurationSlider.value = _AM_DEFAULTS.duration;
      _amGapSlider.value      = _AM_DEFAULTS.gap;
      _amUpdateLabels();
    });

    // Toggle popover on button click
    if (_amBtn) _amBtn.addEventListener("click", () => {
      const open = _amPopover.style.display !== "none";
      _amPopover.style.display = open ? "none" : "block";
    });

    // Close popover when clicking outside
    document.addEventListener("click", (e) => {
      if (_amPopover && _amPopover.style.display !== "none") {
        if (!_amPopover.contains(e.target) && e.target !== _amBtn && !_amBtn.contains(e.target)) {
          _amPopover.style.display = "none";
        }
      }
      // Close any open mobile volume popovers
      document.querySelectorAll(".track-volume-wrap.vol-open").forEach(w => w.classList.remove("vol-open"));
    });

    async function _runAutoMarkers() {
      const jobId = mixer.jobId;
      if (!jobId) return;
      _amPopover.style.display = "none";
      const origHTML = _amBtn.innerHTML;
      _amBtn.disabled = true;
      _amBtn.textContent = "Detecting…";

      const params = {
        silence_top_db:            parseFloat(_amSilenceSlider.value),
        min_vocal_duration:        parseFloat(_amDurationSlider.value),
        min_silence_before_start:  parseFloat(_amGapSlider.value),
      };

      try {
        const r = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/auto-markers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        const d = await r.json();
        if (!d.ok) { alert(d.error || "Auto-detect failed"); return; }

        const suggested = d.markers || {};
        let added = 0;
        for (const track of mixer.tracks) {
          const stemMarkers = suggested[track.key];
          if (!stemMarkers || !stemMarkers.length) continue;
          for (const m of stemMarkers) {
            const duplicate = (track.markers || []).some(e => Math.abs(e.time - m.time) < 1.0);
            if (!duplicate) {
              track.markers = track.markers || [];
              track.markers.push({ id: m.id || (Date.now() + Math.random()), label: m.label, time: m.time });
              added++;
            }
          }
          track.markers.sort((a, b) => a.time - b.time);
        }

        if (added > 0) {
          redrawAllWaveforms();
          renderMarkerChips();
          scheduleSaveProjectMetadata();
          _updateRevertBtn();
          _amBtn.textContent = `✓ ${added} marker${added > 1 ? "s" : ""} added`;
        } else {
          _amBtn.textContent = "No new markers found";
        }
      } catch(e) {
        _amBtn.textContent = "Error";
        console.error("auto-markers:", e);
      } finally {
        setTimeout(() => {
          _amBtn.disabled = false;
          _amBtn.innerHTML = origHTML;
        }, 3000);
      }
    }

    if (_amGenerateBtn) _amGenerateBtn.addEventListener("click", _runAutoMarkers);

    function getProjectById(jobId) {
      return allProjects.find((project) => project.job_id === jobId) || null;
    }

    function setActiveProject(jobId) {
      activeProjectId = jobId || "";
      const activeProject = getProjectById(activeProjectId);
      _setActiveProjectName(activeProject ? (activeProject.name || "") : "");
      const items = projectListEl ? projectListEl.querySelectorAll(".project-item") : [];
      for (const item of items) {
        item.classList.toggle("active", item.dataset.jobId === activeProjectId);
        item.classList.toggle("menu-open", item.dataset.jobId === activeProjectMenuJobId);
      }
    }

    function getFilteredProjects(projects) {
      const entries = Array.isArray(projects) ? projects : [];
      const term = (projectSearchTerm || "").trim().toLowerCase();
      if (!term) return entries;
      return entries.filter((project) => {
        const haystack = [
          project.name || "",
          project.job_id || "",
          project.updated_at || "",
        ].join(" ").toLowerCase();
        return haystack.includes(term);
      });
    }

    // ── Build a single project-item DOM node ─────────────────────────────
    function makeProjectItem(project) {
      const item = document.createElement("div");
      item.className = "project-item";
      item.dataset.jobId = project.job_id || "";

      // Main clickable button
      const mainButton = document.createElement("button");
      mainButton.type = "button";
      mainButton.className = "project-item-main";
      const body = document.createElement("div");
      body.className = "project-item-body";
      const icon = document.createElement("span");
      icon.className = "project-icon";
      icon.textContent = userFavorites.has(project.job_id) ? "⭐" : "♪";
      const copy = document.createElement("div");
      copy.className = "project-copy";
      const displayName = formatProjectDisplayName(project);
      const isRenaming = activeProjectRenameJobId === (project.job_id || "");
      let renameInput = null;
      if (isRenaming) {
        renameInput = document.createElement("input");
        renameInput.type = "text";
        renameInput.className = "project-rename-input";
        renameInput.value = displayName;
        renameInput.maxLength = 120;
        renameInput.autocomplete = "off";
        renameInput.spellcheck = false;
        copy.appendChild(renameInput);
      } else {
        const nameRow = document.createElement("div");
        nameRow.className = "project-name-row";
        const name = document.createElement("span");
        name.className = "project-name";
        name.textContent = displayName;
        nameRow.appendChild(name);
        if (project.has_song_lyrics) {
          const lf = document.createElement("span");
          lf.className = "project-flag-icon";
          lf.title = "Has lyrics";
          lf.innerHTML = `<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>`;
          nameRow.appendChild(lf);
        }
        if (project.has_karaoke) {
          const kf = document.createElement("span");
          kf.className = "project-flag-icon project-flag-karaoke";
          kf.title = "Has karaoke timing";
          kf.innerHTML = `<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`;
          nameRow.appendChild(kf);
        }
        copy.appendChild(nameRow);
      }
      const meta = document.createElement("div");
      meta.className = "project-meta";
      const updated = document.createElement("span");
      updated.textContent = formatProjectUpdatedLabel(project.updated_at);
      meta.appendChild(updated);

      const status = project.status || "completed";
      const stemCount = Number(project.stem_count || 0);
      if (status === "completed" && stemCount > 0) {
        const divider = document.createElement("span");
        divider.className = "project-meta-divider";
        divider.textContent = "•";
        const stems = document.createElement("span");
        stems.textContent = `${stemCount} stem${stemCount === 1 ? "" : "s"}`;
        meta.appendChild(divider);
        meta.appendChild(stems);
      } else if (status === "running" || status === "queued") {
        const badge = document.createElement("span");
        badge.className = `project-item-status-badge ${status}`;
        const spinner = document.createElement("span");
        spinner.className = "project-item-spinner";
        badge.appendChild(spinner);
        badge.appendChild(document.createTextNode(status === "running" ? "Generating…" : "Queued"));
        meta.appendChild(badge);
      } else if (status === "failed") {
        const badge = document.createElement("span");
        badge.className = "project-item-status-badge failed";
        badge.textContent = "Failed";
        meta.appendChild(badge);
      }
      copy.appendChild(meta);
      body.appendChild(icon);
      body.appendChild(copy);
      mainButton.appendChild(body);
      if (!isRenaming) {
        mainButton.addEventListener("click", () => {
          openProject(project.job_id).catch((err) => showError(err.message || "Failed to open project."));
        });
      } else {
        mainButton.disabled = true;
      }

      // ⋮ menu trigger
      const menuButton = document.createElement("button");
      menuButton.type = "button";
      menuButton.className = "project-menu-trigger";
      menuButton.setAttribute("aria-label", `Project options for ${displayName}`);
      menuButton.textContent = "⋮";
      menuButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const next = activeProjectMenuJobId === project.job_id ? "" : (project.job_id || "");
        activeProjectMenuJobId = next;
        activeFolderPickerJobId = "";
        renderProjectList(allProjects);
      });

      // ⋮ menu
      const menu = document.createElement("div");
      menu.className = "project-menu";
      if (activeProjectMenuJobId === project.job_id) item.classList.add("menu-open");
      menu.addEventListener("click", (event) => event.stopPropagation());

      // Rename
      const renameAction = document.createElement("button");
      renameAction.type = "button";
      renameAction.className = "project-menu-action";
      renameAction.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"></path></svg><span>Rename project</span>';
      renameAction.addEventListener("click", () => {
        closeProjectMenu(); activeFolderPickerJobId = "";
        activeProjectRenameJobId = project.job_id || "";
        renderProjectList(allProjects);
      });

      // Add to playlist
      const playlistAction = document.createElement("button");
      playlistAction.type = "button";
      playlistAction.className = "project-menu-action";
      playlistAction.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><span>Add to playlist</span>';
      playlistAction.addEventListener("click", (e) => {
        e.stopPropagation();
        activeFolderPickerJobId = activeFolderPickerJobId === project.job_id ? "" : project.job_id;
        renderProjectList(allProjects);
      });
      // Favorite toggle
      const isFav = userFavorites.has(project.job_id);
      const favAction = document.createElement("button");
      favAction.type = "button";
      favAction.className = "project-menu-action" + (isFav ? " active" : "");
      favAction.innerHTML = isFav
        ? '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><span>Remove from Favorites</span>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><span>Add to Favorites</span>';
      favAction.style.color = isFav ? "#f59e0b" : "";
      favAction.addEventListener("click", () => {
        closeProjectMenu();
        toggleFavorite(project.job_id).catch((err) => showError(err.message || "Failed to update favorites."));
      });

      menu.appendChild(renameAction);
      menu.appendChild(favAction);
      menu.appendChild(playlistAction);

      if (_isAdminUser) {
        const separator = document.createElement("div");
        separator.className = "project-menu-separator";
        const deleteAction = document.createElement("button");
        deleteAction.type = "button";
        deleteAction.className = "project-menu-action danger";
        deleteAction.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg><span>Delete project</span>';
        deleteAction.addEventListener("click", () => {
          closeProjectMenu();
          deleteProject(project.job_id).catch((err) => showError(err.message || "Failed to delete project."));
        });
        menu.appendChild(separator);
        menu.appendChild(deleteAction);
      }

      // Playlist picker (inline checkbox list — toggle membership)
      if (activeFolderPickerJobId === project.job_id) {
        const picker = document.createElement("div");
        picker.className = "folder-picker";
        picker.addEventListener("click", (e) => e.stopPropagation());
        const pickerLabel = document.createElement("div");
        pickerLabel.className = "folder-picker-label";
        pickerLabel.textContent = "Playlists";
        picker.appendChild(pickerLabel);

        const optionsWrap = document.createElement("div");
        optionsWrap.className = "folder-picker-options";
        const projectPlaylistIds = new Set((project.playlists || []).map(p => p.id));

        for (const pl of allPlaylists) {
          const inPlaylist = projectPlaylistIds.has(pl.id);
          const opt = document.createElement("button");
          opt.type = "button";
          opt.className = "folder-picker-option";
          opt.style.cssText = "display:flex;align-items:center;gap:6px;";
          const check = document.createElement("span");
          check.textContent = inPlaylist ? "✓" : "○";
          check.style.cssText = `width:14px;text-align:center;color:${inPlaylist ? "#16a34a" : "#94a3b8"};font-weight:700;`;
          opt.appendChild(check);
          opt.appendChild(document.createTextNode((pl.is_shared ? "🎵 " : "🎧 ") + pl.name));
          opt.addEventListener("click", () => {
            const action = inPlaylist
              ? apiRemoveProjectFromPlaylist(pl.id, project.job_id)
              : apiAddProjectToPlaylist(pl.id, project.job_id);
            action
              .then(() => renderProjectList(allProjects))
              .catch((err) => showError(err.message || "Failed to update playlist."));
          });
          optionsWrap.appendChild(opt);
        }
        picker.appendChild(optionsWrap);

        // Create new playlist and add project immediately
        const newRow = document.createElement("div");
        newRow.className = "folder-picker-new-row";
        const newInput = document.createElement("input");
        newInput.type = "text";
        newInput.className = "folder-picker-new-input";
        newInput.placeholder = "New playlist…";
        newInput.maxLength = 80;
        const newConfirm = document.createElement("button");
        newConfirm.type = "button";
        newConfirm.className = "folder-picker-new-confirm";
        newConfirm.textContent = "✓";
        const createAndAdd = async () => {
          const name = (newInput.value || "").trim();
          if (!name) { newInput.focus(); return; }
          closeProjectMenu(); activeFolderPickerJobId = "";
          try {
            const pl = await apiCreatePlaylist(name, _isAdminUser);
            await apiAddProjectToPlaylist(pl.id, project.job_id);
            renderProjectList(allProjects);
          } catch (err) {
            showError(err.message || "Failed to create playlist.");
          }
        };
        newConfirm.addEventListener("click", createAndAdd);
        newInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); createAndAdd(); }
          else if (e.key === "Escape") { activeFolderPickerJobId = ""; renderProjectList(allProjects); }
        });
        newRow.appendChild(newInput);
        newRow.appendChild(newConfirm);
        picker.appendChild(newRow);
        menu.appendChild(picker);
        requestAnimationFrame(() => newInput.focus());
      }

      item.appendChild(mainButton);
      item.appendChild(menuButton);
      // Don't append menu to item — it will be moved into #project-menu-portal which
      // sits outside .project-sidebar, escaping the backdrop-filter containing block.
      if (activeProjectMenuJobId === project.job_id) {
        _activePortalMenu = menu;
      }

      // Rename input wiring
      if (renameInput) {
        let renameHandled = false;
        const commitRename = async () => {
          if (renameHandled) return;
          renameHandled = true;
          const nextName = (renameInput.value || "").trim();
          if (!nextName) { renameHandled = false; renameInput.focus(); return; }
          activeProjectRenameJobId = "";
          try {
            await saveProjectTitle(project.job_id, nextName);
          } catch (err) {
            activeProjectRenameJobId = project.job_id || "";
            renderProjectList(allProjects);
            showError(err.message || "Failed to rename project.");
          }
        };
        renameInput.addEventListener("click", (e) => e.stopPropagation());
        renameInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); commitRename(); }
          else if (e.key === "Escape") { e.preventDefault(); cancelProjectRename(); }
        });
        renameInput.addEventListener("blur", () => { if (!renameHandled) commitRename(); });
        requestAnimationFrame(() => { renameInput.focus(); renameInput.select(); });
      }

      return item;
    }

    // ── Render the full sidebar project list with folder grouping ─────────
    function renderProjectList(projects = allProjects) {
      if (!projectListEl || !projectEmptyEl) return;
      _activePortalMenu = null;   // reset before rebuild; makeProjectItem will re-set it
      projectListEl.innerHTML = "";
      const allEntries = Array.isArray(projects) ? projects : [];
      const entries = getFilteredProjects(allEntries);
      const hasContent = entries.length > 0 || (!projectSearchTerm.trim() && allPlaylists.length > 0);
      projectEmptyEl.textContent = projectSearchTerm.trim()
        ? "No matching projects found."
        : "No projects yet. Split a song to create your first project.";
      projectEmptyEl.classList.toggle("hidden", hasContent);

      // While searching: flat list, no playlist grouping
      if (projectSearchTerm.trim()) {
        const flat = [...entries];
        if (projectSortMode === "alpha") flat.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        for (const project of flat) projectListEl.appendChild(makeProjectItem(project));
        setActiveProject(activeProjectId);
        _positionProjectMenu();
        return;
      }

      // Sort entries before grouping
      const sortedEntries = [...entries];
      if (projectSortMode === "alpha") {
        sortedEntries.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      }

      // Build a set of job_ids that appear in at least one playlist
      const groupedJobIds = new Set();

      // ── Favorites section (always first) ─────────────────────────────────
      const favProjects = sortedEntries.filter(p => userFavorites.has(p.job_id));
      if (favProjects.length > 0) {
        favProjects.forEach(p => groupedJobIds.add(p.job_id));
        const favCollapsed = !!playlistCollapsed["__favorites__"];
        const favGroup = document.createElement("div");
        favGroup.className = "folder-group";
        const favHeader = document.createElement("div");
        favHeader.className = "folder-header" + (favCollapsed ? " collapsed" : "");
        favHeader.setAttribute("role", "button");
        favHeader.setAttribute("tabindex", "0");
        const favMain = document.createElement("div");
        favMain.className = "folder-main";
        const favArrow = document.createElement("span");
        favArrow.className = "folder-arrow";
        favArrow.textContent = "▾";
        const favIcon = document.createElement("span");
        favIcon.className = "folder-icon";
        favIcon.textContent = "⭐";
        const favName = document.createElement("span");
        favName.className = "folder-name";
        favName.textContent = "Favorites";
        const favCount = document.createElement("span");
        favCount.className = "folder-name-count";
        favCount.textContent = `(${favProjects.length})`;
        favName.appendChild(favCount);
        favMain.appendChild(favArrow);
        favMain.appendChild(favIcon);
        favMain.appendChild(favName);
        favHeader.appendChild(favMain);
        const toggleFavCollapse = () => {
          playlistCollapsed["__favorites__"] = !playlistCollapsed["__favorites__"];
          savePlaylistCollapsed();
          renderProjectList(allProjects);
        };
        favHeader.addEventListener("click", toggleFavCollapse);
        favHeader.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFavCollapse(); }});
        const favContainer = document.createElement("div");
        favContainer.className = "folder-projects" + (favCollapsed ? " collapsed" : "");
        for (const project of favProjects) favContainer.appendChild(makeProjectItem(project));
        favGroup.appendChild(favHeader);
        favGroup.appendChild(favContainer);
        projectListEl.appendChild(favGroup);
      }

      // Sort playlists alphabetically before rendering
      const sortedPlaylists = [...allPlaylists].sort((a, b) => (a.name || "").localeCompare(b.name || ""));

      // Render each playlist section
      for (const playlist of sortedPlaylists) {
        const plId = playlist.id;
        const plName = playlist.name;
        const plProjects = sortedEntries.filter(p =>
          Array.isArray(p.playlists) && p.playlists.some(pl => pl.id === plId)
        );
        // Mark these projects as grouped (even if playlist is empty, show section)
        plProjects.forEach(p => groupedJobIds.add(p.job_id));

        const collapsed = !!playlistCollapsed[plId];
        const isRenaming = activeFolderRenameName === String(plId);

        const group = document.createElement("div");
        group.className = "folder-group";

        const header = document.createElement("div");
        header.className = "folder-header" + (collapsed ? " collapsed" : "");
        header.setAttribute("role", "button");
        header.setAttribute("tabindex", "0");

        const mainWrap = document.createElement("div");
        mainWrap.className = "folder-main";
        const actionsWrap = document.createElement("div");
        actionsWrap.className = "folder-actions";

        const arrow = document.createElement("span");
        arrow.className = "folder-arrow";
        arrow.textContent = "▾";

        const iconEl = document.createElement("span");
        iconEl.className = "folder-icon";
        iconEl.textContent = playlist.is_shared ? "🎵" : "🎧";

        let renameInput = null;
        let nameEl = null;
        if (isRenaming) {
          renameInput = document.createElement("input");
          renameInput.type = "text";
          renameInput.className = "folder-rename-input";
          renameInput.value = plName;
          renameInput.maxLength = 80;
          renameInput.autocomplete = "off";
          renameInput.spellcheck = false;
        } else {
          nameEl = document.createElement("span");
          nameEl.className = "folder-name";
          nameEl.textContent = plName;
          const countEl = document.createElement("span");
          countEl.className = "folder-name-count";
          countEl.textContent = `(${plProjects.length})`;
          nameEl.appendChild(countEl);
        }

        // Delete button — owners and admins can delete
        const canDelete = _isAdminUser || (!playlist.owner_id || playlist.owner_id === (_sessionUser.id || ""));
        if (canDelete) {
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "folder-delete-btn";
          delBtn.title = "Delete playlist";
          delBtn.textContent = "✕";
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!confirm(`Delete playlist "${plName}"? Projects will not be deleted.`)) return;
            delete playlistCollapsed[plId];
            savePlaylistCollapsed();
            apiDeletePlaylist(plId)
              .then(() => renderProjectList(allProjects))
              .catch((err) => showError(err.message || "Failed to delete playlist."));
          });
          actionsWrap.appendChild(delBtn);
        }

        mainWrap.appendChild(arrow);
        mainWrap.appendChild(iconEl);
        if (renameInput) mainWrap.appendChild(renameInput);
        if (nameEl) mainWrap.appendChild(nameEl);
        header.appendChild(mainWrap);
        header.appendChild(actionsWrap);

        const toggleCollapse = () => {
          playlistCollapsed[plId] = !playlistCollapsed[plId];
          savePlaylistCollapsed();
          renderProjectList(allProjects);
        };
        header.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapse(); }});
        arrow.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleCollapse(); });
        iconEl.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleCollapse(); });

        if (nameEl && canDelete) {
          nameEl.addEventListener("dblclick", (e) => {
            e.preventDefault(); e.stopPropagation();
            activeFolderRenameName = String(plId);
            renderProjectList(allProjects);
          });
        }

        if (renameInput) {
          let renameHandled = false;
          const commitRename = async () => {
            if (renameHandled) return;
            renameHandled = true;
            const nextName = (renameInput.value || "").trim();
            if (!nextName) { renameHandled = false; renameInput.focus(); return; }
            activeFolderRenameName = "";
            try {
              await apiRenamePlaylist(plId, nextName);
              renderProjectList(allProjects);
            } catch (err) {
              activeFolderRenameName = String(plId);
              renderProjectList(allProjects);
              showError(err.message || "Failed to rename playlist.");
            }
          };
          renameInput.addEventListener("click", (e) => e.stopPropagation());
          renameInput.addEventListener("dblclick", (e) => e.stopPropagation());
          renameInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
            else if (e.key === "Escape") { e.preventDefault(); activeFolderRenameName = ""; renderProjectList(allProjects); }
          });
          renameInput.addEventListener("blur", () => { if (!renameHandled) commitRename(); });
          requestAnimationFrame(() => { renameInput.focus(); renameInput.select(); });
        }

        const projectsContainer = document.createElement("div");
        projectsContainer.className = "folder-projects" + (collapsed ? " collapsed" : "");
        for (const project of plProjects) {
          projectsContainer.appendChild(makeProjectItem(project));
        }

        group.appendChild(header);
        group.appendChild(projectsContainer);
        projectListEl.appendChild(group);
      }

      // Ungrouped — projects not in any playlist
      const ungrouped = sortedEntries.filter(p => !groupedJobIds.has(p.job_id));
      if (ungrouped.length > 0) {
        if (allPlaylists.length > 0) {
          const label = document.createElement("div");
          label.className = "ungrouped-label";
          label.textContent = `Ungrouped (${ungrouped.length})`;
          projectListEl.appendChild(label);
        }
        for (const project of ungrouped) projectListEl.appendChild(makeProjectItem(project));
      }

      setActiveProject(activeProjectId);
      _positionProjectMenu();
    }

    async function loadProjects(selectJobId = "", offset = 0) {
      if (SHARE_TOKEN) {
        // Share-token mode: single fetch, no pagination
        if (projectListLoadingEl) projectListLoadingEl.classList.remove("hidden");
        if (projectEmptyEl) projectEmptyEl.classList.add("hidden");
        if (projectListEl) projectListEl.innerHTML = "";
        try {
          const response = await fetch(`${API_BASE}/share/${encodeURIComponent(SHARE_TOKEN)}`);
          if (!response.ok) return;
          const payload = await response.json();
          allProjects = Array.isArray(payload.projects) ? payload.projects : [];
          projectsTotal = allProjects.length;
          renderProjectList(allProjects);
          if (selectJobId) setActiveProject(selectJobId);
        } finally {
          if (projectListLoadingEl) projectListLoadingEl.classList.add("hidden");
        }
        return;
      }

      projectsOffset = offset;
      const q = encodeURIComponent(projectSearchTerm.trim());
      const url = `${API_BASE}/projects?q=${q}&limit=${PROJECTS_PAGE_SIZE}&offset=${offset}`;
      if (projectListLoadingEl) projectListLoadingEl.classList.remove("hidden");
      if (projectEmptyEl) projectEmptyEl.classList.add("hidden");
      if (offset === 0 && projectListEl) projectListEl.innerHTML = "";
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        const payload = await response.json();
        const newProjects = Array.isArray(payload.projects) ? payload.projects : [];
        projectsTotal = payload.total || newProjects.length;
        if (offset === 0) {
          allProjects = newProjects;
        } else {
          // Append for infinite scroll / load-more
          allProjects = [...allProjects, ...newProjects];
        }
        // Keep a full folder name cache from unfiltered loads so the folder picker
        // always shows every folder even when a search term is active.
        if (!projectSearchTerm.trim()) {
          _folderNameCache = allProjects.map(p => (p.folder || "").trim()).filter(Boolean);
        }
        renderProjectList(allProjects);
        _renderLoadMoreBtn();
        if (selectJobId) setActiveProject(selectJobId);
      } finally {
        if (projectListLoadingEl) projectListLoadingEl.classList.add("hidden");
      }
    }

    function _renderLoadMoreBtn() {
      const existing = document.getElementById("projects-load-more");
      if (existing) existing.remove();
      if (!projectListEl) return;
      const remaining = projectsTotal - allProjects.length;
      if (remaining <= 0) return;
      const btn = document.createElement("button");
      btn.id = "projects-load-more";
      btn.type = "button";
      btn.textContent = `Load more (${remaining} remaining)`;
      btn.style.cssText = "width:100%;margin-top:8px;padding:7px;border-radius:8px;border:1px solid #dbe3f0;background:#f8fafc;font-size:12px;font-weight:600;color:#475569;cursor:pointer;";
      btn.addEventListener("click", () => loadProjects("", projectsOffset + PROJECTS_PAGE_SIZE));
      projectListEl.parentElement?.appendChild(btn);
    }

    async function searchProjectByUrl(url) {
      if (!url || SHARE_TOKEN) return null;
      try {
        const res = await fetch(`${API_BASE}/projects/search-url?url=${encodeURIComponent(url)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.found ? data : null;
      } catch { return null; }
    }

    async function saveProjectTitle(jobId = activeProjectId, nextTitle = "") {
      if (!jobId) return;
      const projectName = String(nextTitle || "").trim();
      if (!projectName) {
        showError("Project title cannot be empty.");
        return;
      }
      const response = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_name: projectName }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to save project title.");
      }
      if (jobId === activeProjectId) {
        _setActiveProjectName(payload.project_name || projectName);
      }
      await loadProjects(jobId);
      showSuccess("Project title saved.");
    }

    function parseUrlEntries(rawText = "") {
      const lines = String(rawText || "").split(/\r?\n/);
      const entries = [];
      let pendingTitle = "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("#")) {
          pendingTitle = line.slice(1).trim();
          continue;
        }
        entries.push({ url: line, title: pendingTitle });
        pendingTitle = "";
      }
      return entries;
    }

    async function assignProjectTitles(entries = [], jobs = []) {
      const tasks = [];
      for (let i = 0; i < Math.min(entries.length, jobs.length); i += 1) {
        const title = String(entries[i]?.title || "").trim();
        const jobId = String(jobs[i]?.job_id || "").trim();
        if (!title || !jobId || !jobs[i]?.ok) continue;
        tasks.push(
          fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project_name: title }),
          }).catch(() => null)
        );
      }
      if (tasks.length) await Promise.all(tasks);
    }

    async function deleteProject(jobId = activeProjectId) {
      if (!jobId) return;
      const project = getProjectById(jobId);
      const projectName = project?.name || activeProjectName || jobId;
      if (!window.confirm(`Delete project "${projectName}" and all files under this job? This cannot be undone.`)) {
        return;
      }
      const response = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to delete project.");
      }
      if (mixer.jobId === jobId) {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        card.classList.remove("expanded");
        await resetMixer();
      }
      activeProjectId = "";
      _setActiveProjectName("");
      activeProjectMenuJobId = "";
      await loadProjects();
      setActiveProject("");
      clearStatus();
      showSuccess("Project deleted.");
    }

    async function openProject(jobId) {
      if (!jobId) return;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // Stop any prior stem-generation poll for a different job
      if (stemProgressJobId && stemProgressJobId !== jobId) {
        stopStemProgressPoll();
        setStemProgressPanel(false);
      }
      clearStatus();
      progressSection.classList.add("hidden");
      setSplitPanelVisible(false);
      // On mobile, collapse sidebar so main panel is visible
      if (window.innerWidth <= 760) {
        setSidebarCollapsed(true);
      }
      setProjectLoading(true);
      try {
        const jobUrl = SHARE_TOKEN
          ? `${API_BASE}/share/${encodeURIComponent(SHARE_TOKEN)}/jobs/${encodeURIComponent(jobId)}`
          : `${API_BASE}/jobs/${jobId}`;
        const response = await fetch(jobUrl);
        if (!response.ok) throw new Error("Project not found.");
        const raw = await response.json();
        // Shared endpoint wraps the job in { ok, job }, normal endpoint returns it flat
        const data = (SHARE_TOKEN && raw.job) ? raw.job : raw;

        // Stems are ready — load the mixer
        if (data.status === "completed" && data.stem_urls && Object.keys(data.stem_urls).length) {
          stopStemProgressPoll();
          setStemProgressPanel(false);
          await initMixer(
            data.job_id,
            data.stem_urls,
            data.stem_download_urls,
            data.download_url || "",
            data.source_download_url || "",
            data.mixer_state || {},
            { bpm: data.bpm || null, bpmSegments: data.bpm_segments || [], key: data.key || null, keyConfidence: data.key_confidence || 0, thaat: data.thaat || null, thaatAlt: data.thaat_alt || null, noteTimeline: data.note_timeline || [] },
            data.lyrics || [],
            data.song_lyrics_text || "",
          );
          setSplitPanelVisible(false);
          card.classList.add("expanded");
          _setActiveProjectName(data.project_name || getProjectById(data.job_id)?.name || "");
          closeProjectMenu();
          setActiveProject(data.job_id);
          return;
        }

        // Job is still running / queued — show progress panel and start polling
        const projectName = data.project_name || getProjectById(jobId)?.name || `Project ${jobId.slice(0, 8)}`;
        closeProjectMenu();
        setActiveProject(jobId);
        card.classList.remove("expanded");
        startStemProgressPoll(jobId, projectName);
      } finally {
        setProjectLoading(false);
      }
    }

