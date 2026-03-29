# ♟ Échecs — Stockfish natif (niveau 3000+)

## Prérequis

### 1. Installer Python 3.7+
Déjà installé sur la plupart des systèmes. Vérifier : `python3 --version`

### 2. Installer Stockfish

**Linux (Ubuntu/Debian)**
```bash
sudo apt install stockfish
```

**macOS**
```bash
brew install stockfish
```

**Windows**
1. Télécharger sur https://stockfishchess.org/download/
2. Extraire `stockfish.exe`
3. Copier `stockfish.exe` dans ce dossier, OU modifier `STOCKFISH_PATH` dans `server.py`

---

## Lancer le serveur

**Linux / macOS**
```bash
python3 server.py
```

**Windows**
```bash
python server.py
```

Vous verrez :
```
✅ Stockfish chargé depuis : /usr/games/stockfish
♟  Serveur lancé → http://localhost:8765
   Ctrl+C pour arrêter
```

## Ouvrir le jeu

Ouvrir **http://localhost:8765** dans votre navigateur.

Le badge moteur affichera **"Stockfish natif ✓"** en vert.

---

## Niveaux

| Slider | ELO approximatif |
|--------|-----------------|
| 1      | ~600 (débutant) |
| 5      | ~1200           |
| 10     | ~1800           |
| 15     | ~2400           |
| 20     | ~3000+          |

---

## Fonctionnement sans serveur

Si le serveur n'est pas lancé, le jeu bascule automatiquement sur :
1. **Stockfish WASM** (via CDN, ~2000 ELO max) si internet disponible
2. **Minimax maison** (profondeur 3, ~900 ELO) en dernier recours

---

## Fichiers

```
chess-server/
├── server.py    ← serveur Python (stdlib, aucune dépendance)
├── chess.html   ← le jeu complet
└── README.md    ← ce fichier
```
