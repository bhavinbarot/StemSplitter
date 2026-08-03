    // ── Lyrics vocals waveform strip ─────────────────────────────────────
    function drawLyricsVocalsWaveform() {
      if (!lyricsVocalsCanvas) return;
      const vocalsTrack = (mixer.tracks || []).find(t => t.key === "vocals");
      const canvas = lyricsVocalsCanvas;
      const wrap = lyricsVocalsWaveWrap;
      if (!vocalsTrack || !vocalsTrack.buffer || !wrap) {
        // Clear canvas
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const wr = wrap ? wrap.getBoundingClientRect() : { width: 400, height: 52 };
          canvas.width = wr.width || 400;
          canvas.height = wr.height || 52;
          ctx.fillStyle = "#f0f4ff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        return;
      }
      const wrapRect = wrap.getBoundingClientRect();
      const width = Math.max(1, Math.round(wrapRect.width || 400));
      const height = Math.max(1, Math.round(wrapRect.height || 52));
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width  = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width  = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = vocalsTrack.waveBackground || "#ede9fe";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = vocalsTrack.waveFillColor || "#7c3aed";
      const visibleStart    = mixer.visibleStart || 0;
      const visibleDuration = mixer.visibleDuration || getMaxVisibleDuration();
      const visibleEnd      = visibleStart + visibleDuration;
      const sampleRate      = vocalsTrack.buffer.sampleRate || 44100;
      const bufferLength    = vocalsTrack.buffer.length || 0;
      if (!bufferLength) return;
      const amp = height / 2;
      const cols = Math.max(1, width);
      for (let col = 0; col < cols; col++) {
        const tStart = visibleStart + (col / cols) * visibleDuration;
        const tEnd   = visibleStart + ((col + 1) / cols) * visibleDuration;
        const si = Math.max(0, Math.floor(tStart * sampleRate));
        const ei = Math.min(bufferLength - 1, Math.ceil(tEnd * sampleRate));
        if (si > ei) continue;
        let maxVal = 0;
        for (let ch = 0; ch < vocalsTrack.buffer.numberOfChannels; ch++) {
          const data = vocalsTrack.buffer.getChannelData(ch);
          for (let s = si; s <= ei; s++) {
            const v = Math.abs(data[s]);
            if (v > maxVal) maxVal = v;
          }
        }
        const barH = Math.max(1, maxVal * amp * 2);
        ctx.fillRect(col, amp - barH / 2, 1, barH);
      }

      // Draw vocals track markers
      const markers = vocalsTrack.markers || [];
      if (markers.length) {
        ctx.font = "10px Menlo, Monaco, Consolas, monospace";
        ctx.textBaseline = "middle";
        const badgeRows = [];
        const visibleMarkers = [];
        for (const marker of markers) {
          const x = ((marker.time - visibleStart) / visibleDuration) * width;
          if (x < -56 || x > width + 4) continue;
          const label = String(marker.label || "");
          const textWidth = Math.ceil(ctx.measureText(label).width);
          const badgeWidth = Math.max(20, textWidth + 10);
          const badgeHeight = 16;
          const badgeX = Math.max(2, Math.min(width - badgeWidth - 2, x + 4));
          let rowIndex = 0;
          while (rowIndex < badgeRows.length && badgeX < badgeRows[rowIndex]) rowIndex++;
          badgeRows[rowIndex] = badgeX + badgeWidth + 4;
          visibleMarkers.push({ x, label, badgeWidth, badgeHeight, badgeX, badgeY: 4 + rowIndex * (badgeHeight + 3) });
        }
        for (const { x, label, badgeWidth, badgeHeight, badgeX, badgeY } of visibleMarkers) {
          // White halo line
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
          // Dark marker line
          ctx.strokeStyle = "#0f172a";
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
          // Badge background
          ctx.fillStyle = "rgba(15,23,42,0.88)";
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 6);
          } else {
            ctx.rect(badgeX, badgeY, badgeWidth, badgeHeight);
          }
          ctx.fill();
          // Badge text
          ctx.fillStyle = "#ffffff";
          ctx.fillText(label, badgeX + 5, badgeY + badgeHeight / 2);
        }
      }
    }

    function updateLyricsVocalsPlayhead(offset) {
      if (!lyricsVocalsPlayhead || !lyricsVocalsWaveWrap) return;
      const wrapRect = lyricsVocalsWaveWrap.getBoundingClientRect();
      const width = Math.max(1, wrapRect.width || 400);
      const x = timeToViewportX(offset, width);
      const isVisible = x >= 0 && x <= width;
      lyricsVocalsPlayhead.style.left = `${Math.max(0, Math.min(width, x))}px`;
      lyricsVocalsPlayhead.style.opacity = isVisible ? "1" : "0";
    }

    function updateLyricsVocalsMarkLines() {
      if (!lyricsVocalsMarkLines || !lyricsVocalsWaveWrap) return;
      const wrapRect = lyricsVocalsWaveWrap.getBoundingClientRect();
      const width = Math.max(1, wrapRect.width || 400);
      lyricsVocalsMarkLines.innerHTML = "";
      const lyrics = (mixer.lyrics || []).filter(l => l.time !== null);
      for (const line of lyrics) {
        const x = timeToViewportX(line.time, width);
        if (x < -2 || x > width + 2) continue;
        const el = document.createElement("div");
        el.className = `lyrics-vocals-mark-line type-${line.type}`;
        el.style.left = `${x}px`;
        lyricsVocalsMarkLines.appendChild(el);
        const dot = document.createElement("div");
        dot.className = `lyrics-vocals-mark-dot type-${line.type}`;
        dot.style.left = `${x}px`;
        lyricsVocalsMarkLines.appendChild(dot);
      }
    }

    // Click on vocals strip to seek
    if (lyricsVocalsWaveWrap) {
      lyricsVocalsWaveWrap.addEventListener("click", async (e) => {
        const rect = lyricsVocalsWaveWrap.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const offset = viewportXToTime(x, Math.max(1, rect.width));
        await seekTo(offset);
      });
    }

    // Vocals waveform hide/show toggle (persists within session)
    let _vocalsWaveHidden = false;
    const lyricsVocalsWaveToggle = document.getElementById("lyrics-vocals-wave-toggle");
    if (lyricsVocalsWaveToggle) {
      lyricsVocalsWaveToggle.addEventListener("click", () => {
        _vocalsWaveHidden = !_vocalsWaveHidden;
        const wrap = document.getElementById("lyrics-vocals-wave-wrap");
        if (wrap) wrap.style.display = _vocalsWaveHidden ? "none" : "";
        lyricsVocalsWaveToggle.textContent = _vocalsWaveHidden ? "Show" : "Hide";
        lyricsVocalsWaveToggle.title = _vocalsWaveHidden ? "Show waveform" : "Hide waveform";
        if (!_vocalsWaveHidden) requestAnimationFrame(() => {
          drawLyricsVocalsWaveform();
          updateLyricsVocalsMarkLines();
          updateLyricsVocalsPlayhead(currentOffset());
        });
      });
    }

    // Vocals waveform zoom slider (mirrors main zoom state)
    const lyricsVocalsZoomSlider = document.getElementById("lyrics-vocals-zoom-slider");
    const lyricsVocalsZoomPct    = document.getElementById("lyrics-vocals-zoom-pct");

    function syncLyricsVocalsZoom() {
      if (!lyricsVocalsZoomSlider || !mixer.duration) return;
      const val = visibleDurationToZoomSlider(mixer.visibleDuration || getMaxVisibleDuration());
      lyricsVocalsZoomSlider.value = String(val);
      if (lyricsVocalsZoomPct) lyricsVocalsZoomPct.textContent = `${getZoomDisplayPercent()}%`;
    }

    if (lyricsVocalsZoomSlider) {
      lyricsVocalsZoomSlider.addEventListener("input", () => {
        const anchor = mixer.isPlaying ? currentOffset() : getViewportCenterTime();
        zoomViewport(zoomSliderToVisibleDuration(Number(lyricsVocalsZoomSlider.value)), anchor);
        if (lyricsVocalsZoomPct) lyricsVocalsZoomPct.textContent = `${getZoomDisplayPercent()}%`;
        drawLyricsVocalsWaveform();
        updateLyricsVocalsMarkLines();
        updateLyricsVocalsPlayhead(currentOffset());
      });
    }

    // ── Workspace tab switching ───────────────────────────────────────────
    function setWorkspaceTab(tab) {
      // Regular users (non-admin, non-contributor) cannot access the timing/editing tab
      if (tab === "timing" && document.body.classList.contains("non-admin") && !document.body.classList.contains("is-contributor")) tab = "mixer";
      activeWorkspaceTab = tab;
      document.querySelectorAll(".workspace-tab").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
      });

      const lyricsInputPanel = document.getElementById("lyrics-input-panel");
      const lyricsToolbar = lyricsPanel ? lyricsPanel.querySelector(".lyrics-toolbar") : null;
      const lyricsMarkRow = document.getElementById("lyrics-mark-row");
      const lyricsFRBar   = document.getElementById("lyrics-find-replace-bar");
      const lyricsVocalsSection = document.getElementById("lyrics-vocals-wave-section");
      const karaokeToolbar = document.getElementById("karaoke-toolbar");

      // Show/hide top-level panels
      if (mixerPanel) mixerPanel.style.display = tab === "mixer" ? "" : "none";
      if (lyricsInputPanel) lyricsInputPanel.style.display = tab === "lyrics" ? "flex" : "none";
      if (lyricsPanel) lyricsPanel.classList.toggle("active", tab === "timing" || tab === "karaoke");

      // Exit fullscreen if user switches away from karaoke
      if (tab !== "karaoke" && typeof exitKaraokeFullscreen === "function") exitKaraokeFullscreen();

      // Restore vocal volume when leaving karaoke
      if (tab !== "karaoke" && _karaokeVocalVolumeSaved !== null) {
        const vocalTrack = _getVocalTrack();
        if (vocalTrack) {
          vocalTrack.volume = _karaokeVocalVolumeSaved;
          if (vocalTrack.volumeSlider) vocalTrack.volumeSlider.value = String(Math.round(vocalTrack.volume * 100));
          if (vocalTrack.volumeLabel) vocalTrack.volumeLabel.textContent = `Vol ${Math.round(vocalTrack.volume * 100)}%`;
          applyPlaybackSettings(vocalTrack);
        }
        _karaokeVocalVolumeSaved = null;
      }

      if (tab === "lyrics") {
        renderSongLyricsTab();
      } else if (tab === "timing") {
        if (lyricsEditView) lyricsEditView.style.display = "";
        if (lyricsToolbar) lyricsToolbar.style.display = "";
        if (lyricsMarkRow) lyricsMarkRow.style.display = "";
        if (lyricsVocalsSection) lyricsVocalsSection.style.display = "";
        if (karaokeToolbar) karaokeToolbar.style.display = "none";
        if (lyricsKaraokeView) lyricsKaraokeView.classList.remove("active");
        lyricsKaraokeMode = false;
        renderLyricsEditView();
        requestAnimationFrame(() => {
          drawLyricsVocalsWaveform();
          updateLyricsVocalsMarkLines();
          updateLyricsVocalsPlayhead(currentOffset());
        });
      } else if (tab === "karaoke") {
        if (lyricsEditView) lyricsEditView.style.display = "none";
        if (lyricsToolbar) lyricsToolbar.style.display = "none";
        if (lyricsMarkRow) lyricsMarkRow.style.display = "none";
        if (lyricsFRBar) lyricsFRBar.style.display = "none";
        if (lyricsVocalsSection) lyricsVocalsSection.style.display = _vocalsWaveHidden ? "none" : "";
        if (karaokeToolbar) karaokeToolbar.style.display = "";
        if (lyricsKaraokeView) lyricsKaraokeView.classList.add("active");
        lyricsKaraokeMode = true;
        const vocalTrack = _getVocalTrack();
        if (vocalTrack && _karaokeVocalVolumeSaved === null) {
          _karaokeVocalVolumeSaved = vocalTrack.volume ?? 1;
          vocalTrack.volume = 0.05;
          applyPlaybackSettings(vocalTrack);
        }
        const karaokeVolSlider = document.getElementById("karaoke-vocal-vol-slider");
        const karaokeVolDisplay = document.getElementById("karaoke-vocal-vol-display");
        if (karaokeVolSlider) karaokeVolSlider.value = String(Math.round((vocalTrack ? vocalTrack.volume : 0.05) * 100));
        if (karaokeVolDisplay) karaokeVolDisplay.textContent = Math.round((vocalTrack ? vocalTrack.volume : 0.05) * 100) + "%";
        renderLyricsKaraokeView(currentOffset());
        if (!_vocalsWaveHidden) requestAnimationFrame(() => {
          drawLyricsVocalsWaveform();
          updateLyricsVocalsMarkLines();
          updateLyricsVocalsPlayhead(currentOffset());
        });
      } else {
        // mixer tab
        if (lyricsEditView) lyricsEditView.style.display = "";
        if (lyricsToolbar) lyricsToolbar.style.display = "";
        if (lyricsMarkRow) lyricsMarkRow.style.display = "";
        if (lyricsVocalsSection) lyricsVocalsSection.style.display = "";
        if (lyricsKaraokeView) lyricsKaraokeView.classList.remove("active");
        lyricsKaraokeMode = false;
      }
    }

    // ── Song Lyrics tab — rich text editor ───────────────────────────────
    let _songLyricsEditMode = false;
    let _slxSavedRange      = null;

    function _isSongLyricsEditor() {
      return !document.body.classList.contains("non-admin") || document.body.classList.contains("is-contributor");
    }

    function _slxSaveRange() {
      const sel = window.getSelection();
      _slxSavedRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
    }

    function _slxRestoreRange() {
      if (!_slxSavedRange) return;
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(_slxSavedRange); }
    }

    function _slxCmd(cmd, val = null) {
      const editor = document.getElementById("song-lyrics-editor");
      if (!editor) return;
      editor.focus();
      document.execCommand(cmd, false, val);
    }

    function _slxUpdateState() {
      const map = {
        "slx-bold":       "bold",
        "slx-italic":     "italic",
        "slx-underline":  "underline",
        "slx-strike":     "strikeThrough",
        "slx-align-left": "justifyLeft",
        "slx-ol":         "insertOrderedList",
        "slx-ul":         "insertUnorderedList",
      };
      for (const [id, cmd] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (el) {
          try { el.classList.toggle("active", document.queryCommandState(cmd)); } catch (_) {}
        }
      }
    }

    function renderSongLyricsTab() {
      const readView  = document.getElementById("song-lyrics-read-view");
      const editView  = document.getElementById("song-lyrics-edit-view");
      const editBtn   = document.getElementById("song-lyrics-edit-btn");
      const addBtn    = document.getElementById("song-lyrics-add-btn");
      const saveBtn   = document.getElementById("song-lyrics-save-btn");
      const cancelBtn = document.getElementById("song-lyrics-cancel-edit-btn");
      if (!readView) return;

      const canEdit = _isSongLyricsEditor();
      const html    = (mixer.songLyricsText || "").trim();
      const hasText = !!html;

      if (_songLyricsEditMode && canEdit) {
        readView.style.display   = "none";
        if (editView)  editView.style.display  = "flex";
        if (saveBtn)   saveBtn.style.display   = "";
        if (cancelBtn) cancelBtn.style.display = "";
        if (editBtn)   editBtn.style.display   = "none";
        if (addBtn)    addBtn.style.display    = "none";
        const editor = document.getElementById("song-lyrics-editor");
        if (editor && editor.innerHTML !== html) editor.innerHTML = html;
        setTimeout(() => { editor && editor.focus(); }, 50);
        return;
      }

      _songLyricsEditMode = false;
      readView.style.display = "";
      if (editView)  editView.style.display  = "none";
      if (saveBtn)   saveBtn.style.display   = "none";
      if (cancelBtn) cancelBtn.style.display = "none";

      if (canEdit) {
        if (editBtn) editBtn.style.display = hasText ? "" : "none";
        if (addBtn)  addBtn.style.display  = hasText ? "none" : "";
      } else {
        if (editBtn) editBtn.style.display = "none";
        if (addBtn)  addBtn.style.display  = "none";
      }

      const readText = document.getElementById("song-lyrics-read-text");
      const emptyEl  = document.getElementById("song-lyrics-read-empty");
      if (readText) { readText.innerHTML = html; readText.style.display = hasText ? "" : "none"; }
      if (emptyEl)  emptyEl.style.display = hasText ? "none" : "";
    }

    async function saveSongLyrics() {
      const statusEl = document.getElementById("song-lyrics-status");
      const editor   = document.getElementById("song-lyrics-editor");
      const html     = editor ? editor.innerHTML : "";
      mixer.songLyricsText = html;
      try {
        const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(mixer.jobId)}/song-lyrics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lyrics_text: html }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Save failed.");
        if (statusEl) { statusEl.textContent = "Saved."; setTimeout(() => { statusEl.textContent = ""; }, 2000); }
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        const hasText = !!tmp.textContent.trim();
        const proj = allProjects.find(p => p.job_id === mixer.jobId);
        if (proj && proj.has_song_lyrics !== hasText) {
          proj.has_song_lyrics = hasText;
          renderProjectList(allProjects);
        }
      } catch (err) {
        if (statusEl) { statusEl.textContent = "Error saving."; setTimeout(() => { statusEl.textContent = ""; }, 3000); }
      }
    }

    document.addEventListener("DOMContentLoaded", () => {
      const editBtn   = document.getElementById("song-lyrics-edit-btn");
      const addBtn    = document.getElementById("song-lyrics-add-btn");
      const saveBtn   = document.getElementById("song-lyrics-save-btn");
      const cancelBtn = document.getElementById("song-lyrics-cancel-edit-btn");
      const editor    = document.getElementById("song-lyrics-editor");

      if (editBtn)   editBtn.addEventListener("click",   () => { _songLyricsEditMode = true;  renderSongLyricsTab(); });
      if (addBtn)    addBtn.addEventListener("click",    () => { _songLyricsEditMode = true;  renderSongLyricsTab(); });
      if (cancelBtn) cancelBtn.addEventListener("click", () => { _songLyricsEditMode = false; renderSongLyricsTab(); });
      if (saveBtn)   saveBtn.addEventListener("click",   async () => {
        await saveSongLyrics();
        _songLyricsEditMode = false;
        renderSongLyricsTab();
      });

      // Simple buttons — mousedown + preventDefault keeps the editor's selection intact
      const simpleBtns = {
        "slx-bold":         () => _slxCmd("bold"),
        "slx-italic":       () => _slxCmd("italic"),
        "slx-underline":    () => _slxCmd("underline"),
        "slx-strike":       () => _slxCmd("strikeThrough"),
        "slx-align-left":   () => _slxCmd("justifyLeft"),
        "slx-ol":           () => _slxCmd("insertOrderedList"),
        "slx-ul":           () => _slxCmd("insertUnorderedList"),
        "slx-clear-format": () => _slxCmd("removeFormat"),
      };
      for (const [id, fn] of Object.entries(simpleBtns)) {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener("mousedown", (e) => { e.preventDefault(); fn(); _slxUpdateState(); });
      }

      // Dropdowns: save selection on editor blur, restore before applying
      let _editorLastRange = null;
      if (editor) {
        editor.addEventListener("blur", () => {
          const sel = window.getSelection();
          _editorLastRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
        });
        editor.addEventListener("keyup",   _slxUpdateState);
        editor.addEventListener("mouseup",  _slxUpdateState);
      }

      function _restoreAndRun(fn) {
        if (_editorLastRange && editor) {
          editor.focus();
          const sel = window.getSelection();
          if (sel) { sel.removeAllRanges(); sel.addRange(_editorLastRange); }
        }
        fn();
      }

      const fontSel = document.getElementById("slx-font-family");
      if (fontSel) fontSel.addEventListener("change", () => _restoreAndRun(() => _slxCmd("fontName", fontSel.value)));

      const blockSel = document.getElementById("slx-format-block");
      if (blockSel) blockSel.addEventListener("change", () => _restoreAndRun(() => _slxCmd("formatBlock", blockSel.value)));

      // Text color
      const colorInput = document.getElementById("slx-color");
      const colorBar   = document.getElementById("slx-color-bar");
      const colorBtn   = document.getElementById("slx-color-btn");
      if (colorBtn && colorInput) {
        colorBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          _slxSaveRange();
          colorInput.click();
        });
        colorInput.addEventListener("input", () => {
          if (colorBar) colorBar.style.background = colorInput.value;
        });
        colorInput.addEventListener("change", () => {
          if (colorBar) colorBar.style.background = colorInput.value;
          _slxRestoreRange();
          _slxCmd("foreColor", colorInput.value);
        });
      }

      // Highlight color
      const hlInput   = document.getElementById("slx-highlight");
      const hlBar     = document.getElementById("slx-highlight-bar");
      const hlPreview = document.getElementById("slx-highlight-preview");
      const hlBtn     = document.getElementById("slx-highlight-btn");
      if (hlBtn && hlInput) {
        hlBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          _slxSaveRange();
          hlInput.click();
        });
        hlInput.addEventListener("input", () => {
          if (hlBar)     hlBar.style.background     = hlInput.value;
          if (hlPreview) hlPreview.style.background = hlInput.value;
        });
        hlInput.addEventListener("change", () => {
          if (hlBar)     hlBar.style.background     = hlInput.value;
          if (hlPreview) hlPreview.style.background = hlInput.value;
          _slxRestoreRange();
          _slxCmd("hiliteColor", hlInput.value);
        });
      }
    });

    function refreshKaraokeTabVisibility() {
      const karaokeTabBtn = document.getElementById("karaoke-tab-btn");
      if (!karaokeTabBtn) return;
      const hasLyrics = (mixer.lyrics || []).some(l => l.text || l.text_alt);
      karaokeTabBtn.style.display = hasLyrics ? "" : "none";
      if (!hasLyrics && activeWorkspaceTab === "karaoke") {
        const canSeeTiming = !document.body.classList.contains("non-admin") || document.body.classList.contains("is-contributor");
        setWorkspaceTab(canSeeTiming ? "timing" : "mixer");
      }
      if (activeWorkspaceTab === "lyrics") renderSongLyricsTab();
    }

    document.querySelectorAll(".workspace-tab").forEach(btn => {
      btn.addEventListener("click", () => setWorkspaceTab(btn.dataset.tab));
    });

    // ── Lyrics helpers ───────────────────────────────────────────────────
    function makeLyricId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function typeLabel(type) {
      if (type === "chorus") return "Chorus";
      if (type === "music")  return "Music";
      return "Lead";
    }

    function buildMixerStatePayloadWithLyrics() {
      return {
        mixer_state: buildMixerStatePayload(),
        lyrics: (mixer.lyrics || []).map(l => ({
          id: l.id,
          text: l.text || "",
          text_alt: l.text_alt || "",
          time: l.time,
          type: l.type,
        })),
      };
    }

    async function persistMetadataWithLyrics() {
      if (!mixer.jobId || isRestoringProjectState) return;
      try {
        await fetch(`${API_BASE}/jobs/${encodeURIComponent(mixer.jobId)}/metadata`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildMixerStatePayloadWithLyrics()),
        });
        // Update in-memory project flags so sidebar icons reflect current state
        const lyrics = mixer.lyrics || [];
        const hasKaraoke = lyrics.some(l => l.time !== null && (l.text || l.text_alt || "").trim());
        const proj = allProjects.find(p => p.job_id === mixer.jobId);
        if (proj && proj.has_karaoke !== hasKaraoke) {
          proj.has_karaoke = hasKaraoke;
          renderProjectList(allProjects);
        }
      } catch (err) {
        console.error("Failed to save lyrics.", err);
      }
    }

    function scheduleSaveLyrics() {
      refreshKaraokeTabVisibility();
      if (!mixer.jobId || isRestoringProjectState) return;
      if (metadataSaveTimer) clearTimeout(metadataSaveTimer);
      metadataSaveTimer = setTimeout(() => {
        metadataSaveTimer = null;
        persistMetadataWithLyrics();
      }, 500);
    }

    function markLyricAtCurrentTime(type = "lead", flashBtn = null) {
      if (!mixer.jobId) return;
      const t = Math.round(currentOffset() * 1000) / 1000;
      mixer.lyrics = mixer.lyrics || [];
      mixer.lyrics.push({ id: makeLyricId(), text: "", text_alt: "", time: t, type, color: "", style: "normal" });
      mixer.lyrics.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
      scheduleSaveLyrics();
      updateLyricsVocalsMarkLines();
      // Flash the clicked button
      if (flashBtn) {
        flashBtn.classList.add("flash-confirm");
        setTimeout(() => flashBtn.classList.remove("flash-confirm"), 300);
      }
      if (activeWorkspaceTab === "timing") renderLyricsEditView();
    }

    if (lyricsMarkLeadBtn)   lyricsMarkLeadBtn.addEventListener("click",   () => markLyricAtCurrentTime("lead",   lyricsMarkLeadBtn));
    if (lyricsMarkChorusBtn) lyricsMarkChorusBtn.addEventListener("click", () => markLyricAtCurrentTime("chorus", lyricsMarkChorusBtn));
    if (lyricsMarkMusicBtn)  lyricsMarkMusicBtn.addEventListener("click",  () => markLyricAtCurrentTime("music",  lyricsMarkMusicBtn));
    if (lyricsMarkLeadBtnB)   lyricsMarkLeadBtnB.addEventListener("click",   () => markLyricAtCurrentTime("lead",   lyricsMarkLeadBtnB));
    if (lyricsMarkChorusBtnB) lyricsMarkChorusBtnB.addEventListener("click", () => markLyricAtCurrentTime("chorus", lyricsMarkChorusBtnB));
    if (lyricsMarkMusicBtnB)  lyricsMarkMusicBtnB.addEventListener("click",  () => markLyricAtCurrentTime("music",  lyricsMarkMusicBtnB));

    function _applyLyricRowStyle(row, line) {
      const inp = row.querySelector(".lyric-text-input:not(.gujarati)");
      const altInp = row.querySelector(".lyric-text-input.gujarati");
      const s = line.style || "normal";
      const fw = s.includes("bold") ? "700" : "";
      const fi = s.includes("italic") ? "italic" : "";
      [inp, altInp].forEach(el => {
        if (!el) return;
        el.style.fontWeight = fw;
        el.style.fontStyle  = fi;
        el.style.color      = line.color || "";
      });
    }

    function renderLyricsEditView() {
      if (!lyricsList) return;
      lyricsList.innerHTML = "";
      updateLyricsVocalsMarkLines();
      const lyrics = mixer.lyrics || [];
      if (!lyrics.length) {
        lyricsList.innerHTML = '<p class="lyrics-empty">No lyrics yet — add a line or paste your lyrics above.</p>';
        return;
      }
      lyrics.forEach((line, idx) => {
        const isPlaceholder = !line.text.trim();
        const row = document.createElement("div");
        row.className = `lyric-row type-${line.type}${isPlaceholder ? " is-placeholder" : ""}`;
        row.draggable = true;
        row.dataset.idx = idx;

        // Drag handle
        const handle = document.createElement("span");
        handle.className = "lyric-drag-handle";
        handle.textContent = "⠿";
        handle.title = "Drag to reorder";

        // Play-from-here button
        const playLineBtn = document.createElement("button");
        playLineBtn.type = "button";
        playLineBtn.className = "lyric-play-btn";
        playLineBtn.title = line.time !== null ? `Play from ${formatTime(line.time)}` : "No timestamp set";
        playLineBtn.disabled = line.time === null;
        playLineBtn.innerHTML = `<svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M5 3.5a.5.5 0 0 1 .757-.429l8 4.5a.5.5 0 0 1 0 .858l-8 4.5A.5.5 0 0 1 5 12.5v-9z"/></svg>`;
        playLineBtn.addEventListener("click", async () => {
          if (line.time === null) return;
          await seekTo(line.time);
          if (!mixer.isPlaying) {
            playFrom(line.time).catch(() => {});
          }
        });

        // Type selector
        const typeSelect = document.createElement("select");
        typeSelect.className = `lyric-type-select type-${line.type}`;
        ["lead","chorus","music"].forEach(t => {
          const opt = document.createElement("option");
          opt.value = t;
          opt.textContent = typeLabel(t);
          if (t === line.type) opt.selected = true;
          typeSelect.appendChild(opt);
        });
        typeSelect.addEventListener("change", () => {
          line.type = typeSelect.value;
          row.className = `lyric-row type-${line.type}`;
          typeSelect.className = `lyric-type-select type-${line.type}`;
          scheduleSaveLyrics();
        });

        // Text inputs — English + Gujarati side by side
        const textsWrap = document.createElement("div");
        textsWrap.className = "lyric-texts";

        // English column
        const engCol = document.createElement("div");
        engCol.className = "lyric-lang-col";
        const engLabel = document.createElement("span");
        engLabel.className = "lyric-lang-label";
        engLabel.textContent = "English";
        const textInput = document.createElement("input");
        textInput.type = "text";
        textInput.className = "lyric-text-input";
        textInput.value = line.text || "";
        textInput.placeholder = isPlaceholder ? `English — ${formatTime(line.time ?? 0)}` : "English…";
        textInput.addEventListener("input", () => {
          line.text = textInput.value;
          row.classList.toggle("is-placeholder", !line.text.trim() && !(line.text_alt || "").trim());
          scheduleSaveLyrics();
        });
        engCol.appendChild(engLabel);
        engCol.appendChild(textInput);
        textsWrap.appendChild(engCol);

        // Gujarati column
        const gujCol = document.createElement("div");
        gujCol.className = "lyric-lang-col";
        const gujLabel = document.createElement("span");
        gujLabel.className = "lyric-lang-label gujarati";
        gujLabel.textContent = "Gujarati";
        const gujTranslitIndicator = document.createElement("span");
        gujTranslitIndicator.className = "lyric-translit-indicator";
        gujTranslitIndicator.title = "Auto-transliterating to English…";
        gujTranslitIndicator.style.cssText = "display:none;margin-left:5px;font-size:10px;color:#7c3aed;font-style:italic;";
        gujTranslitIndicator.textContent = "→ eng…";
        gujLabel.appendChild(gujTranslitIndicator);
        const textAltInput = document.createElement("input");
        textAltInput.type = "text";
        textAltInput.className = "lyric-text-input gujarati";
        textAltInput.value = line.text_alt || "";
        textAltInput.placeholder = isPlaceholder ? `Gujarati — ${formatTime(line.time ?? 0)}` : "Gujarati…";
        let _translitTimer = null;
        textAltInput.addEventListener("input", () => {
          line.text_alt = textAltInput.value;
          row.classList.toggle("is-placeholder", !line.text.trim() && !line.text_alt.trim());
          scheduleSaveLyrics();
          // Auto-transliterate to English after 600ms pause
          clearTimeout(_translitTimer);
          const gujText = textAltInput.value.trim();
          if (!gujText) { gujTranslitIndicator.style.display = "none"; return; }
          // Only trigger if input contains Gujarati Unicode characters (U+0A80–U+0AFF)
          if (!/[\u0A80-\u0AFF]/.test(gujText)) { gujTranslitIndicator.style.display = "none"; return; }
          gujTranslitIndicator.style.display = "";
          _translitTimer = setTimeout(async () => {
            try {
              const res = await fetch(`${API_BASE}/transliterate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: gujText }),
              });
              const data = await res.json();
              if (data.ok && data.result && !textInput.value.trim()) {
                textInput.value = data.result;
                line.text = data.result;
                scheduleSaveLyrics();
              }
            } catch (_) {}
            gujTranslitIndicator.style.display = "none";
          }, 600);
        });
        gujCol.appendChild(gujLabel);
        gujCol.appendChild(textAltInput);
        textsWrap.appendChild(gujCol);

        // Time stamp button
        // Time control: stamp button + fine-tune popover
        const timeWrap = document.createElement("div");
        timeWrap.style.cssText = "display:flex;align-items:center;gap:3px;flex-shrink:0;position:relative;";

        // Stamp button — click sets to current playback position
        const timeBtn = document.createElement("button");
        timeBtn.type = "button";
        timeBtn.className = "lyric-time-btn" + (line.time !== null ? " has-time" : "");
        timeBtn.title = line.time !== null ? "Stamp: set to current playback position" : "Stamp current playback time";
        timeBtn.textContent = line.time !== null ? formatTime(line.time) : "⏱ Set";
        timeBtn.addEventListener("click", () => {
          const t = Math.round(currentOffset() * 1000) / 1000;
          line.time = t;
          timeBtn.textContent = formatTime(t);
          timeBtn.classList.add("has-time");
          timeBtn.title = "Stamp: set to current playback position";
          fineTuneBtn.style.display = "";
          playLineBtn.disabled = false;
          playLineBtn.title = `Play from ${formatTime(t)}`;
          // Re-sort lyrics by time
          mixer.lyrics.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
          scheduleSaveLyrics();
          if (activeWorkspaceTab === "timing") renderLyricsEditView();
        });

        // Fine-tune button — opens popover with nudge + direct input
        const fineTuneBtn = document.createElement("button");
        fineTuneBtn.type = "button";
        fineTuneBtn.style.cssText = `display:${line.time !== null ? "" : "none"};padding:4px 6px;border-radius:6px;border:1px solid #d0d7e8;background:#f8fafc;color:#475569;cursor:pointer;font-size:11px;`;
        fineTuneBtn.title = "Fine-tune timestamp";
        fineTuneBtn.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 0 0-.354 0L3.5 11.06l-.578 2.02 2.02-.578 8.573-8.573a.25.25 0 0 0 0-.354l-1.086-1.086z"/></svg>`;
        fineTuneBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          document.querySelectorAll(".lyric-time-popover").forEach(p => p.remove());

          const pop = document.createElement("div");
          pop.className = "marker-edit-popover lyric-time-popover";
          pop.style.cssText = "top: calc(100% + 4px); right: 0; left: auto; min-width: 200px;";

          const timeLbl = document.createElement("label");
          timeLbl.textContent = "Time (seconds)";

          const timeRow = document.createElement("div");
          timeRow.className = "marker-time-row";

          const nudgeMinus = document.createElement("button");
          nudgeMinus.type = "button";
          nudgeMinus.className = "marker-time-nudge";
          nudgeMinus.textContent = "−";
          nudgeMinus.title = "Back 0.1s";

          const timeInput = document.createElement("input");
          timeInput.type = "number";
          timeInput.step = "0.01";
          timeInput.min = "0";
          timeInput.max = String(mixer.duration || 9999);
          timeInput.value = (line.time ?? 0).toFixed(3);
          timeInput.style.cssText = "flex:1;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid #d0d7e8;font-size:13px;font-variant-numeric:tabular-nums;background:#f8fafc;";

          const nudgePlus = document.createElement("button");
          nudgePlus.type = "button";
          nudgePlus.className = "marker-time-nudge";
          nudgePlus.textContent = "+";
          nudgePlus.title = "Forward 0.1s";

          // Live preview: seek to the input time while popover is open
          const previewTime = () => {
            const v = parseFloat(timeInput.value);
            if (Number.isFinite(v) && v >= 0) {
              if (!mixer.isPlaying) {
                mixer.pausedAt = v;
                setTransport(v);
              }
            }
          };

          nudgeMinus.addEventListener("click", () => {
            const v = Math.max(0, parseFloat(timeInput.value || 0) - 0.1);
            timeInput.value = v.toFixed(3);
            previewTime();
          });
          nudgePlus.addEventListener("click", () => {
            const v = Math.min(mixer.duration || 9999, parseFloat(timeInput.value || 0) + 0.1);
            timeInput.value = v.toFixed(3);
            previewTime();
          });

          let nudgeInterval = null;
          const startNudge = (delta) => {
            nudgeInterval = setInterval(() => {
              const v = Math.max(0, Math.min(mixer.duration || 9999, parseFloat(timeInput.value || 0) + delta));
              timeInput.value = v.toFixed(3);
              previewTime();
            }, 80);
          };
          const stopNudge = () => { clearInterval(nudgeInterval); nudgeInterval = null; };
          nudgeMinus.addEventListener("mousedown", () => startNudge(-0.1));
          nudgePlus.addEventListener("mousedown", () => startNudge(+0.1));
          ["mouseup","mouseleave"].forEach(ev => {
            nudgeMinus.addEventListener(ev, stopNudge);
            nudgePlus.addEventListener(ev, stopNudge);
          });

          timeInput.addEventListener("input", previewTime);

          timeRow.appendChild(nudgeMinus);
          timeRow.appendChild(timeInput);
          timeRow.appendChild(nudgePlus);

          const actions = document.createElement("div");
          actions.className = "marker-edit-actions";

          const clearBtn = document.createElement("button");
          clearBtn.type = "button";
          clearBtn.className = "marker-edit-cancel";
          clearBtn.textContent = "Clear";
          clearBtn.style.marginRight = "auto";
          clearBtn.addEventListener("click", () => {
            line.time = null;
            timeBtn.textContent = "⏱ Set";
            timeBtn.classList.remove("has-time");
            fineTuneBtn.style.display = "none";
            playLineBtn.disabled = true;
            playLineBtn.title = "No timestamp set";
            pop.remove();
            scheduleSaveLyrics();
          });

          const cancelBtn = document.createElement("button");
          cancelBtn.type = "button";
          cancelBtn.className = "marker-edit-cancel";
          cancelBtn.textContent = "Cancel";

          const saveBtn = document.createElement("button");
          saveBtn.type = "button";
          saveBtn.className = "marker-edit-save";
          saveBtn.textContent = "Save";

          const commit = () => {
            const newTime = Math.max(0, Math.min(mixer.duration || 9999, parseFloat(timeInput.value) || 0));
            line.time = Math.round(newTime * 1000) / 1000;
            timeBtn.textContent = formatTime(line.time);
            timeBtn.classList.add("has-time");
            pop.remove();
            mixer.lyrics.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
            scheduleSaveLyrics();
            if (activeWorkspaceTab === "timing") renderLyricsEditView();
          };

          saveBtn.addEventListener("click", commit);
          cancelBtn.addEventListener("click", () => pop.remove());

          actions.appendChild(clearBtn);
          actions.appendChild(cancelBtn);
          actions.appendChild(saveBtn);

          pop.appendChild(timeLbl);
          pop.appendChild(timeRow);
          pop.appendChild(actions);

          timeWrap.appendChild(pop);
          timeInput.focus();
          timeInput.select();

          pop.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Escape") pop.remove();
            if (ev.key === "Enter") { ev.preventDefault(); commit(); }
          });

          setTimeout(() => {
            document.addEventListener("click", function outside(ev) {
              if (!pop.contains(ev.target) && ev.target !== fineTuneBtn) {
                pop.remove();
                document.removeEventListener("click", outside);
              }
            });
          }, 0);
        });

        timeWrap.appendChild(timeBtn);
        timeWrap.appendChild(fineTuneBtn);

        // Style controls: color swatch + Bold + Italic
        const styleWrap = document.createElement("div");
        styleWrap.className = "lyric-style-wrap";

        const isBold   = (line.style || "").includes("bold");
        const isItalic = (line.style || "").includes("italic");

        const boldBtn = document.createElement("button");
        boldBtn.type = "button";
        boldBtn.className = "lyric-style-btn" + (isBold ? " active" : "");
        boldBtn.title = "Bold";
        boldBtn.innerHTML = "<b>B</b>";
        boldBtn.addEventListener("click", () => {
          const b = !boldBtn.classList.contains("active");
          const it = italicBtn.classList.contains("active");
          line.style = b && it ? "bold-italic" : b ? "bold" : it ? "italic" : "normal";
          boldBtn.classList.toggle("active", b);
          _applyLyricRowStyle(row, line);
          scheduleSaveLyrics();
        });

        const italicBtn = document.createElement("button");
        italicBtn.type = "button";
        italicBtn.className = "lyric-style-btn" + (isItalic ? " active" : "");
        italicBtn.title = "Italic";
        italicBtn.innerHTML = "<i>I</i>";
        italicBtn.addEventListener("click", () => {
          const it = !italicBtn.classList.contains("active");
          const b  = boldBtn.classList.contains("active");
          line.style = b && it ? "bold-italic" : b ? "bold" : it ? "italic" : "normal";
          italicBtn.classList.toggle("active", it);
          _applyLyricRowStyle(row, line);
          scheduleSaveLyrics();
        });

        // Color swatch — uses native <input type="color">
        const colorSwatch = document.createElement("label");
        colorSwatch.className = "lyric-color-swatch";
        colorSwatch.title = "Line color (overrides type color in karaoke)";
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.value = line.color || "#ffffff";
        colorInput.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none;";
        const swatchDot = document.createElement("span");
        swatchDot.className = "lyric-color-dot";
        swatchDot.style.background = line.color || "";
        if (!line.color) swatchDot.classList.add("no-color");
        colorSwatch.appendChild(colorInput);
        colorSwatch.appendChild(swatchDot);
        colorInput.addEventListener("input", () => {
          line.color = colorInput.value;
          swatchDot.style.background = line.color;
          swatchDot.classList.remove("no-color");
          _applyLyricRowStyle(row, line);
          scheduleSaveLyrics();
        });
        // Right-click or long-tap to clear color
        colorSwatch.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          line.color = "";
          colorInput.value = "#ffffff";
          swatchDot.style.background = "";
          swatchDot.classList.add("no-color");
          _applyLyricRowStyle(row, line);
          scheduleSaveLyrics();
        });

        styleWrap.appendChild(boldBtn);
        styleWrap.appendChild(italicBtn);
        styleWrap.appendChild(colorSwatch);

        // Delete button
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "lyric-delete-btn";
        delBtn.title = "Delete line";
        delBtn.textContent = "×";
        delBtn.addEventListener("click", () => {
          mixer.lyrics.splice(idx, 1);
          renderLyricsEditView();
          scheduleSaveLyrics();
        });

        row.appendChild(handle);
        row.appendChild(playLineBtn);
        row.appendChild(typeSelect);
        row.appendChild(textsWrap);
        row.appendChild(timeWrap);
        row.appendChild(styleWrap);
        row.appendChild(delBtn);

        _applyLyricRowStyle(row, line);
        lyricsList.appendChild(row);

        // Drag-to-reorder
        row.addEventListener("dragstart", (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", idx);
          row.style.opacity = "0.5";
        });
        row.addEventListener("dragend", () => { row.style.opacity = ""; });
        row.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
          const toIdx = parseInt(row.dataset.idx, 10);
          if (fromIdx === toIdx) return;
          const moved = mixer.lyrics.splice(fromIdx, 1)[0];
          mixer.lyrics.splice(toIdx, 0, moved);
          renderLyricsEditView();
          scheduleSaveLyrics();
        });
      });
    }

    // Refs updated by renderLyricsKaraokeView, read every RAF tick
    let _karaokeLineStart = null;
    let _karaokeLineEnd = null;
    let _karaokeBeatDuration = null; // seconds per beat dot
    let _karaokeBeatCount = 8;
    let _karaokeProgressBar = null;
    let _karaokeBeatDots = null;

    function renderLyricsKaraokeView(currentTime) {
      if (!lyricsKaraokeView) return;
      const lyrics = (mixer.lyrics || []).filter(l => l.text || l.text_alt);
      lyricsKaraokeView.innerHTML = "";
      applyKaraokeFontSize();
      _karaokeProgressBar = null;
      _karaokeBeatDots = null;
      _karaokeLineStart = null;
      _karaokeLineEnd = null;
      _karaokeBeatDuration = null;

      if (!lyrics.length) {
        lyricsKaraokeView.innerHTML = '<p style="color:#475569;text-align:center;padding:24px">No lyrics added yet.</p>';
        return;
      }

      // Find active line (last synced line whose time <= currentTime)
      let activeIdx = -1;
      for (let i = 0; i < lyrics.length; i++) {
        if (lyrics[i].time !== null && lyrics[i].time <= currentTime) activeIdx = i;
      }

      // Find next synced line's start time for duration calculation
      let nextLineTime = null;
      if (activeIdx >= 0) {
        for (let j = activeIdx + 1; j < lyrics.length; j++) {
          if (lyrics[j].time !== null) { nextLineTime = lyrics[j].time; break; }
        }
        _karaokeLineStart = lyrics[activeIdx].time;
        _karaokeLineEnd = nextLineTime ?? (mixer.duration || null);

        // Beat duration: use BPM if available, else divide line into 8 segments
        const lineDuration = (_karaokeLineEnd !== null && _karaokeLineStart !== null)
          ? Math.max(0.1, _karaokeLineEnd - _karaokeLineStart) : null;
        if (mixer.bpm && mixer.bpm > 0) {
          _karaokeBeatDuration = 60 / mixer.bpm;
          _karaokeBeatCount = lineDuration ? Math.max(2, Math.min(16, Math.round(lineDuration / _karaokeBeatDuration))) : 8;
        } else if (lineDuration) {
          _karaokeBeatCount = 8;
          _karaokeBeatDuration = lineDuration / _karaokeBeatCount;
        }
      }

      lyrics.forEach((line, i) => {
        const el = document.createElement("div");
        el.className = `karaoke-line type-${line.type}`;
        el.dataset.idx = i;
        if (line.time === null) {
          el.classList.add("unsynced");
        } else if (i === activeIdx) {
          el.classList.add("active-line");
        } else if (i > activeIdx) {
          el.classList.add("upcoming");
        }

        // Compact type dot (replaces tall badge)
        const dot = document.createElement("span");
        dot.className = `karaoke-type-dot type-${line.type}`;
        dot.title = typeLabel(line.type);
        el.appendChild(dot);

        // Text wrapper
        const textWrap = document.createElement("div");
        textWrap.className = "karaoke-line-text";

        // Apply per-line color/style overrides to the container
        if (line.color) el.style.color = line.color;
        if (line.style && line.style !== "normal") {
          el.style.fontWeight = line.style.includes("bold")   ? "800" : "";
          el.style.fontStyle  = line.style.includes("italic") ? "italic" : "";
        }

        // Primary (English) text
        if (_karaokeLanguage === "both" || _karaokeLanguage === "english") {
          const primaryEl = document.createElement("span");
          primaryEl.textContent = line.text || (_karaokeLanguage === "english" ? "…" : "");
          if (primaryEl.textContent) textWrap.appendChild(primaryEl);
        }

        // Alt (Gujarati) text
        if ((_karaokeLanguage === "both" || _karaokeLanguage === "gujarati") && (line.text_alt || "").trim()) {
          const altEl = document.createElement("span");
          altEl.className = "karaoke-line-alt";
          altEl.textContent = line.text_alt;
          textWrap.appendChild(altEl);
        }

        // Rhythm indicator — only on active line with known duration
        if (i === activeIdx && _karaokeLineStart !== null && _karaokeLineEnd !== null) {
          const rhythmWrap = document.createElement("div");
          rhythmWrap.className = "karaoke-rhythm";

          const barWrap = document.createElement("div");
          barWrap.className = "karaoke-progress-bar-wrap";
          const bar = document.createElement("div");
          bar.className = "karaoke-progress-bar";
          barWrap.appendChild(bar);
          rhythmWrap.appendChild(barWrap);
          _karaokeProgressBar = bar;

          const beatsRow = document.createElement("div");
          beatsRow.className = "karaoke-beats";
          const beatDots = [];
          for (let d = 0; d < _karaokeBeatCount; d++) {
            const bd = document.createElement("div");
            bd.className = "karaoke-beat-dot";
            beatsRow.appendChild(bd);
            beatDots.push(bd);
          }
          rhythmWrap.appendChild(beatsRow);
          _karaokeBeatDots = beatDots;
          textWrap.appendChild(rhythmWrap);
        }

        el.appendChild(textWrap);

        if (line.time !== null) {
          el.title = `Jump to ${formatTime(line.time)}`;
          el.addEventListener("click", () => playFrom(line.time).then(updatePlayPauseIcon));
        }
        lyricsKaraokeView.appendChild(el);
      });

      // Auto-scroll active line into view
      const activeEl = lyricsKaraokeView.querySelector(".active-line");
      if (activeEl) activeEl.scrollIntoView({ block: "center", behavior: "smooth" });

      // Seed the rhythm indicator immediately with current position
      updateKaraokeRhythm(currentTime);
    }

    function updateKaraokeRhythm(offset) {
      if (!_karaokeProgressBar || _karaokeLineStart === null || _karaokeLineEnd === null) return;
      const lineDuration = _karaokeLineEnd - _karaokeLineStart;
      if (lineDuration <= 0) return;
      const elapsed = Math.max(0, offset - _karaokeLineStart);
      const progress = Math.min(1, elapsed / lineDuration);
      _karaokeProgressBar.style.width = `${progress * 100}%`;

      // Beat dots
      if (_karaokeBeatDots && _karaokeBeatDuration > 0) {
        const currentBeat = Math.floor(elapsed / _karaokeBeatDuration);
        _karaokeBeatDots.forEach((dot, i) => {
          dot.classList.toggle("lit", i <= currentBeat);
        });
      }
    }

    // Toggle karaoke / edit view
    if (lyricsViewToggle) {
      lyricsViewToggle.addEventListener("click", () => {
        lyricsKaraokeMode = !lyricsKaraokeMode;
        lyricsViewToggle.textContent = lyricsKaraokeMode ? "Edit Mode" : "Karaoke View";
        lyricsViewToggle.classList.toggle("karaoke-active", lyricsKaraokeMode);
        if (lyricsEditView) lyricsEditView.style.display = lyricsKaraokeMode ? "none" : "";
        if (lyricsKaraokeView) lyricsKaraokeView.classList.toggle("active", lyricsKaraokeMode);
        if (lyricsKaraokeMode) renderLyricsKaraokeView(currentOffset());
      });
    }

    // Add line button
    if (lyricsAddLineBtn) {
      lyricsAddLineBtn.addEventListener("click", () => {
        mixer.lyrics = mixer.lyrics || [];
        mixer.lyrics.push({ id: makeLyricId(), text: "", text_alt: "", time: null, type: "lead", color: "", style: "normal" });
        renderLyricsEditView();
        scheduleSaveLyrics();
        // Focus the new text input
        const rows = lyricsList.querySelectorAll(".lyric-row");
        const last = rows[rows.length - 1];
        if (last) last.querySelector(".lyric-text-input")?.focus();
      });
    }

    // Paste lyrics
    if (lyricsPasteBtn) {
      lyricsPasteBtn.addEventListener("click", () => {
        lyricsPasteArea.classList.add("open");
        lyricsPasteInput.value = "";
        lyricsPasteInput.focus();
      });
    }
    if (lyricsPasteDismissBtn) {
      lyricsPasteDismissBtn.addEventListener("click", () => lyricsPasteArea.classList.remove("open"));
    }
    if (lyricsPasteImportBtn) {
      lyricsPasteImportBtn.addEventListener("click", () => {
        const raw = lyricsPasteInput.value.trim();
        if (!raw) return;
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        mixer.lyrics = mixer.lyrics || [];
        lines.forEach(text => {
          mixer.lyrics.push({ id: makeLyricId(), text, text_alt: "", time: null, type: "lead", color: "", style: "normal" });
        });
        lyricsPasteArea.classList.remove("open");
        renderLyricsEditView();
        scheduleSaveLyrics();
      });
    }

    // ── Karaoke toolbar controls ─────────────────────────────────────────
    function applyKaraokeFontSize() {
      document.documentElement.style.setProperty("--karaoke-font-size", `${_karaokeFontSize}px`);
      const disp = document.getElementById("karaoke-font-size-display");
      if (disp) disp.textContent = _karaokeFontSize;
      const sl = document.getElementById("karaoke-font-slider");
      if (sl) sl.value = _karaokeFontSize;
    }
    const karaokeFontSlider = document.getElementById("karaoke-font-slider");
    if (karaokeFontSlider) karaokeFontSlider.addEventListener("input", () => {
      _karaokeFontSize = parseInt(karaokeFontSlider.value, 10);
      applyKaraokeFontSize();
    });

    (function () {
      const slxFontSlider = document.getElementById("slx-font-slider");
      if (!slxFontSlider) return;
      let _slxFontStyle = document.getElementById("slx-font-size-style");
      if (!_slxFontStyle) {
        _slxFontStyle = document.createElement("style");
        _slxFontStyle.id = "slx-font-size-style";
        document.head.appendChild(_slxFontStyle);
      }
      function _applySlxFontSize() {
        const sz = slxFontSlider.value + "px";
        _slxFontStyle.textContent =
          `#song-lyrics-read-text{font-size:${sz}!important}` +
          `#song-lyrics-read-text p,#song-lyrics-read-text li,` +
          `#song-lyrics-read-text span,#song-lyrics-read-text font,` +
          `#song-lyrics-read-text div{font-size:${sz}!important}`;
      }
      slxFontSlider.addEventListener("input", _applySlxFontSize);
      slxFontSlider.addEventListener("change", _applySlxFontSize);
    })();

    document.querySelectorAll(".karaoke-lang-btn[data-lang]").forEach(btn => {
      btn.addEventListener("click", () => {
        _karaokeLanguage = btn.dataset.lang;
        document.querySelectorAll(".karaoke-lang-btn[data-lang]").forEach(b => b.classList.toggle("active", b === btn));
        if (lyricsKaraokeMode) renderLyricsKaraokeView(currentOffset());
      });
    });

    const karaokeVocalVolSlider = document.getElementById("karaoke-vocal-vol-slider");
    const karaokeVocalVolDisplay = document.getElementById("karaoke-vocal-vol-display");
    if (karaokeVocalVolSlider) {
      karaokeVocalVolSlider.addEventListener("input", () => {
        const pct = Number(karaokeVocalVolSlider.value);
        if (karaokeVocalVolDisplay) karaokeVocalVolDisplay.textContent = pct + "%";
        const vocalTrack = _getVocalTrack();
        if (vocalTrack) {
          vocalTrack.volume = pct / 100;
          applyPlaybackSettings(vocalTrack);
        }
      });
    }

    let _karaokeLight = false;
    const karaokeToolbarEl = document.getElementById("karaoke-toolbar");
    const karaokeThemeToggle = document.getElementById("karaoke-theme-toggle");
    function _applyKaraokeLight() {
      if (karaokeToolbarEl) karaokeToolbarEl.classList.toggle("karaoke-light", _karaokeLight);
      if (lyricsKaraokeView) lyricsKaraokeView.classList.toggle("karaoke-light", _karaokeLight);
      if (karaokeThemeToggle) karaokeThemeToggle.classList.toggle("active", _karaokeLight);
    }
    if (karaokeThemeToggle) karaokeThemeToggle.addEventListener("click", () => {
      _karaokeLight = !_karaokeLight;
      _applyKaraokeLight();
    });

    // ── Fullscreen karaoke ───────────────────────────────────────────────
    let _karaokeFullscreenWrap = null;
    const karaokeFullscreenBtn = document.getElementById("karaoke-fullscreen-btn");
    const karaokeFsExpandIcon   = document.getElementById("karaoke-fs-expand-icon");
    const karaokeFsCompressIcon = document.getElementById("karaoke-fs-compress-icon");

    function _isKaraokeFullscreen() { return !!_karaokeFullscreenWrap; }

    function enterKaraokeFullscreen() {
      if (_karaokeFullscreenWrap) return;
      const wrap = document.createElement("div");
      wrap.className = "karaoke-fullscreen-wrap";
      // Move toolbar and view into wrap
      if (karaokeToolbarEl) wrap.appendChild(karaokeToolbarEl);
      if (lyricsKaraokeView) wrap.appendChild(lyricsKaraokeView);
      document.body.appendChild(wrap);
      _karaokeFullscreenWrap = wrap;
      if (karaokeFsExpandIcon)   karaokeFsExpandIcon.style.display = "none";
      if (karaokeFsCompressIcon) karaokeFsCompressIcon.style.display = "";
      applyKaraokeFontSize();
      // Keyboard: Escape or F to exit
      document.addEventListener("keydown", _karaokeFsKeyHandler);
    }

    function exitKaraokeFullscreen() {
      if (!_karaokeFullscreenWrap) return;
      // Move toolbar and view back to lyrics-panel
      const panel = document.getElementById("lyrics-panel");
      if (karaokeToolbarEl && panel) panel.appendChild(karaokeToolbarEl);
      if (lyricsKaraokeView && panel) panel.appendChild(lyricsKaraokeView);
      _karaokeFullscreenWrap.remove();
      _karaokeFullscreenWrap = null;
      if (karaokeFsExpandIcon)   karaokeFsExpandIcon.style.display = "";
      if (karaokeFsCompressIcon) karaokeFsCompressIcon.style.display = "none";
      applyKaraokeFontSize();
      document.removeEventListener("keydown", _karaokeFsKeyHandler);
    }

    function _karaokeFsKeyHandler(e) {
      if (e.key === "Escape" || e.key === "f" || e.key === "F") exitKaraokeFullscreen();
    }

    if (karaokeFullscreenBtn) karaokeFullscreenBtn.addEventListener("click", () => {
      _isKaraokeFullscreen() ? exitKaraokeFullscreen() : enterKaraokeFullscreen();
    });

    // ── Find & Replace ───────────────────────────────────────────────────
    const lyricsFindReplaceBar    = document.getElementById("lyrics-find-replace-bar");
    const lyricsFindInput         = document.getElementById("lyrics-find-input");
    const lyricsReplaceInput      = document.getElementById("lyrics-replace-input");
    const lyricsReplaceAllBtn     = document.getElementById("lyrics-replace-all-btn");
    const lyricsMatchCount        = document.getElementById("lyrics-match-count");
    const lyricsFindReplaceToggle = document.getElementById("lyrics-find-replace-toggle");
    const lyricsFindReplaceClose  = document.getElementById("lyrics-find-replace-close");

    function countMatches(needle) {
      if (!needle) return 0;
      const lower = needle.toLowerCase();
      return (mixer.lyrics || []).reduce((n, l) => {
        if ((l.text || "").toLowerCase().includes(lower)) n++;
        if ((l.text_alt || "").toLowerCase().includes(lower)) n++;
        return n;
      }, 0);
    }

    function updateMatchCount() {
      if (!lyricsMatchCount) return;
      const needle = lyricsFindInput ? lyricsFindInput.value : "";
      if (!needle) { lyricsMatchCount.textContent = ""; lyricsMatchCount.className = "lyrics-match-count"; return; }
      const n = countMatches(needle);
      if (n === 0) { lyricsMatchCount.textContent = "No matches"; lyricsMatchCount.className = "lyrics-match-count no-matches"; }
      else { lyricsMatchCount.textContent = `${n} match${n === 1 ? "" : "es"}`; lyricsMatchCount.className = "lyrics-match-count has-matches"; }
    }

    if (lyricsFindInput)    lyricsFindInput.addEventListener("input", updateMatchCount);
    if (lyricsReplaceInput) lyricsReplaceInput.addEventListener("input", updateMatchCount);

    if (lyricsReplaceAllBtn) {
      lyricsReplaceAllBtn.addEventListener("click", () => {
        const needle  = lyricsFindInput ? lyricsFindInput.value : "";
        const replace = lyricsReplaceInput ? lyricsReplaceInput.value : "";
        if (!needle || !mixer.lyrics) return;
        const lower = needle.toLowerCase();
        let count = 0;
        // Case-insensitive replace preserving original case boundaries
        const replaceIn = (str) => {
          if (!str.toLowerCase().includes(lower)) return str;
          // Simple global replace, case-insensitive
          const result = str.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), replace);
          count++;
          return result;
        };
        mixer.lyrics.forEach(l => {
          l.text     = replaceIn(l.text || "");
          l.text_alt = replaceIn(l.text_alt || "");
        });
        scheduleSaveLyrics();
        if (activeWorkspaceTab === "timing") renderLyricsEditView();
        // Feedback
        lyricsMatchCount.textContent = count ? `Replaced ${count} occurrence${count === 1 ? "" : "s"}` : "No matches found";
        lyricsMatchCount.className = count ? "lyrics-match-count has-matches" : "lyrics-match-count no-matches";
        if (lyricsFindInput) lyricsFindInput.value = "";
        if (lyricsReplaceInput) lyricsReplaceInput.value = "";
      });
    }

    if (lyricsFindReplaceToggle) {
      lyricsFindReplaceToggle.addEventListener("click", () => {
        if (!lyricsFindReplaceBar) return;
        const visible = lyricsFindReplaceBar.style.display !== "none";
        lyricsFindReplaceBar.style.display = visible ? "none" : "";
        if (!visible && lyricsFindInput) { lyricsFindInput.focus(); lyricsFindInput.select(); }
      });
    }

    if (lyricsFindReplaceClose) {
      lyricsFindReplaceClose.addEventListener("click", () => {
        if (lyricsFindReplaceBar) lyricsFindReplaceBar.style.display = "none";
        if (lyricsFindInput) lyricsFindInput.value = "";
        if (lyricsReplaceInput) lyricsReplaceInput.value = "";
        if (lyricsMatchCount) { lyricsMatchCount.textContent = ""; lyricsMatchCount.className = "lyrics-match-count"; }
      });
    }

    // Keyboard shortcut: Ctrl/Cmd+H opens Find & Replace when on lyrics tab
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "h" && activeWorkspaceTab === "timing") {
        e.preventDefault();
        if (lyricsFindReplaceBar) {
          lyricsFindReplaceBar.style.display = "";
          if (lyricsFindInput) { lyricsFindInput.focus(); lyricsFindInput.select(); }
        }
      }
    });

    function _openMarkerEditPopover(marker, chip, editBtn, track, onSave) {
      const pop = document.createElement("div");
      pop.className = "marker-edit-popover";

      const labelWrap = document.createElement("div");
      const labelLbl = document.createElement("label");
      labelLbl.textContent = "Label";
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = marker.label || "";
      labelInput.placeholder = "Marker label";
      labelInput.maxLength = 120;
      labelWrap.appendChild(labelLbl);
      labelWrap.appendChild(labelInput);

      const timeWrap = document.createElement("div");
      const timeLbl = document.createElement("label");
      timeLbl.textContent = "Time (seconds)";
      const timeRow = document.createElement("div");
      timeRow.className = "marker-time-row";
      const nudgeMinus = document.createElement("button");
      nudgeMinus.type = "button"; nudgeMinus.className = "marker-time-nudge";
      nudgeMinus.textContent = "−"; nudgeMinus.title = "Back 0.1s";
      const timeInput = document.createElement("input");
      timeInput.type = "number"; timeInput.step = "0.01"; timeInput.min = "0";
      timeInput.max = String(mixer.duration || 9999);
      timeInput.value = marker.time.toFixed(3);
      const nudgePlus = document.createElement("button");
      nudgePlus.type = "button"; nudgePlus.className = "marker-time-nudge";
      nudgePlus.textContent = "+"; nudgePlus.title = "Forward 0.1s";
      nudgeMinus.addEventListener("click", () => { timeInput.value = Math.max(0, parseFloat(timeInput.value||0) - 0.1).toFixed(3); });
      nudgePlus.addEventListener("click", () => { timeInput.value = Math.min(mixer.duration||9999, parseFloat(timeInput.value||0) + 0.1).toFixed(3); });
      let nudgeInterval = null;
      const startNudge = (d) => { nudgeInterval = setInterval(() => { timeInput.value = Math.max(0, Math.min(mixer.duration||9999, parseFloat(timeInput.value||0) + d)).toFixed(3); }, 80); };
      const stopNudge = () => { clearInterval(nudgeInterval); nudgeInterval = null; };
      nudgeMinus.addEventListener("mousedown", () => startNudge(-0.1));
      nudgePlus.addEventListener("mousedown", () => startNudge(+0.1));
      ["mouseup","mouseleave"].forEach(ev => { nudgeMinus.addEventListener(ev, stopNudge); nudgePlus.addEventListener(ev, stopNudge); });
      timeRow.appendChild(nudgeMinus); timeRow.appendChild(timeInput); timeRow.appendChild(nudgePlus);
      timeWrap.appendChild(timeLbl); timeWrap.appendChild(timeRow);

      const actions = document.createElement("div");
      actions.className = "marker-edit-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button"; cancelBtn.className = "marker-edit-cancel"; cancelBtn.textContent = "Cancel";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button"; saveBtn.className = "marker-edit-save"; saveBtn.textContent = "Save";
      actions.appendChild(cancelBtn); actions.appendChild(saveBtn);
      pop.appendChild(labelWrap); pop.appendChild(timeWrap); pop.appendChild(actions);

      pop.style.position = "fixed";
      pop.style.zIndex = "9999";
      document.body.appendChild(pop);
      const chipRect = chip.getBoundingClientRect();
      const spaceBelow = window.innerHeight - chipRect.bottom;
      if (spaceBelow < 200) {
        pop.style.bottom = `${window.innerHeight - chipRect.top + 4}px`;
        pop.style.top = "auto";
      } else {
        pop.style.top = `${chipRect.bottom + 4}px`;
        pop.style.bottom = "auto";
      }
      pop.style.left = `${Math.max(8, Math.min(chipRect.left, window.innerWidth - 330))}px`;
      labelInput.focus(); labelInput.select();

      const commit = () => {
        const newLabel = labelInput.value.trim() || marker.label;
        const newTime = Math.max(0, Math.min(mixer.duration || 9999, parseFloat(timeInput.value) || marker.time));
        marker.label = newLabel;
        marker.time = Math.round(newTime * 1000) / 1000;
        pop.remove();
        if (onSave) onSave();
      };
      saveBtn.addEventListener("click", commit);
      cancelBtn.addEventListener("click", () => pop.remove());
      pop.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Escape") pop.remove();
        if (ev.key === "Enter" && ev.target !== timeInput) { ev.preventDefault(); commit(); }
      });
      setTimeout(() => {
        document.addEventListener("click", function outsideClick(ev) {
          if (!pop.contains(ev.target) && ev.target !== editBtn) {
            pop.remove();
            document.removeEventListener("click", outsideClick);
          }
        });
      }, 0);
    }

    function renderLyricsVocalsMarkerChips() {
      const container = document.getElementById("lyrics-vocals-marker-pills");
      if (!container) return;
      container.innerHTML = "";
      const vocalsTrack = (mixer.tracks || []).find(t => t.key === "vocals");
      if (!vocalsTrack) return;
      for (const marker of vocalsTrack.markers || []) {
        const chip = document.createElement("span");
        chip.className = "track-marker-pill" + (!marker.label || marker.label.startsWith("Marker ") ? " marker-placeholder" : "");
        chip.title = `Play from ${formatTime(marker.time)}`;
        chip.setAttribute("role", "button");
        chip.setAttribute("tabindex", "0");
        const labelEl = document.createElement("span");
        labelEl.className = "marker-pill-label";
        labelEl.textContent = marker.label || `@ ${formatTime(marker.time)}`;
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "marker-edit-btn";
        editBtn.title = "Edit marker";
        editBtn.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 0 0-.354 0L3.5 11.06l-.578 2.02 2.02-.578 8.573-8.573a.25.25 0 0 0 0-.354l-1.086-1.086z"/></svg>`;
        editBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          document.querySelectorAll(".marker-edit-popover").forEach(p => p.remove());
          // Reuse the same popover builder by dispatching to a shared function
          _openMarkerEditPopover(marker, chip, editBtn, vocalsTrack, () => {
            labelEl.textContent = marker.label || `@ ${formatTime(marker.time)}`;
            chip.classList.toggle("marker-placeholder", !marker.label || marker.label.startsWith("Marker "));
            chip.title = `Play from ${formatTime(marker.time)}`;
            redrawAllWaveforms();
            renderMarkerChips();
            scheduleSaveProjectMetadata();
          });
        });
        chip.addEventListener("click", (e) => {
          if (e.target.closest(".marker-edit-btn") || e.target.closest("button")) return;
          playFromWithDelay(Math.max(0, Math.min(marker.time, mixer.duration || 0)), chip)
            .catch((err) => showError(err.message || "Failed to play marker."));
        });
        chip.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          playFromWithDelay(Math.max(0, Math.min(marker.time, mixer.duration || 0)), chip)
            .catch((err) => showError(err.message || "Failed to play marker."));
        });
        chip.appendChild(labelEl);
        chip.appendChild(editBtn);
        container.appendChild(chip);
      }
    }

    function renderMarkerChips() {
      renderLyricsVocalsMarkerChips();
      for (const track of mixer.tracks) {
        if (track.markerPills) track.markerPills.innerHTML = "";
        for (const marker of track.markers || []) {
          const chip = document.createElement("span");
          chip.className = "track-marker-pill" + (!marker.label || marker.label.startsWith("Marker ") ? " marker-placeholder" : "");
          chip.title = `Play from ${formatTime(marker.time)}`;
          chip.setAttribute("role", "button");
          chip.setAttribute("tabindex", "0");

          const labelEl = document.createElement("span");
          labelEl.className = "marker-pill-label";
          labelEl.textContent = marker.label || `@ ${formatTime(marker.time)}`;

          // Edit pencil button — opens popover with label + time controls
          const editBtn = document.createElement("button");
          editBtn.type = "button";
          editBtn.className = "marker-edit-btn";
          editBtn.title = "Edit marker";
          editBtn.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 0 0-.354 0L3.5 11.06l-.578 2.02 2.02-.578 8.573-8.573a.25.25 0 0 0 0-.354l-1.086-1.086z"/></svg>`;
          editBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            document.querySelectorAll(".marker-edit-popover").forEach(p => p.remove());
            _openMarkerEditPopover(marker, chip, editBtn, track, () => {
              labelEl.textContent = marker.label || `@ ${formatTime(marker.time)}`;
              chip.classList.toggle("marker-placeholder", !marker.label || marker.label.startsWith("Marker "));
              chip.title = `Play from ${formatTime(marker.time)}`;
              redrawAllWaveforms();
              renderMarkerChips();
              scheduleSaveProjectMetadata();
            });
          });

          const playFromMarker = async () => {
            if (typeof closeAllMiniPopovers === "function") closeAllMiniPopovers();
            if (typeof closeAllBadgePopovers === "function") closeAllBadgePopovers();
            setActiveTrack(track.key);
            if (track.markerTimeInput) track.markerTimeInput.value = formatSeconds(marker.time);
            await playFromWithDelay(Math.max(0, Math.min(marker.time, mixer.duration || 0)), chip);
          };
          chip.addEventListener("click", (e) => {
            if (e.target.closest(".marker-edit-btn") || e.target.closest(".marker-edit-popover") || e.target.closest("button")) return;
            playFromMarker().catch((err) => showError(err.message || "Failed to play marker."));
          });
          chip.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            playFromMarker().catch((err) => showError(err.message || "Failed to play marker."));
          });

          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "×";
          remove.title = "Remove marker";
          remove.addEventListener("click", (event) => {
            event.stopPropagation();
            track.markers = (track.markers || []).filter((m) => m.id !== marker.id);
            redrawAllWaveforms();
            renderMarkerChips();
            scheduleSaveProjectMetadata();
          });

          chip.appendChild(labelEl);
          chip.appendChild(editBtn);
          chip.appendChild(remove);
          if (track.markerPills) track.markerPills.appendChild(chip);
        }
        if (typeof track.updateMarkerBarButtons === "function") track.updateMarkerBarButtons();
      }
    }

