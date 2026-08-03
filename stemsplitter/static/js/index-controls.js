    // ── Tempo / Pitch badge popovers ────────────────────────────────────────
    function closeAllBadgePopovers() {
      tempoPopover && tempoPopover.classList.add("hidden");
      pitchPopover && pitchPopover.classList.add("hidden");
      tempoBadgeBtn && tempoBadgeBtn.classList.remove("open");
      pitchBadgeBtn && pitchBadgeBtn.classList.remove("open");
    }
    if (tempoBadgeBtn && tempoPopover) {
      tempoBadgeBtn.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
      tempoBadgeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const wasHidden = tempoPopover.classList.contains("hidden");
        closeAllBadgePopovers();
        if (wasHidden) {
          tempoPopover.classList.remove("hidden");
          tempoBadgeBtn.classList.add("open");
        }
      });
    }
    if (pitchBadgeBtn && pitchPopover) {
      pitchBadgeBtn.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
      pitchBadgeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const wasHidden = pitchPopover.classList.contains("hidden");
        closeAllBadgePopovers();
        if (wasHidden) {
          pitchPopover.classList.remove("hidden");
          pitchBadgeBtn.classList.add("open");
        }
      });
    }
    // Use pointerdown (not click) so tapping non-interactive elements on iOS Safari
    // also dismisses the popover — iOS doesn't fire click on divs/spans without cursor:pointer.
    document.addEventListener("pointerdown", (ev) => {
      if (!ev.target.closest(".tp-badge-wrap")) closeAllBadgePopovers();
    });

    // ── Mini-player Tempo / Pitch separate panels ───────────────────────────
    const miniTempoBadgeBtn  = document.getElementById("mini-tempo-badge-btn");
    const miniPitchBadgeBtn  = document.getElementById("mini-pitch-badge-btn");
    const miniTempoBadgeVal  = document.getElementById("mini-tempo-badge-val");
    const miniPitchBadgeVal  = document.getElementById("mini-pitch-badge-val");
    const miniTempoPanel     = document.getElementById("mini-tempo-panel");
    const miniPitchPanel     = document.getElementById("mini-pitch-panel");
    const miniTempoSlider    = document.getElementById("mini-tempo-slider");
    const miniPitchSlider    = document.getElementById("mini-pitch-slider");
    const miniTempoResetBtn  = document.getElementById("mini-tempo-reset-btn");
    const miniPitchResetBtn  = document.getElementById("mini-pitch-reset-btn");
    const miniTempoIncBtn    = document.getElementById("mini-tempo-inc");
    const miniTempoDecBtn    = document.getElementById("mini-tempo-dec");
    const miniPitchIncBtn    = document.getElementById("mini-pitch-inc");
    const miniPitchDecBtn    = document.getElementById("mini-pitch-dec");
    const miniTempoValue     = document.getElementById("mini-tempo-value");
    const miniPitchValue     = document.getElementById("mini-pitch-value");
    const miniPitchLoading   = document.getElementById("mini-pitch-loading");
    const miniTempoLoading   = document.getElementById("mini-tempo-loading");

    function closeAllMiniPopovers() {
      miniTempoPanel && miniTempoPanel.classList.add("hidden");
      miniPitchPanel && miniPitchPanel.classList.add("hidden");
    }
    function syncMiniTempoPitch() {
      const tempoChanged = mixer.tempoPct !== 100;
      const pitchChanged = mixer.pitchSemitones !== 0;
      if (miniTempoBadgeVal) miniTempoBadgeVal.textContent = `${mixer.tempoPct}%`;
      if (miniTempoValue) miniTempoValue.textContent = `${mixer.tempoPct}%`;
      if (miniPitchBadgeVal) miniPitchBadgeVal.textContent = getPitchShortLabel();
      if (miniPitchValue) miniPitchValue.textContent = getPitchShortLabel();
      if (miniTempoBadgeBtn) miniTempoBadgeBtn.classList.toggle("active", tempoChanged);
      if (miniPitchBadgeBtn) {
        miniPitchBadgeBtn.classList.toggle("active", pitchChanged);
        miniPitchBadgeBtn.title = getPitchLongLabel();
      }
      if (miniTempoSlider) miniTempoSlider.value = String(mixer.tempoPct);
      if (miniPitchSlider) miniPitchSlider.value = String(mixer.pitchSemitones);
      // Show reset buttons only when value differs from default
      if (miniTempoResetBtn) miniTempoResetBtn.classList.toggle("active", tempoChanged);
      if (miniPitchResetBtn) miniPitchResetBtn.classList.toggle("active", pitchChanged);
    }

    // Tempo badge toggles only the Tempo panel
    if (miniTempoBadgeBtn && miniTempoPanel) {
      miniTempoBadgeBtn.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
      miniTempoBadgeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const wasHidden = miniTempoPanel.classList.contains("hidden");
        closeAllMiniPopovers();
        closeAllBadgePopovers();
        if (wasHidden) miniTempoPanel.classList.remove("hidden");
      });
    }
    // Pitch badge toggles only the Pitch panel
    if (miniPitchBadgeBtn && miniPitchPanel) {
      miniPitchBadgeBtn.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
      miniPitchBadgeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const wasHidden = miniPitchPanel.classList.contains("hidden");
        closeAllMiniPopovers();
        closeAllBadgePopovers();
        if (wasHidden) miniPitchPanel.classList.remove("hidden");
      });
    }

    // Tempo slider
    if (miniTempoSlider) {
      miniTempoSlider.addEventListener("input", () => {
        if (mixer.isPlaying) { _tempoWasPlaying = true; pausePlayback(); }
        mixer.tempoPct = Number(miniTempoSlider.value);
        if (tempoSlider) tempoSlider.value = miniTempoSlider.value;
        syncMiniTempoPitch();
        updateToolReadouts();
        _scheduleTempoCompensation();
      });
      miniTempoSlider.addEventListener("change", () => {
        clearTimeout(_tempoDebounceTimer);
        const resume = _tempoWasPlaying;
        _tempoWasPlaying = false;
        applyPitchShift(resume)
          .then(() => scheduleSaveTempoPixchOverlay())
          .catch((err) => showError(err.message || "Failed to apply tempo."));
      });
    }
    // Tempo +/- step buttons
    if (miniTempoIncBtn) {
      miniTempoIncBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const next = Math.min(150, (mixer.tempoPct || 100) + 1);
        mixer.tempoPct = next;
        if (miniTempoSlider) miniTempoSlider.value = String(next);
        if (tempoSlider) tempoSlider.value = String(next);
        syncMiniTempoPitch();
        updateToolReadouts();
        applyPitchShift().then(() => scheduleSaveTempoPixchOverlay()).catch(() => {});
      });
    }
    if (miniTempoDecBtn) {
      miniTempoDecBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const next = Math.max(50, (mixer.tempoPct || 100) - 1);
        mixer.tempoPct = next;
        if (miniTempoSlider) miniTempoSlider.value = String(next);
        if (tempoSlider) tempoSlider.value = String(next);
        syncMiniTempoPitch();
        updateToolReadouts();
        applyPitchShift().then(() => scheduleSaveTempoPixchOverlay()).catch(() => {});
      });
    }
    // Tempo reset
    if (miniTempoResetBtn) {
      miniTempoResetBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        mixer.tempoPct = 100;
        if (tempoSlider) tempoSlider.value = "100";
        syncMiniTempoPitch();
        updateToolReadouts();
        applyPitchShift()
          .then(() => scheduleSaveTempoPixchOverlay())
          .catch((err) => showError(err.message || "Failed to reset tempo."));
      });
    }

    // Pitch slider
    if (miniPitchSlider) {
      miniPitchSlider.addEventListener("input", () => {
        mixer.pitchSemitones = Number(miniPitchSlider.value);
        if (pitchSlider) pitchSlider.value = miniPitchSlider.value;
        syncMiniTempoPitch();
        updateToolReadouts();
      });
      miniPitchSlider.addEventListener("change", () => {
        mixer.pitchSemitones = Number(miniPitchSlider.value);
        if (pitchSlider) pitchSlider.value = miniPitchSlider.value;
        syncMiniTempoPitch();
        updateToolReadouts();
        applyPitchShift()
          .then(() => scheduleSaveTempoPixchOverlay())
          .catch((err) => showError(err.message || "Failed to apply pitch."));
      });
    }
    // Pitch +/- step buttons
    if (miniPitchIncBtn) {
      miniPitchIncBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const next = Math.min(12, (mixer.pitchSemitones || 0) + 1);
        mixer.pitchSemitones = next;
        if (miniPitchSlider) miniPitchSlider.value = String(next);
        if (pitchSlider) pitchSlider.value = String(next);
        syncMiniTempoPitch();
        updateToolReadouts();
        applyPitchShift().then(() => scheduleSaveTempoPixchOverlay()).catch(() => {});
      });
    }
    if (miniPitchDecBtn) {
      miniPitchDecBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const next = Math.max(-12, (mixer.pitchSemitones || 0) - 1);
        mixer.pitchSemitones = next;
        if (miniPitchSlider) miniPitchSlider.value = String(next);
        if (pitchSlider) pitchSlider.value = String(next);
        syncMiniTempoPitch();
        updateToolReadouts();
        applyPitchShift().then(() => scheduleSaveTempoPixchOverlay()).catch(() => {});
      });
    }
    // Pitch reset
    if (miniPitchResetBtn) {
      miniPitchResetBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        mixer.pitchSemitones = 0;
        if (pitchSlider) pitchSlider.value = "0";
        if (miniPitchSlider) miniPitchSlider.value = "0";
        syncMiniTempoPitch();
        updateToolReadouts();
        applyPitchShift()
          .then(() => scheduleSaveTempoPixchOverlay())
          .catch((err) => showError(err.message || "Failed to reset pitch."));
      });
    }

    // Dismiss panels when tapping outside
    document.addEventListener("pointerdown", (ev) => {
      if (!ev.target.closest("#mini-tempo-panel") &&
          !ev.target.closest("#mini-pitch-panel") &&
          !ev.target.closest("#mini-tempo-badge-btn") &&
          !ev.target.closest("#mini-pitch-badge-btn")) {
        closeAllMiniPopovers();
      }
    });

    // ── Mini-player loop controls ───────────────────────────────────────────
    const miniSetLoopStart  = document.getElementById("mini-set-loop-start");
    const miniSetLoopEnd    = document.getElementById("mini-set-loop-end");
    const miniLoopToggleBtn = document.getElementById("mini-loop-toggle-btn");
    const miniClearLoop     = document.getElementById("mini-clear-loop");
    const miniLoopValue     = document.getElementById("mini-loop-value");

    function syncMiniLoopUI() {
      const hasA = mixer.loopStart !== null;
      const hasB = mixer.loopEnd !== null;
      const hasBoth = hasA && hasB;

      // A button — highlight when set
      if (miniSetLoopStart) miniSetLoopStart.classList.toggle("active", hasA);

      // B button — highlight when set
      if (miniSetLoopEnd) miniSetLoopEnd.classList.toggle("active", hasB);

      // Toggle + Clear — only visible when both A and B are set
      if (miniLoopToggleBtn) {
        miniLoopToggleBtn.style.display = hasBoth ? "" : "none";
        miniLoopToggleBtn.classList.toggle("active", !!mixer.loopEnabled);
      }
      if (miniClearLoop) miniClearLoop.style.display = hasBoth ? "" : "none";

      // Loop range label
      if (miniLoopValue) {
        miniLoopValue.style.display = hasBoth ? "" : "none";
        if (hasBoth) miniLoopValue.textContent = `${formatTime(mixer.loopStart)}–${formatTime(mixer.loopEnd)}`;
      }
    }

    miniSetLoopStart && miniSetLoopStart.addEventListener("click", () => {
      setLoopStartBtn.click();
      syncMiniLoopUI();
    });
    miniSetLoopEnd && miniSetLoopEnd.addEventListener("click", () => {
      setLoopEndBtn.click();
      syncMiniLoopUI();
    });
    miniLoopToggleBtn && miniLoopToggleBtn.addEventListener("click", () => {
      loopToggleBtn.click();
      syncMiniLoopUI();
    });
    miniClearLoop && miniClearLoop.addEventListener("click", () => {
      clearLoopBtn.click();
      syncMiniLoopUI();
    });

    // Zoom slider — slider value 0=fully zoomed out (100%), 1000=max zoom in
    function zoomSliderToVisibleDuration(sliderVal) {
      const minD = getMinVisibleDuration();
      const maxD = getMaxVisibleDuration();
      // Logarithmic mapping: 0 → maxD, 1000 → minD
      const t = sliderVal / 1000;
      return maxD * Math.pow(minD / maxD, t);
    }
    function visibleDurationToZoomSlider(visibleDuration) {
      const minD = getMinVisibleDuration();
      const maxD = getMaxVisibleDuration();
      if (maxD <= minD) return 0;
      return Math.round(Math.log(visibleDuration / maxD) / Math.log(minD / maxD) * 1000);
    }
    function syncZoomSlider() {
      if (!mixer.duration) return;
      const val = String(visibleDurationToZoomSlider(mixer.visibleDuration || getMaxVisibleDuration()));
      if (zoomSlider) zoomSlider.value = val;
      if (lyricsVocalsZoomSlider) lyricsVocalsZoomSlider.value = val;
      if (lyricsVocalsZoomPct) lyricsVocalsZoomPct.textContent = getCurrentZoomLabel();
    }
    if (zoomSlider) {
      zoomSlider.addEventListener("input", () => {
        const anchor = mixer.isPlaying ? currentOffset() : getViewportCenterTime();
        zoomViewport(zoomSliderToVisibleDuration(Number(zoomSlider.value)), anchor);
        if (activeWorkspaceTab === "timing" && !_vocalsWaveHidden) {
          drawLyricsVocalsWaveform();
          updateLyricsVocalsMarkLines();
          updateLyricsVocalsPlayhead(currentOffset());
        }
      });
    }
    setLoopStartBtn.addEventListener("click", () => {
      mixer.loopStart = currentOffset();
      if (mixer.loopEnd !== null && mixer.loopEnd <= mixer.loopStart) mixer.loopEnd = null;
      loopStartInput.value = formatSeconds(mixer.loopStart);
      updateToolReadouts();
      redrawAllWaveforms();
      scheduleSaveProjectMetadata();
    });
    setLoopEndBtn.addEventListener("click", () => {
      if (mixer.loopStart === null) {
        mixer.loopStart = 0;
      }
      applyLoopRange(mixer.loopStart, currentOffset());
      if (mixer.loopStart !== null && mixer.loopEnd !== null && mixer.loopEnd > mixer.loopStart) {
        mixer.loopEnabled = true;
        updateToolReadouts();
        scheduleSaveProjectMetadata();
      }
    });
    clearLoopBtn.addEventListener("click", () => {
      mixer.loopStart = null;
      mixer.loopEnd = null;
      mixer.loopEnabled = false;
      loopStartInput.value = "0.00";
      loopEndInput.value = "0.00";
      updateToolReadouts();
      redrawAllWaveforms();
      scheduleSaveProjectMetadata();
    });
    loopToggleBtn.addEventListener("click", () => {
      mixer.loopEnabled = !mixer.loopEnabled;
      if (mixer.loopEnabled && mixer.loopStart !== null && mixer.loopEnd !== null && mixer.loopEnd > mixer.loopStart) {
        playFrom(mixer.loopStart).catch((err) => showError(err.message || "Failed to start loop."));
      }
      updateToolReadouts();
      scheduleSaveProjectMetadata();
    });
    applyLoopRangeBtn.addEventListener("click", () => {
      applyLoopRange(Number(loopStartInput.value), Number(loopEndInput.value));
    });
    loopStartInput.addEventListener("change", () => {
      applyLoopRange(Number(loopStartInput.value), Number(loopEndInput.value));
    });
    loopEndInput.addEventListener("change", () => {
      applyLoopRange(Number(loopStartInput.value), Number(loopEndInput.value));
    });
    downloadAllBtn.addEventListener("click", () => {
      if (!mixer.zipDownloadUrl) return;
      window.open(mixer.zipDownloadUrl, "_self");
    });

    if (exportProjectBtn) {
      exportProjectBtn.addEventListener("click", async () => {
        if (!mixer.jobId) return;
        // Save latest mixer state first so markers/settings are current
        await persistProjectMetadata().catch(() => {});
        const url = `${API_BASE}/jobs/${encodeURIComponent(mixer.jobId)}/export-project`;
        const a = document.createElement("a");
        a.href = url;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    }

    async function submitUrlBatch(entries = []) {
      const cleanEntries = entries
        .map((entry) => ({
          url: String(entry?.url || "").trim(),
          title: String(entry?.title || "").trim(),
        }))
        .filter((entry) => entry.url);
      const cleanUrls = cleanEntries.map((entry) => entry.url);
      if (!cleanUrls.length) {
        showError("Paste one or more URLs.");
        return false;
      }

      // Use current form settings if available
      const sepMode = document.getElementById("separation_mode")?.value || "full";
      const outFmt = document.getElementById("output_format")?.value || "mp3";

      clearStatus();
      setActiveProject("");
      card.classList.remove("expanded");
      await resetMixer();
      progressSection.classList.remove("hidden");
      progressFill.style.width = "6%";
      progressText.textContent = cleanUrls.length === 1 ? "Submitting link..." : `Queuing ${cleanUrls.length} tracks…`;

      try {
        const resp = await fetch(`${API_BASE}/jobs/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: cleanUrls,
            separation_mode: sepMode,
            output_format: outFmt,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || "URL submission failed.");
        }
        await assignProjectTitles(cleanEntries, data.jobs || []);

        const okJobs = (data.jobs || []).filter((job) => job.ok);
        const failedJobs = (data.jobs || []).filter((job) => !job.ok);
        if (failedJobs.length && !okJobs.length) {
          throw new Error(failedJobs[0].error || "No valid URLs found.");
        }

        if (cleanUrls.length === 1 && okJobs.length === 1) {
          if (pollTimer) clearInterval(pollTimer);
          currentJobId = okJobs[0].job_id;
          setCancelBtnVisible(true);
          setSplitPanelVisible(false);
          await pollStatus(okJobs[0].job_id);
          pollTimer = setInterval(() => {
            pollStatus(okJobs[0].job_id).catch((err) => {
              showError(err.message || "Failed to check progress.");
              if (pollTimer) clearInterval(pollTimer);
              pollTimer = null;
            });
          }, 1500);
          return true;
        }

        progressFill.style.width = "100%";
        progressText.textContent = `Queued ${okJobs.length} job${okJobs.length === 1 ? "" : "s"}.`;
        setCancelBtnVisible(false);
        setSplitPanelVisible(true);
        await loadProjects(okJobs[0]?.job_id || "");
        if (failedJobs.length) {
          showError(`${failedJobs.length} URL${failedJobs.length === 1 ? "" : "s"} could not be queued.`);
        } else {
          showSuccess(`Queued ${okJobs.length} URL${okJobs.length === 1 ? "" : "s"}.`);
        }
        return true;
      } catch (err) {
        showError(err.message || "URL submission failed.");
        return false;
      }
    }

    if (importProjectBtn && importProjectInput) {
      importProjectBtn.addEventListener("click", () => importProjectInput.click());
      importProjectInput.addEventListener("change", async () => {
        const file = importProjectInput.files?.[0];
        if (!file) return;
        importProjectInput.value = "";
        importProjectBtn.disabled = true;
        importProjectBtn.textContent = "Importing...";
        try {
          const formData = new FormData();
          formData.append("project_zip", file);
          const res = await fetch(`${API_BASE}/projects/import`, { method: "POST", body: formData });
          const data = await res.json();
          if (!data.ok) { showError(data.error || "Import failed."); return; }
          await loadProjects(data.job_id);
          await openProject(data.job_id);
        } catch (err) {
          showError(err.message || "Import failed.");
        } finally {
          importProjectBtn.disabled = false;
          importProjectBtn.textContent = "Import Project";
        }
      });
    }
    if (downloadMixBtn) {
      downloadMixBtn.addEventListener("click", async () => {
        if (!mixer.jobId || !mixer.tracks.length) return;
        const originalLabel = downloadMixBtn.textContent;
        downloadMixBtn.disabled = true;
        downloadMixBtn.textContent = "Rendering Mix...";
        try {
          const payload = {
            tempo_pct: Number(mixer.tempoPct || 100),
            pitch_semitones: Number(mixer.pitchSemitones || 0),
            tracks: {},
          };
          for (const track of mixer.tracks) {
            payload.tracks[track.key] = {
              muted: !!track.muted,
              volume: Number.isFinite(track.volume) ? track.volume : 1,
            };
          }
          const response = await fetch(`${API_BASE}/jobs/${encodeURIComponent(mixer.jobId)}/mix-download`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            let errorMessage = "Failed to render mixed audio.";
            try {
              const body = await response.json();
              if (body && body.error) errorMessage = body.error;
            } catch (_) {}
            throw new Error(errorMessage);
          }
          const blob = await response.blob();
          const fallbackName = `${mixer.jobId}_mix.mp3`;
          const filename = parseDownloadFilename(response.headers.get("content-disposition"), fallbackName);
          downloadBlob(blob, filename);
          showSuccess("Final mixed audio downloaded.");
        } catch (err) {
          showError(err.message || "Failed to download final mix.");
        } finally {
          downloadMixBtn.disabled = false;
          downloadMixBtn.textContent = originalLabel;
        }
      });
    }
    sourceDownloadBtn.addEventListener("click", () => {
      if (!sourceDownloadUrl) return;
      window.open(sourceDownloadUrl, "_self");
    });

    if (cancelJobBtn) {
      cancelJobBtn.addEventListener("click", async () => {
        if (!currentJobId || cancelJobBtn.classList.contains("cancelling")) return;
        cancelJobBtn.classList.add("cancelling");
        cancelJobBtn.disabled = true;
        cancelJobBtn.textContent = "Cancelling...";
        try {
          await fetch(`${API_BASE}/jobs/${encodeURIComponent(currentJobId)}/cancel`, { method: "POST" });
        } catch (_) {
          // pollStatus will pick up the cancelled state
        }
      });
    }
    document.addEventListener("click", () => {
      if (!activeProjectMenuJobId) return;
      closeProjectMenu();
    });
    document.getElementById("project-menu-portal")
      ?.addEventListener("click", (e) => e.stopPropagation());
    // Close the fixed-position menu if the sidebar scrolls underneath it
    document.querySelector(".project-list-wrap")?.addEventListener("scroll", () => {
      if (activeProjectMenuJobId) closeProjectMenu();
    }, { passive: true });
    window.addEventListener("resize", () => {
      if (!mixer.tracks.length) return;
      queueWaveformRedraw();
    });
    if (newSplitBtn) {
      newSplitBtn.addEventListener("click", async () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        clearStatus();
        progressSection.classList.add("hidden");
        card.classList.remove("expanded");
        await resetMixer();
        setActiveProject("");
        // On mobile, collapse sidebar so split panel is visible
        if (window.innerWidth <= 760) {
          setSidebarCollapsed(true);
          setSplitPanelVisible(true);
        }
      });
    }
    if (downloadMp3Btn) {
      downloadMp3Btn.addEventListener("click", () => {
        if (urlActionInput) {
          urlActionInput.value = "download_only";
        }
        if (form) {
          form.requestSubmit(submitBtn);
        }
      });
    }
    function updateUploadVisibility() {
      const hasUrl = !!(sourceUrlInput && sourceUrlInput.value.trim());
      const uploadVisual = document.querySelector(".split-upload-visual");
      const urlEyebrow = document.querySelector(".split-url-eyebrow");
      const urlSubcopy = document.querySelector(".split-url-subcopy");
      const shell = document.getElementById("split-dropzone");
      if (uploadVisual) uploadVisual.style.display = hasUrl ? "none" : "";
      if (urlEyebrow) urlEyebrow.style.display = hasUrl ? "none" : "";
      if (urlSubcopy) urlSubcopy.style.display = hasUrl ? "none" : "";
      if (shell) shell.style.minHeight = hasUrl ? "auto" : "";
      if (shell) shell.style.padding = hasUrl ? "28px 40px" : "";
    }
    audioFileInput.addEventListener("change", updateAudioDropHint);
    audioFileInput.addEventListener("change", updateActionButtons);
    sourceUrlInput.addEventListener("input", updateActionButtons);
    sourceUrlInput.addEventListener("input", updateUploadVisibility);
    // ── Workspace header project menu ───────────────────────────────────────
    const _wpTrigger  = document.getElementById("ws-project-menu-trigger");
    const _wpMenu     = document.getElementById("ws-project-menu");
    const _wpFavBtn   = document.getElementById("ws-fav-btn");
    const _wpFavLabel = document.getElementById("ws-fav-label");

    function updateWorkspaceFavBtn() {
      if (!_wpFavBtn || !mixer.jobId) return;
      const isFav = userFavorites.has(mixer.jobId);
      const svg = _wpFavBtn.querySelector("svg");
      if (svg) {
        svg.setAttribute("fill", isFav ? "#f59e0b" : "none");
        svg.setAttribute("stroke", isFav ? "#f59e0b" : "currentColor");
      }
      if (_wpFavLabel) _wpFavLabel.textContent = isFav ? "Remove from Favorites" : "Add to Favorites";
      _wpFavBtn.style.color = isFav ? "#f59e0b" : "";
    }

    if (_wpTrigger && _wpMenu) {
      _wpTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const opening = _wpMenu.classList.contains("hidden");
        _wpMenu.classList.toggle("hidden");
        if (opening) updateWorkspaceFavBtn();
      });
    }

    if (_wpFavBtn) {
      _wpFavBtn.addEventListener("click", async () => {
        if (!mixer.jobId || SHARE_TOKEN) return;
        _wpMenu.classList.add("hidden");
        await toggleFavorite(mixer.jobId);
        updateWorkspaceFavBtn();
      });
    }

    document.addEventListener("click", () => {
      if (_wpMenu) _wpMenu.classList.add("hidden");
    });

    // ── Playlist helpers ─────────────────────────────────────────
