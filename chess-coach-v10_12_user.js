// ==UserScript==
// @name         ♟ Chess Coach — Stockfish
// @namespace    chess-coach-pub
// @version      10.12
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

  // ══════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════
  let coachOn      = false;
  let autoPlayOn   = false;
  let showEnemyOn  = false;
  let showEvalBar  = true;
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

  // ── PRÉCISION ──────────────────────────────────
  let precisionHistory      = [];
  let enemyPrecisionHistory = [];
  let bestScoreBeforeOurMove   = null; // meilleur score possible AVANT notre coup (cp, point de vue nous)
  let bestScoreBeforeEnemyMove = null; // meilleur score possible AVANT le coup ennemi (cp, point de vue ennemi)
  let lastFullmoveTracked   = 0;

  // WASM fallback
  let sf = null, sfReady = false, sfResolve = null, sfLines = [];

  // ══════════════════════════════════════════════
  // PRÉCISION — CALCUL
  // ══════════════════════════════════════════════

  // Formule chess.com : centipawn loss → précision %
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

    // Texte du compteur de coups
    const movEl = document.getElementById('cc-prec-moves');
    if (movEl) movEl.textContent = moves > 0 ? moves + ' coup' + (moves > 1 ? 's analysés' : ' analysé') : '–';

    // Notre précision
    const usEl  = document.getElementById('cc-prec-us');
    const usBar = document.getElementById('cc-prec-bar-us');
    if (usEl) {
      if (usAcc !== null) {
        usEl.textContent  = usAcc.toFixed(1) + '%';
        usEl.style.color  = accuracyColor(usAcc);
        if (usBar) { usBar.style.width = usAcc + '%'; usBar.style.background = accuracyColor(usAcc); }
      } else {
        usEl.textContent = '—';
        usEl.style.color = '#7a9ab5';
        if (usBar) { usBar.style.width = '0%'; }
      }
    }

    // Précision ennemie
    const themEl  = document.getElementById('cc-prec-them');
    const themBar = document.getElementById('cc-prec-bar-them');
    if (themEl) {
      if (themAcc !== null) {
        themEl.textContent  = themAcc.toFixed(1) + '%';
        themEl.style.color  = accuracyColor(themAcc);
        if (themBar) { themBar.style.width = themAcc + '%'; themBar.style.background = accuracyColor(themAcc); }
      } else {
        themEl.textContent = '—';
        themEl.style.color = '#7a9ab5';
        if (themBar) { themBar.style.width = '0%'; }
      }
    }

    // Badge emoji
    const usBadge   = document.getElementById('cc-prec-badge-us');
    const themBadge = document.getElementById('cc-prec-badge-them');
    if (usBadge)   usBadge.textContent   = accuracyEmoji(usAcc);
    if (themBadge) themBadge.textContent = accuracyEmoji(themAcc);
  }

  function resetPrecision() {
    precisionHistory         = [];
    enemyPrecisionHistory    = [];
    bestScoreBeforeOurMove   = null;
    bestScoreBeforeEnemyMove = null;
    lastFullmoveTracked      = 0;
    updatePrecisionDisplay();
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
      <div id="cc-header" style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(255,255,255,0.04);border-bottom:1px solid #2a3f55;cursor:move;">
        <span style="font-size:18px;">♟</span>
        <span style="font-size:13px;font-weight:700;letter-spacing:.5px;flex:1;">CHESS COACH</span>
        <span id="cc-engine-lbl" style="font-size:9px;color:#4a6a85;margin-right:4px;font-weight:700;">WASM</span>
        <span id="cc-server-dot" style="width:8px;height:8px;border-radius:50%;background:#e74c3c;flex-shrink:0;transition:background .4s;" title="Serveur local"></span>
      </div>

      <div style="padding:12px 14px 4px;">
        <button id="cc-toggle" style="width:100%;padding:8px;border:none;border-radius:7px;background:#1c3a52;color:#5bc8f5;font-size:13px;font-weight:700;letter-spacing:.5px;cursor:pointer;transition:all .2s;">▶ Coach OFF</button>
      </div>

      <div style="padding:4px 14px 4px;">
        <button id="cc-autoplay" style="width:100%;padding:8px;border:1px solid #4a2222;border-radius:7px;background:#2b1a1a;color:#e05555;font-size:13px;font-weight:700;letter-spacing:.5px;cursor:pointer;transition:all .2s;">🤖 Auto-play OFF</button>
      </div>

      <div style="padding:8px 14px 6px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#7a9ab5;margin-bottom:4px;">
          <span>Niveau Stockfish</span><span id="cc-lvl-val" style="color:#5bc8f5;font-weight:700;">10</span>
        </div>
        <input id="cc-level" type="range" min="1" max="20" value="10" style="width:100%;accent-color:#5bc8f5;cursor:pointer;">
      </div>

      <div style="padding:0 14px 6px;display:flex;flex-direction:column;gap:5px;">
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:11px;color:#7a9ab5;">
          <input id="cc-eval-toggle" type="checkbox" checked style="accent-color:#5bc8f5;cursor:pointer;width:13px;height:13px;">
          <span>Barre d'évaluation</span>
        </label>
      </div>

      <div id="cc-eval-bar-wrap" style="padding:2px 14px 6px;">
        <div style="width:100%;height:16px;border-radius:4px;overflow:hidden;border:1px solid #2a3f55;position:relative;background:#1a1a1a;">
          <div id="cc-eval-white" style="position:absolute;left:0;top:0;bottom:0;width:50%;background:#e8d5b0;transition:width .5s cubic-bezier(.4,0,.2,1);"></div>
          <div id="cc-eval-score" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.95);">= 0.0</div>
        </div>
      </div>

      <div style="padding:2px 14px 4px;">
        <div style="font-size:10px;color:#7a9ab5;margin-bottom:3px;">Votre meilleur coup</div>
        <div id="cc-bestmove" style="background:rgba(0,200,120,0.1);border:1px solid rgba(0,200,120,0.3);border-radius:5px;padding:5px 10px;font-size:14px;font-weight:700;color:#00c878;letter-spacing:.5px;text-align:center;min-height:26px;">—</div>
      </div>

      <!-- ══ SECTION PRÉCISION ══ -->
      <div style="margin:6px 14px 0;border-top:1px solid #1e3348;"></div>

      <div id="cc-precision-section" style="padding:8px 14px 10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;">
          <span style="font-size:10px;font-weight:700;color:#7a9ab5;letter-spacing:.5px;">⚡ PRÉCISION</span>
          <span id="cc-prec-moves" style="font-size:9px;color:#4a6a85;font-weight:600;background:rgba(255,255,255,0.04);padding:2px 6px;border-radius:10px;">–</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;">

          <!-- Nous -->
          <div style="background:rgba(255,255,255,0.03);border:1px solid #1e3348;border-radius:8px;padding:7px 6px 6px;text-align:center;position:relative;overflow:hidden;">
            <div style="font-size:9px;color:#7a9ab5;margin-bottom:3px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;">Vous</div>
            <div style="display:flex;align-items:center;justify-content:center;gap:3px;">
              <span id="cc-prec-us" style="font-size:17px;font-weight:800;color:#7a9ab5;line-height:1;">—</span>
              <span id="cc-prec-badge-us" style="font-size:12px;line-height:1;"></span>
            </div>
            <div style="margin-top:5px;height:3px;border-radius:2px;background:rgba(255,255,255,0.06);overflow:hidden;">
              <div id="cc-prec-bar-us" style="height:100%;width:0%;border-radius:2px;transition:width .6s ease,background .4s;background:#7a9ab5;"></div>
            </div>
          </div>

          <!-- Adversaire -->
          <div style="background:rgba(255,255,255,0.03);border:1px solid #1e3348;border-radius:8px;padding:7px 6px 6px;text-align:center;position:relative;overflow:hidden;">
            <div style="font-size:9px;color:#7a9ab5;margin-bottom:3px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;">Adverse</div>
            <div style="display:flex;align-items:center;justify-content:center;gap:3px;">
              <span id="cc-prec-them" style="font-size:17px;font-weight:800;color:#7a9ab5;line-height:1;">—</span>
              <span id="cc-prec-badge-them" style="font-size:12px;line-height:1;"></span>
            </div>
            <div style="margin-top:5px;height:3px;border-radius:2px;background:rgba(255,255,255,0.06);overflow:hidden;">
              <div id="cc-prec-bar-them" style="height:100%;width:0%;border-radius:2px;transition:width .6s ease,background .4s;background:#7a9ab5;"></div>
            </div>
          </div>

        </div>

        <div id="cc-prec-status" style="font-size:9px;color:#3a5a75;text-align:center;margin-top:5px;font-style:italic;min-height:12px;"></div>
      </div>

      <div id="cc-status" style="padding:4px 14px 10px;font-size:10px;color:#4a6a85;text-align:center;font-style:italic;">Initialisation…</div>
    `;

    document.body.appendChild(p);
    makeDraggable(p, p.querySelector('#cc-header'));

    const slider = p.querySelector('#cc-level');
    const sliderVal = p.querySelector('#cc-lvl-val');
    slider.addEventListener('input', () => { sliderVal.textContent = slider.value; });

    p.querySelector('#cc-toggle').addEventListener('click', toggleCoach);
    p.querySelector('#cc-autoplay').addEventListener('click', toggleAutoPlay);

    p.querySelector('#cc-eval-toggle').addEventListener('change', e => {
      showEvalBar = e.target.checked;
      const wrap = document.getElementById('cc-eval-bar-wrap');
      if (wrap) wrap.style.display = showEvalBar ? '' : 'none';
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
    return new Promise(resolve => {
      const skill = level >= 20 ? 20 : Math.max(0, level-1);
      const depth = level >= 20 ? 40 : Math.min(20, Math.max(8, Math.round(6+level*0.8)));
      const timeout = level >= 20 ? 35000 : 15000;
      GM_xmlhttpRequest({
        method:'POST', url:SERVER+'/analyse',
        headers:{'Content-Type':'application/json'},
        data: JSON.stringify({fen, depth, skill, multipv:1}),
        timeout: timeout,
        onload: r => {
          try {
            const d   = JSON.parse(r.responseText);
            const pv1 = d.lines?.['1'] || d.lines?.[1];
            const uci = pv1?.uci || d.bestmove;
            if (!uci) { resolve(null); return; }
            const st    = pv1?.score_type || 'cp';
            const sv    = parseInt(pv1?.score) || 0;
            const mate  = st==='mate' ? sv : null;
            const score = st==='cp'   ? sv : (sv>0?99999:-99999);
            resolve({uci, score, mate});
          } catch(e) {
            serverOk = false;
            updateEngineLabel();
            resolve(null);
          }
        },
        onerror:  () => { serverOk=false; updateEngineLabel(); if(coachOn) setStatus('Serveur déconnecté → WASM'); resolve(null); },
        ontimeout:() => { serverOk=false; updateEngineLabel(); if(coachOn) setStatus('Serveur timeout → WASM'); resolve(null); },
      });
    });
  }

  // Analyse dédiée à la précision — profondeur fixe 14 pour être cohérente entre tous les coups
  const PREC_DEPTH = 14;
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

  async function analyse(fen) {
    const level = getLevel();
    if (serverOk) {
      const res = await analyseLocal(fen, level);
      if (res && res.uci) return res;
    }
    if (sfReady) return parseWasmResult(await askWasm(fen, level));
    return null;
  }

  // ══════════════════════════════════════════════
  // FEN DETECTION
  // ══════════════════════════════════════════════
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

    await new Promise(r=>setTimeout(r, PLAY_DELAY_MIN + Math.random()*(PLAY_DELAY_MAX-PLAY_DELAY_MIN)));
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
    if (lastFullmoveTracked > 3 && fullmove <= 1) {
      // La partie a recommencé
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

        // ── PRÉCISION NOUS : score avant notre coup vs score après notre coup ──
        // bestScoreBeforeOurMove = meilleur score possible avant qu'on joue (point de vue nous)
        // On analyse maintenant (après notre coup) du point de vue de l'ennemi
        // Score après notre coup (point de vue nous) = -scoreAprès(ennemi)
        // cpLoss = max(0, bestScoreBeforeOurMove - (-scoreAprès))
        //        = max(0, bestScoreBeforeOurMove + scoreAprès(ennemi))
        // Si on a joué le meilleur coup : scoreAprès(ennemi) ≈ -bestScoreBeforeOurMove → cpLoss ≈ 0
        if (bestScoreBeforeOurMove !== null && !enemyAnalysing) {
          enemyAnalysing = true;
          const afterOurMove = await analyseForPrecision(fen);
          enemyAnalysing = false;

          if (afterOurMove && coachOn) {
            let cpLoss;
            if (autoPlayOn && getLevel() >= 20) {
              cpLoss = 0;
            } else if (afterOurMove.mate !== null) {
              cpLoss = afterOurMove.mate > 0 ? 0 : 1000;
            } else {
              // bestScoreBeforeOurMove = meilleur score avant notre coup (point de vue nous, profondeur fixe)
              // afterOurMove.score = score après notre coup (point de vue ennemi, même profondeur)
              // Notre perte = bestAvant(nous) - (-afterOurMove.score)
              //             = bestAvant(nous) + afterOurMove.score
              // Si coup optimal : afterOurMove.score ≈ -bestAvant → cpLoss ≈ 0
              cpLoss = Math.max(0, bestScoreBeforeOurMove + afterOurMove.score);
            }
            precisionHistory.push(cpLoss);
            bestScoreBeforeEnemyMove = afterOurMove.mate !== null ? null : afterOurMove.score;
            updatePrecisionDisplay();
            setPrecStatus('Analyse en cours… ' + precisionHistory.length + ' coup' + (precisionHistory.length > 1 ? 's analysés' : ' analysé'));
          }
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

    // ── PRÉCISION ENNEMI ──
    if (bestScoreBeforeEnemyMove !== null && result.mate === null) {
      // bestScoreBeforeEnemyMove = score après notre coup (point de vue ennemi, profondeur fixe)
      // On compare avec le score après le coup ennemi (point de vue ennemi, profondeur fixe)
      // Score après coup ennemi (point de vue ennemi) = -precResult.score
      const precResult = await analyseForPrecision(fen);
      if (precResult && precResult.mate === null) {
        const scoreAfterEnemy = -precResult.score;
        const enemyCpLoss = Math.max(0, bestScoreBeforeEnemyMove - scoreAfterEnemy);
        enemyPrecisionHistory.push(enemyCpLoss);
        updatePrecisionDisplay();
      }
    }

    // Stocker bestScoreBeforeOurMove avec profondeur fixe pour cohérence
    if (result.mate === null) {
      const precNow = await analyseForPrecision(fen);
      bestScoreBeforeOurMove = (precNow && precNow.mate === null) ? precNow.score : null;
    } else {
      bestScoreBeforeOurMove = null;
    }

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
      btn.textContent='🤖 Auto-play ON'; btn.style.background='#2b0d0d'; btn.style.color='#ff6b6b'; btn.style.borderColor='#ff4444';
      setStatus('🤖 Auto-play actif !');
      scanAndAnalyse();
    } else {
      isPlaying=false; autoPlayRetries=0;
      btn.textContent='🤖 Auto-play OFF'; btn.style.background='#2b1a1a'; btn.style.color='#e05555'; btn.style.borderColor='#4a2222';
      setStatus('Auto-play désactivé');
    }
  }

  // ══════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════
  function init() {
    buildPanel();
    initWasm();
    updateServerDot();
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
