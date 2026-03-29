#!/bin/bash
# Lance le serveur et ouvre le navigateur automatiquement
echo "♟  Démarrage du serveur Stockfish…"
python3 server.py &
PID=$!
sleep 2
# Ouvre le navigateur selon l'OS
if command -v xdg-open &> /dev/null; then
    xdg-open http://localhost:8765
elif command -v open &> /dev/null; then
    open http://localhost:8765
fi
echo "Appuyer sur Ctrl+C pour arrêter"
wait $PID
