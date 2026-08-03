    function setSourceDownloadUrl(url) {
      sourceDownloadUrl = url || "";
      sourceDownloadBtn.disabled = !sourceDownloadUrl;
      sourceDownloadBtn.classList.toggle("ready", !!sourceDownloadUrl);
      sourceDownloadBtn.classList.toggle("hidden", !sourceDownloadUrl);
    }

    function parseDownloadFilename(contentDisposition, fallback) {
      const value = contentDisposition || "";
      const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
      if (utf8Match && utf8Match[1]) {
        try { return decodeURIComponent(utf8Match[1]); } catch (_) {}
      }
      const plainMatch = value.match(/filename=\"?([^\";]+)\"?/i);
      if (plainMatch && plainMatch[1]) return plainMatch[1];
      return fallback;
    }

    function downloadBlob(blob, filename) {
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 500);
    }

    function updateActionButtons() {
      if (!submitBtn || !downloadMp3Btn) return;
      const hasFile = !!(audioFileInput && audioFileInput.files && audioFileInput.files.length);
      const hasUrl = !!(sourceUrlInput && sourceUrlInput.value.trim());
      submitBtn.disabled = !(hasFile || hasUrl);
      const showDownloadButton = hasUrl && !hasFile;
      downloadMp3Btn.classList.toggle("hidden", !showDownloadButton);
    }

    let _searchDebounce = null;
    if (projectSearchInput) {
      projectSearchInput.addEventListener("input", () => {
        projectSearchTerm = projectSearchInput.value || "";
        // Instant client-side filter for already-loaded projects
        renderProjectList(allProjects);
        // Debounced server search for full result set
        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(() => loadProjects("", 0), 350);
      });
    }

    // Sort toggle button
    const projectSortBtn = document.getElementById("project-sort-btn");
    const sortIconRecent = document.getElementById("sort-icon-recent");
    const sortIconAlpha  = document.getElementById("sort-icon-alpha");
    function _applySortUI() {
      const isAlpha = projectSortMode === "alpha";
      if (projectSortBtn) projectSortBtn.classList.toggle("active", isAlpha);
      if (projectSortBtn) projectSortBtn.title = isAlpha ? "Sorted A–Z (click for newest first)" : "Sorted newest first (click for A–Z)";
      if (sortIconRecent) sortIconRecent.style.display = isAlpha ? "none" : "";
      if (sortIconAlpha)  sortIconAlpha.style.display  = isAlpha ? ""     : "none";
    }
    _applySortUI();
    if (projectSortBtn) {
      projectSortBtn.addEventListener("click", () => {
        projectSortMode = projectSortMode === "alpha" ? "recent" : "alpha";
        localStorage.setItem("stemsplitter.sortMode", projectSortMode);
        _applySortUI();
        renderProjectList(allProjects);
      });
    }
    function formatTime(seconds) {
      const rounded = Math.max(0, Math.floor(seconds));
      const mins = String(Math.floor(rounded / 60)).padStart(2, "0");
      const secs = String(rounded % 60).padStart(2, "0");
      return `${mins}:${secs}`;
    }

    function formatSeconds(seconds) {
      return (Math.max(0, seconds)).toFixed(2);
    }

    function getPitchShortLabel() {
      return mixer.pitchSemitones === 0 ? "0st" : `${mixer.pitchSemitones > 0 ? "+" : ""}${mixer.pitchSemitones}st`;
    }

    function getPitchLongLabel() {
      const amount = Number(mixer.pitchSemitones || 0);
      const unit = Math.abs(amount) === 1 ? "semitone" : "semitones";
      return `${amount > 0 ? "+" : ""}${amount} ${unit}`;
    }

    const NOTE_INDEX = {
      "C": 0, "B#": 0,
      "C#": 1, "DB": 1,
      "D": 2,
      "D#": 3, "EB": 3,
      "E": 4, "FB": 4,
      "F": 5, "E#": 5,
      "F#": 6, "GB": 6,
      "G": 7,
      "G#": 8, "AB": 8,
      "A": 9,
      "A#": 10, "BB": 10,
      "B": 11, "CB": 11,
    };
    const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    function getDisplayedKeyLabel(keyLabel) {
      const raw = String(keyLabel || "").trim();
      if (!raw) return "";
      const match = raw.match(/^([A-G](?:#|b)?)(.*)$/i);
      if (!match) return raw;
      const rootIndex = NOTE_INDEX[match[1].toUpperCase()];
      if (!Number.isInteger(rootIndex)) return raw;
      const semitones = Number.isFinite(Number(mixer.pitchSemitones)) ? Number(mixer.pitchSemitones) : 0;
      const shiftedIndex = ((rootIndex + semitones) % 12 + 12) % 12;
      return `${NOTE_NAMES_SHARP[shiftedIndex]}${match[2] || ""}`;
    }

    function refreshDisplayedKeyBadges() {
      const confidencePct = Math.round((mixer.keyConfidence || 0) * 100);
      const displayedKey = getDisplayedKeyLabel(mixer.key);
      for (const track of mixer.tracks || []) {
        if (track.key !== "vocals") continue;
        const nameBlock = track.row?.querySelector(".track-name-block");
        if (!nameBlock) continue;
        let badge = nameBlock.querySelector(".key-badge");
        if (badge && badge.classList.contains("key-badge--pending")) continue;
        if (!displayedKey || confidencePct < 50) {
          badge?.remove();
          continue;
        }
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "key-badge";
          nameBlock.appendChild(badge);
        }
        badge.textContent = `♪ ${displayedKey}`;
        badge.title = `Key: ${displayedKey}${confidencePct ? ` (${confidencePct}% confidence)` : ""}`;
      }
    }

    function makeLoopDownloadUrl(trackKey) {
      const params = new URLSearchParams({
        start: String(mixer.loopStart ?? 0),
        end: String(mixer.loopEnd ?? 0),
      });
      return `${API_BASE}/jobs/${mixer.jobId}/stems/${trackKey}/loop?${params.toString()}`;
    }

    function applyLoopRange(start, end) {
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const safeStart = Math.max(0, Math.min(start, mixer.duration || 0));
      const safeEnd = Math.max(0, Math.min(end, mixer.duration || 0));
      if (safeEnd <= safeStart) return;
      mixer.loopStart = safeStart;
      mixer.loopEnd = safeEnd;
      loopStartInput.value = formatSeconds(safeStart);
      loopEndInput.value = formatSeconds(safeEnd);
      updateToolReadouts();
      redrawAllWaveforms();
      scheduleSaveProjectMetadata();
    }

    function effectiveTempoRate() {
      return mixer.tempoPct / 100;
    }

    function updateTrackAudibility() {
      const hasSolo = mixer.tracks.some((item) => item.soloed);
      const ctx = mixer.audioContext;
      for (const track of mixer.tracks) {
        if (!track.gainNode) continue;
        const trackVolume = Number.isFinite(track.volume) ? Math.max(0, Math.min(1, track.volume)) : 1;
        const isAudible = hasSolo ? !!track.soloed : true;
        const gain = (track.muted || !isAudible) ? 0 : trackVolume;
        // Smooth gain change to avoid clicks
        if (ctx) {
          track.gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.015);
        } else {
          track.gainNode.gain.value = gain;
        }
      }
    }

    function applyPlaybackSettings(track) {
      const pitchComp = Number.isFinite(track.pitchTempoComp) ? track.pitchTempoComp : 1;
      const rate = effectiveTempoRate() * pitchComp;
      if (track.sourceNode) track.sourceNode.playbackRate.value = rate;
      updateTrackAudibility();
    }

    function setPitchWarmupBanner(active, done) {
      const banner = document.getElementById("pitch-warmup-banner");
      const bannerDone = document.getElementById("pitch-warmup-banner-done");
      if (active) {
        if (banner) banner.classList.remove("hidden");
        if (bannerDone) bannerDone.classList.add("hidden");
      } else if (done) {
        if (banner) banner.classList.add("hidden");
        if (bannerDone) {
          bannerDone.classList.remove("hidden");
          setTimeout(() => bannerDone.classList.add("hidden"), 3500);
        }
      } else {
        if (banner) banner.classList.add("hidden");
        if (bannerDone) bannerDone.classList.add("hidden");
      }
    }

    async function loadPitchAdjustedTrack(track, semitones) {
      // AudioBufferSourceNode.playbackRate = r shifts pitch by 12·log₂(r) semitones.
      // Counter-compensate so the net pitch heard = the user's intended value.
      const tempoCompSemitones = -12 * Math.log2(effectiveTempoRate());
      const effectiveSemitones = semitones + tempoCompSemitones;
      const cacheKey = `${track.key}:${effectiveSemitones.toFixed(4)}`;

      // Cache hit: use the pre-decoded buffer instantly — no network, no decode.
      const cached = mixer.pitchBufferCache.get(cacheKey);
      if (cached) {
        track.buffer = cached.buffer;
        track.waveformLevels = cached.waveformLevels;
        track.pitchTempoComp = cached.pitchTempoComp;
        applyPlaybackSettings(track);
        return;
      }

      // Cache miss: fetch from server, then store for future use.
      const pitchUrl = `${track.url}${track.url.includes("?") ? "&" : "?"}pitch=${encodeURIComponent(effectiveSemitones.toFixed(4))}`;
      const response = await fetch(pitchUrl);
      if (!response.ok) throw new Error(`Failed to apply pitch for ${track.key}.`);
      const arrayBuffer = await response.arrayBuffer();
      const decoded = await mixer.audioContext.decodeAudioData(arrayBuffer.slice(0));
      track.buffer = decoded;
      track.waveformLevels = buildWaveformLevels(decoded);
      track.pitchTempoComp = decoded.duration > 0 ? (track.sourceDuration / decoded.duration) : 1;
      mixer.pitchBufferCache.set(cacheKey, {
        buffer: decoded,
        waveformLevels: track.waveformLevels,
        pitchTempoComp: track.pitchTempoComp,
      });
      applyPlaybackSettings(track);
    }

    // Build the list of effectiveSemitones values for ±4 user semitones around center.
    function _buildNeighborhoodEffective(centerUserSemitones) {
      const tempoComp = -12 * Math.log2(effectiveTempoRate());
      const result = [];
      for (let delta = -4; delta <= 4; delta++) {
        const userPitch = centerUserSemitones + delta;
        if (userPitch < -12 || userPitch > 12) continue;
        const effective = parseFloat((userPitch + tempoComp).toFixed(4));
        if (effective < -24 || effective > 24) continue;
        result.push(effective);
      }
      return result;
    }

    // Pre-fetch a single effectiveSemitones variant for all tracks and store in cache.
    async function _prefetchPitchVariant(effectiveSemitones) {
      if (!mixer.audioContext || !mixer.tracks.length) return;
      for (const track of mixer.tracks) {
        const cacheKey = `${track.key}:${effectiveSemitones.toFixed(4)}`;
        if (mixer.pitchBufferCache.has(cacheKey)) continue;
        try {
          const url = `${track.url}${track.url.includes("?") ? "&" : "?"}pitch=${encodeURIComponent(effectiveSemitones.toFixed(4))}`;
          const resp = await fetch(url);
          if (!resp.ok) continue;
          const buf = await resp.arrayBuffer();
          const decoded = await mixer.audioContext.decodeAudioData(buf);
          const waveformLevels = buildWaveformLevels(decoded);
          const pitchTempoComp = decoded.duration > 0 ? (track.sourceDuration / decoded.duration) : 1;
          mixer.pitchBufferCache.set(cacheKey, { buffer: decoded, waveformLevels, pitchTempoComp });
        } catch (_) {}
      }
    }

    // Poll server until all neighborhood variants are cached, then pre-fetch each one.
    async function _pollAndPrefetchNeighborhood(semitonesList, jobId) {
      if (!semitonesList.length) return;
      const params = semitonesList.map((s) => s.toFixed(4)).join(",");
      const maxAttempts = 60;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (mixer.jobId !== jobId) return; // job changed
        try {
          const resp = await fetch(`${API_BASE}/jobs/${jobId}/pitch-cache-status?semitones=${encodeURIComponent(params)}`);
          if (!resp.ok) return;
          const data = await resp.json();
          for (const s of (data.ready || [])) {
            await _prefetchPitchVariant(s);
          }
          if (!(data.pending || []).length) {
            setPitchWarmupBanner(false, true);
            return;
          }
        } catch (_) {}
      }
      setPitchWarmupBanner(false, false);
    }

    // Trigger server-side background generation of ±4 neighborhood, then pre-fetch into cache.
    async function triggerPitchWarmup(centerUserSemitones) {
      if (!mixer.jobId || LITE_MODE) return;
      const neighborhood = _buildNeighborhoodEffective(centerUserSemitones);
      const toWarm = neighborhood.filter((s) =>
        mixer.tracks.some((t) => !mixer.pitchBufferCache.has(`${t.key}:${s.toFixed(4)}`))
      );
      if (!toWarm.length) return;
      setPitchWarmupBanner(true, false);
      try {
        await fetch(`${API_BASE}/jobs/${mixer.jobId}/pitch-warmup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ semitones: toWarm }),
        });
      } catch (_) {}
      _pollAndPrefetchNeighborhood(neighborhood, mixer.jobId);
    }

    async function applyPitchShift(resumeAfter = false) {
      if (!mixer.audioContext || !mixer.tracks.length) return;
      const wasPlaying = mixer.isPlaying || resumeAfter;
      const offset = currentOffset();
      setPitchLoading(true);
      try {
        pausePlayback();
        for (const track of mixer.tracks) {
          await loadPitchAdjustedTrack(track, mixer.pitchSemitones);
        }
        mixer.duration = Math.max(...mixer.tracks.map((track) => track.buffer.duration));
        setViewportWindow(mixer.visibleStart || 0, mixer.visibleDuration || mixer.duration);
        redrawAllWaveforms();
        if (wasPlaying) {
          await playFrom(Math.min(offset, mixer.duration || offset));
        } else {
          mixer.pausedAt = Math.min(offset, mixer.duration || offset);
          setTransport(mixer.pausedAt);
        }
      } finally {
        setPitchLoading(false);
      }
      // After first pitch request, kick off background warmup for ±4 semitones.
      if (!mixer.pitchNeighborhoodWarmed) {
        mixer.pitchNeighborhoodWarmed = true;
        triggerPitchWarmup(mixer.pitchSemitones);
      }
    }

    async function applySavedMixerState(mixerState) {
      if (!mixerState || typeof mixerState !== "object") return;
      isRestoringProjectState = true;
      try {
        mixer.tempoPct = Number.isFinite(Number(mixerState.tempo_pct)) ? Number(mixerState.tempo_pct) : 100;
        mixer.tempoPct = Math.max(50, Math.min(150, mixer.tempoPct));
        mixer.pitchSemitones = Number.isFinite(Number(mixerState.pitch_semitones)) ? Number(mixerState.pitch_semitones) : 0;
        mixer.pitchSemitones = Math.max(-12, Math.min(12, mixer.pitchSemitones));
        tempoSlider.value = String(mixer.tempoPct);
        pitchSlider.value = String(mixer.pitchSemitones);
        mixer.loopStart = Number.isFinite(Number(mixerState.loop_start)) ? Number(mixerState.loop_start) : null;
        mixer.loopEnd = Number.isFinite(Number(mixerState.loop_end)) ? Number(mixerState.loop_end) : null;
        if (mixer.loopStart !== null && mixer.loopEnd !== null && mixer.loopEnd <= mixer.loopStart) {
          mixer.loopStart = null;
          mixer.loopEnd = null;
        }
        mixer.loopEnabled = !!mixerState.loop_enabled;
        const tracksState = (mixerState.tracks && typeof mixerState.tracks === "object") ? mixerState.tracks : {};
        for (const track of mixer.tracks) {
          const savedTrack = tracksState[track.key] || {};
          track.muted = !!savedTrack.muted;
          track.volume = Number.isFinite(Number(savedTrack.volume)) ? Number(savedTrack.volume) : 1;
          track.volume = Math.max(0, Math.min(2, track.volume));
          const savedMarkers = Array.isArray(savedTrack.markers) ? savedTrack.markers : [];
          track.markers = savedMarkers
            .filter((marker) => marker && typeof marker === "object")
            .map((marker) => ({
              id: marker.id || `${Date.now()}_${Math.random()}`,
              label: String(marker.label || "").trim(),
              time: Number(marker.time || 0),
            }))
            .filter((marker) => Number.isFinite(marker.time) && marker.time >= 0)
            .sort((a, b) => a.time - b.time);
          if (track.muteButton) {
            track.muteButton.classList.toggle("muted", track.muted);
            track.muteButton.setAttribute("aria-pressed", track.muted ? "true" : "false");
            track.muteButton.title = track.muted ? `Unmute ${track.key}` : `Mute ${track.key}`;
            track.muteButton.setAttribute("aria-label", track.muted ? `Unmute ${track.key}` : `Mute ${track.key}`);
          }
          if (track.volumeSlider) {
            track.volumeSlider.value = String(Math.round(track.volume * 100));
          }
          if (track.volumeLabel) {
            track.volumeLabel.textContent = `Vol ${Math.round(track.volume * 100)}%`;
          }
          applyPlaybackSettings(track);
        }
        updateToolReadouts();
        renderMarkerChips();
        if (mixer.pitchSemitones !== 0 || mixer.tempoPct !== 100) {
          await applyPitchShift();
        } else {
          redrawAllWaveforms();
        }
      } finally {
        isRestoringProjectState = false;
        _updateRevertBtn();
      }
    }

    function stopTracks(resetPosition = false) {
      for (const track of mixer.tracks) {
        if (track.sourceNode) {
          try { track.sourceNode.stop(); } catch (_) {}
          track.sourceNode = null;
        }
      }
      if (resetPosition) mixer.pausedAt = 0;
    }

    function currentOffset() {
      if (!mixer.tracks.length) return 0;
      if (!mixer.isPlaying || !mixer.audioContext) return mixer.pausedAt;
      const elapsed = (mixer.audioContext.currentTime - mixer.startedAt) * effectiveTempoRate();
      return Math.min(mixer.duration, mixer.pausedAt + Math.max(0, elapsed));
    }

    let _transportThrottleCount = 0;
    let _mobileScrubTarget = null;
    function _isMobileWaveform() { return window.innerWidth <= 768; }

    function setTransport(offset) {
      const _mob = _isMobileWaveform();
      if (mixer.isPlaying) {
        if (_mob) {
          queueWaveformRedraw();
        } else {
          const previousStart = mixer.visibleStart || 0;
          ensureTimeVisible(offset);
          if (Math.abs((mixer.visibleStart || 0) - previousStart) > 0.0001) {
            queueWaveformRedraw();
          }
        }
      }

      // Playhead positions: on mobile the line is drawn on canvas; hide the div
      for (const track of mixer.tracks) {
        if (track.playhead) {
          if (_mob) {
            track.playhead.style.opacity = "0";
          } else {
            const width = getTrackViewportWidth(track);
            const x = timeToViewportX(offset, width);
            const isVisible = x >= 0 && x <= width;
            track.playhead.style.transform = `translateX(${Math.max(0, Math.min(width, x))}px)`;
            track.playhead.style.opacity = isVisible ? "1" : "0";
          }
        }
      }
      if (activeWorkspaceTab === "timing" || (activeWorkspaceTab === "karaoke" && !_vocalsWaveHidden)) updateLyricsVocalsPlayhead(offset);

      // Seek sliders + time text: throttle to ~15fps during playback to reduce
      // main-thread work that competes with audio processing on mobile.
      if (mixer.isPlaying) {
        _transportThrottleCount = (_transportThrottleCount + 1) % 4;
        if (_transportThrottleCount !== 0) return;
      }

      const safeDuration = Math.max(0.001, mixer.duration || 0.001);
      const pct = Math.max(0, Math.min(1000, Math.round((offset / safeDuration) * 1000)));
      transportSeek.value = String(pct);
      transportTime.textContent = `${formatTime(offset)} / ${formatTime(mixer.duration || 0)}`;
      if (miniSeek && mixer.duration && !miniSeek.dataset.seeking) {
        miniSeek.value = Math.round((offset / mixer.duration) * 1000);
      }
      if (miniPlayerTime) {
        miniPlayerTime.textContent = `${formatTime(offset)} / ${formatTime(mixer.duration || 0)}`;
      }
      // Update prev/next marker button states for each track
      for (const track of mixer.tracks) {
        if (typeof track.updateMarkerBarButtons === "function") track.updateMarkerBarButtons();
      }
    }

    function buildWaveformLevels(audioBuffer) {
      const sourceLength = audioBuffer.length || 0;
      const channelCount = audioBuffer.numberOfChannels || 1;
      const channels = [];
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        channels.push(audioBuffer.getChannelData(channelIndex));
      }
      const levels = [];
      let bucketSize = 64;
      let peakCount = Math.max(1, Math.ceil(sourceLength / bucketSize));
      let mins = new Float32Array(peakCount);
      let maxs = new Float32Array(peakCount);
      for (let peakIndex = 0; peakIndex < peakCount; peakIndex += 1) {
        let min = 1;
        let max = -1;
        const start = peakIndex * bucketSize;
        const end = Math.min(start + bucketSize, sourceLength);
        for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
          for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
            const sample = channels[channelIndex][sampleIndex] || 0;
            if (sample < min) min = sample;
            if (sample > max) max = sample;
          }
        }
        mins[peakIndex] = min;
        maxs[peakIndex] = max;
      }
      levels.push({ bucketSize, mins, maxs });

      while (peakCount > 1) {
        const nextPeakCount = Math.max(1, Math.ceil(peakCount / 2));
        const nextMins = new Float32Array(nextPeakCount);
        const nextMaxs = new Float32Array(nextPeakCount);
        for (let peakIndex = 0; peakIndex < nextPeakCount; peakIndex += 1) {
          const sourceIndex = peakIndex * 2;
          const nextIndex = Math.min(sourceIndex + 1, peakCount - 1);
          nextMins[peakIndex] = Math.min(mins[sourceIndex], mins[nextIndex]);
          nextMaxs[peakIndex] = Math.max(maxs[sourceIndex], maxs[nextIndex]);
        }
        bucketSize *= 2;
        peakCount = nextPeakCount;
        mins = nextMins;
        maxs = nextMaxs;
        levels.push({ bucketSize, mins, maxs });
      }

      return levels;
    }

    function getWaveformLevel(track, samplesPerPixel) {
      const levels = track.waveformLevels || [];
      if (!levels.length) return null;
      let selected = levels[0];
      for (const level of levels) {
        if (level.bucketSize <= samplesPerPixel) {
          selected = level;
        } else {
          break;
        }
      }
      return selected;
    }

    function drawVisibleWaveform(track, canvas) {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx || !track.buffer) return;
      const width = getTrackViewportWidth(track);
      const height = track.waveCssHeight || 62;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const markers = track.markers || [];
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const amp = height / 2;
      ctx.fillStyle = track.waveBackground || "#dde6ff";
      ctx.fillRect(0, 0, width, height);

      // Viewport: on mobile, center on current playback position (or scrub target)
      const _mob = _isMobileWaveform();
      const visibleDuration = mixer.visibleDuration || getMaxVisibleDuration();
      const visibleStart = _mob
        ? ((_mobileScrubTarget !== null ? _mobileScrubTarget : currentOffset()) - visibleDuration / 2)
        : (mixer.visibleStart || 0);
      const visibleEnd = visibleStart + visibleDuration;
      // Local coordinate helper — uses the (possibly mobile-adjusted) visibleStart
      const _tToX = (t) => ((t - visibleStart) / Math.max(0.0001, visibleDuration)) * width;

      // BPM segment bands — drawn on drums track when multiple tempos detected
      if (track.key === "drums" && mixer.bpmSegments && mixer.bpmSegments.length > 1) {
        const segPalette = [
          "rgba(251,146,60,0.18)",   // orange
          "rgba(52,211,153,0.18)",   // green
          "rgba(129,140,248,0.18)",  // indigo
          "rgba(251,191,36,0.18)",   // amber
          "rgba(248,113,113,0.18)",  // red
        ];
        for (let si = 0; si < mixer.bpmSegments.length; si++) {
          const seg = mixer.bpmSegments[si];
          const xStart = Math.max(0, _tToX(seg.start));
          const xEnd   = Math.min(width, _tToX(seg.end));
          if (xEnd <= xStart) continue;
          ctx.fillStyle = segPalette[si % segPalette.length];
          ctx.fillRect(xStart, 0, xEnd - xStart, height);

          // BPM label inside the band
          const bandWidth = xEnd - xStart;
          if (bandWidth > 36) {
            const label = `${seg.bpm}`;
            ctx.font = "bold 11px system-ui, sans-serif";
            ctx.textBaseline = "top";
            const tw = ctx.measureText(label).width;
            const lx = xStart + Math.min(6, (bandWidth - tw) / 2);
            const ly = 4;
            ctx.fillStyle = "rgba(0,0,0,0.42)";
            const pill = { x: lx - 4, y: ly - 2, w: tw + 8, h: 16, r: 6 };
            if (typeof ctx.roundRect === "function") {
              ctx.beginPath(); ctx.roundRect(pill.x, pill.y, pill.w, pill.h, pill.r); ctx.fill();
            } else {
              ctx.fillRect(pill.x, pill.y, pill.w, pill.h);
            }
            ctx.fillStyle = "#ffffff";
            ctx.fillText(label, lx, ly);
          }
        }
        // Draw divider lines between segments
        for (let si = 1; si < mixer.bpmSegments.length; si++) {
          const x = _tToX(mixer.bpmSegments[si].start);
          if (x < 0 || x > width) continue;
          ctx.strokeStyle = "rgba(0,0,0,0.25)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      ctx.fillStyle = track.waveFillColor || "#2256e8";
      const sampleRate = track.buffer?.sampleRate || 44100;
      const bufferLength = track.buffer?.length || 0;
      if (!bufferLength) return;
      const startSample = Math.max(0, Math.min(bufferLength, Math.floor(visibleStart * sampleRate)));
      const endSample = Math.max(startSample + 1, Math.min(bufferLength, Math.ceil(visibleEnd * sampleRate)));
      const visibleSamples = Math.max(1, endSample - startSample);
      const samplesPerPixel = Math.max(1, visibleSamples / Math.max(1, width));
      const level = getWaveformLevel(track, samplesPerPixel);
      if (level) {
        for (let x = 0; x < width; x += 1) {
          const pixelStartTime = visibleStart + (x / width) * visibleDuration;
          const pixelEndTime = visibleStart + ((x + 1) / width) * visibleDuration;
          const pixelStartSample = Math.max(0, Math.min(bufferLength - 1, Math.floor(pixelStartTime * sampleRate)));
          const pixelEndSample = Math.max(pixelStartSample + 1, Math.min(bufferLength, Math.ceil(pixelEndTime * sampleRate)));
          const peakStart = Math.min(level.mins.length - 1, Math.floor(pixelStartSample / level.bucketSize));
          const peakEnd = Math.min(level.mins.length, Math.max(peakStart + 1, Math.ceil(pixelEndSample / level.bucketSize)));
          let min = 1;
          let max = -1;
          for (let peakIndex = peakStart; peakIndex < peakEnd; peakIndex += 1) {
            if (level.mins[peakIndex] < min) min = level.mins[peakIndex];
            if (level.maxs[peakIndex] > max) max = level.maxs[peakIndex];
          }
          const y = Math.max(0, (1 + min) * amp);
          const barHeight = Math.max(1, (max - min) * amp);
          ctx.fillRect(x, y, 1, Math.min(height - y, barHeight));
        }
      }

      if (mixer.loopStart !== null && mixer.loopEnd !== null && mixer.loopEnd > mixer.loopStart) {
        const xStart = _tToX(mixer.loopStart);
        const xEnd = _tToX(mixer.loopEnd);
        const clampedStart = Math.max(0, Math.min(width, xStart));
        const clampedEnd = Math.max(0, Math.min(width, xEnd));
        if (clampedEnd > clampedStart) {
          ctx.fillStyle = "rgba(52, 211, 153, 0.22)";
          ctx.fillRect(clampedStart, 0, Math.max(2, clampedEnd - clampedStart), height);
        }
      } else if (mixer.loopStart !== null) {
        const xStart = _tToX(mixer.loopStart);
        if (xStart < width) {
          ctx.fillStyle = "rgba(245, 158, 11, 0.20)";
          ctx.fillRect(Math.max(0, xStart), 0, Math.max(2, width - Math.max(0, xStart)), height);
        }
      }

      ctx.font = "11px Menlo, Monaco, Consolas, monospace";
      ctx.textBaseline = "middle";
      const badgeRows = [];
      const visibleMarkers = [];
      for (const marker of markers) {
        const x = _tToX(marker.time);
        if (x < -56 || x > width + 4) continue;
        const label = String(marker.label || "");
        const textWidth = Math.ceil(ctx.measureText(label).width);
        const badgeWidth = Math.max(24, textWidth + 12);
        const badgeHeight = 18;
        const badgeX = Math.max(4, Math.min(width - badgeWidth - 4, x + 6));
        let rowIndex = 0;
        while (rowIndex < badgeRows.length && badgeX < badgeRows[rowIndex]) {
          rowIndex += 1;
        }
        badgeRows[rowIndex] = badgeX + badgeWidth + 6;
        visibleMarkers.push({
          marker,
          x,
          label,
          badgeWidth,
          badgeHeight,
          badgeX,
          badgeY: 6 + (rowIndex * (badgeHeight + 4)),
        });
      }

      for (const item of visibleMarkers) {
        const { x, label, badgeWidth, badgeHeight, badgeX, badgeY } = item;
        ctx.strokeStyle = track.markerHaloColor || "rgba(255,255,255,0.98)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.strokeStyle = track.markerColor || "#0f172a";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.fillStyle = track.markerBadgeColor || "rgba(15,23,42,0.94)";
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 8);
        } else {
          ctx.rect(badgeX, badgeY, badgeWidth, badgeHeight);
        }
        ctx.fill();
        ctx.strokeStyle = track.markerHaloColor || "rgba(255,255,255,0.98)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = track.markerTextColor || "#ffffff";
        ctx.fillText(label, badgeX + 6, badgeY + (badgeHeight / 2));
      }

      // Mobile: draw fixed centered playhead line on canvas
      if (_mob) {
        const cx = width / 2;
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
      }
    }

    function updateTrackWaveform(track) {
      const width = getTrackViewportWidth(track);
      const height = 66;
      track.waveCssWidth = width;
      track.waveCssHeight = height;
      track.waveContent.style.width = "100%";
      drawVisibleWaveform(track, track.canvasEl);
      if (track.loopDownloadBtn) {
        if (mixer.loopStart !== null && mixer.loopEnd !== null && mixer.loopEnd > mixer.loopStart) {
          const centerTime = (mixer.loopStart + mixer.loopEnd) / 2;
          const centerX = timeToViewportX(centerTime, width);
          const visible = centerX >= 0 && centerX <= width;
          track.loopDownloadBtn.style.left = `${Math.max(0, Math.min(width, centerX))}px`;
          track.loopDownloadBtn.classList.toggle("show", visible);
        } else {
          track.loopDownloadBtn.classList.remove("show");
        }
      }
    }

