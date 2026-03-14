#!/bin/bash

# Script per sincronizzare modifiche GitHub -> VISION locale
# Uso: ./Github_to_MAC.sh

set -e  # Esce se c'è un errore

# Colori per output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== GitHub to MAC - Sincronizzazione ===${NC}"
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

# Mostra branch corrente
BRANCH=$(git branch --show-current)
echo -e "${YELLOW}Branch corrente: $BRANCH${NC}"
echo ""

# Verifica se ci sono modifiche locali non committate
if ! git diff-index --quiet HEAD --; then
    echo -e "${YELLOW}ATTENZIONE: Ci sono modifiche locali non committate.${NC}"
    git status --short
    echo ""
    read -p "Vuoi salvare le modifiche locali prima di aggiornare? (s/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Ss]$ ]]; then
        echo -e "${GREEN}Stash modifiche locali...${NC}"
        git stash push -m "Stash automatico prima di pull - $(date '+%Y-%m-%d %H:%M:%S')"
        STASHED=true
    else
        echo -e "${RED}Operazione annullata. Committa o scarta le modifiche locali prima di continuare.${NC}"
        exit 1
    fi
fi

# Fetch da GitHub
echo -e "${GREEN}Fetch da GitHub...${NC}"
git fetch origin

# Controlla se ci sono aggiornamenti remoti
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u} 2>/dev/null || echo "")
BASE=$(git merge-base @ @{u} 2>/dev/null || echo "")

if [ -z "$REMOTE" ]; then
    echo -e "${YELLOW}Branch non tracciato. Configurazione upstream...${NC}"
    git push -u origin "$BRANCH"
    echo -e "${GREEN}✓ Branch configurato.${NC}"
    exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
    echo -e "${GREEN}✓ Repository già aggiornato. Nessuna modifica da GitHub.${NC}"
    if [ "$STASHED" = true ]; then
        echo -e "${YELLOW}Ripristino modifiche locali dallo stash...${NC}"
        git stash pop
    fi
    exit 0
fi

if [ "$LOCAL" = "$BASE" ]; then
    echo -e "${YELLOW}Trovati aggiornamenti da GitHub.${NC}"
    echo ""
    read -p "Vuoi scaricare e applicare gli aggiornamenti? (s/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Ss]$ ]]; then
        echo "Operazione annullata."
        if [ "$STASHED" = true ]; then
            git stash pop
        fi
        exit 0
    fi
    
    echo -e "${GREEN}Pull da GitHub...${NC}"
    git pull origin "$BRANCH"
    
    # Ripristina modifiche locali se erano state salvate
    if [ "$STASHED" = true ]; then
        echo -e "${YELLOW}Ripristino modifiche locali dallo stash...${NC}"
        if ! git stash pop; then
            echo -e "${YELLOW}Conflitti durante il ripristino. Risolvi manualmente con: git stash list${NC}"
        fi
    fi
    
    echo ""
    echo -e "${GREEN}✓ Sincronizzazione completata!${NC}"
    echo -e "${GREEN}Modifiche da GitHub applicate localmente.${NC}"
    
elif [ "$REMOTE" = "$BASE" ]; then
    echo -e "${YELLOW}Hai commit locali non pushati.${NC}"
    echo "Usa MAC_to_Github.sh per inviarli a GitHub."
    if [ "$STASHED" = true ]; then
        git stash pop
    fi
else
    echo -e "${RED}Divergenza tra locale e remoto.${NC}"
    echo "Locale e remoto hanno commit diversi. Risolvi manualmente."
    if [ "$STASHED" = true ]; then
        git stash pop
    fi
    exit 1
fi
