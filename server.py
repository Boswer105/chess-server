#!/usr/bin/env python3
"""
╔══════════════════════════════════════════╗
║   Échecs — Serveur Stockfish local       ║
║   Lancer : python server.py              ║
║   Ouvrir : http://localhost:8765         ║
╚══════════════════════════════════════════╝

Dépendances : aucune (stdlib Python 3.7+)
Stockfish   : doit être installé sur le système
  - Linux/macOS : sudo apt install stockfish  /  brew install stockfish
  - Windows     : télécharger sur https://stockfishchess.org/download/
                  puis modifier STOCKFISH_PATH ci-dessous
"""

import http.server
import json
import subprocess
import threading
import time
import os
import sys
import shutil
from urllib.parse import urlparse, parse_qs

# ── Config ────────────────────────────────────────────────────────────────────
PORT = 8765

# Détection automatique : cherche stockfish.exe dans le même dossier
import glob
script_dir = os.path.dirname(os.path.abspath(__file__))
_candidates = (
    glob.glob(os.path.join(script_dir, "stockfish*.exe")) +
    glob.glob(os.path.join(script_dir, "stockfish*")) +
    ([shutil.which("stockfish")] if shutil.which("stockfish") else [])
)
STOCKFISH_PATH = _candidates[0] if _candidates else "stockfish"

# Profondeur max autorisée (évite de bloquer trop longtemps)
MAX_DEPTH = 22

# ─────────────────────────────────────────────────────────────────────────────

