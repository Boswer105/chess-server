// ==UserScript==
// @name         ♟ Chess Coach — Stockfish
// @namespace    chess-coach-pub
// @version      10.38
// @description  Analyse Stockfish en temps réel sur chess.com : flèches, évaluation, auto-play, précision live
// @author       Claude
// @match        https://www.chess.com/*
// @match        https://chess.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// @connect      localhost
// @connect      cdnjs.cloudflare.com
// ==/UserScript==

(function () {
  'use strict';

  // ══════════════════════════════════════════════
  // CONFIG
  // ══════════════════════════════════════════════
  const SERVER          = 'http://localhost:8765';
  const SCAN_INTERVAL   = 1200;
  const ARROW_MY_COLOR  = 'rgba(0,200,120,0.9)';
  const ARROW_FOE_COLOR = 'rgba(255,120,60,0.9)';
  const ARROW_HEAD      = 16;
  const ARROW_WIDTH     = 10;
  const PLAY_DELAY_MIN  = 900;
  const PLAY_DELAY_MAX  = 2500;
  const ANIM_WAIT       = 400;
  const PRECISION_START_MOVE = 5;
  const GOOD_MOVE_THRESHOLD  = 20;
  const BATCH_SIZE           = 1;
  const PREC_DEPTH           = 20;
  const NOISE_FLOOR          = 40;
  // Mode humain : config par niveau
  const HUMAN_LEVELS = {
    1: { mistakeChance: 0.30, delayMin: 1500, delayMax: 6000, thinkChance: 0.20, thinkExtra: 3000 }, // Joueur ~1500 elo
    2: { mistakeChance: 0.15, delayMin: 1200, delayMax: 4500, thinkChance: 0.15, thinkExtra: 2000 }, // Joueur ~2000 elo
    3: { mistakeChance: 0.05, delayMin: 900,  delayMax: 3500, thinkChance: 0.10, thinkExtra: 1500 }, // Joueur ~2500 elo
    4: { mistakeChance: 0.00, delayMin: 300,  delayMax: 5000, thinkChance: 0.20, thinkExtra: 2000 }, // Délai naturel, 0 erreur
  };
  let humanLevel = 1;

  // ══════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════
  let coachOn       = false;
  let autoPlayOn    = false;
  let humanModeOn   = false;
  let autoRematchOn = false;
  let precisionEnabled = true;
  let showEvalBar   = true;
  let serverOk     = false;
  let lastFen      = '';
  let lastEnemyFen = '';
  let lastPlayedFen = '';
  let scanTimer    = null;
  let isPlaying    = false;
  let analysing    = false;
  let enemyAnalysing = false;
  let playerColor  = 'w';
  let autoPlayRetries = 0;
  const MAX_RETRIES = 3;

  // ── PRÉCISION (calcul par batch toutes les 10 coups) ──────────────
  let precisionHistory      = [];
  let enemyPrecisionHistory = [];
  let lastFullmoveTracked   = 0;
  let lastSuggestedUci      = null;
  // Stockage des positions pour le calcul batch
  let ourFenHistory         = []; // {fenBefore, fenAfter, suggestedUci} pour chaque coup
  let enemyFenHistory       = []; // {fenBefore, fenAfter} pour chaque coup ennemi
  let prevOurFen            = null;
  let prevEnemyFen          = null;
  let batchCalculating      = false;

  // WASM fallback
  let sf = null, sfReady = false, sfResolve = null, sfLines = [];

  // ══════════════════════════════════════════════
  // PRÉCISION — CALCUL (batch toutes les 10 coups)
  // ══════════════════════════════════════════════

  function cpLossToAccuracy(cpLoss) {
    const loss = Math.max(0, cpLoss);
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
  }

  function avgAccuracy(history) {
    if (!history.length) return null;
    const sum = history.reduce((acc, loss) => acc + cpLossToAccuracy(loss), 0);
    return sum / history.length;
  }

  function accuracyColor(pct) {
    if (pct === null) return '#7a9ab5';
    if (pct >= 90) return '#00c878';
    if (pct >= 75) return '#f0c040';
    if (pct >= 60) return '#ff8c00';
    return '#e05555';
  }

  function accuracyEmoji(pct) {
    if (pct === null) return '';
    if (pct >= 95) return '🏆';
    if (pct >= 85) return '✨';
    if (pct >= 75) return '👍';
    if (pct >= 60) return '😐';
    return '😬';
  }

  function updatePrecisionDisplay() {
    const usAcc   = avgAccuracy(precisionHistory);
    const themAcc = avgAccuracy(enemyPrecisionHistory);
    const moves   = precisionHistory.length;

    const movEl = document.getElementById('cc-prec-moves');
    if (movEl) movEl.textContent = moves > 0 ? moves + ' coup' + (moves > 1 ? 's analysés' : ' analysé') : '–';

    const usEl  = document.getElementById('cc-prec-us');
    const usBar = document.getElementById('cc-prec-bar-us');
    if (usEl) {
      if (usAcc !== null) {
        usEl.textContent = usAcc.toFixed(1) + '%';
        usEl.style.color = accuracyColor(usAcc);
        if (usBar) { usBar.style.width = usAcc + '%'; usBar.style.background = accuracyColor(usAcc); }
      } else {
        usEl.textContent = '—'; usEl.style.color = '#7a9ab5';
        if (usBar) usBar.style.width = '0%';
      }
    }

    const themEl  = document.getElementById('cc-prec-them');
    const themBar = document.getElementById('cc-prec-bar-them');
    if (themEl) {
      if (themAcc !== null) {
        themEl.textContent = themAcc.toFixed(1) + '%';
        themEl.style.color = accuracyColor(themAcc);
        if (themBar) { themBar.style.width = themAcc + '%'; themBar.style.background = accuracyColor(themAcc); }
      } else {
        themEl.textContent = '—'; themEl.style.color = '#7a9ab5';
        if (themBar) themBar.style.width = '0%';
      }
    }

    const usBadge   = document.getElementById('cc-prec-badge-us');
    const themBadge = document.getElementById('cc-prec-badge-them');
    if (usBadge)   usBadge.textContent   = accuracyEmoji(usAcc);
    if (themBadge) themBadge.textContent = accuracyEmoji(themAcc);

    updateMoveQuality();
  }

  function updateMoveQuality() {
    const goodUs   = precisionHistory.filter(l => l <= GOOD_MOVE_THRESHOLD).length;
    const badUs    = precisionHistory.filter(l => l >  GOOD_MOVE_THRESHOLD).length;
    const goodThem = enemyPrecisionHistory.filter(l => l <= GOOD_MOVE_THRESHOLD).length;
    const badThem  = enemyPrecisionHistory.filter(l => l >  GOOD_MOVE_THRESHOLD).length;

    const g1 = document.getElementById('cc-good-us');
    const b1 = document.getElementById('cc-bad-us');
    const g2 = document.getElementById('cc-good-them');
    const b2 = document.getElementById('cc-bad-them');

    if (g1) g1.textContent = goodUs;
    if (b1) b1.textContent = badUs;
    if (g2) g2.textContent = goodThem;
    if (b2) b2.textContent = badThem;
  }

  function resetPrecision() {
    precisionHistory      = [];
    enemyPrecisionHistory = [];
    ourFenHistory         = [];
    enemyFenHistory       = [];
    prevOurFen            = null;
    prevEnemyFen          = null;
    lastFullmoveTracked   = 0;
    lastSuggestedUci      = null;
    batchCalculating      = false;
    updatePrecisionDisplay();
    updateMoveQuality();
    // Reset compteurs affichés
    ['cc-good-us','cc-bad-us','cc-good-them','cc-bad-them'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '0';
    });
  }

  // Analyse une position et retourne le score du meilleur coup (profondeur PREC_DEPTH)
  function getRefScore(fen) {
    return new Promise(resolve => {
      if (!serverOk) { resolve(null); return; }
      GM_xmlhttpRequest({
        method:'POST', url:SERVER+'/analyse',
        headers:{'Content-Type':'application/json'},
        data: JSON.stringify({fen, depth: PREC_DEPTH, skill: 20, multipv: 1}),
        timeout: 12000,
        onload: r => {
          try {
            const d = JSON.parse(r.responseText);
            const pv1 = d.lines?.['1'] || d.lines?.[1];
            if (!pv1) { resolve(null); return; }
            const st = pv1.score_type || 'cp';
            const sv = parseInt(pv1.score) || 0;
            if (st === 'mate') { resolve({ score: sv > 0 ? 99999 : -99999, mate: sv, uci: pv1.uci }); return; }
            resolve({ score: sv, mate: null, uci: pv1.uci });
          } catch(e) { resolve(null); }
        },
        onerror:  () => resolve(null),
        ontimeout:() => resolve(null),
      });
    });
  }

  // Calcul batch : analyse toutes les positions accumulées
  async function runBatchPrecision(forceAll = false) {
    if (batchCalculating) return;
    if (!precisionEnabled && !forceAll) return;
    const ourPending   = ourFenHistory.filter(e => !e.calculated);
    const enemyPending = enemyFenHistory.filter(e => !e.calculated);
    if (!forceAll && ourPending.length < BATCH_SIZE) return;
    if (!ourPending.length && !enemyPending.length) return;

    batchCalculating = true;
    setPrecStatus('⏳ Calcul précision…');

    // Analyse nos coups
    for (const entry of ourPending) {
      if (!coachOn) break;
      if (entry.followedStockfish) {
        // Auto-play ou coup Stockfish suivi → perte nulle, pas besoin d'analyser
        precisionHistory.push(0);
      } else {
        const refBefore = await getRefScore(entry.fenBefore);
        const refAfter  = await getRefScore(entry.fenAfter);
        if (refBefore && refAfter && refBefore.mate === null && refAfter.mate === null) {
          let cpLoss = Math.max(0, Math.min(500, refBefore.score + refAfter.score));
          if (cpLoss < NOISE_FLOOR) cpLoss = 0;
          precisionHistory.push(cpLoss);
        }
      }
      entry.calculated = true;
    }

    // Analyse les coups ennemis
    for (const entry of enemyPending) {
      if (!coachOn) break;
      const refBefore = await getRefScore(entry.fenBefore);
      const refAfter  = await getRefScore(entry.fenAfter);
      if (refBefore && refAfter && refBefore.mate === null && refAfter.mate === null) {
        // refBefore.score = meilleur score pour l'ennemi avant son coup
        // refAfter.score  = meilleur score pour nous après son coup = -score pour ennemi
        // score_après(ennemi) = -refAfter.score
        // cpLoss ennemi = max(0, refBefore.score - (-refAfter.score)) = max(0, refBefore.score + refAfter.score)
        let enemyCpLoss = Math.max(0, Math.min(500, refBefore.score + refAfter.score));
        if (enemyCpLoss < NOISE_FLOOR) enemyCpLoss = 0;
        enemyPrecisionHistory.push(enemyCpLoss);
      }
      entry.calculated = true;
    }

    batchCalculating = false;
    updatePrecisionDisplay();
    const total = precisionHistory.length;
    setPrecStatus('✅ ' + total + ' coup' + (total > 1 ? 's analysés' : ' analysé'));
  }

  function getFullmoveNumber(fen) {
    if (!fen) return 1;
    const parts = fen.split(' ');
    return parts.length >= 6 ? (parseInt(parts[5]) || 1) : 1;
  }

  // ══════════════════════════════════════════════
  // PANEL
  // ══════════════════════════════════════════════
  function buildPanel() {
    if (document.getElementById('cc-panel')) return;
    const p = document.createElement('div');
    p.id = 'cc-panel';
    p.style.cssText = `
      position:fixed;bottom:24px;right:24px;z-index:2147483647;width:240px;
      background:linear-gradient(160deg,#0f1923,#1a2535);
      border:1px solid #2a3f55;border-radius:12px;
      box-shadow:0 8px 32px rgba(0,0,0,0.7);
      font-family:'Segoe UI',sans-serif;color:#cdd9e5;
      overflow:hidden;user-select:none;
    `;
    p.innerHTML = `
      <!-- HEADER -->
      <div id="cc-header" style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:rgba(255,255,255,0.04);border-bottom:1px solid #2a3f55;cursor:move;">
        <span style="font-size:16px;">♟</span>
        <span style="font-size:12px;font-weight:700;letter-spacing:.5px;flex:1;">CHESS COACH</span>
        <span id="cc-engine-lbl" style="font-size:9px;color:#4a6a85;font-weight:700;margin-right:3px;">WASM</span>
        <span id="cc-server-dot" style="width:7px;height:7px;border-radius:50%;background:#e74c3c;flex-shrink:0;transition:background .4s;"></span>
      </div>

      <!-- ══ SECTION 1 : CONTRÔLES ══ -->
      <div>
        <div id="cc-sec1-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:5px 12px;cursor:pointer;background:rgba(0,180,255,0.04);border-bottom:1px solid #1e3348;">
          <span style="font-size:10px;font-weight:700;color:#5bc8f5;letter-spacing:.5px;">⚙ CONTRÔLES</span>
          <span id="cc-sec1-arrow" style="font-size:10px;color:#4a6a85;line-height:1;">▼</span>
        </div>
        <div id="cc-sec1-body" style="padding:8px 12px 6px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:5px;">
            <button id="cc-toggle" style="padding:7px 2px;border:none;border-radius:6px;background:#1c3a52;color:#5bc8f5;font-size:11px;font-weight:700;cursor:pointer;">▶ Coach OFF</button>
            <button id="cc-autoplay" style="padding:7px 2px;border:1px solid #4a2222;border-radius:6px;background:#2b1a1a;color:#e05555;font-size:11px;font-weight:700;cursor:pointer;">🤖 Auto OFF</button>
          </div>
          <button id="cc-humanmode" style="width:100%;padding:6px;border:1px solid #2a3a2a;border-radius:6px;background:#0d1a0d;color:#5a8a5a;font-size:11px;font-weight:700;cursor:pointer;margin-bottom:4px;">🎭 Mode Humain OFF</button>
          <div id="cc-humanlevel-wrap" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <span style="font-size:9px;color:#4a6a85;flex:1;">Niveau humain</span>
            <select id="cc-humanlevel" style="background:#111820;border:1px solid #2a3f55;border-radius:4px;color:#7a9ab5;font-size:10px;padding:2px 4px;cursor:pointer;">
              <option value="1">Niv.1 — ~1500 elo</option>
              <option value="2">Niv.2 — ~2000 elo</option>
              <option value="3">Niv.3 — ~2500 elo</option>
              <option value="4">Niv.4 — Délai naturel</option>
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:10px;color:#7a9ab5;margin-bottom:6px;">
            <input id="cc-rematch-toggle" type="checkbox" style="accent-color:#5bc8f5;cursor:pointer;width:12px;height:12px;">
            🔄 Rejouer automatiquement
          </label>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:#7a9ab5;margin-bottom:3px;">
            <span>Niveau Stockfish</span><span id="cc-lvl-val" style="color:#5bc8f5;font-weight:700;">10</span>
          </div>
          <input id="cc-level" type="range" min="1" max="20" value="10" style="width:100%;accent-color:#5bc8f5;cursor:pointer;margin-bottom:5px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:10px;color:#7a9ab5;margin-bottom:4px;">
            <input id="cc-eval-toggle" type="checkbox" checked style="accent-color:#5bc8f5;cursor:pointer;width:12px;height:12px;">
            Barre d'évaluation
          </label>
          <div id="cc-eval-bar-wrap">
            <div style="width:100%;height:14px;border-radius:3px;overflow:hidden;border:1px solid #2a3f55;position:relative;background:#111;">
              <div id="cc-eval-white" style="position:absolute;left:0;top:0;bottom:0;width:50%;background:#e8d5b0;transition:width .5s cubic-bezier(.4,0,.2,1);"></div>
              <div id="cc-eval-score" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);">= 0.0</div>
            </div>
          </div>
          <div style="margin-top:6px;">
            <div style="font-size:9px;color:#7a9ab5;margin-bottom:2px;">Meilleur coup</div>
            <div id="cc-bestmove" style="background:rgba(0,200,120,0.1);border:1px solid rgba(0,200,120,0.3);border-radius:5px;padding:4px 8px;font-size:13px;font-weight:700;color:#00c878;text-align:center;min-height:22px;">—</div>
          </div>
        </div>
      </div>

      <!-- ══ SECTION 2 : PRÉCISION ══ -->
      <div>
        <div id="cc-sec2-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:5px 12px;cursor:pointer;background:rgba(255,255,255,0.02);border-top:1px solid #1e3348;border-bottom:1px solid #1e3348;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:10px;font-weight:700;color:#7a9ab5;letter-spacing:.5px;">⚡ PRÉCISION</span>
            <label style="display:flex;align-items:center;gap:3px;cursor:pointer;" onclick="event.stopPropagation()">
              <input id="cc-prec-enabled" type="checkbox" checked style="accent-color:#5bc8f5;cursor:pointer;width:11px;height:11px;">
              <span style="font-size:8px;color:#4a6a85;">Actif</span>
            </label>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span id="cc-prec-moves" style="font-size:9px;color:#4a6a85;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:8px;">–</span>
            <span id="cc-sec2-arrow" style="font-size:10px;color:#4a6a85;line-height:1;">▼</span>
          </div>
        </div>
        <div id="cc-sec2-body" style="padding:7px 12px 8px;">
          <div style="display:flex;gap:8px;margin-bottom:6px;">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:9px;color:#7a9ab5;">
              <input id="cc-show-prec" type="checkbox" checked style="accent-color:#5bc8f5;cursor:pointer;width:11px;height:11px;">
              Précision
            </label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:9px;color:#7a9ab5;">
              <input id="cc-show-moves" type="checkbox" checked style="accent-color:#5bc8f5;cursor:pointer;width:11px;height:11px;">
              Qualité coups
            </label>
          </div>
          <div id="cc-prec-wrap">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:5px;">
              <div style="background:rgba(255,255,255,0.03);border:1px solid #1e3348;border-radius:7px;padding:6px 5px;text-align:center;">
                <div style="font-size:8px;color:#7a9ab5;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px;">Vous</div>
                <div style="display:flex;align-items:center;justify-content:center;gap:2px;">
                  <span id="cc-prec-us" style="font-size:15px;font-weight:800;color:#7a9ab5;">—</span>
                  <span id="cc-prec-badge-us" style="font-size:11px;"></span>
                </div>
                <div style="margin-top:3px;height:2px;border-radius:1px;background:rgba(255,255,255,0.06);overflow:hidden;">
                  <div id="cc-prec-bar-us" style="height:100%;width:0%;border-radius:1px;transition:width .6s,background .4s;background:#7a9ab5;"></div>
                </div>
              </div>
              <div style="background:rgba(255,255,255,0.03);border:1px solid #1e3348;border-radius:7px;padding:6px 5px;text-align:center;">
                <div style="font-size:8px;color:#7a9ab5;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px;">Adverse</div>
                <div style="display:flex;align-items:center;justify-content:center;gap:2px;">
                  <span id="cc-prec-them" style="font-size:15px;font-weight:800;color:#7a9ab5;">—</span>
                  <span id="cc-prec-badge-them" style="font-size:11px;"></span>
                </div>
                <div style="margin-top:3px;height:2px;border-radius:1px;background:rgba(255,255,255,0.06);overflow:hidden;">
                  <div id="cc-prec-bar-them" style="height:100%;width:0%;border-radius:1px;transition:width .6s,background .4s;background:#7a9ab5;"></div>
                </div>
              </div>
            </div>
          </div>
          <div id="cc-moves-wrap">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;">
              <div style="background:rgba(255,255,255,0.03);border:1px solid #1e3348;border-radius:7px;padding:5px;text-align:center;">
                <div style="font-size:8px;color:#7a9ab5;margin-bottom:3px;text-transform:uppercase;letter-spacing:.3px;">Vous</div>
                <div style="display:flex;justify-content:center;gap:8px;">
                  <div><span id="cc-good-us" style="font-size:13px;font-weight:800;color:#00c878;display:block;">0</span><span style="font-size:7px;color:#7a9ab5;">✅</span></div>
                  <div><span id="cc-bad-us" style="font-size:13px;font-weight:800;color:#e05555;display:block;">0</span><span style="font-size:7px;color:#7a9ab5;">❌</span></div>
                </div>
              </div>
              <div style="background:rgba(255,255,255,0.03);border:1px solid #1e3348;border-radius:7px;padding:5px;text-align:center;">
                <div style="font-size:8px;color:#7a9ab5;margin-bottom:3px;text-transform:uppercase;letter-spacing:.3px;">Adverse</div>
                <div style="display:flex;justify-content:center;gap:8px;">
                  <div><span id="cc-good-them" style="font-size:13px;font-weight:800;color:#00c878;display:block;">0</span><span style="font-size:7px;color:#7a9ab5;">✅</span></div>
                  <div><span id="cc-bad-them" style="font-size:13px;font-weight:800;color:#e05555;display:block;">0</span><span style="font-size:7px;color:#7a9ab5;">❌</span></div>
                </div>
              </div>
            </div>
          </div>
          <div id="cc-prec-status" style="font-size:8px;color:#3a5a75;text-align:center;margin-top:4px;font-style:italic;min-height:10px;"></div>
        </div>
      </div>

      <div id="cc-status" style="padding:3px 12px 7px;font-size:9px;color:#4a6a85;text-align:center;font-style:italic;">Initialisation…</div>
    `;

    document.body.appendChild(p);
    makeDraggable(p, p.querySelector('#cc-header'));

    p.querySelector('#cc-level').addEventListener('input', e => {
      document.getElementById('cc-lvl-val').textContent = e.target.value;
    });

    p.querySelector('#cc-toggle').addEventListener('click', toggleCoach);
    p.querySelector('#cc-autoplay').addEventListener('click', toggleAutoPlay);
    p.querySelector('#cc-humanmode').addEventListener('click', toggleHumanMode);
    p.querySelector('#cc-humanlevel').addEventListener('change', e => {
      humanLevel = parseInt(e.target.value);
      const names = { 1: '~1500', 2: '~2000', 3: '~2500', 4: 'Délai naturel' };
      const btn = document.getElementById('cc-humanmode');
      if (humanModeOn) {
        btn.textContent = '🎭 Humain ON — ' + names[humanLevel] + ' elo';
        setStatus('🎭 Mode humain Niv.' + humanLevel + ' (' + names[humanLevel] + ' elo)');
      }
    });
    p.querySelector('#cc-rematch-toggle').addEventListener('change', e => {
      autoRematchOn = e.target.checked;
      setStatus(autoRematchOn ? '🔄 Rejouer auto activé' : 'Rejouer auto désactivé');
    });

    // Sections repliables
    p.querySelector('#cc-sec1-hdr').addEventListener('click', () => {
      const body = document.getElementById('cc-sec1-body');
      const arrow = document.getElementById('cc-sec1-arrow');
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      arrow.textContent = open ? '▶' : '▼';
    });
    p.querySelector('#cc-sec2-hdr').addEventListener('click', () => {
      const body = document.getElementById('cc-sec2-body');
      const arrow = document.getElementById('cc-sec2-arrow');
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      arrow.textContent = open ? '▶' : '▼';
    });

    p.querySelector('#cc-eval-toggle').addEventListener('change', e => {
      showEvalBar = e.target.checked;
      const wrap = document.getElementById('cc-eval-bar-wrap');
      if (wrap) wrap.style.display = showEvalBar ? '' : 'none';
    });
    p.querySelector('#cc-show-prec').addEventListener('change', e => {
      const wrap = document.getElementById('cc-prec-wrap');
      if (wrap) wrap.style.display = e.target.checked ? '' : 'none';
    });
    p.querySelector('#cc-prec-enabled').addEventListener('change', e => {
      precisionEnabled = e.target.checked;
      setStatus(precisionEnabled ? 'Calcul précision activé' : 'Calcul précision désactivé');
    });
    p.querySelector('#cc-show-moves').addEventListener('change', e => {
      const wrap = document.getElementById('cc-moves-wrap');
      if (wrap) wrap.style.display = e.target.checked ? '' : 'none';
    });
  }

  function makeDraggable(el, handle) {
    let ox=0,oy=0,mx=0,my=0;
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      ox=el.offsetLeft; oy=el.offsetTop; mx=e.clientX; my=e.clientY;
      document.addEventListener('mousemove', drag);
      document.addEventListener('mouseup', stop);
    });
    function drag(e) { el.style.left=(ox+e.clientX-mx)+'px'; el.style.top=(oy+e.clientY-my)+'px'; el.style.right='auto'; el.style.bottom='auto'; }
    function stop() { document.removeEventListener('mousemove',drag); document.removeEventListener('mouseup',stop); }
  }

  function setStatus(msg)  { const el=document.getElementById('cc-status'); if(el) el.textContent=msg; }
  function setPrecStatus(msg) { const el=document.getElementById('cc-prec-status'); if(el) el.textContent=msg; }
  function getLevel()      { const el=document.getElementById('cc-level'); return el ? parseInt(el.value) : 10; }

  // ══════════════════════════════════════════════
  // WASM STOCKFISH
  // ══════════════════════════════════════════════
  function initWasm() {
    try {
      const blob = new Blob(
        [`self.importScripts('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');`],
        {type:'application/javascript'}
      );
      sf = new Worker(URL.createObjectURL(blob));
      sf.onmessage = e => {
        const line = typeof e.data==='string' ? e.data : '';
        if (line.startsWith('info') && line.includes(' pv ')) sfLines.push(line);
        if (line==='uciok') sf.postMessage('isready');
        if (line==='readyok') {
          sfReady = true;
          updateEngineLabel();
          if (!serverOk) setStatus('Stockfish WASM prêt ✓');
        }
        if (line.startsWith('bestmove') && sfResolve) {
          const r=sfResolve; sfResolve=null;
          r({bestLine:line, infoLines:[...sfLines]}); sfLines=[];
        }
      };
      sf.onerror = () => { sfReady=false; };
      sf.postMessage('uci');
    } catch(e) { sfReady=false; }
  }

  function askWasm(fen, level) {
    return new Promise(resolve => {
      if (!sf || !sfReady) { resolve(null); return; }
      sfLines = [];
      const skill = level >= 20 ? 20 : Math.max(0, level-1);
      const depth = level >= 20 ? 17 : Math.max(4, Math.round(3 + level*0.7));
      sf.postMessage('ucinewgame');
      if (skill < 20) sf.postMessage(`setoption name Skill Level value ${skill}`);
      sf.postMessage('setoption name MultiPV value 1');
      sf.postMessage(`position fen ${fen}`);
      sfResolve = resolve;
      sf.postMessage(`go depth ${depth}`);
      setTimeout(() => { if (sfResolve) { const r=sfResolve; sfResolve=null; r(null); } }, 9000);
    });
  }

  function parseWasmResult(data) {
    if (!data) return null;
    for (let i=data.infoLines.length-1; i>=0; i--) {
      const line = data.infoLines[i];
      const uciM = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
      const scM  = line.match(/score (cp|mate) (-?\d+)/);
      if (uciM) {
        const uci   = uciM[1];
        const mate  = scM && scM[1]==='mate' ? parseInt(scM[2]) : null;
        const score = scM && scM[1]==='cp'   ? parseInt(scM[2]) : (mate!==null ? (mate>0?99999:-99999) : 0);
        return {uci, score, mate};
      }
    }
    if (data.bestLine) {
      const bm = data.bestLine.split(' ')[1];
      if (bm && bm!=='(none)') return {uci:bm, score:0, mate:null};
    }
    return null;
  }

  // ══════════════════════════════════════════════
  // SERVEUR LOCAL
  // ══════════════════════════════════════════════
  function checkServer() {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method:'GET', url:SERVER+'/status', timeout:2000,
        onload:   r => { try { serverOk=JSON.parse(r.responseText).ready===true; } catch(e){ serverOk=false; } resolve(serverOk); },
        onerror:  () => { serverOk=false; resolve(false); },
        ontimeout:() => { serverOk=false; resolve(false); },
      });
    });
  }

  function updateEngineLabel() {
    const lbl = document.getElementById('cc-engine-lbl');
    const dot = document.getElementById('cc-server-dot');
    if (lbl) { lbl.textContent=serverOk?'LOCAL':'WASM'; lbl.style.color=serverOk?'#00c878':'#4a6a85'; }
    if (dot) dot.style.background = serverOk ? '#00c878' : '#e74c3c';
  }

  async function updateServerDot() {
    await checkServer();
    updateEngineLabel();
    if (!coachOn) setStatus(serverOk ? 'Stockfish local prêt ✓' : (sfReady ? 'WASM prêt (sans serveur)' : 'Serveur déconnecté'));
  }

  // ══════════════════════════════════════════════
  // ANALYSE
  // ══════════════════════════════════════════════
  function analyseLocal(fen, level) {
    const skill = level >= 20 ? 20 : Math.max(0, level-1);
    const depth = level >= 20 ? 40 : Math.min(20, Math.max(8, Math.round(6+level*0.8)));
    const timeout = level >= 20 ? 35000 : 15000;
    // multipv:3 uniquement si le niveau peut faire des erreurs
    const needMulti = humanModeOn && autoPlayOn && HUMAN_LEVELS[humanLevel].mistakeChance > 0;
    const multipv = needMulti ? 3 : 1;
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method:'POST', url:SERVER+'/analyse',
        headers:{'Content-Type':'application/json'},
        data: JSON.stringify({fen, depth, skill, multipv}),
        timeout: timeout,
        onload: r => {
          try {
            const d = JSON.parse(r.responseText);
            const pv1 = d.lines?.['1'] || d.lines?.[1];
            if (!pv1) { resolve(null); return; }

            // Mode humain : parfois jouer le 2e ou 3e coup
            if (humanModeOn && autoPlayOn && Math.random() < HUMAN_LEVELS[humanLevel].mistakeChance) {
              const pv2 = d.lines?.['2'] || d.lines?.[2];
              const pv3 = d.lines?.['3'] || d.lines?.[3];
              const alts = [pv2, pv3].filter(p => p && p.uci);
              if (alts.length > 0) {
                const pick = alts[Math.floor(Math.random() * alts.length)];
                const st = pick.score_type || 'cp';
                const sv = parseInt(pick.score) || 0;
                resolve({ uci: pick.uci, score: st==='cp' ? sv : (sv>0?99999:-99999), mate: st==='mate'?sv:null });
                return;
              }
            }

            const st    = pv1?.score_type || 'cp';
            const sv    = parseInt(pv1?.score) || 0;
            const mate  = st==='mate' ? sv : null;
            const score = st==='cp'   ? sv : (sv>0?99999:-99999);
            resolve({uci: pv1.uci || d.bestmove, score, mate});
          } catch(e) {
            serverOk = false; updateEngineLabel(); resolve(null);
          }
        },
        onerror:  () => { serverOk=false; updateEngineLabel(); if(coachOn) setStatus('Serveur déconnecté → WASM'); resolve(null); },
        ontimeout:() => { serverOk=false; updateEngineLabel(); if(coachOn) setStatus('Serveur timeout → WASM'); resolve(null); },
      });
    });
  }

  // Analyse dédiée à la précision (ancienne version, gardée pour compatibilité)
  function analyseForPrecision(fen) {
    return new Promise(resolve => {
      if (serverOk) {
        GM_xmlhttpRequest({
          method:'POST', url:SERVER+'/analyse',
          headers:{'Content-Type':'application/json'},
          data: JSON.stringify({fen, depth: PREC_DEPTH, skill: 20, multipv: 1}),
          timeout: 8000,
          onload: r => {
            try {
              const d   = JSON.parse(r.responseText);
              const pv1 = d.lines?.['1'] || d.lines?.[1];
              const uci = pv1?.uci || d.bestmove;
              if (!uci) { resolve(null); return; }
              const st  = pv1?.score_type || 'cp';
              const sv  = parseInt(pv1?.score) || 0;
              const mate = st==='mate' ? sv : null;
              const score = st==='cp' ? sv : (sv>0?99999:-99999);
              resolve({uci, score, mate});
            } catch(e) { resolve(null); }
          },
          onerror:  () => resolve(null),
          ontimeout:() => resolve(null),
        });
      } else if (sfReady) {
        resolve(parseWasmResult(askWasm(fen, 10)));
      } else {
        resolve(null);
      }
    });
  }

  // Analyse avec multipv:2 — retourne le score du MEILLEUR coup (référence absolue)
  // Utilisé pour calculer la précision de façon exacte :
  // cpLoss = scoreRef(meilleur coup) - scoreAprès(coup joué)
  // Si coup joué = meilleur coup → cpLoss = 0 exactement
  function analyseWithRef(fen) {
    return new Promise(resolve => {
      if (!serverOk) { resolve(null); return; }
      GM_xmlhttpRequest({
        method:'POST', url:SERVER+'/analyse',
        headers:{'Content-Type':'application/json'},
        data: JSON.stringify({fen, depth: PREC_DEPTH, skill: 20, multipv: 2}),
        timeout: 10000,
        onload: r => {
          try {
            const d = JSON.parse(r.responseText);
            const pv1 = d.lines?.['1'] || d.lines?.[1];
            if (!pv1) { resolve(null); return; }
            const st = pv1.score_type || 'cp';
            const sv = parseInt(pv1.score) || 0;
            const mate = st === 'mate' ? sv : null;
            const score = st === 'cp' ? sv : (sv > 0 ? 99999 : -99999);
            // bestUci = meilleur coup de référence
            const bestUci = pv1.uci || d.bestmove;
            resolve({ score, mate, bestUci });
          } catch(e) { resolve(null); }
        },
        onerror:  () => resolve(null),
        ontimeout:() => resolve(null),
      });
    });
  }

  async function analyse(fen) {
    const level = getLevel();
    if (serverOk) {
      const res = await analyseLocal(fen, level);
      if (res && res.uci) return res;
    }
    if (sfReady) return parseWasmResult(await askWasm(fen, level));
    return null;
  }

  // Récupère le dernier coup joué par nous depuis l'API chess.com
  function getLastPlayedMoveUci() {
    try {
      const b = document.querySelector('chess-board') || document.querySelector('wc-chess-board');
      if (!b) return null;
      const g = b.game || b._game;
      if (!g) return null;
      // Tentative 1 : getMoveList
      if (typeof g.getMoveList === 'function') {
        const moves = g.getMoveList();
        if (moves && moves.length) {
          const last = moves[moves.length - 1];
          if (last && last.from && last.to) {
            return last.from + last.to + (last.promotion || '');
          }
        }
      }
      // Tentative 2 : getTurn / moves array
      if (g.moves && g.moves.length) {
        const last = g.moves[g.moves.length - 1];
        if (last && last.from && last.to) {
          return last.from + last.to + (last.promotion || '');
        }
      }
      // Tentative 3 : historique dans le DOM (cases surlignées = dernier coup)
      const board = b;
      const highlights = board.querySelectorAll('[class*="highlight"]');
      if (highlights.length >= 2) {
        const sqs = [];
        highlights.forEach(el => {
          const m = el.className.match(/square-(\d)(\d)/);
          if (m) {
            const file = String.fromCharCode(96 + parseInt(m[1]));
            const rank = m[2];
            sqs.push(file + rank);
          }
        });
        if (sqs.length >= 2) return sqs[0] + sqs[1];
      }
    } catch(e) {}
    return null;
  }
  function fenIsValid(fen) {
    if (!fen || typeof fen !== 'string') return false;
    const parts = fen.split(' ');
    if (parts.length < 2) return false;
    const rows = parts[0].split('/');
    if (rows.length !== 8) return false;
    const hasWK = parts[0].includes('K');
    const hasBK = parts[0].includes('k');
    if (!hasWK || !hasBK) return false;
    for (const row of rows) {
      let count = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') count += parseInt(ch);
        else count++;
      }
      if (count !== 8) return false;
    }
    return true;
  }

  function getFen() {
    try {
      const b = document.querySelector('chess-board') || document.querySelector('wc-chess-board');
      if (b) {
        const g = b.game || b._game;
        if (g) {
          let fen = null;
          if (typeof g.getFEN==='function') fen = g.getFEN();
          else if (typeof g.fen==='function') fen = g.fen();
          if (fenIsValid(fen)) return fen;
        }
      }
    } catch(e) {}
    const fen = getFenFromDOM();
    return fenIsValid(fen) ? fen : null;
  }

  function getFenFromDOM() {
    try {
      const boardEl = document.querySelector('chess-board') ||
                      document.querySelector('wc-chess-board') ||
                      document.querySelector('.board');
      if (!boardEl) return null;

      const pieces = boardEl.querySelectorAll('[class*="piece "]');
      if (!pieces.length) return null;

      const grid = Array.from({length:8},()=>Array(8).fill(null));
      const PM   = {wp:'P',wr:'R',wn:'N',wb:'B',wq:'Q',wk:'K',bp:'p',br:'r',bn:'n',bb:'b',bq:'q',bk:'k'};
      const flip = boardEl.classList.contains('flipped');

      pieces.forEach(el => {
        if (el.classList.contains('dragging')) return;
        if (el.style.transition && el.style.transform && el.style.transform !== 'none') return;
        const cls = el.className || '';
        const sq  = cls.match(/square-(\d)(\d)/);
        if (!sq) return;
        let file = parseInt(sq[1])-1;
        let rank = parseInt(sq[2])-1;
        if (flip) { file=7-file; rank=7-rank; }
        const row = 7-rank;
        for (const [k,v] of Object.entries(PM)) {
          if (cls.includes(' '+k) || cls.includes(k+' ')) {
            if (row>=0&&row<8&&file>=0&&file<8) grid[row][file]=v;
            break;
          }
        }
      });

      let fen = '';
      for (let r=0;r<8;r++) {
        let e=0;
        for (let c=0;c<8;c++) {
          if (grid[r][c]) { if(e){fen+=e;e=0;} fen+=grid[r][c]; } else e++;
        }
        if(e) fen+=e;
        if(r<7) fen+='/';
      }

      const activeClock = document.querySelector('.clock-bottom.clock-player-turn') ||
                          document.querySelector('[class*="clock-bottom"][class*="player-turn"]');
      const turn = activeClock ? (flip?'b':'w') : (flip?'w':'b');
      return fen + ' ' + turn + ' KQkq - 0 1';
    } catch(e) { return null; }
  }

  function getTurn(fen) { return fen ? (fen.split(' ')[1]||'w') : 'w'; }

  function detectPlayerColor() {
    try {
      const b = document.querySelector('chess-board') || document.querySelector('wc-chess-board');
      if (b) {
        if (b.myColor) return b.myColor === 'black' ? 'b' : 'w';
        if (b.playerColor) return b.playerColor === 'black' ? 'b' : 'w';
        const g = b.game || b._game;
        if (g) {
          if (typeof g.getPlayingAs === 'function') {
            const c = g.getPlayingAs();
            if (c === 1) return 'w';
            if (c === 2) return 'b';
          }
          if (typeof g.myColor !== 'undefined') return g.myColor === 2 ? 'b' : 'w';
        }
        if (b.classList.contains('flipped')) return 'b';
        const flip = b.classList.contains('flipped');
        const pieces = b.querySelectorAll('[class*="piece"]');
        let wKingRow = -1, bKingRow = -1;
        pieces.forEach(el => {
          const cls = el.className || '';
          const sq = cls.match(/square-(\d)(\d)/);
          if (!sq) return;
          const rank = parseInt(sq[2]) - 1;
          const row = flip ? rank : 7 - rank;
          if (cls.match(/\bwk\b/)) wKingRow = row;
          if (cls.match(/\bbk\b/)) bKingRow = row;
        });
        if (wKingRow >= 5) return 'w';
        if (bKingRow >= 5) return 'b';
      }
    } catch(e) {}
    return 'w';
  }

  // ══════════════════════════════════════════════
  // CANVAS ET FLÈCHES
  // ══════════════════════════════════════════════
  function getBoard() {
    return document.querySelector('chess-board') ||
           document.querySelector('wc-chess-board') ||
           document.querySelector('.board-layout-chessboard') ||
           document.querySelector('.board');
  }

  function getOrCreateCanvas(id, zIndex) {
    const b = getBoard();
    if (!b) return null;
    let c = document.getElementById(id);
    if (c && c.parentElement !== b) { c.remove(); c=null; }
    if (!c) {
      c = document.createElement('canvas');
      c.id = id;
      c.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:${zIndex};`;
      b.style.position = b.style.position || 'relative';
      b.appendChild(c);
    }
    return c;
  }

  function clearCanvas(who) {
    const map = { my:['cc-canvas-my'], foe:['cc-canvas-foe'], all:['cc-canvas-my','cc-canvas-foe'] };
    (map[who]||[]).forEach(id => {
      const c = document.getElementById(id);
      if (c) c.getContext('2d').clearRect(0,0,c.width,c.height);
    });
  }

  function drawArrow(canvasId, zIndex, uci, color) {
    const c = getOrCreateCanvas(canvasId, zIndex);
    if (!c || !uci || uci.length<4) return;
    const b = getBoard();
    if (!b) return;
    const rect = b.getBoundingClientRect();
    c.width=rect.width; c.height=rect.height;
    const flipped = b.classList.contains('flipped');
    const sqSize  = rect.width / 8;

    function center(sq) {
      const file = sq.charCodeAt(0)-97;
      const rank = parseInt(sq[1])-1;
      const col  = flipped ? 7-file : file;
      const row  = flipped ? rank   : 7-rank;
      return { x:(col+.5)*sqSize, y:(row+.5)*sqSize };
    }

    const from  = center(uci.substring(0,2));
    const to    = center(uci.substring(2,4));
    const angle = Math.atan2(to.y-from.y, to.x-from.x);
    const sh    = ARROW_HEAD+4;
    const ex    = to.x - Math.cos(angle)*sh;
    const ey    = to.y - Math.sin(angle)*sh;

    const ctx = c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);
    ctx.save();
    ctx.strokeStyle=color; ctx.fillStyle=color;
    ctx.lineWidth=ARROW_WIDTH; ctx.lineCap='round';
    ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.moveTo(from.x,from.y); ctx.lineTo(ex,ey); ctx.stroke();
    ctx.beginPath(); ctx.translate(to.x,to.y); ctx.rotate(angle);
    ctx.moveTo(-ARROW_HEAD,-ARROW_HEAD*.6); ctx.lineTo(0,0); ctx.lineTo(-ARROW_HEAD,ARROW_HEAD*.6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ══════════════════════════════════════════════
  // BARRE D'ÉVALUATION
  // ══════════════════════════════════════════════
  function updateEvalBar(score, mate, turn) {
    if (!showEvalBar) return;
    const wEl = document.getElementById('cc-eval-white');
    const sEl = document.getElementById('cc-eval-score');
    if (!wEl || !sEl) return;

    let cpWhite;
    if (mate !== null) {
      const matingColor = mate > 0 ? turn : (turn==='w'?'b':'w');
      cpWhite = matingColor === 'w' ? 99999 : -99999;
    } else {
      cpWhite = turn === 'w' ? score : -score;
    }

    const sigmoid = (x) => 1 / (1 + Math.exp(-x / 250));
    const pct = mate !== null
      ? (cpWhite > 0 ? 100 : 0)
      : Math.round(sigmoid(cpWhite) * 100);

    wEl.style.width = pct + '%';

    let label;
    if (mate !== null) {
      label = (cpWhite > 0 ? '+' : '-') + 'M' + Math.abs(mate);
    } else {
      const p = (Math.abs(cpWhite) / 100).toFixed(1);
      label = cpWhite > 30 ? '+' + p : cpWhite < -30 ? '-' + p : '= ' + p;
    }
    sEl.textContent = label;
    sEl.style.color = pct > 60 ? '#1a1a1a' : '#ffffff';
  }

  // ══════════════════════════════════════════════
  // AUTO-PLAY
  // ══════════════════════════════════════════════
  function squareCoords(sq) {
    const b = getBoard();
    if (!b) return null;
    const rect = b.getBoundingClientRect();
    const flip = b.classList.contains('flipped');
    const size = rect.width / 8;
    const file = sq.charCodeAt(0)-97;
    const rank = parseInt(sq[1])-1;
    const col  = flip ? 7-file : file;
    const row  = flip ? rank   : 7-rank;
    return { x:rect.left+(col+.5)*size, y:rect.top+(row+.5)*size };
  }

  function fire(el, type, x, y) {
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const opts = {
      bubbles:true, cancelable:true,
      clientX:x, clientY:y, screenX:x, screenY:y,
      view:win,
      buttons:(type==='mousedown'||type==='mousemove')?1:0, button:0
    };
    try { el.dispatchEvent(new PointerEvent(type.replace('mouse','pointer'), opts)); } catch(e){}
    el.dispatchEvent(new MouseEvent(type, opts));
  }

  async function autoPlayMove(uci) {
    if (isPlaying) return;
    const fenCheck = getFen();
    if (!fenCheck || getTurn(fenCheck) !== playerColor) return;
    isPlaying = true;

    const from  = uci.substring(0,2);
    const to    = uci.substring(2,4);
    const promo = uci[4] || null;

    // Délai variable pour simuler la réflexion humaine
    // En mode humain : délai plus long et plus variable
    // En mode normal : parfois très rapide (coup évident), parfois plus long (réflexion)
    let delay;
    if (humanModeOn) {
      const cfg = HUMAN_LEVELS[humanLevel];
      const base = cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin);
      delay = Math.random() < cfg.thinkChance ? base + cfg.thinkExtra + Math.random() * cfg.thinkExtra : base;
    } else {
      // Mode normal : délai constant entre PLAY_DELAY_MIN et PLAY_DELAY_MAX
      delay = PLAY_DELAY_MIN + Math.random() * (PLAY_DELAY_MAX - PLAY_DELAY_MIN);
    }
    await new Promise(r => setTimeout(r, delay));
    if (!autoPlayOn || !coachOn) { isPlaying=false; return; }
    const fenAfterDelay = getFen();
    if (!fenAfterDelay || getTurn(fenAfterDelay) !== playerColor) { isPlaying=false; return; }

    const fp = squareCoords(from);
    const tp = squareCoords(to);
    if (!fp || !tp) { isPlaying=false; return; }

    const board = getBoard();
    const body  = document.body;
    lastPlayedFen = getFen() || '';

    if (promo) {
      fire(board,'mousedown',fp.x,fp.y);
      await new Promise(r=>setTimeout(r,60));
      fire(board,'mouseup',fp.x,fp.y);
      fire(board,'click',fp.x,fp.y);
      await new Promise(r=>setTimeout(r,150));
      fire(board,'mousedown',tp.x,tp.y);
      await new Promise(r=>setTimeout(r,60));
      fire(board,'mouseup',tp.x,tp.y);
      fire(board,'click',tp.x,tp.y);

      let pEl = null;
      const promoLetter = promo.toLowerCase();
      const pieceClass  = playerColor + promoLetter;

      const PROMO_SELECTORS = [
        `.promotion-window--visible .promotion-piece.${pieceClass}`,
        `.promotion-window .promotion-piece.${pieceClass}`,
        `[class*="promotion"] [class*="${pieceClass}"]`,
        `[class*="promotion"] [data-piece="${pieceClass}"]`,
        `[class*="promotion-piece"]:not([style*="display:none"])`,
      ];

      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(r => setTimeout(r, 100));
        if (!autoPlayOn || !coachOn) { isPlaying=false; return; }
        for (const sel of PROMO_SELECTORS) {
          try {
            const candidates = document.querySelectorAll(sel);
            for (const c of candidates) {
              const ORDER = ['q','r','b','n'];
              if (sel.includes('promotion-piece') && !sel.includes(pieceClass)) {
                const allPieces = [...document.querySelectorAll('[class*="promotion-piece"]:not([style*="display:none"])')];
                const idx = ORDER.indexOf(promoLetter);
                if (idx >= 0 && allPieces[idx]) { pEl = allPieces[idx]; break; }
              } else { pEl = c; break; }
            }
          } catch(e) {}
          if (pEl) break;
        }
        if (pEl) break;
      }

      if (!autoPlayOn || !coachOn) { isPlaying=false; return; }

      if (pEl) {
        const rect = pEl.getBoundingClientRect();
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        try {
          pEl.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, clientX:cx, clientY:cy, isPrimary:true}));
          pEl.dispatchEvent(new PointerEvent('pointerup',   {bubbles:true, cancelable:true, clientX:cx, clientY:cy, isPrimary:true}));
        } catch(e) {}
        pEl.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:win, clientX:cx, clientY:cy}));
        await new Promise(r => setTimeout(r, 80));
        pEl.dispatchEvent(new MouseEvent('mouseup',   {bubbles:true, cancelable:true, view:win, clientX:cx, clientY:cy}));
        pEl.dispatchEvent(new MouseEvent('click',     {bubbles:true, cancelable:true, view:win, clientX:cx, clientY:cy}));
        // Attendre plus longtemps après une promotion — l'animation est plus longue
        await new Promise(r => setTimeout(r, 800));
      } else {
        setStatus('⚠ Promo manuelle requise (sélecteur introuvable)');
        await new Promise(r => setTimeout(r, 10000));
      }

      // Après une promotion : reset immédiat pour que le scan reprenne normalement
      autoPlayRetries = 0;
      lastPlayedFen = '';
      lastFen = '';

    } else {
      fire(board,'mousedown',fp.x,fp.y);
      await new Promise(r=>setTimeout(r,80));
      for (let i=1;i<=8;i++) {
        fire(body,'mousemove', fp.x+(tp.x-fp.x)*i/8, fp.y+(tp.y-fp.y)*i/8);
        await new Promise(r=>setTimeout(r,15));
      }
      fire(body,'mouseup',tp.x,tp.y);
      fire(board,'mouseup',tp.x,tp.y);
      await new Promise(r=>setTimeout(r,350));

      const fenAfterDrag = getFen();
      const dragWorked   = fenAfterDrag && fenAfterDrag !== lastPlayedFen;

      if (!dragWorked) {
        await new Promise(r=>setTimeout(r,200));
        fire(board,'mousedown',fp.x,fp.y); fire(board,'mouseup',fp.x,fp.y); fire(board,'click',fp.x,fp.y);
        await new Promise(r=>setTimeout(r,150));
        fire(board,'mousedown',tp.x,tp.y); fire(board,'mouseup',tp.x,tp.y); fire(board,'click',tp.x,tp.y);
        await new Promise(r=>setTimeout(r,350));
      }
    }

    // Pour les promotions : on a déjà vidé lastFen et lastPlayedFen, on skip la vérif post-coup
    if (!promo) {
      const newFen = getFen();
      if (newFen && newFen === lastPlayedFen && autoPlayOn && coachOn) {
        autoPlayRetries++;
        if (autoPlayRetries <= MAX_RETRIES) {
          isPlaying = false;
          lastFen   = '';
          return;
        } else {
          autoPlayRetries = 0;
          autoPlayOn = false;
          const btn = document.getElementById('cc-autoplay');
          if (btn) { btn.textContent='🤖 Auto-play OFF'; btn.style.background='#2b1a1a'; btn.style.color='#e05555'; btn.style.borderColor='#4a2222'; }
          setStatus('⚠ Auto-play arrêté (coup impossible)');
        }
      } else {
        autoPlayRetries = 0;
        if (newFen) lastFen = newFen;
      }
    }

    isPlaying = false;
    if (!promo) {
      analysing = true;
      await new Promise(r=>setTimeout(r, 1500));
      analysing = false;
    }
    // Après une promotion : isPlaying=false immédiatement, lastFen='' déjà fait, scan reprend au prochain tick
  }

  // ══════════════════════════════════════════════
  // SCAN LOOP
  // ══════════════════════════════════════════════
  async function scanAndAnalyse() {
    if (!coachOn) return;

    const fen = getFen();
    if (!fen) return;

    const turn = getTurn(fen);
    const detectedColor = detectPlayerColor();
    if (detectedColor !== playerColor) {
      playerColor = detectedColor;
      lastFen = '';
    }
    const enemyColor = playerColor === 'w' ? 'b' : 'w';

    // ── Détection nouvelle partie ─────────────────
    const fullmove = getFullmoveNumber(fen);
    if (lastFullmoveTracked > 1 && fullmove <= 1) {
      resetPrecision();
      setPrecStatus('Nouvelle partie détectée');
    }
    lastFullmoveTracked = fullmove;

    // ── Tour de l'ennemi ──────────────────────────
    if (turn === enemyColor) {
      if (fen !== lastEnemyFen) {
        lastEnemyFen = fen;
        clearCanvas('my');
        const bm = document.getElementById('cc-bestmove');
        if (bm) bm.textContent = '⏳ Adversaire…';
        setStatus('Attente adversaire…');

        // Stocker la position après notre coup pour le calcul batch
        if (prevOurFen && fullmove > PRECISION_START_MOVE && precisionEnabled) {
          const playedMove = getLastPlayedMoveUci();
          // En mode humain, on compare toujours le coup joué au coup suggéré
          // (autoPlayOn seul ne suffit pas car le mode humain joue parfois un coup différent)
          const followedStockfish = (autoPlayOn && !humanModeOn) ||
            (lastSuggestedUci && playedMove &&
             playedMove.toLowerCase().startsWith(lastSuggestedUci.substring(0,4).toLowerCase()));
          ourFenHistory.push({
            fenBefore: prevOurFen,
            fenAfter: fen,
            followedStockfish,
            calculated: false
          });
          prevOurFen = null;
          // Stocker aussi pour l'ennemi (fenBefore = position actuelle, fenAfter = après son coup)
          prevEnemyFen = fen;

          // Lancer le calcul en arrière-plan après chaque coup
          runBatchPrecision();
        }
      }
      return;
    }

    // ── Notre tour ────────────────────────────────
    const fenPos  = fen.split(' ')[0] + ' ' + fen.split(' ')[1];
    const lastPos = lastFen.split(' ')[0] + ' ' + lastFen.split(' ')[1];
    if (fenPos === lastPos && !analysing) return;
    if (analysing) return;

    lastFen   = fen;
    analysing = true;
    clearCanvas('my');
    const bmEl = document.getElementById('cc-bestmove');
    if (bmEl) bmEl.textContent = '⏳…';

    const level = getLevel();
    setStatus('⏳ Niv.' + level + '…');

    const watchdog = setTimeout(() => {
      if (analysing) {
        analysing = false;
        lastFen = '';
        setStatus('⚠ Analyse timeout — nouvelle tentative…');
      }
    }, 22000);

    const result = await analyse(fen);
    clearTimeout(watchdog);
    analysing = false;

    if (!coachOn) return;
    if (!result || !result.uci) { setStatus('Aucun coup trouvé'); return; }

    const fenNow = getFen();
    if (!fenNow || getTurn(fenNow) !== playerColor) return;

    // Stocker le FEN après le coup ennemi pour le calcul batch
    if (prevEnemyFen && fullmove > PRECISION_START_MOVE && precisionEnabled) {
      enemyFenHistory.push({
        fenBefore: prevEnemyFen,
        fenAfter: fen,
        calculated: false
      });
      prevEnemyFen = null;
    }

    // Stocker le FEN avant notre prochain coup
    prevOurFen = fen;

    lastSuggestedUci = result.uci; // mémorise le coup suggéré pour la précision

    drawArrow('cc-canvas-my', 9998, result.uci, ARROW_MY_COLOR);
    const f  = result.uci.substring(0,2).toUpperCase();
    const t  = result.uci.substring(2,4).toUpperCase();
    const pr = result.uci[4] ? '=' + result.uci[4].toUpperCase() : '';
    const bm = document.getElementById('cc-bestmove');

    // Affiche le mat — uniquement si mat détecté en ≤ 10 coups
    const isMateForUs   = result.mate !== null && result.mate > 0 && result.mate <= 10;
    const isMateForThem = result.mate !== null && result.mate < 0 && Math.abs(result.mate) <= 10;

    if (isMateForUs || isMateForThem) {
      const mateIn = Math.abs(result.mate);
      const mateWho = isMateForUs ? '☠ Mat en ' : '⚠ Mat en ';
      const mateSuffix = isMateForUs ? ' coup' + (mateIn > 1 ? 's' : '') : ' (adverse)';
      if (bm) {
        bm.textContent = mateWho + mateIn + mateSuffix + '\n' + f + ' → ' + t + pr;
        bm.style.whiteSpace = 'pre-line';
        bm.style.color = isMateForUs ? '#00c878' : '#e05555';
        bm.style.borderColor = isMateForUs ? 'rgba(0,200,120,0.5)' : 'rgba(224,85,85,0.5)';
        bm.style.background = isMateForUs ? 'rgba(0,200,120,0.15)' : 'rgba(224,85,85,0.1)';
      }
    } else {
      if (bm) {
        bm.style.whiteSpace = '';
        bm.textContent = f + ' → ' + t + pr;
        bm.style.color = '#00c878';
        bm.style.borderColor = 'rgba(0,200,120,0.3)';
        bm.style.background = 'rgba(0,200,120,0.1)';
      }
    }

    updateEvalBar(result.score, result.mate, turn);

    const eng = serverOk ? 'LOCAL' : 'WASM';
    const sc  = result.mate !== null
      ? 'M' + Math.abs(result.mate)
      : (result.score >= 0 ? '+' : '-') + (Math.abs(result.score) / 100).toFixed(1);
    setStatus(eng + ' Niv.' + level + ' · ' + sc + (autoPlayOn ? ' · 🤖' : ''));

    if (autoPlayOn && !isPlaying && getTurn(getFen()) === playerColor) {
      await autoPlayMove(result.uci);
    }
  }

  // ══════════════════════════════════════════════
  // TOGGLES
  // ══════════════════════════════════════════════
  function resetState() {
    coachOn       = false;
    autoPlayOn    = false;
    analysing     = false;
    enemyAnalysing = false;
    isPlaying     = false;
    lastFen       = '';
    lastEnemyFen  = '';
    lastPlayedFen = '';
    autoPlayRetries = 0;
    clearInterval(scanTimer);
    scanTimer = null;
    // On ne reset PAS la précision ici, pour qu'elle reste visible après la partie
    // resetPrecision() est appelé uniquement à la détection d'une nouvelle partie
  }

  async function toggleCoach() {
    const btn = document.getElementById('cc-toggle');
    if (coachOn) {
      resetState();
      clearCanvas('all');

      btn.textContent='▶ Coach OFF'; btn.style.background='#1c3a52'; btn.style.color='#5bc8f5';
      const ab=document.getElementById('cc-autoplay');
      if(ab){ ab.textContent='🤖 Auto-play OFF'; ab.style.background='#2b1a1a'; ab.style.color='#e05555'; ab.style.borderColor='#4a2222'; }
      const bm=document.getElementById('cc-bestmove'); if(bm) bm.textContent='—';
      const ew=document.getElementById('cc-eval-white'); if(ew) ew.style.width='50%';
      const es=document.getElementById('cc-eval-score'); if(es) es.textContent='= 0.0';
      setStatus('Coach désactivé');

      // Lancer le calcul batch final sur tous les coups restants
      coachOn = true; // temporairement pour que runBatchPrecision ne soit pas interrompu
      await runBatchPrecision(true);
      coachOn = false;

      // Afficher la précision finale
      const usAcc = avgAccuracy(precisionHistory);
      if (usAcc !== null) {
        setPrecStatus('✅ Résultats finaux — ' + precisionHistory.length + ' coup' + (precisionHistory.length > 1 ? 's' : ''));
        updatePrecisionDisplay();
      } else {
        setPrecStatus('');
      }

    } else {
      setStatus('Connexion…');
      resetState();
      await updateServerDot();
      if (!serverOk && !sfReady) { setStatus('⚠ Aucun moteur disponible !'); return; }

      coachOn   = true;
      lastFen   = '';
      analysing = false;
      btn.textContent='⏹ Coach ON'; btn.style.background='#0d2b1a'; btn.style.color='#00c878';

      // Reset précision seulement si pas de données (nouvelle session)
      if (precisionHistory.length === 0) {
        setPrecStatus('Analyse en cours…');
      } else {
        setPrecStatus('Reprise — ' + precisionHistory.length + ' coup' + (precisionHistory.length > 1 ? 's' : ''));
      }

      const safetyInterval = setInterval(() => {
        if (!coachOn) { clearInterval(safetyInterval); return; }
      }, 25000);

      scanAndAnalyse();
      scanTimer = setInterval(scanAndAnalyse, SCAN_INTERVAL);
    }
  }

  async function toggleAutoPlay() {
    if (!coachOn) { await toggleCoach(); if(!coachOn) return; }
    autoPlayOn = !autoPlayOn;
    const btn = document.getElementById('cc-autoplay');
    if (autoPlayOn) {
      isPlaying=false; autoPlayRetries=0; lastFen='';
      btn.textContent='🤖 Auto ON'; btn.style.background='#2b0d0d'; btn.style.color='#ff6b6b'; btn.style.borderColor='#ff4444';
      setStatus('🤖 Auto-play actif !');
      scanAndAnalyse();
    } else {
      isPlaying=false; autoPlayRetries=0;
      btn.textContent='🤖 Auto OFF'; btn.style.background='#2b1a1a'; btn.style.color='#e05555'; btn.style.borderColor='#4a2222';
      setStatus('Auto-play désactivé');
    }
  }

  function toggleHumanMode() {
    humanModeOn = !humanModeOn;
    const btn = document.getElementById('cc-humanmode');
    const names = { 1: '~1500', 2: '~2000', 3: '~2500', 4: 'Délai naturel' };
    if (humanModeOn) {
      btn.textContent = '🎭 Humain ON — ' + names[humanLevel] + ' elo';
      btn.style.background = '#1a2a0d';
      btn.style.color = '#7ec850';
      btn.style.borderColor = '#4a7a2a';
      setStatus('🎭 Mode humain Niv.' + humanLevel + ' (' + names[humanLevel] + ' elo)');
    } else {
      btn.textContent = '🎭 Mode Humain OFF';
      btn.style.background = '#0d1a0d';
      btn.style.color = '#5a8a5a';
      btn.style.borderColor = '#2a3a2a';
      setStatus('Mode humain désactivé');
    }
  }

  // ══════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════
  function init() {
    buildPanel();
    initWasm();
    updateServerDot();

    // Auto-rematch indépendant du coach
    setInterval(() => {
      if (!autoRematchOn) return;
      const allBtns = Array.from(document.querySelectorAll('button'));
      const rematchBtn = allBtns.find(b => {
        const txt = b.textContent.trim().toLowerCase();
        return txt.includes('rejouer') || txt.includes('revanche') ||
               txt.includes('rematch') || txt.includes('nouvelle en');
      }) || document.querySelector('button[data-cy="rematch-button"],button[data-cy="new-game-button"]');
      if (rematchBtn && !rematchBtn.disabled) {
        setStatus('🔄 Nouvelle partie dans 3s…');
        const wasEnabled = autoRematchOn;
        autoRematchOn = false; // bloquer les re-détections pendant le délai
        setTimeout(() => {
          // Relire la checkbox au moment du clic — pas la valeur au moment de la détection
          const chk = document.getElementById('cc-rematch-toggle');
          autoRematchOn = chk ? chk.checked : wasEnabled;
          if (autoRematchOn) {
            rematchBtn.click();
            lastFen = '';
          }
        }, 3000);
      }
    }, 1500);
    setInterval(async () => {
      const wasOk = serverOk;
      await updateServerDot();
      if (!wasOk && serverOk && coachOn) {
        lastFen = '';
        setStatus('Serveur reconnecté ✓');
      }
    }, 10000);
    window.addEventListener('resize', () => { if (coachOn) clearCanvas('all'); });
  }

  if (document.readyState==='complete') setTimeout(init, 1500);
  else window.addEventListener('load', () => setTimeout(init, 1500));

})();
