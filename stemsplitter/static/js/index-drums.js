    // ── Drum Pattern Intelligence ─────────────────────────────────────────────
    // Depends on: mixer, seekTo, currentOffset, effectiveTempoRate (index-playback.js)
    // Injected below the drums waveform row by renderTracks() in index-mixer.js

    let _drumState = null;   // one object per loaded project; replaced on each initDrumPatterns call
    let _drumStylesInjected = false;

    function initDrumPatterns(track, jobId, containerEl) {
      // Cancel any pending switch from a previous project
      if (_drumState) {
        _drumState.active = false;
        if (_drumState.switchTimer) clearTimeout(_drumState.switchTimer);
      }

      _drumState = {
        jobId,
        containerEl,
        track,
        data: null,
        patterns: [],
        segments: [],
        measureTimestamps: [],
        threshold: 0.4,
        pendingSwitch: null,
        switchTimer: null,
        countdownInterval: null,
        active: true,
        // DOM refs (set after first render)
        timelineEl: null,
        cardsEl: null,
        statusBarEl: null,
        countLabelEl: null,
      };

      _injectDrumStyles();
      _renderDrumProgress(containerEl, 0, 'Loading audio…');
      _fetchDrumAnalysis(jobId, containerEl, _drumState);
    }

    // ── Data fetching ─────────────────────────────────────────────────────────

    async function _fetchDrumAnalysis(jobId, containerEl, state) {
      try {
        const resp = await fetch(`${API_BASE}/jobs/${jobId}/drums/analysis`);
        if (!resp.ok) { containerEl.innerHTML = ''; return; }
        const data = await resp.json();

        if (state !== _drumState) return;  // stale — project changed

        if (data.status === 'running' || data.status === 'pending') {
          _renderDrumProgress(containerEl, data.progress || 0, data.step || 'Analyzing…');
          setTimeout(() => {
            if (state === _drumState) _fetchDrumAnalysis(jobId, containerEl, state);
          }, 3000);
          return;
        }
        if (data.status === 'too_short') {
          containerEl.innerHTML = '<div class="dp-too-short">Drum track too short to detect patterns</div>';
          return;
        }
        if (data.status !== 'complete') {
          containerEl.innerHTML = '';
          return;
        }

        state.data = data;
        state.measureTimestamps = data.measure_timestamps || [];

        await _fetchDrumCluster(jobId, state.threshold, containerEl, state);

        // Start the position-tracking ticker
        requestAnimationFrame(() => _drumTicker(state));

      } catch (_) {
        if (state === _drumState) containerEl.innerHTML = '';
      }
    }

    async function _fetchDrumCluster(jobId, threshold, containerEl, state) {
      try {
        const resp = await fetch(`${API_BASE}/jobs/${jobId}/drums/cluster`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold }),
        });
        if (!resp.ok || state !== _drumState) return;
        const result = await resp.json();
        if (!result.ok) return;

        state.patterns = result.patterns || [];
        state.segments = result.segments || [];
        state.threshold = threshold;

        _renderDrumPanel(containerEl, state);
      } catch (_) { /* silently ignore network errors */ }
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    function _renderDrumProgress(containerEl, pct, step) {
      let wrap = containerEl.querySelector('.dp-progress-wrap');
      if (!wrap) {
        containerEl.innerHTML = `
          <div class="dp-progress-wrap">
            <div class="dp-progress-top">
              <span class="dp-progress-title">Analyzing drum patterns</span>
              <span class="dp-progress-pct">0%</span>
            </div>
            <div class="dp-progress-track"><div class="dp-progress-fill" style="width:0%"></div></div>
            <div class="dp-progress-step"></div>
          </div>`;
        wrap = containerEl.querySelector('.dp-progress-wrap');
      }
      const fillEl = wrap.querySelector('.dp-progress-fill');
      const stepEl = wrap.querySelector('.dp-progress-step');
      const pctEl  = wrap.querySelector('.dp-progress-pct');
      if (fillEl) fillEl.style.width = `${pct}%`;
      if (stepEl) stepEl.textContent = step;
      if (pctEl)  pctEl.textContent  = `${pct}%`;
    }

    function _renderDrumPanel(containerEl, state) {
      const { data, patterns, segments, threshold } = state;
      if (!data || !patterns.length) return;

      const timeSigNum = data.time_signature || 4;
      const timeSigDen = timeSigNum <= 4 ? 4 : 8;
      const patternCount = patterns.length;
      const totalDuration = segments.length
        ? (segments[segments.length - 1].end - segments[0].start)
        : 1;

      containerEl.innerHTML = '';

      // ── Header ───────────────────────────────────────────────────────────
      const header = _dpEl('div', 'dp-header');

      const meta = _dpEl('span', 'dp-meta');
      meta.textContent = `${data.bpm} BPM · ${timeSigNum}/${timeSigDen}`;

      const thresholdWrap = _dpEl('div', 'dp-threshold-wrap');
      const thresholdLbl = _dpEl('span', 'dp-threshold-label');
      thresholdLbl.textContent = 'Detail';

      const lessLbl = _dpEl('span', 'dp-range-end');
      lessLbl.textContent = 'Less';

      // slider: left=low detail (high threshold=few clusters), right=high detail (low threshold=many)
      // threshold = (100 - sliderValue) / 100 * 0.95 + 0.05
      const sliderToThreshold = (v) => (100 - v) / 100 * 0.95 + 0.05;
      const thresholdToSlider = (t) => Math.round((1 - (t - 0.05) / 0.95) * 100);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'dp-slider';
      slider.min = '1';
      slider.max = '99';
      slider.step = '1';
      slider.value = String(thresholdToSlider(threshold));

      const moreLbl = _dpEl('span', 'dp-range-end');
      moreLbl.textContent = 'More';

      const countLabel = _dpEl('span', 'dp-pattern-count');
      countLabel.textContent = `${patternCount} pattern${patternCount !== 1 ? 's' : ''}`;
      state.countLabelEl = countLabel;

      let sliderDebounce = null;
      slider.addEventListener('input', () => {
        clearTimeout(sliderDebounce);
        const t = sliderToThreshold(Number(slider.value));
        sliderDebounce = setTimeout(async () => {
          if (state !== _drumState) return;
          if (state.countLabelEl) state.countLabelEl.textContent = '…';
          await _fetchDrumCluster(state.jobId, t, containerEl, state);
        }, 280);
      });

      thresholdWrap.appendChild(thresholdLbl);
      thresholdWrap.appendChild(lessLbl);
      thresholdWrap.appendChild(slider);
      thresholdWrap.appendChild(moreLbl);
      thresholdWrap.appendChild(countLabel);
      header.appendChild(meta);
      header.appendChild(thresholdWrap);
      containerEl.appendChild(header);

      // ── Timeline strip ────────────────────────────────────────────────────
      const timeline = _dpEl('div', 'dp-timeline');
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const pattern = patterns.find(p => p.id === seg.pattern_id);
        const color = pattern ? pattern.color : '#94a3b8';
        const widthPct = ((seg.end - seg.start) / totalDuration) * 100;

        const segEl = _dpEl('div', 'dp-segment');
        segEl.style.flexBasis = `${widthPct.toFixed(2)}%`;
        segEl.style.backgroundColor = color;
        segEl.title = pattern ? (pattern.name || pattern.id) : '';
        segEl.dataset.segIdx = String(i);
        segEl.addEventListener('click', () => {
          if (pattern) _queuePatternSwitch(pattern.id, state);
        });
        timeline.appendChild(segEl);
      }
      state.timelineEl = timeline;
      containerEl.appendChild(timeline);

      // ── Pattern cards ─────────────────────────────────────────────────────
      const cards = _dpEl('div', 'dp-cards');
      for (const pattern of patterns) {
        const card = _dpEl('div', 'dp-card');
        card.style.setProperty('--dp-color', pattern.color);
        card.dataset.patternId = pattern.id;
        card.title = `Play pattern ${pattern.name || pattern.id}`;

        const dot = _dpEl('span', 'dp-card-dot');
        const nameEl = _dpEl('span', 'dp-card-name');
        nameEl.textContent = pattern.name || pattern.id;
        nameEl.contentEditable = 'true';
        nameEl.spellcheck = false;

        nameEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
          if (e.key === 'Escape') { nameEl.textContent = pattern.name || pattern.id; nameEl.blur(); }
          e.stopPropagation();  // don't trigger global keyboard shortcuts
        });
        nameEl.addEventListener('blur', () => {
          const newName = (nameEl.textContent || '').trim() || pattern.id;
          nameEl.textContent = newName;
          if (newName !== (pattern.name || pattern.id)) {
            pattern.name = newName;
            // Update timeline tooltips
            if (state.timelineEl) {
              state.timelineEl.querySelectorAll('.dp-segment').forEach((s, idx) => {
                const seg = state.segments[idx];
                if (seg && seg.pattern_id === pattern.id) s.title = newName;
              });
            }
            fetch(`${API_BASE}/jobs/${state.jobId}/drums/patterns`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ names: { [pattern.id]: newName } }),
            }).catch(() => {});
          }
        });
        // Prevent card click from firing when editing the name
        nameEl.addEventListener('pointerdown', (e) => e.stopPropagation());
        nameEl.addEventListener('click', (e) => e.stopPropagation());

        const countEl = _dpEl('span', 'dp-card-count');
        countEl.textContent = `${pattern.occurrences.length}×`;

        card.appendChild(dot);
        card.appendChild(nameEl);
        card.appendChild(countEl);
        card.addEventListener('click', () => _queuePatternSwitch(pattern.id, state));
        cards.appendChild(card);
      }
      state.cardsEl = cards;
      containerEl.appendChild(cards);

      // ── Switch status bar ─────────────────────────────────────────────────
      const statusBar = _dpEl('div', 'dp-switch-status dp-hidden');
      state.statusBarEl = statusBar;
      containerEl.appendChild(statusBar);
    }

    // ── Quantized pattern switching ───────────────────────────────────────────

    function _queuePatternSwitch(patternId, state) {
      // Cancel existing pending switch
      if (state.switchTimer) { clearTimeout(state.switchTimer); state.switchTimer = null; }
      if (state.countdownInterval) { clearInterval(state.countdownInterval); state.countdownInterval = null; }
      state.pendingSwitch = null;

      const pattern = state.patterns.find(p => p.id === patternId);
      if (!pattern || !pattern.occurrences.length) return;

      if (!mixer.isPlaying) {
        seekTo(pattern.occurrences[0].start).catch(() => {});
        return;
      }

      const songPos = currentOffset();
      const nextBoundary = _nextMeasureBoundary(songPos, state.measureTimestamps);

      // Find the first occurrence of the target pattern at or after the next measure boundary
      let targetOccurrence = null;
      if (nextBoundary !== null) {
        targetOccurrence = pattern.occurrences.find(o => o.start >= nextBoundary - 0.05) || null;
      }
      // If the pattern has no occurrence after the next boundary, loop back to its first occurrence
      if (!targetOccurrence) targetOccurrence = pattern.occurrences[0];

      if (nextBoundary === null) {
        seekTo(targetOccurrence.start).catch(() => {});
        return;
      }

      // Calculate delay: time remaining in song-time → convert to real-time
      const remaining = nextBoundary - songPos;   // seconds of song content
      const realRemaining = remaining / effectiveTempoRate();  // real seconds
      const delayMs = Math.max(0, realRemaining * 1000 - 20); // 20 ms early for seekTo overhead

      state.pendingSwitch = { patternId, targetStart: targetOccurrence.start };
      _updateDrumCards(state);
      _updateSwitchStatus(state, pattern, realRemaining);

      // Countdown display
      state.countdownInterval = setInterval(() => {
        if (!state.pendingSwitch || state.pendingSwitch.patternId !== patternId) {
          clearInterval(state.countdownInterval);
          state.countdownInterval = null;
          return;
        }
        const pos = currentOffset();
        const nb = _nextMeasureBoundary(pos, state.measureTimestamps);
        const rem = nb !== null ? (nb - pos) / effectiveTempoRate() : 0;
        _updateSwitchStatus(state, pattern, rem);
      }, 80);

      // The actual switch
      state.switchTimer = setTimeout(() => {
        state.switchTimer = null;
        if (state.countdownInterval) { clearInterval(state.countdownInterval); state.countdownInterval = null; }
        if (!state.pendingSwitch || state.pendingSwitch.patternId !== patternId) return;
        state.pendingSwitch = null;
        _updateDrumCards(state);
        _updateSwitchStatus(state, null, 0);
        // Only jump if still playing (user may have stopped)
        if (mixer.isPlaying || mixer.pausedAt !== undefined) {
          seekTo(targetOccurrence.start).catch(() => {});
        }
      }, delayMs);
    }

    function _nextMeasureBoundary(songPos, measureTimestamps) {
      // 150 ms lookahead: if we're almost at a boundary, skip to the next one
      const LOOKAHEAD = 0.15;
      for (const t of measureTimestamps) {
        if (t > songPos + LOOKAHEAD) return t;
      }
      return null;
    }

    function _updateDrumCards(state) {
      if (!state.cardsEl) return;
      state.cardsEl.querySelectorAll('.dp-card').forEach(card => {
        const pid = card.dataset.patternId;
        card.classList.toggle('dp-pending', !!(state.pendingSwitch && state.pendingSwitch.patternId === pid));
      });
    }

    function _updateSwitchStatus(state, pattern, remainingSecs) {
      if (!state.statusBarEl) return;
      if (!pattern || !state.pendingSwitch) {
        state.statusBarEl.classList.add('dp-hidden');
        return;
      }
      state.statusBarEl.classList.remove('dp-hidden');
      const name = pattern.name || pattern.id;
      const sec = Math.max(0, remainingSecs).toFixed(1);
      state.statusBarEl.innerHTML =
        `Switching to <strong>${_escHtml(name)}</strong> at next measure (${sec}s)`;
    }

    // ── Position ticker ───────────────────────────────────────────────────────

    function _drumTicker(state) {
      if (!state.active || !state.containerEl.isConnected) {
        state.active = false;
        return;
      }

      if (mixer.isPlaying && state.timelineEl && state.cardsEl) {
        const pos = currentOffset();

        // Find which segment the playhead is currently in
        let activeIdx = -1;
        for (let i = 0; i < state.segments.length; i++) {
          if (pos >= state.segments[i].start && pos < state.segments[i].end) {
            activeIdx = i;
            break;
          }
        }

        // Highlight active segment in timeline
        let activePatternId = null;
        state.timelineEl.querySelectorAll('.dp-segment').forEach((segEl, i) => {
          const isActive = i === activeIdx;
          segEl.classList.toggle('dp-seg-active', isActive);
          if (isActive && state.segments[i]) activePatternId = state.segments[i].pattern_id;
        });

        // Highlight active pattern card (only when no pending switch)
        if (!state.pendingSwitch) {
          state.cardsEl.querySelectorAll('.dp-card').forEach(card => {
            card.classList.toggle('dp-playing', card.dataset.patternId === activePatternId);
          });
        }
      } else if (!mixer.isPlaying) {
        // Clear active states while paused
        if (state.cardsEl) {
          state.cardsEl.querySelectorAll('.dp-card.dp-playing').forEach(c => c.classList.remove('dp-playing'));
        }
        if (state.timelineEl) {
          state.timelineEl.querySelectorAll('.dp-seg-active').forEach(s => s.classList.remove('dp-seg-active'));
        }
      }

      requestAnimationFrame(() => _drumTicker(state));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _dpEl(tag, className) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      return el;
    }

    function _escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // ── Styles (injected once into <head>) ────────────────────────────────────

    function _injectDrumStyles() {
      if (_drumStylesInjected) return;
      _drumStylesInjected = true;
      const style = document.createElement('style');
      style.textContent = `
.drum-pattern-panel {
  padding: 10px 14px 14px;
  background: rgba(0,0,0,0.035);
  border-top: 1px solid rgba(0,0,0,0.07);
  border-radius: 0 0 8px 8px;
}
.dp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.dp-meta {
  font-size: 11px;
  font-weight: 600;
  color: #374151;
  white-space: nowrap;
  letter-spacing: 0.01em;
}
.dp-threshold-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  flex-wrap: nowrap;
}
.dp-threshold-label {
  font-size: 10px;
  color: #6b7280;
  white-space: nowrap;
}
.dp-range-end {
  font-size: 10px;
  color: #9ca3af;
  white-space: nowrap;
}
.dp-slider {
  width: 80px;
  cursor: pointer;
  accent-color: #3b82f6;
}
.dp-pattern-count {
  font-size: 10px;
  color: #6b7280;
  min-width: 54px;
  white-space: nowrap;
}
.dp-timeline {
  display: flex;
  height: 14px;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 10px;
  gap: 1px;
  background: rgba(0,0,0,0.08);
}
.dp-segment {
  flex: 0 0 auto;
  height: 100%;
  cursor: pointer;
  transition: filter 0.12s, transform 0.12s;
  position: relative;
}
.dp-segment:hover { filter: brightness(1.18); }
.dp-seg-active {
  outline: 2px solid rgba(255,255,255,0.85);
  outline-offset: -2px;
  filter: brightness(1.1);
}
.dp-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.dp-card {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px 4px 7px;
  border-radius: 20px;
  border: 2px solid transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: #1f2937;
  background: rgba(255,255,255,0.82);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  user-select: none;
  transition: box-shadow 0.15s, transform 0.15s, background 0.15s, border-color 0.15s, color 0.15s;
}
.dp-card:hover {
  box-shadow: 0 2px 7px rgba(0,0,0,0.18);
  transform: translateY(-1px);
}
.dp-card.dp-playing {
  background: var(--dp-color);
  color: #fff;
  border-color: transparent;
}
.dp-card.dp-pending {
  border-color: var(--dp-color);
  animation: dp-pulse 0.75s ease-in-out infinite;
}
@keyframes dp-pulse {
  0%,100% { opacity: 1; }
  50%       { opacity: 0.55; }
}
.dp-card-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dp-color);
  flex-shrink: 0;
  transition: background 0.15s;
}
.dp-card.dp-playing .dp-card-dot { background: rgba(255,255,255,0.85); }
.dp-card-name {
  outline: none;
  min-width: 14px;
  max-width: 84px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  border-bottom: 1px solid transparent;
  transition: border-color 0.1s;
}
.dp-card-name:focus { border-bottom-color: currentColor; }
.dp-card-count {
  font-size: 10px;
  opacity: 0.65;
  font-weight: 400;
}
.dp-switch-status {
  font-size: 11px;
  color: #1d4ed8;
  padding: 5px 9px;
  background: rgba(59,130,246,0.10);
  border-radius: 5px;
  border-left: 3px solid #3b82f6;
  line-height: 1.4;
}
.dp-hidden { display: none !important; }
.dp-progress-wrap {
  padding: 8px 2px 6px;
}
.dp-progress-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 7px;
}
.dp-progress-title {
  font-size: 11px;
  font-weight: 600;
  color: #374151;
}
.dp-progress-pct {
  font-size: 11px;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}
.dp-progress-track {
  height: 5px;
  background: rgba(0,0,0,0.10);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 7px;
}
.dp-progress-fill {
  height: 100%;
  background: #3b82f6;
  border-radius: 3px;
  transition: width 0.6s ease;
}
.dp-progress-step {
  font-size: 11px;
  color: #9ca3af;
  font-style: italic;
}
.dp-loading {
  text-align: center;
  padding: 10px 0 6px;
  color: #9ca3af;
  font-size: 11px;
}
.dp-too-short {
  text-align: center;
  padding: 6px 0;
  color: #9ca3af;
  font-size: 11px;
  font-style: italic;
}
      `;
      document.head.appendChild(style);
    }
