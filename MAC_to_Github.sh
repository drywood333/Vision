#!/bin/bash

# Script per sincronizzare modifiche locali VISION -> GitHub
# Uso: ./MAC_to_Github.sh

set -e  # Esce se c'è un errore

# Colori per output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== MAC to GitHub - Sincronizzazione ===${NC}"
echo ""

# Trova la directory VISION (assumendo che lo script sia nella root di VISION)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Verifica che sia una directory git
if [ ! -d ".git" ]; then
    echo -e "${RED}Errore: questa directory non è un repository git.${NC}"
    echo "Assicurati di essere nella cartella VISION."
    exit 1
fi

# Mostra stato corrente
echo -e "${YELLOW}Stato repository:${NC}"
git status -sb
echo ""

# Verifica se ci sono modifiche
if git diff-index --quiet HEAD --; then
    echo -e "${YELLOW}Nessuna modifica locale da committare.${NC}"
    
    # Controlla se ci sono commit locali non pushati
    LOCAL=$(git rev-list @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ')
    if [ "$LOCAL" -gt 0 ]; then
        echo -e "${YELLOW}Trovati $LOCAL commit locali non pushati.${NC}"
        read -p "Vuoi pushare i commit esistenti? (s/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Ss]$ ]]; then
            echo -e "${GREEN}Push in corso...${NC}"
            git push -u origin "$(git branch --show-current)"
            echo -e "${GREEN}✓ Push completato.${NC}"
        else
            echo "Operazione annullata."
            exit 0
        fi
    else
        echo -e "${GREEN}Repository già sincronizzato con GitHub.${NC}"
    fi
    exit 0
fi

# Mostra modifiche
echo -e "${YELLOW}Modifiche rilevate:${NC}"
git status --short
echo ""

# Chiedi conferma
read -p "Vuoi committare e pushare queste modifiche? (s/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    echo "Operazione annullata."
    exit 0
fi

# Aggiungi tutti i file modificati
echo -e "${GREEN}Aggiunta file modificati...${NC}"
git add -A

# Crea commit con messaggio
BRANCH=$(git branch --show-current)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
COMMIT_MSG="Sync MAC to GitHub - $TIMESTAMP"

echo -e "${GREEN}Creazione commit...${NC}"
git commit -m "$COMMIT_MSG"

# Push al branch corrente
echo -e "${GREEN}Push in corso su branch: $BRANCH...${NC}"
git push -u origin "$BRANCH"

echo ""
echo -e "${GREEN}✓ Sincronizzazione completata!${NC}"
echo -e "${GREEN}Modifiche locali inviate a GitHub.${NC}"
