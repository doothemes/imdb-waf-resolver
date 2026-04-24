#!/usr/bin/env bash
# imdb-waf-resolver — one-shot installer para Ubuntu/Debian
#
# Instalar / actualizar:
#   curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash
#
# Exponer a una red (requiere AUTH_TOKEN):
#   HOST=0.0.0.0 AUTH_TOKEN=$(openssl rand -hex 32) \
#     bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
#
# Desinstalar (sidecar + código, conserva Node/PM2):
#   curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash -s -- --uninstall
#
# Desinstalar también Chromium cache + PM2 systemd unit (NO toca Node ni PM2 global):
#   curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash -s -- --purge
#
# Install es idempotente: correrlo de nuevo actualiza al último main y reinicia PM2.
# Preserva el AUTH_TOKEN existente si ya fue instalado antes.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_URL="https://github.com/doothemes/imdb-waf-resolver.git"
INSTALL_DIR="/opt/imdb-waf-resolver"
NODE_MAJOR="20"
DEFAULT_PORT="3100"
DEFAULT_HOST="127.0.0.1"       # loopback por seguridad; override con HOST=0.0.0.0
DEFAULT_CONCURRENCY="3"

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
# Parseo de flags
# ---------------------------------------------------------------------------

MODE="install"
for arg in "$@"; do
    case "$arg" in
        --uninstall) MODE="uninstall" ;;
        --purge)     MODE="purge" ;;
        -h|--help)
            cat <<EOF
imdb-waf-resolver installer

Flags:
  (sin flag)    Instalar o actualizar al último main
  --uninstall   Quitar sidecar + código (conserva Node.js, PM2, Chromium cache)
  --purge       Lo anterior + PM2 systemd unit + Chromium cache + ~/.pm2
                (NO toca Node.js ni PM2 global — para eso, remover manual)
  -h, --help    Muestra esta ayuda

Env vars (solo para install):
  HOST          Dirección de bind (default: 127.0.0.1 — solo loopback)
  PORT          Puerto TCP (default: 3100)
  AUTH_TOKEN    Bearer token (obligatorio si HOST != 127.0.0.1)
  CONCURRENCY   Scrapes paralelos máximo (default: 3)
EOF
            exit 0
            ;;
        *) die "Flag desconocido: $arg (usa --help)" ;;
    esac
done

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Debe correr como root (usa sudo)."
command -v apt-get >/dev/null || die "Requiere apt-get (Ubuntu/Debian)."

# ---------------------------------------------------------------------------
# Modo: uninstall / purge
# ---------------------------------------------------------------------------

if [ "$MODE" = "uninstall" ] || [ "$MODE" = "purge" ]; then
    log "Modo: $MODE"

    if command -v pm2 >/dev/null; then
        log "Deteniendo y eliminando proceso PM2"
        pm2 delete imdb-waf-resolver >/dev/null 2>&1 || true
        pm2 save --force >/dev/null 2>&1 || true
    fi

    if [ -d "$INSTALL_DIR" ]; then
        log "Eliminando $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
        ok "Código + config + logs borrados"
    else
        warn "$INSTALL_DIR no existe"
    fi

    if [ "$MODE" = "purge" ]; then
        # Solo tocamos cosas que nosotros creamos. Node.js y PM2 global pueden
        # ser usados por otros servicios (Plesk, otras apps) → no los removemos.
        # Si el usuario quiere desinstalarlos, que lo haga manual.
        if command -v pm2 >/dev/null; then
            log "Quitando auto-start de systemd (pm2-root.service)"
            pm2 unstartup systemd >/dev/null 2>&1 || true
            systemctl disable pm2-root >/dev/null 2>&1 || true
            rm -f /etc/systemd/system/pm2-root.service
        fi
        log "Quitando caché de Playwright/Chromium (~300 MB)"
        rm -rf /root/.cache/ms-playwright
        log "Quitando estado PM2 (~/.pm2)"
        rm -rf /root/.pm2
        ok "Purge completo (Node.js + PM2 global conservados)"
    else
        ok "Uninstall completo (Node/PM2/Chromium cache conservados)"
    fi

    cat <<EOF

${C_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}
${C_GREEN}  Desinstalación lista${C_RESET}
${C_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}

  Si quieres también remover Node.js y PM2 global (solo si no los usa
  ningún otro servicio del sistema):
    sudo npm uninstall -g pm2
    sudo apt-get purge -y nodejs
    sudo rm -f /etc/apt/sources.list.d/nodesource.list
    sudo rm -f /etc/apt/keyrings/nodesource.gpg

  Si ya no necesitas el firewall de este servicio, quita la regla ufw:
    sudo ufw status numbered
    sudo ufw delete <numero-de-la-regla-3100>

EOF
    exit 0
fi

# ---------------------------------------------------------------------------
# Resolver config final
# ---------------------------------------------------------------------------

HOST="${HOST:-$DEFAULT_HOST}"
PORT="${PORT:-$DEFAULT_PORT}"
CONCURRENCY="${CONCURRENCY:-$DEFAULT_CONCURRENCY}"

