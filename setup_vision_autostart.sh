#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/dmdimac/Downloads/VISION"
APP_PORT="${APP_PORT:-3002}"
TUNNEL_NAME="${TUNNEL_NAME:-vision-api}"
API_HOSTNAME="${API_HOSTNAME:-api.progredire.net}"
ENABLE_TUNNEL="${ENABLE_TUNNEL:-1}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"
BACKEND_LABEL="net.progredire.vision-backend"
TUNNEL_LABEL="net.progredire.vision-tunnel"
BACKEND_SCRIPT="$HOME/vision-start.sh"
TUNNEL_SCRIPT="$HOME/cloudflared-start.sh"
TUNNEL_CONFIG_FILE="${TUNNEL_CONFIG_FILE:-$PROJECT_DIR/cloudflared-config.yml}"
BACKEND_PLIST="$LAUNCH_AGENTS_DIR/$BACKEND_LABEL.plist"
TUNNEL_PLIST="$LAUNCH_AGENTS_DIR/$TUNNEL_LABEL.plist"
NPM_BIN="${NPM_BIN:-}"

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

if [ -z "$NPM_BIN" ]; then
  if command -v npm >/dev/null 2>&1; then
    NPM_BIN="$(command -v npm)"
  elif [ -x "/opt/homebrew/bin/npm" ]; then
    NPM_BIN="/opt/homebrew/bin/npm"
  elif [ -x "/usr/local/bin/npm" ]; then
    NPM_BIN="/usr/local/bin/npm"
  elif [ -x "/usr/bin/npm" ]; then
    NPM_BIN="/usr/bin/npm"
  else
    echo "npm non trovato. Installa Node.js e riprova."
    exit 1
  fi
fi

if [ "$ENABLE_TUNNEL" = "1" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    CLOUDFLARED_BIN="$(command -v cloudflared)"
  elif [ -x "/opt/homebrew/bin/cloudflared" ]; then
    CLOUDFLARED_BIN="/opt/homebrew/bin/cloudflared"
  elif [ -x "/usr/local/bin/cloudflared" ]; then
    CLOUDFLARED_BIN="/usr/local/bin/cloudflared"
  else
    ENABLE_TUNNEL="0"
    echo "cloudflared non trovato. Continuo con solo server VISION."
    echo "Per abilitare tunnel: brew install cloudflared"
  fi
fi

cat > "$BACKEND_SCRIPT" <<EOF
#!/bin/zsh
cd "$PROJECT_DIR"
export PORT="$APP_PORT"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
"$NPM_BIN" start
EOF
chmod +x "$BACKEND_SCRIPT"

if [ "$ENABLE_TUNNEL" = "1" ]; then
  cat > "$TUNNEL_SCRIPT" <<EOF
#!/bin/zsh
if [ -f "$TUNNEL_CONFIG_FILE" ]; then
  $CLOUDFLARED_BIN tunnel --config "$TUNNEL_CONFIG_FILE" run "$TUNNEL_NAME"
else
  $CLOUDFLARED_BIN tunnel run "$TUNNEL_NAME"
fi
EOF
  chmod +x "$TUNNEL_SCRIPT"
fi

cat > "$BACKEND_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>$BACKEND_LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/bin/zsh</string><string>$BACKEND_SCRIPT</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/vision-backend.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/vision-backend.err.log</string>
  </dict>
</plist>
EOF

if [ "$ENABLE_TUNNEL" = "1" ]; then
cat > "$TUNNEL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>$TUNNEL_LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/bin/zsh</string><string>$TUNNEL_SCRIPT</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_DIR/vision-tunnel.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/vision-tunnel.err.log</string>
  </dict>
</plist>
EOF
fi

launchctl unload "$BACKEND_PLIST" >/dev/null 2>&1 || true
launchctl load "$BACKEND_PLIST"
launchctl kickstart -k "gui/$(id -u)/$BACKEND_LABEL" >/dev/null 2>&1 || true
if [ "$ENABLE_TUNNEL" = "1" ]; then
  launchctl unload "$TUNNEL_PLIST" >/dev/null 2>&1 || true
  launchctl load "$TUNNEL_PLIST"
  launchctl kickstart -k "gui/$(id -u)/$TUNNEL_LABEL" >/dev/null 2>&1 || true
fi

echo "Setup completato"
if [ "$ENABLE_TUNNEL" = "1" ]; then
  echo "Server VISION e tunnel avviati subito."
else
  echo "Server VISION avviato subito."
  echo "Tunnel non attivo: installa cloudflared e rilancia lo script."
fi
echo "Backend URL locale: http://localhost:$APP_PORT"
echo "Hostname API previsto: https://$API_HOSTNAME"
echo "Verifica servizi: launchctl list | grep vision"
echo "Log backend: tail -f $LOG_DIR/vision-backend.log"
if [ "$ENABLE_TUNNEL" = "1" ]; then
  echo "Log tunnel: tail -f $LOG_DIR/vision-tunnel.log"
fi
