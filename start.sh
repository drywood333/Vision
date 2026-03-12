#!/bin/bash

# Spostati nella directory dove si trova questo script
cd "$(dirname "$0")"

PORT=3002
LOCKFILE="$(pwd)/.vision-start.lock"

# Lock: evita di aprire due istanze (due finestre che avviano entrambe il server)
if [ -f "$LOCKFILE" ]; then
    OLD_PID=$(cat "$LOCKFILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Vision è già in esecuzione (PID $OLD_PID). Vai a http://localhost:$PORT"
        exit 0
    fi
    rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

echo "Avvio Vision AI Reader..."
echo "Directory di lavoro: $(pwd)"

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "Node.js non trovato! Assicurati di installarlo prima."
    exit 1
fi

# Install dependencies if not present
if [ ! -d "node_modules" ]; then
    echo "Installazione dipendenze..."
    npm install
fi

# Se la porta è già in uso (es. server lanciato a mano), esci senza aprire altro
if command -v lsof &> /dev/null && lsof -Pi :$PORT -sTCP:LISTEN -t &>/dev/null; then
    echo "Server già in ascolto su porta $PORT. Vai a http://localhost:$PORT"
    exit 0
fi

echo "Avvio server su http://localhost:$PORT ..."
echo "Se il browser non si apre, vai manualmente a: http://localhost:$PORT"
# Apri il browser dopo 2 s (nohup così si apre anche se lo script termina per errore)
nohup bash -c "sleep 2; [[ \"\$OSTYPE\" == darwin* ]] && open 'http://localhost:$PORT' || xdg-open 'http://localhost:$PORT' 2>/dev/null" >/dev/null 2>&1 &
npm start