# Si HOST no es loopback, AUTH_TOKEN es obligatorio
if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ]; then
    if [ -z "${AUTH_TOKEN:-}" ]; then
        # Preservar el existente si ya había instalación, sino generar
        EXISTING_TOKEN=""
        if [ -f "$INSTALL_DIR/ecosystem.config.js" ]; then
            EXISTING_TOKEN="$(grep -oP "AUTH_TOKEN:\s*'\K[^']+" "$INSTALL_DIR/ecosystem.config.js" 2>/dev/null || true)"
        fi
        AUTH_TOKEN="${EXISTING_TOKEN:-$(openssl rand -hex 32)}"
    fi
else
    # Loopback — token opcional (vacío por default)
    AUTH_TOKEN="${AUTH_TOKEN:-}"
fi

# ---------------------------------------------------------------------------
# Port collision check
# ---------------------------------------------------------------------------

# Chequea solo si el puerto está ocupado por algo que NO sea nuestro sidecar
if ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q LISTEN; then
    # ¿Es nuestro? Si está corriendo imdb-waf-resolver es update, OK
    if pm2 list 2>/dev/null | grep -q imdb-waf-resolver; then
        log "Puerto ${PORT} ocupado por imdb-waf-resolver existente (update OK)"
    else
        die "Puerto ${PORT} ya está en uso por otro proceso. Libera o define PORT=otro."
    fi
fi

# ---------------------------------------------------------------------------
# Dependencias del sistema
# ---------------------------------------------------------------------------

log "Actualizando apt + instalando utilidades base"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl iproute2 >/dev/null

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

# Permisos restrictivos al dir del sidecar (token en ecosystem.config.js)
chmod 700 "$INSTALL_DIR"

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
# pm2-logrotate — sin rotación, logs crecerían infinitamente
# ---------------------------------------------------------------------------

log "Asegurando pm2-logrotate (rotación a 10M, 7 archivos, comprimidos)"
pm2 install pm2-logrotate >/dev/null 2>&1 || true
pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain  7    >/dev/null 2>&1 || true
pm2 set pm2-logrotate:compress true >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Config PM2 (preserva AUTH_TOKEN si ya existía)
# ---------------------------------------------------------------------------

log "Escribiendo ecosystem.config.js"
# umask 077 → archivo se crea con permisos 600 (solo root)
(umask 077 && cat > "$INSTALL_DIR/ecosystem.config.js" <<EOF
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
        max_memory_restart: '800M',
        kill_timeout: 10000,
        env: {
            NODE_ENV:    'production',
            HOST:        '${HOST}',
            PORT:        '${PORT}',
            AUTH_TOKEN:  '${AUTH_TOKEN}',
            CONCURRENCY: '${CONCURRENCY}'
        },
        error_file: './logs/err.log',
        out_file:   './logs/out.log',
        merge_logs: true,
        time:       true
    }]
};
EOF
)
chmod 600 "$INSTALL_DIR/ecosystem.config.js"

# ---------------------------------------------------------------------------
# Arrancar con PM2
# ---------------------------------------------------------------------------

log "Arrancando proceso con PM2"
pm2 delete imdb-waf-resolver >/dev/null 2>&1 || true
pm2 start "$INSTALL_DIR/ecosystem.config.js" --update-env >/dev/null
pm2 save --force >/dev/null

if ! systemctl is-enabled pm2-root >/dev/null 2>&1; then
    log "Habilitando auto-start en boot (systemd)"
    # Como root, pm2 startup configura systemd directamente. Si falla algún step,
    # lo forzamos con systemctl. NO parseamos stdout de pm2 (riesgo supply chain).
    env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
    systemctl enable pm2-root >/dev/null 2>&1 || true
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
# Resumen (sin exponer el token en stdout)
# ---------------------------------------------------------------------------

cat <<EOF

${C_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}
${C_GREEN}  imdb-waf-resolver instalado y corriendo${C_RESET}
${C_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}

  Endpoint:     http://${HOST}:${PORT}
  Bind:         ${HOST} $([ "$HOST" = "127.0.0.1" ] && echo '(solo loopback)' || echo '(público — verifica firewall)')
  Concurrencia: ${CONCURRENCY}

  AUTH_TOKEN (para Authorization: Bearer …):
    sudo cat /opt/imdb-waf-resolver/ecosystem.config.js | grep AUTH_TOKEN

EOF

if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
    cat <<EOF
  Prueba (loopback, sin token):
    curl http://127.0.0.1:${PORT}/health
    curl "http://127.0.0.1:${PORT}/scrape?imdb_id=tt0111161"

EOF
else
    cat <<EOF
  Prueba (remoto — sustituye TOKEN):
    TOKEN=\$(sudo grep -oP "AUTH_TOKEN:\\s*'\\K[^']+" /opt/imdb-waf-resolver/ecosystem.config.js)
    curl -H "Authorization: Bearer \$TOKEN" "http://${HOST}:${PORT}/scrape?imdb_id=tt0111161"

  ⚠  Asegura tu firewall — solo deja entrar clientes legítimos:
     sudo ufw allow from <IP_CLIENTE> to any port ${PORT} proto tcp

EOF
fi

cat <<EOF
  Comandos útiles:
    pm2 status
    pm2 logs imdb-waf-resolver
    pm2 restart imdb-waf-resolver
    pm2 monit

EOF