class StockfishEngine:
    """Wrapper UCI thread-safe autour du processus Stockfish."""

    def __init__(self, path):
        self.path = path
        self.proc = None
        self.lock = threading.Lock()
        self._start()

    def _start(self):
        try:
            self.proc = subprocess.Popen(
                [self.path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
            self._send("uci")
            self._wait_for("uciok", timeout=5)
            # Optimisations vitesse
            threads = max(1, os.cpu_count() - 1)  # tous les cœurs sauf 1 pour l OS
            self._send(f"setoption name Threads value {threads}")
            self._send("setoption name Hash value 256")  # 256 MB de cache
            self._send("setoption name Move Overhead value 10")
            self._send("isready")
            self._wait_for("readyok", timeout=5)
            print(f"✅ Stockfish chargé depuis : {self.path}")
            print(f"   Threads : {threads} | Hash : 256 MB")
        except FileNotFoundError:
            print(f"❌ Stockfish introuvable à : {self.path}")
            print("   Installez-le :")
            print("   • Linux   : sudo apt install stockfish")
            print("   • macOS   : brew install stockfish")
            print("   • Windows : https://stockfishchess.org/download/")
            self.proc = None

    def _send(self, cmd):
        if self.proc:
            self.proc.stdin.write(cmd + "\n")
            self.proc.stdin.flush()

    def _wait_for(self, keyword, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline().strip()
            if keyword in line:
                return line
        return ""

    def _read_until_bestmove(self, timeout=12):
        lines = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline().strip()
            if not line:
                continue
            lines.append(line)
            if line.startswith("bestmove"):
                return lines
        # Timeout dépassé : force l'arrêt et récupère le meilleur coup partiel
        self._send("stop")
        stop_deadline = time.time() + 2
        while time.time() < stop_deadline:
            line = self.proc.stdout.readline().strip()
            if not line:
                continue
            lines.append(line)
            if line.startswith("bestmove"):
                break
        return lines

    def analyse(self, fen: str, depth: int, skill: int, multipv: int = 1) -> dict:
        """Retourne les meilleurs coups pour une position FEN donnée."""
        if not self.proc:
            return {"error": "Stockfish non disponible", "lines": []}

        depth = min(depth, MAX_DEPTH)
        skill = max(0, min(19, skill))  # 0-19 pour Stockfish

        with self.lock:
            self._send("ucinewgame")
            # Niveau 20 (skill=20 côté client) = force maximale, pas de handicap
            if skill >= 19:
                self._send("setoption name Skill Level value 20")
            else:
                self._send(f"setoption name Skill Level value {skill}")
            self._send(f"setoption name MultiPV value {multipv}")
            self._send(f"position fen {fen}")
            self._send(f"go depth {depth}")

            raw_lines = self._read_until_bestmove(timeout=12)

        # Parse info lines
        results_by_pv = {}
        bestmove_uci = None

        for line in raw_lines:
            if line.startswith("bestmove"):
                parts = line.split()
                if len(parts) >= 2 and parts[1] != "(none)":
                    bestmove_uci = parts[1]

            elif line.startswith("info") and " pv " in line and "multipv" in line:
                pv_match = _re_search(r"multipv (\d+)", line)
                uci_match = _re_search(r" pv ([a-h][1-8][a-h][1-8][qrbn]?)", line)
                score_match = _re_search(r"score (cp|mate) (-?\d+)", line)
                depth_match = _re_search(r" depth (\d+)", line)

                if uci_match:
                    pv = int(pv_match) if pv_match else 1
                    uci = uci_match
                    score_type = score_match[0] if score_match else "cp"
                    score_val = int(score_match[1]) if score_match else 0
                    dep = int(depth_match) if depth_match else 0
                    results_by_pv[pv] = {
                        "uci": uci,
                        "score_type": score_type,
                        "score": score_val,
                        "depth": dep,
                    }

        # Fallback si pas de multipv info
        if not results_by_pv and bestmove_uci:
            results_by_pv[1] = {"uci": bestmove_uci, "score_type": "cp", "score": 0, "depth": depth}

        return {
            "bestmove": bestmove_uci,
            "lines": results_by_pv,
            "depth": depth,
            "skill": skill,
        }

    def is_ready(self):
        return self.proc is not None


def _re_search(pattern, text):
    """Petit helper regex sans import re au top level."""
    import re
    m = re.search(pattern, text)
    if not m:
        return None
    return m.groups() if len(m.groups()) > 1 else (m.group(1) if m.groups() else m.group(0))


# ── Singleton engine ──────────────────────────────────────────────────────────
engine = StockfishEngine(STOCKFISH_PATH)

# ── Lire le HTML ─────────────────────────────────────────────────────────────
HTML_FILE = os.path.join(os.path.dirname(__file__), "chess.html")


class ChessHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        # Silencieux sauf erreurs
        if args and str(args[1]) not in ("200", "304"):
            super().log_message(fmt, *args)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        # ── Status endpoint ──
        if parsed.path == "/status":
            self._json({"ready": engine.is_ready(), "path": STOCKFISH_PATH})
            return

        # ── Serve chess.html ──
        if parsed.path in ("/", "/index.html", "/chess.html"):
            try:
                with open(HTML_FILE, "r", encoding="utf-8") as f:
                    content = f.read()
                # Inject local-mode flag so JS knows to use local server
                content = content.replace(
                    "// __SERVER_MODE__",
                    "const SERVER_MODE = true;"
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self._cors()
                self.end_headers()
                self.wfile.write(content.encode("utf-8"))
            except FileNotFoundError:
                self._error(404, "chess.html introuvable — placez-le dans le même dossier que server.py")
            return

        self._error(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)

        # ── Analyse endpoint ──
        if parsed.path == "/analyse":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._error(400, "JSON invalide")
                return

            fen      = data.get("fen", "")
            depth    = int(data.get("depth", 18))
            skill    = int(data.get("skill", 19))   # 0-20
            multipv  = int(data.get("multipv", 1))

            if not fen:
                self._error(400, "FEN manquant")
                return

            result = engine.analyse(fen, depth, skill, multipv)
            self._json(result)
            return

        self._error(404, "Not found")

    def _json(self, obj):
        body = json.dumps(obj).encode("utf-8")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass  # Le navigateur a raccroché avant qu'on réponde — normal

    def _error(self, code, msg):
        body = json.dumps({"error": msg}).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not engine.is_ready():
        print("\n⚠️  Le serveur démarrera mais sans Stockfish.")
        print("   Installez Stockfish puis relancez server.py\n")

    server = http.server.ThreadingHTTPServer(("localhost", PORT), ChessHandler)
    print(f"\n♟  Serveur lancé → http://localhost:{PORT}")
    print("   Ctrl+C pour arrêter\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Serveur arrêté.")
        server.server_close()
