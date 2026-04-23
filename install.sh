#!/usr/bin/env bash
# imdb-waf-resolver — one-shot installer for Ubuntu/Debian
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash
#
# Idempotente: correrlo de nuevo actualiza al último main y reinicia PM2.
# Preserva el AUTH_TOKEN existente si ya fue instalado antes.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_URL="https://github.com/doothemes/imdb-waf-resolver.git"
INSTALL_DIR="/opt/imdb-waf-resolver"
NODE_MAJOR="20"
DEFAULT_PORT="3100"
DEFAULT_HOST="0.0.0.0"

# Colores
C_GREEN='\033[1;32m'
C_YELLOW='\033[1;33m'
C_RED='\033[1;31m'
C_BLUE='\033[1;34m'
C_RESET='\033[0m'

log()  { echo -e "${C_BLUE}==>${C_RESET} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!${C_RESET} $*"; }
die()  { echo -e "${C_RED}✗${C_RESET} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Debe correr como root (usa sudo)."
command -v apt-get >/dev/null || die "Requiere apt-get (Ubuntu/Debian)."

# ---------------------------------------------------------------------------
# Dependencias del sistema
# ---------------------------------------------------------------------------

log "Actualizando apt + instalando utilidades base"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
    log "Instalando Node.js $NODE_MAJOR LTS vía NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v) + npm $(npm -v)"

if ! command -v pm2 >/dev/null; then
    log "Instalando PM2 global"
    npm install -g pm2 --silent >/dev/null
fi
ok "PM2 $(pm2 -v)"

# ---------------------------------------------------------------------------
# Clonar / actualizar el código
# ---------------------------------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
    log "Actualizando repo en $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --quiet origin main
    git -C "$INSTALL_DIR" reset --hard --quiet origin/main
else
    log "Clonando repo a $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# npm install + Playwright + Chromium
# ---------------------------------------------------------------------------

log "Instalando dependencias Node"
npm install --omit=dev --silent >/dev/null

log "Instalando dependencias de sistema para Chromium (puede tardar ~1 min)"
npx --yes playwright install-deps chromium >/dev/null

log "Descargando Chromium (~160 MB, una vez)"
npx --yes playwright install chromium >/dev/null

# ---------------------------------------------------------------------------
# Config PM2 (preserva AUTH_TOKEN si ya existía)
# ---------------------------------------------------------------------------

EXISTING_TOKEN=""
if [ -f "$INSTALL_DIR/ecosystem.config.js" ]; then
    EXISTING_TOKEN="$(grep -oP "AUTH_TOKEN:\s*'\K[^']+" "$INSTALL_DIR/ecosystem.config.js" 2>/dev/null || true)"
fi

AUTH_TOKEN="${AUTH_TOKEN:-${EXISTING_TOKEN:-$(openssl rand -hex 32)}}"
HOST="${HOST:-$DEFAULT_HOST}"
PORT="${PORT:-$DEFAULT_PORT}"

log "Escribiendo ecosystem.config.js"
cat > "$INSTALL_DIR/ecosystem.config.js" <<EOF
module.exports = {
    apps: [{
        name:        'imdb-waf-resolver',
        script:      './server.js',
        cwd:         __dirname,
        instances:   1,
        exec_mode:   'fork',
        autorestart: true,
        max_restarts: 10,
        min_uptime:  '30s',
        max_memory_restart: '500M',
        kill_timeout: 10000,
        env: {
            NODE_ENV:   'production',
            HOST:       '${HOST}',
            PORT:       '${PORT}',
            AUTH_TOKEN: '${AUTH_TOKEN}'
        },
        error_file: './logs/err.log',
        out_file:   './logs/out.log',
        merge_logs: true,
        time:       true
    }]
};
EOF

# ---------------------------------------------------------------------------
# Arrancar con PM2
# ---------------------------------------------------------------------------

log "Arrancando proceso con PM2"
pm2 delete imdb-waf-resolver >/dev/null 2>&1 || true
pm2 start "$INSTALL_DIR/ecosystem.config.js" >/dev/null
pm2 save --force >/dev/null

if ! systemctl is-enabled pm2-root >/dev/null 2>&1; then
    log "Habilitando auto-start en boot (systemd)"
    env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root 2>&1 | \
        grep -E '^sudo ' | bash >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# Sanity check
# ---------------------------------------------------------------------------

sleep 2
HEALTH="$(curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo '{}')"
if ! echo "$HEALTH" | grep -q '"ok":true'; then
    warn "Health check no respondió OK. Revisa: pm2 logs imdb-waf-resolver"
else
    ok "Health check OK"
fi

# ---------------------------------------------------------------------------
# Resumen
# ---------------------------------------------------------------------------

PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo 'unknown')"

cat <<EOF

${C_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}
${C_GREEN}  imdb-waf-resolver instalado y corriendo${C_RESET}
${C_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}

  Endpoint local:    http://127.0.0.1:${PORT}
  Endpoint externo:  http://${PUBLIC_IP}:${PORT}
  AUTH_TOKEN:        ${AUTH_TOKEN}

  Prueba:
    curl -X POST http://127.0.0.1:${PORT}/scrape \\
      -H "Authorization: Bearer ${AUTH_TOKEN}" \\
      -H "Content-Type: application/json" \\
      -d '{"imdb_id":"tt0111161"}'

  Comandos útiles:
    pm2 status
    pm2 logs imdb-waf-resolver
    pm2 restart imdb-waf-resolver

  ⚠  Si expones el puerto ${PORT} a internet, asegura tu firewall:
     sudo ufw allow from <IP_DEL_CLIENTE> to any port ${PORT} proto tcp

EOF
