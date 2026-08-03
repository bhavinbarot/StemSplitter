    // ── BPM / Key auto-analysis for old projects ──────────────────────────────
    let analyseTimer = null;
    let analyseStartedAt = 0;

    function _maybeShowReanalyzeBtn(jobId) {}

    function _analysisStageLabel(stage, progress, trackKey) {
      const pct = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Math.round(Number(progress)))) : null;
      const suffix = pct === null ? "" : ` ${pct}%`;
      if (stage === "queued") return `Preparing analysis...${suffix}`;
      if (stage === "bpm") return trackKey === "drums" ? `Detecting BPM...${suffix}` : `Analysing BPM...${suffix}`;
      if (stage === "key") return trackKey === "vocals" ? `Detecting Key...${suffix}` : `Analysing Key...${suffix}`;
      if (stage === "notes") return trackKey === "vocals" ? `Detecting Notes...${suffix}` : `Finalising...${suffix}`;
      return trackKey === "drums" ? `Detecting BPM...${suffix}` : `Detecting Key...${suffix}`;
    }

    function _setAnalysingBadges(analysing, stage = "", progress = null) {
      // Show/hide staged analysis badges on drums + vocals tracks
      for (const track of mixer.tracks) {
        if (track.key === "drums") {
          let badge = track.row?.querySelector(".bpm-badge");
          if (analysing && !badge) {
            badge = document.createElement("span");
            badge.className = "bpm-badge bpm-badge--pending";
            badge.textContent = _analysisStageLabel(stage, progress, "drums");
            track.row?.querySelector(".track-name-block")?.appendChild(badge);
          } else if (analysing && badge && badge.classList.contains("bpm-badge--pending")) {
            badge.textContent = _analysisStageLabel(stage, progress, "drums");
          } else if (!analysing && badge && badge.classList.contains("bpm-badge--pending")) {
            badge.remove();
          }
        }
        if (track.key === "vocals") {
          // Remove the manual reanalyze button while auto-analysis is running
          if (analysing) {
            track.row?.querySelector(".reanalyze-btn")?.remove();
          }
          let badge = track.row?.querySelector(".key-badge");
          if (analysing && !badge) {
            badge = document.createElement("span");
            badge.className = "key-badge key-badge--pending";
            badge.textContent = _analysisStageLabel(stage, progress, "vocals");
            track.row?.querySelector(".track-name-block")?.appendChild(badge);
          } else if (analysing && badge && badge.classList.contains("key-badge--pending")) {
            badge.textContent = _analysisStageLabel(stage, progress, "vocals");
          } else if (!analysing && badge && badge.classList.contains("key-badge--pending")) {
            badge.remove();
          }
        }
      }
    }

    function _applyAnalysisResults(data) {
      // Update mixer state with new BPM / key data
      if (data.bpm) mixer.bpm = data.bpm;
      if (data.bpm_segments) mixer.bpmSegments = data.bpm_segments;
      if (data.key)  mixer.key = data.key;
      if (data.key_confidence) mixer.keyConfidence = data.key_confidence;
      if (data.thaat) mixer.thaat = data.thaat;
      if (data.thaat_alt) mixer.thaatAlt = data.thaat_alt;

      // Remove pending badges and add real ones
      _setAnalysingBadges(false);

      for (const track of mixer.tracks) {
        const nameBlock = track.row?.querySelector(".track-name-block");
        if (!nameBlock) continue;

        if (track.key === "drums" && mixer.bpm && !nameBlock.querySelector(".bpm-badge")) {
          const badge = document.createElement("span");
          badge.className = "bpm-badge";
          const hasSegments = mixer.bpmSegments && mixer.bpmSegments.length > 1;
          badge.textContent = hasSegments ? `${mixer.bpm} BPM (variable)` : `${mixer.bpm} BPM`;
          badge.title = hasSegments
            ? mixer.bpmSegments.map((s) => `${formatTime(s.start)}–${formatTime(s.end)}: ${s.bpm} BPM`).join("\n")
            : `${mixer.bpm} BPM`;
          nameBlock.appendChild(badge);
          // Redraw waveform to show BPM segments
          redrawAllWaveforms();
        }

        if (track.key === "vocals" && mixer.key && !nameBlock.querySelector(".key-badge") && Math.round((mixer.keyConfidence || 0) * 100) >= 50) {
          const badge = document.createElement("span");
          badge.className = "key-badge";
          const displayedKey = getDisplayedKeyLabel(mixer.key);
          badge.textContent = `♪ ${displayedKey}`;
          const pct = Math.round((mixer.keyConfidence || 0) * 100);
          badge.title = `Key: ${displayedKey} (${pct}% confidence)`;
          nameBlock.appendChild(badge);
        }

        // Attach note timeline to vocals track and redraw
        if (track.key === "vocals" && data.note_timeline && data.note_timeline.length) {
          track.noteTimeline = data.note_timeline;
          redrawAllWaveforms();
        }
      }
      refreshDisplayedKeyBadges();
    }

    async function startAnalysis(jobId) {
      if (analyseTimer) { clearInterval(analyseTimer); analyseTimer = null; }
      analyseStartedAt = Date.now();
      _setAnalysingBadges(true, "queued", 5);
      try {
        const startRes = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/analyse`, { method: "POST" });
        if (!startRes.ok) {
          const payload = await startRes.json().catch(() => ({}));
          _setAnalysingBadges(false);
          showError(payload.error || "Failed to start BPM/key detection.");
          return;
        }
      } catch (err) {
        _setAnalysingBadges(false);
        showError(err.message || "Failed to start BPM/key detection.");
        return;
      }

      // Poll job status until bpm_analyse_status === "done" or "failed"
      analyseTimer = setInterval(async () => {
        try {
          if (Date.now() - analyseStartedAt > 120000) {
            clearInterval(analyseTimer);
            analyseTimer = null;
            _setAnalysingBadges(false);
            showError("BPM/key detection is taking too long. Check the job log and try again.");
            return;
          }
          const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`);
          if (!res.ok) {
            clearInterval(analyseTimer);
            analyseTimer = null;
            _setAnalysingBadges(false);
            showError("Failed to read BPM/key detection status.");
            return;
          }
          const data = await res.json();
          if (data.bpm_analyse_status === "running") {
            _setAnalysingBadges(true, data.bpm_analyse_stage, data.bpm_analyse_progress);
          }
          if (data.bpm_analyse_status === "done") {
            clearInterval(analyseTimer); analyseTimer = null;
            _applyAnalysisResults(data);
          } else if (data.bpm_analyse_status === "failed") {
            clearInterval(analyseTimer); analyseTimer = null;
            _setAnalysingBadges(false);
            showError("BPM/key detection failed. Check the job log and try again.");
          }
        } catch (err) {
          clearInterval(analyseTimer);
          analyseTimer = null;
          _setAnalysingBadges(false);
          showError(err.message || "BPM/key detection failed.");
        }
      }, 2000);
    }

    function applySidebarWidth(nextWidth, persist = true) {
      sidebarWidth = clampSidebarWidth(nextWidth);
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
      if (!appShell?.classList.contains("sidebar-collapsed") && mixer.tracks.length) {
        queueWaveformRedraw();
      }
      if (!persist) return;
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
      } catch (_) {}
    }

    function setSidebarCollapsed(collapsed) {
      if (!appShell || !sidebarToggle) return;
      appShell.classList.toggle("sidebar-collapsed", collapsed);
      sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      sidebarToggle.setAttribute("aria-label", collapsed ? "Expand projects sidebar" : "Collapse projects sidebar");
      sidebarToggle.title = collapsed ? "Expand projects sidebar" : "Collapse projects sidebar";
      try {
        window.localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? "1" : "0");
      } catch (_) {}
      if (mixer.tracks.length) {
        queueWaveformRedraw();
      }
    }

    function formatProjectDisplayName(project) {
      const explicitName = String(project?.name || "").trim();
      if (explicitName) return explicitName;
      const raw = String(project?.job_id || "").trim();
      if (!raw) return "Untitled project";
      return raw
        .replace(/^source_\d{8}_\d{6}_/i, "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (match) => match.toUpperCase()) || "Untitled project";
    }

    function formatProjectUpdatedLabel(value) {
      const text = String(value || "").trim();
      if (!text) return "Recent";
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return text.replace("T", " ");
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    }

    function setSplitPanelVisible(visible) {
      if (!splitPanel) return;
      if (visible) {
        // Leaving a project view — stop any in-progress stem generation poll
        stopStemProgressPoll();
        setStemProgressPanel(false);
      }
      splitPanel.classList.toggle("hidden", !visible);
      updateWorkspaceMode();
    }

    function setProjectLoading(loading) {
      isProjectLoading = !!loading;
      if (projectLoadingPanel) {
        projectLoadingPanel.classList.toggle("hidden", !isProjectLoading);
      }
      updateWorkspaceMode();
    }

    function setPitchLoading(loading) {
      isPitchLoading = !!loading;
      // Pitch controls
      if (pitchLoading) pitchLoading.classList.toggle("hidden", !isPitchLoading);
      if (pitchSlider) pitchSlider.disabled = isPitchLoading;
      if (pitchResetBtn) pitchResetBtn.disabled = isPitchLoading;
      if (miniPitchLoading) miniPitchLoading.classList.toggle("hidden", !isPitchLoading);
      if (miniPitchSlider) miniPitchSlider.disabled = isPitchLoading;
      if (miniPitchResetBtn) miniPitchResetBtn.disabled = isPitchLoading;
      if (typeof miniPitchIncBtn !== "undefined" && miniPitchIncBtn) miniPitchIncBtn.disabled = isPitchLoading;
      if (typeof miniPitchDecBtn !== "undefined" && miniPitchDecBtn) miniPitchDecBtn.disabled = isPitchLoading;
      // Tempo controls — also disabled/loading while audio is being reprocessed
      if (tempoLoading) tempoLoading.classList.toggle("hidden", !isPitchLoading);
      if (tempoSlider) tempoSlider.disabled = isPitchLoading;
      if (tempoResetBtn) tempoResetBtn.disabled = isPitchLoading;
      if (miniTempoLoading) miniTempoLoading.classList.toggle("hidden", !isPitchLoading);
      if (miniTempoSlider) miniTempoSlider.disabled = isPitchLoading;
      if (miniTempoResetBtn) miniTempoResetBtn.disabled = isPitchLoading;
      if (typeof miniTempoIncBtn !== "undefined" && miniTempoIncBtn) miniTempoIncBtn.disabled = isPitchLoading;
      if (typeof miniTempoDecBtn !== "undefined" && miniTempoDecBtn) miniTempoDecBtn.disabled = isPitchLoading;
      // Play button — prevent starting playback while tracks are being reprocessed
      if (playBtn) playBtn.disabled = isPitchLoading;
      if (typeof miniPlayBtn !== "undefined" && miniPlayBtn) miniPlayBtn.disabled = isPitchLoading;
    }

    function updateWorkspaceMode() {
      const inHomeMode = !isProjectLoading && !isStemProgress && !!splitPanel && !splitPanel.classList.contains("hidden");
      if (mainPane) {
        mainPane.classList.toggle("home-mode", inHomeMode);
      }
      if (card) {
        card.classList.toggle("home-card", inHomeMode);
      }
    }

    function setStemProgressPanel(visible, projectName = "", message = "", progress = 0) {
      isStemProgress = visible;
      if (stemProgressPanel) stemProgressPanel.classList.toggle("hidden", !visible);
      if (stemProgressName) stemProgressName.textContent = projectName || "";
      if (stemProgressMsg) stemProgressMsg.textContent = message || "Processing…";
      if (stemProgressBar) stemProgressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
      updateWorkspaceMode();
    }

    function stopStemProgressPoll() {
      if (stemProgressPollTimer) {
        clearInterval(stemProgressPollTimer);
        stemProgressPollTimer = null;
      }
      stemProgressJobId = null;
    }

    function startStemProgressPoll(jobId, projectName) {
      stopStemProgressPoll();
      stemProgressJobId = jobId;
      setStemProgressPanel(true, projectName, "Processing…", 5);

      async function checkStatus() {
        if (stemProgressJobId !== jobId) return;
        try {
          const resp = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`);
          if (!resp.ok) return;
          const data = await resp.json();
          const status = data.status || "queued";
          const msg = data.message || "Processing…";
          const pct = Number(data.progress || 0);
          const name = data.project_name || projectName;

          // Update sidebar item too
          const existingProject = allProjects.find(p => p.job_id === jobId);
          if (existingProject) {
            existingProject.status = status;
            existingProject.progress = pct;
            if (name) existingProject.name = name;
            renderProjectList(allProjects);
            setActiveProject(jobId);
          }

          if (status === "completed" && data.stem_urls && Object.keys(data.stem_urls).length) {
            stopStemProgressPoll();
            setStemProgressPanel(false);
            // Auto-load the mixer now that stems are ready
            await initMixer(
              data.job_id,
              data.stem_urls,
              data.stem_download_urls,
              data.download_url || "",
              data.source_download_url || "",
              data.mixer_state || {},
              { bpm: data.bpm || null, bpmSegments: data.bpm_segments || [], key: data.key || null, keyConfidence: data.key_confidence || 0, thaat: data.thaat || null, thaatAlt: data.thaat_alt || null, noteTimeline: data.note_timeline || [] },
              data.lyrics || [],
            );
            setSplitPanelVisible(false);
            card.classList.add("expanded");
            _setActiveProjectName(data.project_name || projectName);
            return;
          }

          if (status === "failed") {
            stopStemProgressPoll();
            setStemProgressPanel(true, name, `Failed: ${msg}`, 100);
            return;
          }

          setStemProgressPanel(true, name, msg, pct);
        } catch (_) {}
      }

      checkStatus();
      stemProgressPollTimer = setInterval(checkStatus, 4000);
    }

    function getTrackTheme(trackKey) {
      const key = String(trackKey || "").toLowerCase();
      if (key === "vocals") return { accent: "#7c3aed", soft: "#f3e8ff", status: "Lead stem" };
      if (key === "drums") return { accent: "#ea580c", soft: "#fff7ed", status: "Rhythm stem" };
      if (key === "bass") return { accent: "#16a34a", soft: "#ecfdf5", status: "Low-end stem" };
      if (key === "others" || key === "other") return { accent: "#2563eb", soft: "#eff6ff", status: "Instrument stem" };
      return { accent: "#2563eb", soft: "#eff6ff", status: "Instrument stem" };
    }

    function getTrackSortOrder(trackKey) {
      const key = String(trackKey || "").toLowerCase();
      if (key === "vocals") return 0;
      if (key === "drums") return 1;
      if (key === "others") return 2;
      if (key === "bass") return 3;
      return 99;
    }

    function getTrackTypeIcon(trackKey) {
      const key = String(trackKey || "").toLowerCase();
      if (key === "vocals") {
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 14a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v4.5A3.5 3.5 0 0 0 12 14Z"></path>
            <path d="M6.5 10.5a5.5 5.5 0 0 0 11 0"></path>
            <path d="M12 14v5"></path>
            <path d="M9 19h6"></path>
          </svg>
        `;
      }
      if (key === "drums") {
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 9.5c0-1.9 3.1-3.5 7-3.5s7 1.6 7 3.5-3.1 3.5-7 3.5-7-1.6-7-3.5Z"></path>
            <path d="M5 9.5v5c0 1.9 3.1 3.5 7 3.5s7-1.6 7-3.5v-5"></path>
            <path d="M8 7.5V5"></path>
            <path d="M16 7.5V5"></path>
          </svg>
        `;
      }
      if (key === "bass") {
        return `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17 4a4 4 0 0 0-4 4v9.5a2.5 2.5 0 1 0 1.5 2.3V10.2a7.8 7.8 0 0 0 4.5 1.3"></path>
            <path d="M14.5 8.3c1.8 1.3 3.4 1.9 4.5 1.9V4.8c-1.7 0-3.3 1.3-4.5 3.5Z"></path>
          </svg>
        `;
      }
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 17V7"></path>
          <path d="M8 20V4"></path>
          <path d="M12 16v-8"></path>
          <path d="M16 19V5"></path>
          <path d="M20 14v-4"></path>
        </svg>
      `;
    }

    function setActiveTrack(trackKey = "") {
      activeTrackKey = trackKey || "";
      for (const track of mixer.tracks) {
        if (!track.row) continue;
        track.row.classList.toggle("track-active", !!activeTrackKey && track.key === activeTrackKey);
      }
    }

    function getMaxVisibleDuration() {
      return Math.max(0.1, mixer.duration || 0.1);
    }

    function getMinVisibleDuration() {
      return Math.min(MIN_VISIBLE_DURATION, getMaxVisibleDuration());
    }

    function clampVisibleDuration(value) {
      return Math.max(getMinVisibleDuration(), Math.min(getMaxVisibleDuration(), value));
    }

    function clampVisibleStart(start, duration = mixer.visibleDuration || getMaxVisibleDuration()) {
      const safeDuration = clampVisibleDuration(duration);
      const maxStart = Math.max(0, (mixer.duration || 0) - safeDuration);
      return Math.max(0, Math.min(maxStart, start));
    }

    function setViewportWindow(start, duration) {
      const safeDuration = clampVisibleDuration(duration);
      mixer.visibleDuration = safeDuration;
      mixer.visibleStart = clampVisibleStart(start, safeDuration);
    }

    function getViewportEnd() {
      return (mixer.visibleStart || 0) + (mixer.visibleDuration || getMaxVisibleDuration());
    }

    function getViewportCenterTime() {
      return (mixer.visibleStart || 0) + ((mixer.visibleDuration || getMaxVisibleDuration()) / 2);
    }

    function timeToViewportX(time, width) {
      const start = mixer.visibleStart || 0;
      const duration = mixer.visibleDuration || getMaxVisibleDuration();
      return ((time - start) / Math.max(0.0001, duration)) * width;
    }

    function viewportXToTime(x, width) {
      const start = mixer.visibleStart || 0;
      const duration = mixer.visibleDuration || getMaxVisibleDuration();
      const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)));
      return start + ratio * duration;
    }

    function ensureTimeVisible(time) {
      const duration = mixer.visibleDuration || getMaxVisibleDuration();
      const start = mixer.visibleStart || 0;
      const end = start + duration;
      if (time >= start && time <= end) return;
      setViewportWindow(time - (duration / 2), duration);
    }

    function zoomViewport(nextDuration, anchorTime = getViewportCenterTime()) {
      const clampedDuration = clampVisibleDuration(nextDuration);
      const currentDuration = mixer.visibleDuration || getMaxVisibleDuration();
      const ratio = Math.max(0, Math.min(1, (anchorTime - (mixer.visibleStart || 0)) / Math.max(0.0001, currentDuration)));
      const nextStart = anchorTime - clampedDuration * ratio;
      setViewportWindow(nextStart, clampedDuration);
      updateToolReadouts();
      queueWaveformRedraw();
    }

    function zoomViewportByFactor(factor, anchorTime = getViewportCenterTime()) {
      zoomViewport((mixer.visibleDuration || getMaxVisibleDuration()) * factor, anchorTime);
    }

    function panViewportBy(deltaSeconds) {
      setViewportWindow((mixer.visibleStart || 0) + deltaSeconds, mixer.visibleDuration || getMaxVisibleDuration());
      queueWaveformRedraw();
    }

    function getZoomDisplayPercent() {
      const fullDuration = getMaxVisibleDuration();
      const visibleDuration = mixer.visibleDuration || fullDuration;
      return Math.max(100, Math.round((fullDuration / Math.max(getMinVisibleDuration(), visibleDuration)) * 100));
    }

    function getZoomPresetLabel(seconds) {
      if (seconds === null || seconds === undefined) return "All";
      if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
      if (seconds < 60) return `${seconds}s`;
      return `${Math.round(seconds / 60)}m`;
    }

    function getCurrentZoomLabel() {
      const vd = mixer.visibleDuration || getMaxVisibleDuration();
      const full = getMaxVisibleDuration();
      if (!mixer.duration || Math.abs(vd - full) / Math.max(full, 0.0001) < 0.05) return "All";
      let closestPreset = null;
      let closestDiff = Infinity;
      for (const p of ZOOM_PRESETS) {
        if (p === null) continue;
        const diff = Math.abs(vd - p);
        if (diff < closestDiff) { closestDiff = diff; closestPreset = p; }
      }
      return getZoomPresetLabel(closestPreset);
    }

    function getTrackViewportWidth(track) {
      const width = track.waveWrap?.getBoundingClientRect().width || track.mainEl?.getBoundingClientRect().width || track.row?.getBoundingClientRect().width || 0;
      return Math.max(1, Math.round(width || 680));
    }

    function queueWaveformRedraw() {
      if (redrawQueued) return;
      redrawQueued = true;
      requestAnimationFrame(() => {
        redrawQueued = false;
        redrawAllWaveforms();
      });
    }

    function buildMixerStatePayload() {
      const tracks = {};
      for (const track of mixer.tracks) {
        tracks[track.key] = {
          muted: !!track.muted,
          volume: Number.isFinite(track.volume) ? track.volume : 1,
          markers: (track.markers || []).map((marker) => ({
            id: String(marker.id || ""),
            label: String(marker.label || ""),
            time: Number.isFinite(marker.time) ? marker.time : 0,
          })),
        };
      }
      return {
        // tempo_pct and pitch_semitones are intentionally excluded here —
        // they are personal preferences saved per-user via the overlay API.
        loop_start: mixer.loopStart,
        loop_end: mixer.loopEnd,
        loop_enabled: !!mixer.loopEnabled,
        tracks,
      };
    }

    // Save tempo + pitch to the current user's overlay (not job.json)
    let _overlayTpTimer = null;
    function scheduleSaveTempoPixchOverlay() {
      if (!mixer.jobId || SHARE_TOKEN) return;
      clearTimeout(_overlayTpTimer);
      _overlayTpTimer = setTimeout(async () => {
        try {
          await fetch(`${API_BASE}/jobs/${encodeURIComponent(mixer.jobId)}/overlay`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mixer_state: {
                tempo_pct: Number(mixer.tempoPct || 100),
                pitch_semitones: Number(mixer.pitchSemitones || 0),
              },
            }),
          });
        } catch (_) {}
      }, 400);
    }

    async function persistProjectMetadata() {
      if (!mixer.jobId || isRestoringProjectState) return;
      try {
        await fetch(`${API_BASE}/jobs/${encodeURIComponent(mixer.jobId)}/metadata`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildMixerStatePayloadWithLyrics()),
        });
      } catch (err) {
        console.error("Failed to save project metadata.", err);
      }
    }

    function scheduleSaveProjectMetadata() {
      if (!mixer.jobId || isRestoringProjectState) return;
      if (metadataSaveTimer) clearTimeout(metadataSaveTimer);
      metadataSaveTimer = setTimeout(() => {
        metadataSaveTimer = null;
        persistProjectMetadata();
      }, 350);
    }

