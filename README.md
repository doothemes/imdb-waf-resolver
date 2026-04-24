# imdb-waf-resolver

Microservicio Node + Chromium que navega a IMDb y devuelve el `ld+json` de la ficha de un título, resolviendo transparentemente el challenge de AWS WAF que IMDb sirve a clientes no-navegador.

Útil cuando necesitas datos estructurados de una página de IMDb y `cURL`/`wget` se topan con HTTP 202 + challenge JavaScript que no pueden ejecutar.

---

## Tabla de contenidos

- [Instalación rápida](#instalación-rápida)
- [Escenarios de despliegue](#escenarios-de-despliegue)
- [Actualización](#actualización)
- [Desinstalación](#desinstalación)
- [Variables de entorno](#variables-de-entorno)
- [API](#api)
- [Ejemplos de cliente](#ejemplos-de-cliente)
- [Arquitectura](#arquitectura)
- [Seguridad](#seguridad)
- [Operación](#operación)
- [Troubleshooting](#troubleshooting)
- [Licencia](#licencia)

---

## Instalación rápida

**Requisitos**: Ubuntu / Debian, acceso `root` (o `sudo`).

```bash
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash
```

El instalador:

- Verifica que el puerto `3100` esté libre antes de continuar.
- Instala Node.js 20 LTS (via NodeSource) y PM2 global si no están.
- Clona el repo a `/opt/imdb-waf-resolver` con permisos `700` (solo root).
- Instala las deps de npm + Chromium headless (via Playwright) + libs de sistema (`libnss3`, fonts, etc.).
- Instala `pm2-logrotate` (rota logs a 10 MB, retiene 7 comprimidos).
- Escribe `ecosystem.config.js` con permisos `600` (token legible solo por root).
- Arranca el proceso con PM2 bindeado por defecto a `127.0.0.1` (solo loopback — seguro).
- Persiste el proceso en boot vía `systemd` (`pm2-root.service`).
- Ejecuta un health check tras arrancar.
- Imprime resumen con el endpoint y cómo recuperar el token.

Al terminar verás:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  imdb-waf-resolver instalado y corriendo
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Endpoint:     http://127.0.0.1:3100
  Bind:         127.0.0.1 (solo loopback)
  Concurrencia: 3

  AUTH_TOKEN (para Authorization: Bearer …):
    sudo cat /opt/imdb-waf-resolver/ecosystem.config.js | grep AUTH_TOKEN

  Prueba (loopback, sin token):
    curl http://127.0.0.1:3100/health
    curl "http://127.0.0.1:3100/scrape?imdb_id=tt0111161"
```

---

## Escenarios de despliegue

### Escenario A — Sidecar + cliente en el mismo servidor (recomendado)

El cliente (PHP, Node, Python…) corre en el mismo host. Bind a loopback, sin token, sin firewall.

```bash
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash
```

En tu cliente:
```
http://127.0.0.1:3100/scrape?imdb_id=tt0111161
```

Sin `Authorization` header — el sidecar rechaza auth solo si `HOST != 127.0.0.1`.

### Escenario B — Sidecar en LAN privada (VPC, WireGuard, Tailscale)

Los clientes están en otra máquina de la misma red privada. Bind a IP privada, con token obligatorio.

```bash
HOST=0.0.0.0 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

Firewall restringido al segmento privado:
```bash
# Ejemplo — ajusta el CIDR a tu red
sudo ufw allow from 10.0.0.0/24 to any port 3100 proto tcp
sudo ufw reload
```

Recupera el token:
```bash
sudo grep AUTH_TOKEN /opt/imdb-waf-resolver/ecosystem.config.js
```

Úsalo en todos los clientes vía `Authorization: Bearer <token>`.

### Escenario C — Sidecar expuesto a internet (solo si es necesario)

Bind a `0.0.0.0` + token fuerte + firewall allow-list + preferiblemente TLS.

```bash
HOST=0.0.0.0 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

**Restringe el firewall a IPs específicas**:
```bash
sudo ufw allow from <IP_CLIENTE_1> to any port 3100 proto tcp
sudo ufw allow from <IP_CLIENTE_2> to any port 3100 proto tcp
sudo ufw reload
```

**Recomendación adicional**: pon un reverse proxy (nginx/Caddy) delante con cert Let's Encrypt. Así el token no viaja en texto plano.

---

## Actualización

El instalador es **idempotente** — correrlo sobre una instalación existente hace:

1. `git pull` al último `main`.
2. `npm install` de deps nuevas o actualizadas.
3. `pm2 restart` del proceso.
4. **Preserva** el `AUTH_TOKEN`, `HOST`, `PORT` y `CONCURRENCY` actuales (leídos del `ecosystem.config.js` existente).

```bash
# Actualizar al último main (preserva config)
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash
```

Si quieres **cambiar** la config durante una actualización, especifica la env var explícita:

```bash
# Cambiar el puerto
PORT=4000 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)

# Cambiar el bind a público (requiere AUTH_TOKEN)
HOST=0.0.0.0 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)

# Subir la concurrencia máxima
CONCURRENCY=6 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

**Nota**: si actualizas desde v1.3.x o anterior, es posible que tu token haya sido regenerado (bug de migración conocido en v1.4.0, resuelto en v1.4.1). Verifica el token post-update:
```bash
sudo grep AUTH_TOKEN /opt/imdb-waf-resolver/ecosystem.config.js
```
Y propaga el nuevo valor a todos tus clientes.

---

## Desinstalación

### `--uninstall` — Solo el sidecar

Para el proceso, borra `/opt/imdb-waf-resolver/` (código, config, logs). **Conserva** Node.js, PM2, cache de Chromium — por si los usa otro proyecto.

```bash
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash -s -- --uninstall
```

### `--purge` — Todo lo anterior + más

Añade:
- PM2 systemd unit (`/etc/systemd/system/pm2-root.service`)
- Cache de Chromium (`~/.cache/ms-playwright/`, ~300 MB)
- Estado de PM2 (`~/.pm2/`)

**NO toca** Node.js ni PM2 global — pueden ser usados por otros servicios (especialmente en Plesk). Si quieres removerlos, el script imprime los comandos manuales al final.

```bash
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash -s -- --purge
```

### Reglas de firewall

**Nunca** se tocan automáticamente. Si creaste reglas `ufw` asociadas al puerto 3100, bórralas a mano:

```bash
sudo ufw status numbered
sudo ufw delete <número>
```

---

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `HOST` | `127.0.0.1` | Interfaz de bind. `0.0.0.0` para exponer (exige token). |
| `PORT` | `3100` | Puerto TCP. |
| `AUTH_TOKEN` | auto-generado si `HOST != 127.0.0.1`, si no vacío | Bearer token. |
| `CONCURRENCY` | `3` | Scrapes paralelos máximos. Excedentes van a cola. |
| `RATE_LIMIT_MAX` | `120` | Requests máximas por ventana/IP en `/scrape`. |
| `RATE_LIMIT_WIN` | `1 minute` | Ventana del rate limit (`@fastify/rate-limit`). |

Cómo pasarlas al instalador:

```bash
HOST=0.0.0.0 PORT=4000 CONCURRENCY=5 RATE_LIMIT_MAX=300 \
  bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

Para cambiarlas **después** de instalar, edita `/opt/imdb-waf-resolver/ecosystem.config.js` y reinicia con `pm2 restart imdb-waf-resolver --update-env`.

---

## API

### `POST /scrape` y `GET /scrape`

Ambos métodos son equivalentes. Usa GET para pruebas rápidas desde browser / terminal, POST cuando integres desde código.

**Auth**: `Authorization: Bearer <AUTH_TOKEN>` si `HOST != 127.0.0.1`. Sin header en modo loopback.

**POST body:**
```json
{ "imdb_id": "tt0111161" }
```

**GET query**:
```
/scrape?imdb_id=tt0111161
```

**Response (200 OK)**:
```json
{
    "status": 200,
    "ld_json": {
        "@context": "https://schema.org",
        "@type": "Movie",
        "url": "https://www.imdb.com/title/tt0111161/",
        "name": "The Shawshank Redemption",
        "image": "https://m.media-amazon.com/images/M/....jpg",
        "contentRating": "R",
        "aggregateRating": { "ratingCount": 2900000, "ratingValue": 9.3 },
        "datePublished": "1994-10-14"
    },
    "final_url": "https://www.imdb.com/title/tt0111161/",
    "elapsed_ms": 1850
}
```

- `status`: status HTTP de la navegación inicial (`202` es normal — Chromium resuelve el challenge).
- `ld_json`: objeto JSON-LD **ya parseado** de la ficha, o `null` si el scrape falló.
- `final_url`: URL final tras redirects.
- `elapsed_ms`: tiempo total de la operación (navegación + espera del `ld+json` + extracción).

**Errores**:
- `400 invalid_imdb_id` — el `imdb_id` no matchea `^tt\d{7,8}$`.
- `401 unauthorized` — token faltante o inválido.
- `429 rate_limited` — sobrepasaste `RATE_LIMIT_MAX` para tu IP; `retry_after` en el body.
- `502 scrape_failed` — error interno de Chromium; el context se resetea automáticamente.

### `GET /health`

Sin auth, sin rate limit. Útil para monitoreo.

```json
{
    "ok": true,
    "browser": true,
    "context": true,
    "active": 0,
    "queued": 0
}
```

- `browser`/`context`: si el Chromium persistente está vivo.
- `active`: scrapes ejecutándose en este momento.
- `queued`: scrapes esperando un slot libre (semáforo).

---

## Ejemplos de cliente

### cURL

```bash
# Localhost sin token
curl "http://127.0.0.1:3100/scrape?imdb_id=tt0111161"

# Con token
TOKEN="tu-token"
curl -H "Authorization: Bearer $TOKEN" \
    "http://resolver.tu-dominio:3100/scrape?imdb_id=tt0111161"

# POST JSON
curl -X POST "http://127.0.0.1:3100/scrape" \
    -H "Content-Type: application/json" \
    -d '{"imdb_id":"tt0111161"}'
```

### PHP (CodeIgniter 4)

```php
$client = \Config\Services::curlrequest();
$response = $client->get('http://127.0.0.1:3100/scrape?imdb_id=' . urlencode($imdb_id), [
    'timeout'     => 90,
    'http_errors' => false,
    'headers'     => [
        // 'Authorization' => 'Bearer ' . env('imdbResolverToken'),  // solo si no es loopback
    ],
]);
$data   = json_decode($response->getBody(), true);
$ldJson = $data['ld_json'] ?? null;  // objeto ya parseado
```

### PHP (WordPress)

```php
$response = wp_remote_get(
    add_query_arg(['imdb_id' => trim($imdb_id)], 'http://127.0.0.1:3100/scrape'),
    [
        'timeout' => 90,
        'headers' => [
            // 'Authorization' => 'Bearer ' . $token,
        ],
    ]
);
if (!is_wp_error($response)) {
    $data   = json_decode(wp_remote_retrieve_body($response), true);
    $ldJson = $data['ld_json'] ?? null;
}
```

### Node.js

```js
const url = 'http://127.0.0.1:3100/scrape?imdb_id=tt0111161';
const res = await fetch(url, {
    headers: {
        // 'Authorization': `Bearer ${process.env.AUTH_TOKEN}`,
    },
});
const { ld_json } = await res.json();
```

---

## Arquitectura

```
┌─────────┐   HTTP    ┌──────────────────────────────────────────┐
│ Cliente │ ────────> │ Fastify :3100                            │
└─────────┘           │  ├─ rate-limit + semáforo (CONCURRENCY)  │
                      │  ├─ auth Bearer (timingSafeEqual)        │
                      │  └─ /scrape handler                      │
                      │       │                                  │
                      │       ▼                                  │
                      │  Chromium persistente (Playwright)       │
                      │  ├─ 1 browser + 1 context reusable       │
                      │  ├─ cookies aws-waf-token persisten      │
                      │  ├─ block images/fonts/css/media         │
                      │  └─ page.goto + waitForSelector(ld+json) │
                      │       │                                  │
                      │       ▼                                  │
                      │  page.evaluate → extrae JSON-LD (~2 KB)  │
                      └──────────────────────────────────────────┘
                              │
                              ▼
                      JSON al cliente: { status, ld_json, … }
```

**Warm-up en boot**: el servicio dispara un scrape dummy en background (~1.5 s después de arrancar) contra uno de 5 IDs clásicos rotados. Así el `aws-waf-token` queda en las cookies del context antes del primer request real. El cold-start (~5-8 s) lo paga el warm-up, no el usuario.

**Fast path**: una vez el context tiene el cookie, IMDb sirve HTML directo sin challenge. Scrapes típicos: **1–3 s**. Cuando WAF rota el token (raro), el siguiente scrape paga el challenge (~5–8 s) y vuelve al fast path.

**URL con `?ref_=tt_sims_tt_t_1`**: WAF distingue entre URLs "limpias" (202 + body vacío, rechazo silencioso) y URLs con query param de referrer (202 + challenge resoluble). Imitamos navegación orgánica añadiendo ese parámetro.

**Payload mínimo**: el `ld+json` se extrae dentro del navegador con `page.evaluate()`. El cliente recibe solo el JSON parseado (~2 KB), no el HTML entero (~1.5 MB).

**Stack**:
- [Fastify 4](https://fastify.dev/) — servidor HTTP
- [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit) — rate limiting por IP
- [Playwright](https://playwright.dev/) + [playwright-extra](https://github.com/berstend/puppeteer-extra/tree/master/packages/playwright-extra) + [stealth plugin](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth)
- [PM2](https://pm2.keymetrics.io/) — gestor de procesos

---

## Seguridad

**Defaults seguros**:

| Mecanismo | Estado |
|---|---|
| Bind a `127.0.0.1` por default | ✓ |
| Token Bearer obligatorio si `HOST != 127.0.0.1` | ✓ |
| `timingSafeEqual` con `Buffer.byteLength` | ✓ |
| `ecosystem.config.js` permisos `600` (root-only) | ✓ |
| `/opt/imdb-waf-resolver/` permisos `700` | ✓ |
| `bodyLimit: 1024` — rechaza payloads grandes | ✓ |
| Rate limit por IP (120/min default) | ✓ |
| Semáforo de concurrencia (3 default) | ✓ |
| Input validation `^tt\d{7,8}$` | ✓ |

**Lo que no cubre el sidecar** y debes añadir tú según el caso:

- **TLS**: el sidecar habla HTTP plano. Si lo expones a internet, pon nginx/Caddy delante con Let's Encrypt.
- **Firewall**: `ufw allow from <IP>` para restringir clientes.
- **Rotación del token**: si sospechas filtración, regenera:
  ```bash
  sudo sed -i "s/AUTH_TOKEN: '[^']*'/AUTH_TOKEN: '$(openssl rand -hex 32)'/" /opt/imdb-waf-resolver/ecosystem.config.js
  pm2 restart imdb-waf-resolver --update-env
  sudo grep AUTH_TOKEN /opt/imdb-waf-resolver/ecosystem.config.js
  ```
  Y propaga el nuevo token a todos tus clientes.

---

## Operación

### Comandos útiles

```bash
pm2 status                               # ver si está online
pm2 logs imdb-waf-resolver               # stream de logs (Ctrl+C sale)
pm2 logs imdb-waf-resolver --lines 100   # últimas 100 líneas
pm2 restart imdb-waf-resolver            # reinicio manual
pm2 restart imdb-waf-resolver --update-env  # reinicio leyendo ecosystem.config.js de nuevo
pm2 monit                                # dashboard interactivo (CPU, RAM, logs)
pm2 delete imdb-waf-resolver             # quitar del proceso list (sin borrar código)
```

### Monitoreo de actividad

Logs formateados con `jq` (solo los scrapes):

```bash
tail -f /opt/imdb-waf-resolver/logs/out.log | \
    jq -r 'select(.msg=="scrape") | "[\((.time/1000)|strftime("%H:%M:%S"))] \(.imdb_id)  status=\(.status)  \(.ms)ms  ld_json=\(.ld_json)"'
```

Estadísticas desde el arranque:
```bash
jq -s '
  map(select(.msg=="scrape")) |
  {
    total:  length,
    ok:     map(select(.ld_json)) | length,
    avg_ms: (map(.ms) | add / length | floor),
    max_ms: (map(.ms) | max)
  }
' /opt/imdb-waf-resolver/logs/out.log
```

### PM2.io (dashboard remoto — opcional)

```bash
pm2 link <secret_key> <public_key>       # suscríbete en https://app.pm2.io
```

Sube telemetría (CPU, RAM, logs, event loop) al dashboard web. Gratis hasta 4 procesos. `pm2 unlink` para desvincular.

### Rotación de logs

`pm2-logrotate` se instala automáticamente con defaults sensatos:

- `max_size: 10M` — rota cuando el archivo llega a 10 MB
- `retain: 7` — guarda los últimos 7 archivos rotados
- `compress: true` — comprime los antiguos con gzip

Ajusta si necesitas:
```bash
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
```

### Límites de recursos

El proceso tiene `max_memory_restart: '800M'` en PM2 — si Chromium se infla más de 800 MB, PM2 lo recicla. Típicamente Chromium consume 200–500 MB en reposo y puede subir a 700 MB durante scrapes concurrentes.

---

## Troubleshooting

### `HTTP 000` / `Connection refused` externamente

El bind es loopback (`127.0.0.1`), no responde a IPs externas.

```bash
ss -tlnp | grep 3100   # debe mostrar 0.0.0.0:3100 o la IP deseada
```

Si dice `127.0.0.1:3100`, re-instala con HOST explícito:
```bash
HOST=0.0.0.0 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

### `HTTP 401 unauthorized`

El token no coincide. Obtén el actual:
```bash
sudo grep AUTH_TOKEN /opt/imdb-waf-resolver/ecosystem.config.js
```

Usa ese valor en `Authorization: Bearer <token>`.

### `ld_json: null`

WAF bloqueó el scrape. Causas:

- **IP de origen quemada**: datacenter sospechoso, IP en listas. Prueba desde otra IP (residencial o VPC distinto).
- **Chromium colgado**: `pm2 restart imdb-waf-resolver`.
- **Headers/fingerprint detectados**: revisa `pm2 logs` por mensajes de WAF. Puede requerir actualizar el UA o el `?ref_=`.

### Proceso no arranca (`pm2 status` muestra `errored`)

```bash
pm2 logs imdb-waf-resolver --lines 50 --err
```

Causas comunes:
- Puerto en uso (otro proceso en `3100`).
- Chromium no se descargó bien: `cd /opt/imdb-waf-resolver && npx playwright install chromium`.
- Libs de sistema faltantes: `cd /opt/imdb-waf-resolver && sudo npx playwright install-deps chromium`.

### Memoria alta / OOM

Si el proceso se reinicia por memoria constantemente, baja la concurrencia:

```bash
# Editar /opt/imdb-waf-resolver/ecosystem.config.js — cambiar CONCURRENCY
pm2 restart imdb-waf-resolver --update-env
```

### HTTP 429

Sobrepasaste el rate limit. Sube el umbral:
```bash
RATE_LIMIT_MAX=300 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

### Scrapes en cola

`/health` reporta `queued > 0` persistente = la concurrencia es insuficiente para tu tráfico. Sube `CONCURRENCY`:
```bash
CONCURRENCY=6 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

Monitorea RAM después — cada scrape paralelo cuesta 50-100 MB extra.

### El health dice `browser: false`

Chromium no arrancó. Probablemente faltan libs de sistema:
```bash
cd /opt/imdb-waf-resolver
sudo npx playwright install-deps chromium
pm2 restart imdb-waf-resolver
```

---

## Licencia

MIT © 2026 Doothemes
