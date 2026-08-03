    // --- Screen Wake Lock: keep display on while a project is open ---
    // Strategy: Wake Lock API (HTTPS only, no gesture needed) + NoSleep.js video
    // fallback (HTTP, but must be triggered from a synchronous user-gesture handler).
    let _wakeLock = null;
    const _noSleep = (typeof NoSleep !== "undefined") ? new NoSleep() : null;
    let _noSleepEnabled = false;

    // Called on project load and on visibilitychange — tries Wake Lock only.
    async function _requestWakeLock() {
      if (!("wakeLock" in navigator)) return;
      try {
        if (_wakeLock) return;
        _wakeLock = await navigator.wakeLock.request("screen");
        _wakeLock.addEventListener("release", () => { _wakeLock = null; });
      } catch (_) {}
    }

    // Called synchronously from play button handlers so iOS allows video.play().
    function _enableNoSleepFromGesture() {
      if (_noSleep && !_noSleepEnabled) {
        try { _noSleep.enable(); _noSleepEnabled = true; } catch (_) {}
      }
    }

    function _releaseWakeLock() {
      if (_wakeLock) { _wakeLock.release(); _wakeLock = null; }
      if (_noSleep && _noSleepEnabled) { try { _noSleep.disable(); } catch (_) {} _noSleepEnabled = false; }
    }

    // Re-acquire Wake Lock after returning to the tab (OS releases it on hide).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && mixer.tracks && mixer.tracks.length) {
        _requestWakeLock();
      }
    });

    let _waveZoomDropdown = null;
    let _waveZoomAnchorBtn = null;

    function _buildWaveZoomDropdown() {
      const dd = document.createElement("div");
      dd.className = "wave-zoom-dropdown";
      ZOOM_PRESETS.forEach((preset) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "wave-zoom-dropdown-item";
        item.textContent = getZoomPresetLabel(preset);
        item.dataset.preset = preset === null ? "all" : String(preset);
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          _closeWaveZoomDropdown();
          const full = getMaxVisibleDuration();
          const newDur = (preset === null || preset >= full) ? full : preset;
          zoomViewport(newDur, getViewportCenterTime());
        });
        dd.appendChild(item);
      });
      document.body.appendChild(dd);
      document.addEventListener("click", _closeWaveZoomDropdown);
      return dd;
    }

    function _closeWaveZoomDropdown() {
      if (_waveZoomDropdown) _waveZoomDropdown.classList.remove("open");
      _waveZoomAnchorBtn = null;
    }

    function _openWaveZoomDropdown(btn) {
      if (!_waveZoomDropdown) _waveZoomDropdown = _buildWaveZoomDropdown();
      if (_waveZoomAnchorBtn === btn) { _closeWaveZoomDropdown(); return; }
      _waveZoomAnchorBtn = btn;

      // Filter: hide presets >= full song duration (except All)
      const full = getMaxVisibleDuration();
      _waveZoomDropdown.querySelectorAll(".wave-zoom-dropdown-item").forEach(item => {
        const p = item.dataset.preset;
        const ps = p === "all" ? 0 : Number(p);
        item.style.display = (p === "all" || ps < full * 0.99) ? "" : "none";
      });

      // Highlight current level
      _syncWaveZoomDropdownActive();

      // Position: fixed, right-aligned to button, below it
      const rect = btn.getBoundingClientRect();
      _waveZoomDropdown.style.top = `${rect.bottom + 4}px`;
      _waveZoomDropdown.style.right = `${window.innerWidth - rect.right}px`;
      _waveZoomDropdown.classList.add("open");
    }

    function _syncWaveZoomDropdownActive() {
      if (!_waveZoomDropdown) return;
      const vd = mixer.visibleDuration || getMaxVisibleDuration();
      const full = getMaxVisibleDuration();
      _waveZoomDropdown.querySelectorAll(".wave-zoom-dropdown-item").forEach(item => {
        const p = item.dataset.preset;
        const ps = p === "all" ? full : Number(p);
        item.classList.toggle("active", Math.abs(vd - ps) / Math.max(ps, 0.0001) < 0.08);
      });
    }

    function redrawAllWaveforms() {
      for (const track of mixer.tracks) {
        updateTrackWaveform(track);
      }
      if (activeWorkspaceTab === "timing" || activeWorkspaceTab === "karaoke") {
        if (!_vocalsWaveHidden) drawLyricsVocalsWaveform();
        updateLyricsVocalsMarkLines();
      }
      if (tracksContainer) {
        tracksContainer.classList.toggle("is-playing", !!mixer.isPlaying);
      }
      setActiveTrack(activeTrackKey);
      setTransport(currentOffset());
    }

    function updateToolReadouts() {
      const tempoChanged = mixer.tempoPct !== 100;
      const pitchChanged = mixer.pitchSemitones !== 0;
      tempoValue.textContent = `${mixer.tempoPct}%`;
      pitchValue.textContent = getPitchLongLabel();
      if (tempoBadgeVal) tempoBadgeVal.textContent = `${mixer.tempoPct}%`;
      if (pitchBadgeVal) pitchBadgeVal.textContent = getPitchShortLabel();
      if (tempoBadgeBtn) tempoBadgeBtn.classList.toggle("active", tempoChanged);
      if (pitchBadgeBtn) {
        pitchBadgeBtn.classList.toggle("active", pitchChanged);
        pitchBadgeBtn.title = getPitchLongLabel();
      }
      // Show desktop reset buttons only when modified
      const tempoResetBtn = document.getElementById("tempo-reset-btn");
      const pitchResetBtn = document.getElementById("pitch-reset-btn");
      if (tempoResetBtn) tempoResetBtn.classList.toggle("active", tempoChanged);
      if (pitchResetBtn) pitchResetBtn.classList.toggle("active", pitchChanged);
      if (typeof syncMiniTempoPitch === "function") syncMiniTempoPitch();
      if (typeof syncMiniLoopUI === "function") syncMiniLoopUI();
      const _zoomLabel = getCurrentZoomLabel();
      zoomValue.textContent = _zoomLabel;
      document.querySelectorAll(".wave-zoom-label").forEach(el => el.textContent = _zoomLabel);
      _syncWaveZoomDropdownActive();
      syncZoomSlider();
      if (mixer.loopStart !== null && mixer.loopEnd !== null) {
        loopValue.textContent = `Loop ${formatTime(mixer.loopStart)} - ${formatTime(mixer.loopEnd)}`;
        loopStartInput.value = formatSeconds(mixer.loopStart);
        loopEndInput.value = formatSeconds(mixer.loopEnd);
      } else if (mixer.loopStart !== null) {
        loopValue.textContent = `Loop A ${formatTime(mixer.loopStart)}`;
        loopStartInput.value = formatSeconds(mixer.loopStart);
      } else {
        loopValue.textContent = "Loop: Off";
      }
      loopToggleBtn.classList.toggle("active", mixer.loopEnabled);
      loopToggleBtn.textContent = mixer.loopEnabled ? "Loop On" : "Loop Off";
      setLoopStartBtn.classList.toggle("active", mixer.loopStart !== null);
      setLoopEndBtn.classList.toggle("active", mixer.loopEnd !== null);
      refreshDisplayedKeyBadges();
    }

    function renderTracks() {
      tracksContainer.innerHTML = "";
      for (const track of mixer.tracks) {
        const theme = getTrackTheme(track.key);
        const row = document.createElement("div");
        row.className = "track-row";
        row.style.setProperty("--track-accent", theme.accent);
        row.style.setProperty("--track-accent-soft", theme.soft);
        const trackHead = document.createElement("div");
        trackHead.className = "track-head";

        // Collapse toggle
        const collapseBtn = document.createElement("button");
        collapseBtn.type = "button";
        collapseBtn.className = "track-collapse-btn";
        collapseBtn.title = "Collapse / expand track";
        collapseBtn.innerHTML = `<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M8 10.94L2.53 5.47a.75.75 0 0 1 1.06-1.06L8 8.82l4.41-4.41a.75.75 0 1 1 1.06 1.06L8 10.94z"/></svg>`;
        collapseBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          track.collapsed = !track.collapsed;
          row.classList.toggle("collapsed", track.collapsed);
          if (!track.collapsed) requestAnimationFrame(() => redrawAllWaveforms());
        });

        const trackHeadLeft = document.createElement("div");
        trackHeadLeft.className = "track-head-left";

        const meta = document.createElement("div");
        meta.className = "track-meta";
        const typeIcon = document.createElement("span");
        typeIcon.className = "track-type-icon";
        typeIcon.innerHTML = getTrackTypeIcon(track.key);
        const labelGroup = document.createElement("div");
        labelGroup.className = "track-label-group";
        const nameBlock = document.createElement("div");
        nameBlock.className = "track-name-block";
        // Top row: name + inline badges
        const nameRow = document.createElement("div");
        nameRow.className = "track-name-row";
        const name = document.createElement("div");
        name.className = "track-name";
        const _stemDisplayNames = { others: "Music", other: "Music", no_vocals: "No Vocals" };
        name.textContent = _stemDisplayNames[track.key] || (track.key.charAt(0).toUpperCase() + track.key.slice(1));
        nameRow.appendChild(name);
        // BPM badge — only shown on drums track
        if (track.key === "drums" && mixer.bpm) {
          const bpmBadge = document.createElement("span");
          bpmBadge.className = "bpm-badge";
          const hasSegments = mixer.bpmSegments && mixer.bpmSegments.length > 1;
          bpmBadge.textContent = hasSegments ? `${mixer.bpm} BPM (variable)` : `${mixer.bpm} BPM`;
          bpmBadge.title = hasSegments
            ? mixer.bpmSegments.map((s) => `${formatTime(s.start)}–${formatTime(s.end)}: ${s.bpm} BPM`).join("\n")
            : `${mixer.bpm} BPM`;
          nameRow.appendChild(bpmBadge);
        }
        // Key badge — shown on vocals track only when confidence >= 50%
        if (track.key === "vocals" && mixer.key && Math.round((mixer.keyConfidence || 0) * 100) >= 50) {
          const keyBadge = document.createElement("span");
          keyBadge.className = "key-badge";
          const displayedKey = getDisplayedKeyLabel(mixer.key);
          keyBadge.textContent = `♪ ${displayedKey}`;
          const pct = Math.round((mixer.keyConfidence || 0) * 100);
          keyBadge.title = `Key: ${displayedKey}${pct ? `\nConfidence: ${pct}%` : ""}`;
          nameRow.appendChild(keyBadge);
        }
        const status = document.createElement("div");
        status.className = "track-status";
        status.textContent = theme.status;
        nameBlock.appendChild(nameRow);
        nameBlock.appendChild(status);
        labelGroup.appendChild(typeIcon);
        labelGroup.appendChild(nameBlock);
        meta.appendChild(labelGroup);
        const mute = document.createElement("button");
        mute.type = "button";
        mute.className = "track-mute";
        mute.title = `Mute ${track.key}`;
        mute.setAttribute("aria-label", `Mute ${track.key}`);
        const setMuteButtonState = () => {
          mute.classList.toggle("muted", track.muted);
          mute.setAttribute("aria-pressed", track.muted ? "true" : "false");
          mute.title = track.muted ? `Unmute ${track.key}` : `Mute ${track.key}`;
          mute.setAttribute("aria-label", track.muted ? `Unmute ${track.key}` : `Mute ${track.key}`);
        };
        mute.innerHTML = `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 10.5h4.2l4.8-4v11l-4.8-4H4z"></path>
            <path d="M16.25 9.25l4.5 5.5"></path>
            <path d="M20.75 9.25l-4.5 5.5"></path>
          </svg>
        `;
        mute.addEventListener("click", () => {
          track.muted = !track.muted;
          applyPlaybackSettings(track);
          setMuteButtonState();
          scheduleSaveProjectMetadata();
        });
        setMuteButtonState();
        const solo = document.createElement("button");
        solo.type = "button";
        solo.className = "track-solo";
        solo.textContent = "Solo";
        solo.addEventListener("click", () => {
          const shouldSolo = !track.soloed;
          for (const other of mixer.tracks) {
            other.soloed = false;
            if (other.soloButton) other.soloButton.classList.remove("active");
          }
          track.soloed = shouldSolo;
          if (track.soloButton) track.soloButton.classList.toggle("active", shouldSolo);
          updateTrackAudibility();
        });
        const actionGroup = document.createElement("div");
        actionGroup.className = "track-actions";
        actionGroup.appendChild(mute);
        actionGroup.appendChild(solo);
        const volumeWrap = document.createElement("div");
        volumeWrap.className = "track-volume-wrap";
        const volumeIcon = document.createElement("span");
        volumeIcon.className = "track-volume-icon";
        volumeIcon.textContent = "🔊";
        const volumeSlider = document.createElement("input");
        volumeSlider.type = "range";
        volumeSlider.min = "0";
        volumeSlider.max = "100";
        volumeSlider.step = "1";
        volumeSlider.value = String(Math.round((track.volume ?? 1) * 100));
        volumeSlider.className = "track-volume";
        const volumeLabel = document.createElement("span");
        volumeLabel.className = "track-volume-label";
        volumeLabel.textContent = `Vol ${volumeSlider.value}%`;
        // Mobile-only % badge (shown instead of slider on small screens)
        const volPctSpan = document.createElement("span");
        volPctSpan.className = "track-vol-pct";
        volPctSpan.textContent = `${volumeSlider.value}%`;
        // Desktop: horizontal slider + label inline
        const volPopover = document.createElement("div");
        volPopover.className = "track-vol-popover";
        volPopover.appendChild(volumeSlider);
        volPopover.appendChild(volumeLabel);
        // Mobile: vertical slider panel (same pattern as tempo/pitch panels)
        const volPanel = document.createElement("div");
        volPanel.className = "track-vol-panel";
        const volPanelHead = document.createElement("div");
        volPanelHead.className = "mtp-head";
        const volPanelLabel = document.createElement("strong");
        volPanelLabel.textContent = "Vol";
        const volPanelValue = document.createElement("code");
        volPanelValue.className = "mtp-value";
        volPanelValue.style.cssText = "background:#dbeafe;border:1px solid #93c5fd;color:#1d4ed8;min-width:36px;";
        volPanelValue.textContent = `${volumeSlider.value}%`;
        volPanelHead.appendChild(volPanelLabel);
        volPanelHead.appendChild(volPanelValue);
        const volVSliderWrap = document.createElement("div");
        volVSliderWrap.className = "mtp-vslider-wrap";
        const volIncBtn = document.createElement("button");
        volIncBtn.type = "button";
        volIncBtn.className = "mtp-step-btn";
        volIncBtn.textContent = "+";
        volIncBtn.title = "Increase volume";
        const volVSlider = document.createElement("input");
        volVSlider.type = "range";
        volVSlider.min = "0";
        volVSlider.max = "100";
        volVSlider.step = "1";
        volVSlider.value = volumeSlider.value;
        volVSlider.className = "mtp-vslider";
        volVSlider.setAttribute("orient", "vertical");
        volVSlider.setAttribute("aria-label", "Volume");
        const volDecBtn = document.createElement("button");
        volDecBtn.type = "button";
        volDecBtn.className = "mtp-step-btn";
        volDecBtn.textContent = "−";
        volDecBtn.title = "Decrease volume";
        volVSliderWrap.appendChild(volIncBtn);
        volVSliderWrap.appendChild(volVSlider);
        volVSliderWrap.appendChild(volDecBtn);
        volPanel.appendChild(volPanelHead);
        volPanel.appendChild(volVSliderWrap);
        // Sync both sliders + badge + label
        const _syncVol = (pct) => {
          const clamped = Math.max(0, Math.min(100, pct));
          track.volume = clamped / 100;
          volumeSlider.value = clamped;
          volVSlider.value = clamped;
          volumeLabel.textContent = `Vol ${clamped}%`;
          volPctSpan.textContent = `${clamped}%`;
          volPanelValue.textContent = `${clamped}%`;
          applyPlaybackSettings(track);
          scheduleSaveProjectMetadata();
        };
        volumeSlider.addEventListener("input", () => _syncVol(Number(volumeSlider.value)));
        volVSlider.addEventListener("input", () => _syncVol(Number(volVSlider.value)));
        volIncBtn.addEventListener("click", (e) => { e.stopPropagation(); _syncVol(Number(volVSlider.value) + 5); });
        volDecBtn.addEventListener("click", (e) => { e.stopPropagation(); _syncVol(Number(volVSlider.value) - 5); });
        // Stop panel clicks from bubbling to document (would immediately close it)
        volPanel.addEventListener("click", (e) => e.stopPropagation());
        volPopover.addEventListener("click", (e) => e.stopPropagation());
        // Toggle panel on mobile tap of the badge (position: fixed, JS-placed)
        volumeWrap.addEventListener("click", (e) => {
          if (window.innerWidth > 760) return;
          e.stopPropagation();
          document.querySelectorAll(".track-volume-wrap.vol-open").forEach(w => {
            if (w !== volumeWrap) w.classList.remove("vol-open");
          });
          const isOpen = volumeWrap.classList.toggle("vol-open");
          if (isOpen) {
            const rect = volumeWrap.getBoundingClientRect();
            const panelH = 220;
            const rightOffset = window.innerWidth - rect.right;
            volPanel.style.right = `${rightOffset}px`;
            volPanel.style.left = "";
            if (window.innerHeight - rect.bottom >= panelH) {
              volPanel.style.top = `${rect.bottom + 6}px`;
              volPanel.style.bottom = "";
            } else {
              volPanel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
              volPanel.style.top = "";
            }
          }
        });
        volumeWrap.appendChild(volumeIcon);
        volumeWrap.appendChild(volPctSpan);
        volumeWrap.appendChild(volPopover);
        volumeWrap.appendChild(volPanel);
        // Keep hidden inputs so existing code that writes to markerTimeInput still works
        const markerTimeInput = document.createElement("input");
        markerTimeInput.type = "number";
        markerTimeInput.style.display = "none";
        const markerLabelInput = document.createElement("input");
        markerLabelInput.type = "text";
        markerLabelInput.style.display = "none";
        actionGroup.appendChild(volumeWrap);
        actionGroup.appendChild(markerTimeInput);
        actionGroup.appendChild(markerLabelInput);
        trackHeadLeft.appendChild(collapseBtn);
        trackHeadLeft.appendChild(meta);
        trackHead.appendChild(trackHeadLeft);
        trackHead.appendChild(actionGroup);
        const trackBody = document.createElement("div");
        trackBody.className = "track-body";
        const markerPills = document.createElement("div");
        markerPills.className = "track-markers";
        const waveWrap = document.createElement("div");
        waveWrap.className = "wave-wrap";
        const waveContent = document.createElement("div");
        waveContent.className = "wave-content";
        const waveCanvas = document.createElement("canvas");
        waveCanvas.className = "wave-canvas";
        const playhead = document.createElement("div");
        playhead.className = "playhead";
        const loopDownloadBtn = document.createElement("button");
        loopDownloadBtn.type = "button";
        loopDownloadBtn.className = "loop-download-btn";
        loopDownloadBtn.title = "Download selected loop";
        loopDownloadBtn.innerHTML = '<img class="download-glyph" src="/ui-icon/download-loop" alt="">';
        loopDownloadBtn.addEventListener("click", () => {
          if (mixer.loopStart === null || mixer.loopEnd === null || mixer.loopEnd <= mixer.loopStart) return;
          window.open(makeLoopDownloadUrl(track.key), "_self");
        });
        const zoomPickerBtn = document.createElement("button");
        zoomPickerBtn.type = "button";
        zoomPickerBtn.className = "wave-zoom-picker-btn";
        zoomPickerBtn.title = "Zoom";
        zoomPickerBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="5" r="3.2"/><line x1="7.5" y1="7.5" x2="11" y2="11"/></svg><span class="wave-zoom-label">All</span>`;
        zoomPickerBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          _openWaveZoomDropdown(zoomPickerBtn);
        });
        waveContent.appendChild(waveCanvas);
        waveContent.appendChild(playhead);
        waveContent.appendChild(loopDownloadBtn);
        waveContent.appendChild(zoomPickerBtn);
        waveWrap.appendChild(waveContent);
        const pointerState = { active: false, moved: false, startX: 0, startVisibleStart: 0, startTimeOffset: 0 };
        waveWrap.addEventListener("pointerdown", (event) => {
          pointerState.active = true;
          pointerState.moved = false;
          pointerState.startX = event.clientX;
          pointerState.startVisibleStart = mixer.visibleStart || 0;
          pointerState.startTimeOffset = currentOffset();
          waveWrap.setPointerCapture?.(event.pointerId);
          setActiveTrack(track.key);
        });
        waveWrap.addEventListener("pointermove", (event) => {
          if (!pointerState.active) return;
          const width = Math.max(1, waveWrap.getBoundingClientRect().width);
          const dx = event.clientX - pointerState.startX;
          if (!pointerState.moved && Math.abs(dx) >= PAN_DRAG_THRESHOLD) {
            pointerState.moved = true;
          }
          if (!pointerState.moved) return;
          if (_isMobileWaveform()) {
            // Mobile: drag scrubs the timeline (visual preview; audio seeks on release)
            const vd = mixer.visibleDuration || getMaxVisibleDuration();
            _mobileScrubTarget = Math.max(0, Math.min(mixer.duration || 0,
              pointerState.startTimeOffset - (dx / width) * vd));
            queueWaveformRedraw();
          } else {
            // Desktop: drag pans the viewport
            const deltaSeconds = (dx / width) * (mixer.visibleDuration || getMaxVisibleDuration());
            setViewportWindow(pointerState.startVisibleStart - deltaSeconds, mixer.visibleDuration || getMaxVisibleDuration());
            queueWaveformRedraw();
          }
        });
        const endPan = async (event) => {
          if (!pointerState.active) return;
          pointerState.active = false;
          waveWrap.releasePointerCapture?.(event.pointerId);
          if (_isMobileWaveform() && _mobileScrubTarget !== null) {
            const target = _mobileScrubTarget;
            _mobileScrubTarget = null;
            await seekTo(target);
          }
        };
        waveWrap.addEventListener("pointerup", endPan);
        waveWrap.addEventListener("pointercancel", endPan);
        waveWrap.addEventListener("click", async (event) => {
          if (pointerState.moved) {
            pointerState.moved = false;
            return;
          }
          if (event.detail === 2) return; // handled by dblclick
          const wrapRect = waveWrap.getBoundingClientRect();
          const x = event.clientX - wrapRect.left;
          let offset;
          if (_isMobileWaveform()) {
            // Mobile: map tap x to time using the centered viewport
            const vd = mixer.visibleDuration || getMaxVisibleDuration();
            const center = currentOffset();
            offset = Math.max(0, Math.min(mixer.duration || 0,
              (center - vd / 2) + (x / Math.max(1, wrapRect.width)) * vd));
          } else {
            offset = viewportXToTime(x, Math.max(1, wrapRect.width));
          }
          if (track.markerTimeInput) track.markerTimeInput.value = formatSeconds(offset);
          setActiveTrack(track.key);
          await seekTo(offset);
        });
        waveWrap.addEventListener("dblclick", (event) => {
          const wrapRect = waveWrap.getBoundingClientRect();
          const x = event.clientX - wrapRect.left;
          const offset = viewportXToTime(x, Math.max(1, wrapRect.width));
          setActiveTrack(track.key);
          addMarkerAtTime(offset);
        });
        waveWrap.addEventListener("wheel", (event) => {
          const wrapRect = waveWrap.getBoundingClientRect();
          const width = Math.max(1, wrapRect.width);
          // Horizontal scroll — pan the viewport
          if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            event.preventDefault();
            setActiveTrack(track.key);
            panViewportBy((event.deltaX / width) * (mixer.visibleDuration || getMaxVisibleDuration()));
            return;
          }
          // Vertical scroll — let the page scroll normally, no zoom
        }, { passive: true });
        trackBody.appendChild(markerPills);
        trackBody.appendChild(waveWrap);

        // Marker bar — sits below the waveform: [←prev] [+ Add Marker] [next→]
        const markerBar = document.createElement("div");
        markerBar.className = "track-marker-bar";

        const prevMarkerBtn = document.createElement("button");
        prevMarkerBtn.type = "button";
        prevMarkerBtn.className = "marker-bar-btn marker-bar-prev";
        prevMarkerBtn.title = "Jump to previous marker";
        prevMarkerBtn.innerHTML = `<svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 3 5 8 10 13"/></svg>`;

        const addMarkerBtn = document.createElement("button");
        addMarkerBtn.type = "button";
        addMarkerBtn.className = "marker-bar-btn marker-bar-add";
        addMarkerBtn.title = "Add marker at current position (or press M)";
        addMarkerBtn.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 1a.75.75 0 0 1 .75.75V7h5.25a.75.75 0 0 1 0 1.5H8.75v5.25a.75.75 0 0 1-1.5 0V8.5H2a.75.75 0 0 1 0-1.5h5.25V1.75A.75.75 0 0 1 8 1z"/></svg> Add Marker`;

        const nextMarkerBtn = document.createElement("button");
        nextMarkerBtn.type = "button";
        nextMarkerBtn.className = "marker-bar-btn marker-bar-next";
        nextMarkerBtn.title = "Jump to next marker";
        nextMarkerBtn.innerHTML = `<svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 3 11 8 6 13"/></svg>`;

        markerBar.appendChild(prevMarkerBtn);
        markerBar.appendChild(addMarkerBtn);
        markerBar.appendChild(nextMarkerBtn);
        trackBody.appendChild(markerBar);

        // Drum pattern panel — injected below the waveform for the drums track only
        if (track.key === "drums") {
          const drumPanel = document.createElement("div");
          drumPanel.className = "drum-pattern-panel";
          trackBody.appendChild(drumPanel);
          requestAnimationFrame(() => {
            if (typeof initDrumPatterns === "function" && mixer.jobId) {
              initDrumPatterns(track, mixer.jobId, drumPanel);
            }
          });
        }

        const trackMain = document.createElement("div");
        trackMain.className = "track-main";
        trackMain.appendChild(trackHead);
        trackMain.appendChild(trackBody);

        function addMarkerAtTime(time) {
          const safeTime = Math.max(0, Math.min(time, mixer.duration || 0));
          track.markers = track.markers || [];
          const label = `Marker ${track.markers.length + 1}`;
          track.markers.push({ id: Date.now() + Math.random(), time: safeTime, label });
          track.markers.sort((a, b) => a.time - b.time);
          redrawAllWaveforms();
          renderMarkerChips();
          scheduleSaveProjectMetadata();
          _updateMarkerBarButtons(track, prevMarkerBtn, nextMarkerBtn);
        }
        track.addMarkerAtTime = addMarkerAtTime;

        function _updateMarkerBarButtons(t, prevBtn, nextBtn) {
          const pos = currentOffset();
          const markers = (t.markers || []).slice().sort((a, b) => a.time - b.time);
          const hasPrev = markers.some((m) => m.time < pos - 0.05);
          const hasNext = markers.some((m) => m.time > pos + 0.05);
          prevBtn.disabled = !hasPrev;
          nextBtn.disabled = !hasNext;
        }
        track.updateMarkerBarButtons = () => _updateMarkerBarButtons(track, prevMarkerBtn, nextMarkerBtn);

        addMarkerBtn.addEventListener("click", () => {
          setActiveTrack(track.key);
          addMarkerAtTime(currentOffset());
        });
        prevMarkerBtn.addEventListener("click", () => {
          const pos = currentOffset();
          const markers = (track.markers || []).slice().sort((a, b) => a.time - b.time);
          // Current marker = last one at or before the playhead
          const currentMarker = markers.filter((m) => m.time <= pos + 0.05).pop();
          if (!currentMarker) return;
          if (pos - currentMarker.time < 3.0) {
            // Within 3 s of arriving at this marker → jump to the one before it
            const prev = markers.filter((m) => m.time < currentMarker.time - 0.05).pop();
            if (prev) seekTo(prev.time).catch(() => {});
          } else {
            // More than 3 s in → restart at the current marker
            seekTo(currentMarker.time).catch(() => {});
          }
        });
        nextMarkerBtn.addEventListener("click", () => {
          const pos = currentOffset();
          const markers = (track.markers || []).slice().sort((a, b) => a.time - b.time);
          const next = markers.find((m) => m.time > pos + 0.05);
          if (next) seekTo(next.time).catch(() => {});
        });

        track.muteButton = mute;
        track.soloButton = solo;
        track.volumeSlider = volumeSlider;
        track.volumeLabel = volumeLabel;
        track.playhead = playhead;
        track.loopDownloadBtn = loopDownloadBtn;
        track.waveWrap = waveWrap;
        track.waveContent = waveContent;
        track.canvasEl = waveCanvas;
        track.row = row;
        track.mainEl = trackMain;
        track.markerPills = markerPills;
        track.waveFillColor = theme.accent;
        track.waveBackground = theme.soft;
        track.markerColor = "#0f172a";
        track.markerHaloColor = "rgba(255, 255, 255, 0.98)";
        track.markerBadgeColor = "rgba(15, 23, 42, 0.94)";
        track.markerTextColor = "#ffffff";
        track.markerTimeInput = markerTimeInput;
        track.collapseBtn = collapseBtn;
        // Default: vocals expanded, all other stems collapsed
        if (track.collapsed === undefined) {
          track.collapsed = track.key !== "vocals";
        }
        if (track.collapsed) row.classList.add("collapsed");
        row.appendChild(trackMain);
        tracksContainer.appendChild(row);
      }
      setTransport(0);
      renderMarkerChips();
      updateToolReadouts();
      setActiveTrack(activeTrackKey || (mixer.tracks[0] ? mixer.tracks[0].key : ""));
      requestAnimationFrame(() => redrawAllWaveforms());
    }

    function stopPlayback() {
      stopTracks(true);
      mixer.isPlaying = false;
      mixer.pausedAt = 0;
      if (mixer.rafId) cancelAnimationFrame(mixer.rafId);
      mixer.rafId = null;
      setTransport(0);
      redrawAllWaveforms();
      if (typeof updatePlayPauseIcon === "function") updatePlayPauseIcon();
    }

    function pausePlayback() {
      if (!mixer.isPlaying) return;
      mixer.pausedAt = currentOffset();
      stopTracks(false);
      mixer.isPlaying = false;
      if (mixer.rafId) cancelAnimationFrame(mixer.rafId);
      mixer.rafId = null;
      setTransport(mixer.pausedAt);
      redrawAllWaveforms();
    }

    let _lastKaraokeActiveIdx = -2;
    function runTicker() {
      const offset = currentOffset();
      if (mixer.loopEnabled && mixer.loopStart !== null && mixer.loopEnd !== null && mixer.loopEnd > mixer.loopStart && offset >= mixer.loopEnd) {
        playFrom(mixer.loopStart).catch((err) => showError(err.message || "Loop restart failed."));
        return;
      }
      setTransport(offset);

      // No periodic drift correction here — setting currentTime on a playing
      // audio element causes audible hiccups. Initial sync is handled by
      // waiting for 'seeked' events in playFrom() before any play() call.

      // Karaoke sync
      if (lyricsKaraokeMode && (activeWorkspaceTab === "timing" || activeWorkspaceTab === "karaoke") && lyricsKaraokeView) {
        const lyrics = mixer.lyrics || [];
        let activeIdx = -1;
        for (let i = 0; i < lyrics.length; i++) {
          if (lyrics[i].time !== null && lyrics[i].time <= offset) activeIdx = i;
        }
        if (activeIdx !== _lastKaraokeActiveIdx) {
          // Line changed — full re-render
          _lastKaraokeActiveIdx = activeIdx;
          renderLyricsKaraokeView(offset);
        } else {
          // Same line — just update progress bar + beat dots
          updateKaraokeRhythm(offset);
        }
      }

      if (offset >= mixer.duration - 0.03) {
        stopPlayback();
        return;
      }
      mixer.rafId = requestAnimationFrame(runTicker);
    }

    // ── Playback delay (countdown before playing from a marker) ─────────────
    // Returns a promise that resolves after the configured delay, updating the
    // chip's visual state.  Clicking the chip again during countdown cancels it.
    let _countdownTimers = [];
    function _cancelAllCountdowns() {
      for (const t of _countdownTimers) clearTimeout(t);
      _countdownTimers = [];
      document.querySelectorAll(".track-marker-pill.counting-down").forEach(chip => {
        chip.classList.remove("counting-down");
        const lbl = chip.querySelector(".marker-pill-label");
        if (lbl) lbl.removeAttribute("data-countdown");
      });
    }

    function playFromWithDelay(offset, chip) {
      _cancelAllCountdowns();
      const delayMs = Number(_getSetting("playback_delay_ms", 0)) || 0;
      if (delayMs <= 0) {
        return playFrom(offset).then(updatePlayPauseIcon);
      }
      const steps = Math.ceil(delayMs / 1000);  // countdown in whole seconds
      let cancelHandler = null;
      if (chip) {
        chip.classList.add("counting-down");
        const lbl = chip.querySelector(".marker-pill-label");
        if (lbl) lbl.setAttribute("data-countdown", steps);
        // Cancel on second click
        cancelHandler = () => { _cancelAllCountdowns(); };
        chip.addEventListener("click", cancelHandler, { once: true });
        // Tick each second
        for (let i = 1; i <= steps; i++) {
          const t = setTimeout(() => {
            const lbl2 = chip.querySelector(".marker-pill-label");
            if (lbl2 && i < steps) lbl2.setAttribute("data-countdown", steps - i);
          }, i * 1000);
          _countdownTimers.push(t);
        }
      }
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          // Remove the cancel handler before _cancelAllCountdowns so it can't
          // fire on the very next click and wipe out the new playback session.
          if (chip && cancelHandler) chip.removeEventListener("click", cancelHandler);
          _cancelAllCountdowns();
          playFrom(offset).then(updatePlayPauseIcon).then(resolve).catch(resolve);
        }, delayMs);
        _countdownTimers.push(t);
      });
    }

    async function playFrom(offset) {
      if (!mixer.audioContext || !mixer.tracks.length) return;
      // iOS Safari requires the AudioContext to be resumed AND a real buffer
      // to be started synchronously within a user-gesture handler.  Playing a
      // 1-sample silent buffer before anything else unlocks the audio engine
      // on devices that ignore a plain resume() call (common on iOS < 17).
      try {
        const silentBuf = mixer.audioContext.createBuffer(1, 1, mixer.audioContext.sampleRate);
        const silentSrc = mixer.audioContext.createBufferSource();
        silentSrc.buffer = silentBuf;
        silentSrc.connect(mixer.audioContext.destination);
        silentSrc.start(0);
      } catch (_) {}
      await mixer.audioContext.resume();

      // Stop any currently running source nodes
      for (const track of mixer.tracks) {
        if (track.sourceNode) {
          try { track.sourceNode.stop(); } catch (_) {}
          track.sourceNode = null;
        }
      }

      // Schedule all tracks to start at the same AudioContext time (20 ms ahead).
      // Because all source nodes share the same AudioContext clock they are
      // sample-accurate — no per-track OS round-trips, no drift possible.
      const startWhen = mixer.audioContext.currentTime + 0.02;
      mixer.pausedAt  = offset;
      mixer.startedAt = startWhen;

      for (const track of mixer.tracks) {
        if (!track.buffer) continue;
        const pitchComp = Number.isFinite(track.pitchTempoComp) ? track.pitchTempoComp : 1;
        const rate = effectiveTempoRate() * pitchComp;
        const source = mixer.audioContext.createBufferSource();
        source.buffer = track.buffer;
        source.playbackRate.value = rate;
        source.connect(track.gainNode);
        source.start(startWhen, offset);
        track.sourceNode = source;
      }

      updateTrackAudibility();
      mixer.isPlaying = true;
      if (mixer.rafId) cancelAnimationFrame(mixer.rafId);
      mixer.rafId = requestAnimationFrame(runTicker);
      redrawAllWaveforms();
    }

    async function seekTo(offset) {
      const nextOffset = Math.max(0, Math.min(offset, mixer.duration || 0));
      if (mixer.isPlaying) {
        await playFrom(nextOffset);
      } else {
        mixer.pausedAt = nextOffset;
        setTransport(nextOffset);
      }
    }

    async function resetMixer(showHome = true) {
      if (analyseTimer) { clearInterval(analyseTimer); analyseTimer = null; }
      _releaseWakeLock();
      stopPlayback();
      for (const track of mixer.tracks) {
        if (track.sourceNode) {
          try { track.sourceNode.stop(); } catch (_) {}
          track.sourceNode = null;
        }
      }
      tracksContainer.innerHTML = "";
      mixerSection.classList.add("hidden");
      if (exportBar) exportBar.classList.add("hidden");
      hideMiniPlayer();
      playBtn.disabled = true;
      stopBtn.disabled = true;
      if (lyricMarkTransportBtn) lyricMarkTransportBtn.disabled = true;
      if (miniLyricMarkBtn) miniLyricMarkBtn.disabled = true;
      _allMarkBtns().forEach(b => { if (b) b.disabled = true; });
      if (mixer.audioContext) {
        try { await mixer.audioContext.close(); } catch (_) {}
      }
      mixer = {
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
        pitchBufferCache: new Map(),
        pitchNeighborhoodWarmed: false,
      };
      // Reset lyrics UI
      if (lyricsList) lyricsList.innerHTML = "";
      if (lyricsKaraokeView) lyricsKaraokeView.innerHTML = "";
      lyricsKaraokeMode = false;
      if (lyricsViewToggle) { lyricsViewToggle.textContent = "Karaoke View"; lyricsViewToggle.classList.remove("karaoke-active"); }
      if (lyricsEditView) lyricsEditView.style.display = "";
      if (lyricsKaraokeView) lyricsKaraokeView.classList.remove("active");
      refreshKaraokeTabVisibility();
      setWorkspaceTab("mixer");
      _lastKaraokeActiveIdx = -2;
      activeTrackKey = "";
      if (metadataSaveTimer) {
        clearTimeout(metadataSaveTimer);
        metadataSaveTimer = null;
      }
      tempoSlider.value = "100";
      pitchSlider.value = "0";
      setPitchLoading(false);
      mixer.pitchBufferCache = new Map();
      mixer.pitchNeighborhoodWarmed = false;
      setPitchWarmupBanner(false, false);
      zoomValue.textContent = "30s";
      if (zoomSlider) zoomSlider.value = "0";
      setSourceDownloadUrl("");
      if (downloadMixBtn) {
        downloadMixBtn.disabled = true;
        downloadMixBtn.textContent = "Download Final Mix";
      }
      if (showHome) {
        setProjectLoading(false);
      }
      setSplitPanelVisible(showHome);
      updateToolReadouts();
      setTransport(0);
    }

    async function initMixer(jobId, stemUrls, stemDownloadUrls, zipDownloadUrl, sourceUrl, mixerState = {}, bpmData = {}, lyricsData = [], songLyricsText = "") {
      await resetMixer(false);
      setSourceDownloadUrl(sourceUrl || "");
      const entries = Object.entries(stemUrls || {});
      if (!entries.length) return;
      entries.sort((a, b) => getTrackSortOrder(a[0]) - getTrackSortOrder(b[0]) || a[0].localeCompare(b[0]));
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("Web Audio API is not supported in this browser.");
      // 'playback' latency hint tells the browser to prioritise audio
      // stability over low latency — critical for smooth mobile playback.
      const audioContext = new AudioCtx({ latencyHint: 'playback', sampleRate: 44100 });
      const tracks = [];
      for (const [key, url] of entries) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed loading ${key} stem.`);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
        const gainNode = audioContext.createGain();
        gainNode.connect(audioContext.destination);
        tracks.push({
          key,
          url,
          buffer,
          waveformLevels: buildWaveformLevels(buffer),
          sourceDuration: buffer.duration,
          pitchTempoComp: 1,
          gainNode,
          sourceNode: null,
          muted: false,
          soloed: false,
          volume: 1,
          playhead: null,
          markers: [],
          downloadUrl: (stemDownloadUrls || {})[key] || "",
        });
      }
      mixer.audioContext = audioContext;
      mixer.tracks = tracks;
      mixer.duration = Math.max(...tracks.map((track) => track.buffer.duration));
      mixer.jobId = jobId;
      mixer.zipDownloadUrl = zipDownloadUrl || "";
      mixer.bpm = bpmData.bpm || null;
      mixer.bpmSegments = bpmData.bpmSegments || [];
      mixer.key = bpmData.key || null;
      mixer.keyConfidence = bpmData.keyConfidence || 0;
      mixer.thaat = bpmData.thaat || null;
      mixer.thaatAlt = bpmData.thaatAlt || null;
      // Assign note timeline to the vocals track for waveform overlay
      if (bpmData.noteTimeline && bpmData.noteTimeline.length) {
        for (const track of tracks) {
          if (track.key === "vocals") {
            track.noteTimeline = bpmData.noteTimeline;
          }
        }
      }
      mixerSection.classList.remove("hidden");
      if (exportBar) exportBar.classList.remove("hidden");
      playBtn.disabled = false;
      stopBtn.disabled = false;
      if (miniPlayBtn) miniPlayBtn.disabled = false;
      if (miniStopBtn) miniStopBtn.disabled = false;
      if (lyricMarkTransportBtn) lyricMarkTransportBtn.disabled = false;
      if (miniLyricMarkBtn) miniLyricMarkBtn.disabled = false;
      _allMarkBtns().forEach(b => { if (b) b.disabled = false; });
      drawLyricsVocalsWaveform();
      updateLyricsVocalsMarkLines();
      showMiniPlayer(activeProjectName || Object.keys(stemUrls || {}).join(", "));
      if (downloadMixBtn) {
        downloadMixBtn.disabled = false;
        downloadMixBtn.textContent = "Download Final Mix";
      }
      setProjectLoading(false);
      _requestWakeLock();
      setViewportWindow(0, Math.min(30, mixer.duration || getMaxVisibleDuration()));
      // Load lyrics
      mixer.songLyricsText = typeof songLyricsText === "string" ? songLyricsText : "";
      _lyricsEditInputOpen = false;
      mixer.lyrics = Array.isArray(lyricsData) ? lyricsData.map(l => ({
        id: l.id || makeLyricId(),
        text: String(l.text || "").trim(),
        text_alt: String(l.text_alt || "").trim(),
        time: (l.time !== null && l.time !== undefined && Number.isFinite(Number(l.time))) ? Number(l.time) : null,
        type: ["lead","chorus","music"].includes(l.type) ? l.type : "lead",
        color: l.color || "",
        style: l.style || "normal",
      })).filter(l => l.text || l.text_alt || l.time !== null) : [];
      refreshKaraokeTabVisibility();
      renderTracks();
      await applySavedMixerState(mixerState);
      setActiveProject(jobId);
      if (typeof updateWorkspaceFavBtn === "function") updateWorkspaceFavBtn();

      // Auto-analyse BPM + key for projects that don't have it yet
      if (!mixer.bpm || !mixer.key) {
        startAnalysis(jobId);
      } else {
        // BPM/key already present — check if note timeline needs to be computed
        _maybeShowReanalyzeBtn(jobId);
      }
    }

    function updatePlayPauseIcon() {
      if (mixer.isPlaying) {
        playIcon.style.display = "none";
        pauseIcon.style.display = "";
        playBtn.setAttribute("aria-label", "Pause");
        playBtn.setAttribute("title", "Pause");
        miniPlayIcon.style.display = "none";
        miniPauseIcon.style.display = "";
        miniPlayBtn.setAttribute("aria-label", "Pause");
      } else {
        playIcon.style.display = "";
        pauseIcon.style.display = "none";
        playBtn.setAttribute("aria-label", "Play");
        playBtn.setAttribute("title", "Play");
        miniPlayIcon.style.display = "";
        miniPauseIcon.style.display = "none";
        miniPlayBtn.setAttribute("aria-label", "Play");
      }
    }

    playBtn.addEventListener("click", async () => {
      // Both resume() and _enableNoSleepFromGesture() must run synchronously
      // before any await — iOS requires these inside the user-gesture call stack.
      if (mixer.audioContext) mixer.audioContext.resume().catch(() => {});
      _enableNoSleepFromGesture();
      if (mixer.isPlaying) {
        pausePlayback();
        updatePlayPauseIcon();
      } else {
        await playFrom(currentOffset()).catch((err) => showError(err.message || "Could not start playback."));
        updatePlayPauseIcon();
      }
    });
    // touchstart fires before click on mobile — resume() here gives iOS the
    // earliest possible synchronous unlock inside a user-gesture handler.
    playBtn.addEventListener("touchstart", () => {
      if (mixer.audioContext) mixer.audioContext.resume().catch(() => {});
      _enableNoSleepFromGesture();
    }, { passive: true });
    stopBtn.addEventListener("click", () => {
      stopPlayback();
      updatePlayPauseIcon();
    });
    transportSeek.addEventListener("input", () => {
      const offset = (Number(transportSeek.value) / 1000) * (mixer.duration || 0);
      seekTo(offset).catch((err) => showError(err.message || "Failed to seek."));
    });
    let _tempoDebounceTimer = null;
    // Tracks whether audio was playing before we paused it during a tempo drag.
    // Needed because pausePlayback() sets mixer.isPlaying=false before applyPitchShift
    // captures wasPlaying, so we must pass the original state explicitly.
    let _tempoWasPlaying = false;
    function _scheduleTempoCompensation() {
      clearTimeout(_tempoDebounceTimer);
      _tempoDebounceTimer = setTimeout(() => {
        const resume = _tempoWasPlaying;
        _tempoWasPlaying = false;
        applyPitchShift(resume)
          .then(() => scheduleSaveTempoPixchOverlay())
          .catch((err) => showError(err.message || "Failed to apply tempo."));
      }, 400);
    }
    tempoSlider.addEventListener("input", () => {
      // Capture playing state BEFORE pausing, so applyPitchShift can resume correctly.
      if (mixer.isPlaying) { _tempoWasPlaying = true; pausePlayback(); }
      mixer.tempoPct = Number(tempoSlider.value);
      updateToolReadouts();
      _scheduleTempoCompensation();
    });
    tempoSlider.addEventListener("change", () => {
      clearTimeout(_tempoDebounceTimer);
      const resume = _tempoWasPlaying;
      _tempoWasPlaying = false;
      applyPitchShift(resume)
        .then(() => scheduleSaveTempoPixchOverlay())
        .catch((err) => showError(err.message || "Failed to apply tempo."));
    });
    pitchSlider.addEventListener("input", () => {
      mixer.pitchSemitones = Number(pitchSlider.value);
      updateToolReadouts();
    });
    pitchSlider.addEventListener("change", () => {
      applyPitchShift()
        .then(() => scheduleSaveTempoPixchOverlay())
        .catch((err) => showError(err.message || "Failed to apply pitch."));
    });
    tempoResetBtn.addEventListener("click", () => {
      mixer.tempoPct = 100;
      tempoSlider.value = "100";
      updateToolReadouts();
      applyPitchShift()
        .then(() => scheduleSaveTempoPixchOverlay())
        .catch((err) => showError(err.message || "Failed to reset tempo."));
    });
    pitchResetBtn.addEventListener("click", () => {
      mixer.pitchSemitones = 0;
      pitchSlider.value = "0";
      updateToolReadouts();
      applyPitchShift()
        .then(() => scheduleSaveTempoPixchOverlay())
        .catch((err) => showError(err.message || "Failed to reset pitch."));
    });
