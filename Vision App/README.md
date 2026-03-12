# Vision App

Frontend chat standalone che usa il backend VISION esistente.

## Avvio rapido

1. Avvia il server VISION.
2. Apri `index.html` in browser.
3. Imposta `Server API` con l'URL del server.
4. Invia messaggi alla chat.

## Configurazione hosting

### Frontend

- `window.VISION_APP_DEFAULT_API_BASE_URL` in `index.html`:
  - `''` usa route relativa `/api/ai-chat` (stesso dominio del backend)
  - `https://api.tuodominio.it` usa backend separato
- L'URL impostato nel campo viene salvato in `localStorage`.

### Backend

- Variabile ambiente `CORS_ORIGINS` (lista separata da virgola), esempio:
  - `CORS_ORIGINS=https://progredire.net,https://chat.tuodominio.it`
- Se `CORS_ORIGINS` è vuota, il server consente tutte le origin.
