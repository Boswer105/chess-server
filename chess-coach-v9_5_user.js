// ==UserScript==
// @name         ♟ Chess Coach — Stockfish
// @namespace    chess-coach-pub
// @version      9.5
// @description  Analyse Stockfish en temps réel sur chess.com : flèches, évaluation, auto-play
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
  const SCAN_INTERVAL   = 1200;  // légèrement plus long pour laisser les animations finir
  const ARROW_MY_COLOR  = 'rgba(0,200,120,0.9)';
  const ARROW_FOE_COLOR = 'rgba(255,120,60,0.9)';
  const ARROW_HEAD      = 16;
  const ARROW_WIDTH     = 10;
  const PLAY_DELAY_MIN  = 900;
  const PLAY_DELAY_MAX  = 2500;
  const ANIM_WAIT       = 400;   // attend la fin des animations avant de lire le FEN

  // ══════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════
  let coachOn      = false;
  let autoPlayOn   = false;
  let showEnemyOn  = false;
  let showEvalBar  = true;
  let serverOk     = false;
  let lastFen      = '';        // dernier FEN analysé (notre tour)
  let lastEnemyFen = '';        // dernier FEN analysé (tour ennemi)
  let lastPlayedFen = '';       // FEN juste avant qu'on joue (pour détecter si le coup a été accepté)
  let scanTimer    = null;
  let isPlaying    = false;
  let analysing    = false;
  let enemyAnalysing = false;
  let playerColor  = 'w';
  let autoPlayRetries = 0;      // compteur pour relancer si coup rejeté
  const MAX_RETRIES = 3;

  // WASM fallback
  let sf = null, sfReady = false, sfResolve = null, sfLines = [];

  // ══════════════════════════════════════════════
  // PANEL
  // ══════════════════════════════════════════════
  function buildPanel() {
    if (document.getElementById('cc-panel')) return;
    const p = document.createElement('div');
    p.id = 'cc-panel';
    p.style.cssText = `
      position:fixed;bottom:24px;right:24px;z-index:2147483647;width:220px;
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

  function setStatus(msg) { const el=document.getElementById('cc-status'); if(el) el.textContent=msg; }
  function getLevel()     { const el=document.getElementById('cc-level'); return el ? parseInt(el.value) : 10; }

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
            // Erreur de parsing = serveur planté, on bascule sur WASM
            serverOk = false;
            updateEngineLabel();
            resolve(null);
          }
        },
        onerror:  () => {
          // Connexion refusée = serveur planté
          serverOk = false;
          updateEngineLabel();
          if (coachOn) setStatus('Serveur déconnecté → WASM');
          resolve(null);
        },
        ontimeout:() => {
          // Timeout = serveur trop lent ou planté
          serverOk = false;
          updateEngineLabel();
          if (coachOn) setStatus('Serveur timeout → WASM');
          resolve(null);
        },
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

  // ══════════════════════════════════════════════
  // FEN DETECTION
  // ══════════════════════════════════════════════

  // FIX BUG 5 : vérifie que le FEN est valide (bonne structure, au moins les 2 rois)
  function fenIsValid(fen) {
    if (!fen || typeof fen !== 'string') return false;
    const parts = fen.split(' ');
    if (parts.length < 2) return false;
    const rows = parts[0].split('/');
    if (rows.length !== 8) return false;
    // Vérifie qu'il y a exactement 1 roi blanc et 1 roi noir
    const hasWK = parts[0].includes('K');
    const hasBK = parts[0].includes('k');
    if (!hasWK || !hasBK) return false;
    // Vérifie que chaque rangée fait bien 8 cases
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
    // Méthode 1 : API interne chess.com (plus fiable, pas affectée par les animations)
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
    // Méthode 2 : parse DOM (fallback)
    const fen = getFenFromDOM();
    return fenIsValid(fen) ? fen : null;
  }

  function getFenFromDOM() {
    try {
      const boardEl = document.querySelector('chess-board') ||
                      document.querySelector('wc-chess-board') ||
                      document.querySelector('.board');
      if (!boardEl) return null;

      // FIX BUG 5 : ignore les pièces en cours d'animation (elles ont une classe 'dragging' ou transform)
      const pieces = boardEl.querySelectorAll('[class*="piece "]');
      if (!pieces.length) return null;

      const grid = Array.from({length:8},()=>Array(8).fill(null));
      const PM   = {wp:'P',wr:'R',wn:'N',wb:'B',wq:'Q',wk:'K',bp:'p',br:'r',bn:'n',bb:'b',bq:'q',bk:'k'};
      const flip = boardEl.classList.contains('flipped');

      pieces.forEach(el => {
        // Ignore les pièces qui sont en train d'être animées
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

      // Détecte le trait via l'horloge active
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
    const opts = {
      bubbles:true, cancelable:true,
      clientX:x, clientY:y, screenX:x, screenY:y,
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

    // Délai aléatoire
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
      // ── PROMOTION : click-click pour déplacer le pion ──
      fire(board,'mousedown',fp.x,fp.y);
      await new Promise(r=>setTimeout(r,60));
      fire(board,'mouseup',fp.x,fp.y);
      fire(board,'click',fp.x,fp.y);
      await new Promise(r=>setTimeout(r,150));
      fire(board,'mousedown',tp.x,tp.y);
      await new Promise(r=>setTimeout(r,60));
      fire(board,'mouseup',tp.x,tp.y);
      fire(board,'click',tp.x,tp.y);

      // ── DÉTECTION PROMOTION : sélecteurs multiples pour robustesse ──
      // Chess.com change parfois ses classes CSS ; on essaie plusieurs variantes.
      let pEl = null;
      const promoLetter = promo.toLowerCase(); // q, r, b, n
      const pieceClass  = playerColor + promoLetter; // 'wq','bq','wr','br', etc.

      // Ordre de priorité : du plus spécifique au plus générique
      const PROMO_SELECTORS = [
        // Variante 1 : fenêtre visible + classe couleur+pièce
        `.promotion-window--visible .promotion-piece.${pieceClass}`,
        // Variante 2 : toute fenêtre de promo ouverte + classe couleur+pièce
        `.promotion-window .promotion-piece.${pieceClass}`,
        // Variante 3 : dialog/modal générique chess.com (nouveau layout)
        `[class*="promotion"] [class*="${pieceClass}"]`,
        // Variante 4 : data-piece attribute (certaines versions)
        `[class*="promotion"] [data-piece="${pieceClass}"]`,
        // Variante 5 : les 4 boutons de promotion sont souvent les seuls dans la modal —
        // on prend le premier visible si tout le reste échoue (= dame par défaut)
        `[class*="promotion-piece"]:not([style*="display:none"])`,
      ];

      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(r => setTimeout(r, 100));
        if (!autoPlayOn || !coachOn) { isPlaying=false; return; }

        for (const sel of PROMO_SELECTORS) {
          try {
            const candidates = document.querySelectorAll(sel);
            for (const c of candidates) {
              // Pour le sélecteur générique (variante 5), on vérifie le bon ordre :
              // chess.com affiche toujours Dame en premier (index 0), puis Tour, Fou, Cavalier
              const ORDER = ['q','r','b','n'];
              if (sel.includes('promotion-piece') && !sel.includes(pieceClass)) {
                // Sélecteur générique : on choisit par position dans la liste
                const allPieces = [...document.querySelectorAll('[class*="promotion-piece"]:not([style*="display:none"])')];
                const idx = ORDER.indexOf(promoLetter);
                if (idx >= 0 && allPieces[idx]) { pEl = allPieces[idx]; break; }
              } else {
                pEl = c;
                break;
              }
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
        // PointerEvent d'abord (chess.com réagit parfois mieux)
        try {
          pEl.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, clientX:cx, clientY:cy, isPrimary:true}));
          pEl.dispatchEvent(new PointerEvent('pointerup',   {bubbles:true, cancelable:true, clientX:cx, clientY:cy, isPrimary:true}));
        } catch(e) {}
        pEl.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy}));
        await new Promise(r => setTimeout(r, 80));
        pEl.dispatchEvent(new MouseEvent('mouseup',   {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy}));
        pEl.dispatchEvent(new MouseEvent('click',     {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy}));
        await new Promise(r => setTimeout(r, 400));
      } else {
        // Ne rien faire pour ne pas annuler le coup
        setStatus('⚠ Promo manuelle requise (sélecteur introuvable)');
        await new Promise(r => setTimeout(r, 10000));
      }

      await new Promise(r => setTimeout(r, 200));

    } else {
      // ── COUP NORMAL : drag puis fallback click-click ──
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
        // Fallback click-click
        await new Promise(r=>setTimeout(r,200));
        fire(board,'mousedown',fp.x,fp.y); fire(board,'mouseup',fp.x,fp.y); fire(board,'click',fp.x,fp.y);
        await new Promise(r=>setTimeout(r,150));
        fire(board,'mousedown',tp.x,tp.y); fire(board,'mouseup',tp.x,tp.y); fire(board,'click',tp.x,tp.y);
        await new Promise(r=>setTimeout(r,350));
      }
    }

    // Vérifie si le coup a été joué
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

    isPlaying = false;
    analysing = true;
    await new Promise(r=>setTimeout(r, 1500));
    analysing = false;
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

    // Tour de l'ennemi : efface notre flèche et attend
    if (turn === enemyColor) {
      if (fen !== lastFen) {
        lastFen = fen;
        clearCanvas('my');
        const bm = document.getElementById('cc-bestmove');
        if (bm) bm.textContent = '⏳ Adversaire…';
        setStatus('Attente adversaire…');
      }
      return;
    }

    // Notre tour
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

    // Watchdog : si l'analyse prend plus de 22s, reset analysing pour ne pas bloquer
    const watchdog = setTimeout(() => {
      if (analysing) {
        analysing = false;
        lastFen = ''; // force une nouvelle tentative au prochain scan
        setStatus('⚠ Analyse timeout — nouvelle tentative…');
      }
    }, 22000);

    const result = await analyse(fen);
    clearTimeout(watchdog);
    analysing = false;

    if (!coachOn) return;
    if (!result || !result.uci) { setStatus('Aucun coup trouvé'); return; }

    // Vérifie que c'est toujours notre tour
    const fenNow = getFen();
    if (!fenNow || getTurn(fenNow) !== playerColor) return;

    drawArrow('cc-canvas-my', 9998, result.uci, ARROW_MY_COLOR);
    const f  = result.uci.substring(0,2).toUpperCase();
    const t  = result.uci.substring(2,4).toUpperCase();
    const pr = result.uci[4] ? '=' + result.uci[4].toUpperCase() : '';
    const bm = document.getElementById('cc-bestmove');
    if (bm) bm.textContent = f + ' → ' + t + pr;

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
    // Reset complet de tous les flags — appelé à chaque désactivation
    coachOn       = false;
    autoPlayOn    = false;
    analysing     = false;
    isPlaying     = false;
    lastFen       = '';
    lastEnemyFen  = '';
    lastPlayedFen = '';
    autoPlayRetries = 0;
    clearInterval(scanTimer);
    scanTimer = null;
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

    } else {
      setStatus('Connexion…');
      // S'assure que tout est bien reset avant d'activer
      resetState();
      await updateServerDot();
      if (!serverOk && !sfReady) { setStatus('⚠ Aucun moteur disponible !'); return; }

      coachOn   = true;
      lastFen   = '';
      analysing = false;
      btn.textContent='⏹ Coach ON'; btn.style.background='#0d2b1a'; btn.style.color='#00c878';

      // Timeout de sécurité : si analysing reste bloqué > 25s, reset automatique
      const safetyInterval = setInterval(() => {
        if (!coachOn) { clearInterval(safetyInterval); return; }
        // Si analysing bloqué trop longtemps, force le reset
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
      isPlaying=false; autoPlayRetries=0; lastFen=''; // FIX : reset état pour jouer immédiatement
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
    // Vérifie le serveur toutes les 10s et tente une reconnexion si besoin
    setInterval(async () => {
      const wasOk = serverOk;
      await updateServerDot();
      // Si le serveur vient de se reconnecter pendant une partie, reset lastFen pour réanalyser
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
