♟ Chess Coach — Stockfish pour Chess.com
Un script qui analyse tes parties sur chess.com en temps réel grâce à Stockfish, affiche les meilleurs coups avec des flèches, et peut jouer automatiquement à ta place (mode auto-play).

📋 Ce dont tu as besoin

Un navigateur : Brave, Chrome ou Firefox 
Tampermonkey : une extension navigateur 
Python 3.7+ : un langage de programmation 
Stockfish : le moteur d'échecs 
Ce script : les fichiers de ce repo 


🪜 Installation étape par étape
Étape 1 — Installer Tampermonkey
Tampermonkey est une extension qui permet d'exécuter des scripts dans ton navigateur.

Ouvre ton navigateur
Va sur le store de ton navigateur :

Chrome / Brave → chrome.google.com/webstore → recherche "Tampermonkey"
Firefox → addons.mozilla.org → recherche "Tampermonkey"


Clique "Ajouter" ou "Installer"
Une icône Tampermonkey apparaît en haut à droite de ton navigateur ✅


Étape 2 — Installer Python
Python est nécessaire pour faire tourner le serveur local qui communique avec Stockfish.

Va sur python.org/downloads
Clique sur le gros bouton "Download Python"
Lance l'installateur téléchargé
⚠️ IMPORTANT : coche la case "Add Python to PATH" avant de cliquer Install
Clique "Install Now"
Une fois terminé, Python est installé ✅


Étape 3 — Installer Stockfish
Stockfish est le moteur d'échecs qui calcule les meilleurs coups.

Va sur stockfishchess.org/download
Clique sur Windows
Télécharge le fichier .zip
Extrais le .zip — tu obtiens un fichier .exe
Copie ce fichier .exe dans le dossier chess-server (le dossier de ce projet) ✅


Étape 4 — Télécharger ce projet

Sur cette page GitHub, clique sur le bouton vert "Code"
Clique "Download ZIP"
Extrais le ZIP où tu veux (ex : sur le Bureau)
Tu obtiens un dossier chess-server avec tous les fichiers ✅


Étape 5 — Installer le script Tampermonkey

Clique sur l'icône Tampermonkey en haut à droite de ton navigateur
Clique "Tableau de bord"
Clique l'onglet "Utilitaires"
Dans la section "Importer depuis un fichier", clique "Choisir un fichier"
Sélectionne le fichier chess-coach-v9_5_user.js du dossier téléchargé
Clique "Installer" ✅


Étape 6 — Lancer le serveur local
Le serveur local fait le lien entre ton navigateur et Stockfish.

Ouvre le dossier chess-server
Double-clique sur lancer.sh

Si ça ne marche pas, ouvre PowerShell dans le dossier (clique sur la barre d'adresse de l'Explorateur Windows, tape powershell, appuie sur Entrée) et tape :
python server.py


Une fenêtre noire s'ouvre avec le message ♟ Serveur lancé → http://localhost:8765 ✅
Laisse cette fenêtre ouverte pendant toute ta session de jeu


🎮 Utilisation

Lance le serveur (Étape 6)
Va sur chess.com et commence une partie contre un bot
Le panneau Chess Coach apparaît en bas à droite de l'écran
Clique "▶ Coach ON" pour activer l'analyse
Une flèche verte indique le meilleur coup à jouer
(Optionnel) Clique "🤖 Auto-play ON" pour que le script joue automatiquement


⚙️ Options du panneau
Coach ON/OFF — Active ou désactive l'analyse en temps réel.
Auto-play ON/OFF — Le script joue les coups automatiquement à ta place.
Niveau Stockfish — De 1 (analyse rapide et superficielle) à 20 (niveau grand maître, calcul long).
Barre d'évaluation — Affiche qui est en avantage dans la partie. Plus la barre est blanche, mieux c'est pour les blancs. Plus elle est noire, mieux c'est pour les noirs.

❓ Problèmes fréquents
Le panneau Chess Coach n'apparaît pas
Vérifie que Tampermonkey est bien activé (clique sur l'icône en haut à droite du navigateur et vérifie que le script est bien "Activé"). Recharge ensuite la page chess.com.
Le point reste rouge (serveur déconnecté)
Le serveur Python n'est pas lancé. Retourne à l'Étape 6. Le point devient vert quand le serveur tourne correctement.
La promotion de pion ne se fait pas automatiquement
Assure-toi d'utiliser la version v9.5 du script (le fichier chess-coach-v9_5_user.js).
Stockfish introuvable au démarrage
Vérifie que le fichier .exe de Stockfish est bien copié dans le dossier chess-server. Le nom du fichier doit commencer par stockfish.

⚠️ Avertissement
Ce script est conçu pour s'entraîner contre des bots sur chess.com. L'utiliser en partie classée contre de vrais joueurs est contraire aux conditions d'utilisation de chess.com.

📁 Contenu du projet

server.py — Serveur local Python
chess.html — Interface web optionnelle
lancer.sh — Script de démarrage rapide
chess-coach-v9_5_user.js — Script Tampermonkey à installer
README.md — Ce fichier d'instructions
stockfish.exe — À télécharger séparément sur stockfishchess.org (trop lourd pour GitHub)
