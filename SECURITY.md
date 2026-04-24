# Política de seguridad

Este documento describe el modelo de amenaza, controles activos, riesgos conocidos, y procedimientos de operación segura del `imdb-waf-resolver`.

---

## Tabla de contenidos

- [Versiones soportadas](#versiones-soportadas)
- [Reporte de vulnerabilidades](#reporte-de-vulnerabilidades)
- [Modelo de amenaza](#modelo-de-amenaza)
- [Controles activos](#controles-activos)
- [Riesgos conocidos y mitigaciones](#riesgos-conocidos-y-mitigaciones)
- [Hardening por escenario](#hardening-por-escenario)
- [Operación segura](#operación-segura)
- [Historial de parches de seguridad](#historial-de-parches-de-seguridad)
- [Auditoría externa recomendada](#auditoría-externa-recomendada)

---

## Versiones soportadas

Solo la última versión de `main` recibe actualizaciones de seguridad. No hay branches de soporte LTS.

| Versión  | Estado             |
|----------|--------------------|
| v1.4.x   | ✅ Soportada        |
| v1.3.x   | ⚠️ EOL — actualizar |
| < v1.3   | ❌ No soportada     |

Para actualizar:
```bash
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash
```

---

## Reporte de vulnerabilidades

**No abras un issue público para vulnerabilidades de seguridad.**

Para reportar un problema:

1. Envía un correo a **security@ews.pe** con:
   - Descripción del problema.
   - PoC o pasos para reproducir.
   - Impacto que consideras (opcional).
2. Espera confirmación de recepción en 48 h.
3. Trabajamos el parche y te avisamos cuando esté publicado.
4. Si quieres crédito público, lo añadimos al changelog.

**Scope**:
- Vulnerabilidades en el código de este repo (`server.js`, `install.sh`, configuración PM2).
- Cadenas de exploit que involucren Playwright/Chromium/Fastify que afecten al sidecar.
- Problemas de configuración **en los defaults** del instalador.

**Fuera de scope**:
- Vulnerabilidades en dependencias upstream (repórtalas a ellas).
- Ataques que requieren control físico o privilegios root previos al deploy.
- Brute-force del `AUTH_TOKEN` (64 hex chars = 256 bits de entropía — no es viable).

---

## Modelo de amenaza

### Qué protegemos

- **Confidencialidad del token**: el `AUTH_TOKEN` no debe filtrarse a otros usuarios del host, logs públicos, ni journald.
- **Disponibilidad del sidecar**: protección contra DoS por bursts de requests, memory leaks, logs descontrolados.
- **Integridad del scraping**: que nadie pueda forzar a Chromium a visitar URLs arbitrarias (SSRF).
- **Aislamiento del proceso**: que un fallo en Chromium no tumbe el host ni deje zombies.

### Qué NO protegemos (fuera del scope)

- **Ataques a nivel de navegador/Chromium**: si un 0-day en Chromium permite RCE, el atacante necesitaría controlar qué HTML se renderiza — solo IMDb lo sirve. Mitigado por validación regex + URL hardcodeada.
- **Confidencialidad en tránsito**: el sidecar sirve HTTP plano. Si lo expones públicamente sin reverse-proxy TLS, el token va en texto claro.
- **Ataques a infraestructura**: compromiso del host, de systemd, de PM2, de Node.js. El sidecar es un proceso userland.
- **Abuso legítimo del scraping**: este servicio existe para obtener datos públicos de IMDb. No es responsable de los términos de uso del cliente.

### Superficie de ataque

| Componente | Superficie |
|---|---|
| Fastify HTTP server | `GET/POST /scrape`, `GET /health` |
| Chromium headless | Ejecuta JS de `imdb.com` — validación previa del `imdb_id` previene SSRF |
| Playwright IPC | Unix socket entre Node y Chromium — solo accesible al user del proceso |
| PM2 daemon | `/root/.pm2/`, systemd unit `pm2-root.service` |
| Filesystem | `/opt/imdb-waf-resolver/` (700), `ecosystem.config.js` (600) |

---

## Controles activos

Todos se aplican por default al instalar desde el `install.sh` actual.

### Autenticación

- **Bearer token** en header `Authorization`, validado contra `AUTH_TOKEN`.
- **Comparación tiempo-constante** con `crypto.timingSafeEqual` sobre `Buffer.byteLength` — previene timing attacks.
- **Try/catch** alrededor de la comparación — entradas malformadas (UTF-8 inválido, lengths extremos) retornan `401`, no crash.
- **Exención de `/health`** del auth — para que monitores externos puedan hacer healthcheck sin secret.

### Bind seguro por default

- `HOST=127.0.0.1` si no se especifica otra cosa.
- El server.js **se niega a arrancar** si `HOST` no es loopback y `AUTH_TOKEN` está vacío.

### Rate limiting

- `@fastify/rate-limit`: **120 req/min por IP** sobre `/scrape` (configurable vía `RATE_LIMIT_MAX` / `RATE_LIMIT_WIN`).
- `/health` exento.
- Excedentes devuelven `429 rate_limited` con `retry_after` en el body.

### Concurrency cap

- Semáforo interno: máximo `CONCURRENCY=3` scrapes paralelos (configurable).
- Excedentes quedan en cola (no se rechazan) — cada uno recibe su respuesta cuando sale un slot.
- Previene OOM por bursts: cada scrape paralelo costaría 50-100 MB extra en Chromium.

### Input validation

- Regex estricto `^tt\d{7,8}$` sobre `imdb_id`. Nada más pasa.
- **URL destino hardcodeada**: `https://www.imdb.com/title/${imdbId}/?ref_=tt_sims_tt_t_1`. No hay SSRF — el cliente no controla la URL.

### Límites de payload

- `bodyLimit: 1024` bytes en Fastify — rechaza body inflado con `413`.

### Filesystem

- `/opt/imdb-waf-resolver/` con permisos `700` — solo root entra.
- `ecosystem.config.js` con permisos `600` (creado con `umask 077`) — el token solo lo lee root.

### Rotación de logs

- `pm2-logrotate` auto-instalado: 10 MB por archivo, 7 archivos retenidos, comprimidos con gzip.
- Previene disk-fill por logs descontrolados.

### Gestión de procesos

- `max_memory_restart: '800M'` — PM2 recicla si Chromium excede 800 MB.
- `autorestart: true`, `max_restarts: 10`, `min_uptime: '30s'` — protege contra loops de crash.
- PM2 **no** evalúa stdout para su setup systemd (eliminada la pipe `pm2 startup | grep | bash` que era vector de supply-chain).

### Silencio del token

- El `install.sh` **no imprime** el `AUTH_TOKEN` en stdout — evita que aparezca en TTYs, logs de cron, journald, bash history.
- Indica la ruta exacta para recuperarlo manualmente: `sudo grep AUTH_TOKEN /opt/imdb-waf-resolver/ecosystem.config.js`.

---

## Riesgos conocidos y mitigaciones

### R1 — Chromium corre como root con `--no-sandbox`

**Severidad**: Baja (probabilidad baja, impacto alto).

Chromium se lanza con `--no-sandbox` y `--disable-setuid-sandbox` porque no puede usar user-namespaces sin capability. Si un 0-day en Chromium permitiera RCE desde una página, sería como root.

**Por qué es baja probabilidad**:
- Chromium solo visita `https://www.imdb.com/title/tt.../` — URLs hardcodeadas, no controlables por el atacante.
- El cliente pasa solo `imdb_id` (validado por regex) — no inyecta URLs ni headers.

**Mitigaciones futuras** (no implementadas aún):
- Crear user `imdb-waf` y correr PM2 bajo ese user.
- Usar `docker run --init --security-opt seccomp` para aislamiento.
- Considerar `playwright run-server` en container con seccomp profile.

### R2 — HTTP en texto claro

**Severidad**: Media si se expone a internet, Info si es loopback/VPC.

El token viaja en `Authorization: Bearer` sin TLS. Snifeable si la red entre cliente y sidecar no es confiable.

**Mitigaciones**:
- **Mantenerlo en loopback** cuando sea posible.
- Para despliegues públicos: reverse-proxy con nginx/Caddy + Let's Encrypt. Ejemplo nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name resolver.ejemplo.com;

    ssl_certificate     /etc/letsencrypt/live/resolver.ejemplo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/resolver.ejemplo.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }
}
```

Y el sidecar sigue bindeado en `127.0.0.1:3100` — solo nginx le habla.

### R3 — Supply chain (npm dependencies)

**Severidad**: Media — mitigación parcial.

Las dependencias npm (`fastify`, `playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth`, `@fastify/rate-limit`) son puntos de compromiso si sus mantenedores se ven afectados.

**Mitigaciones aplicadas**:
- `install.sh` **ya no ejecuta** stdout de `pm2` (eliminado `pm2 startup | grep | bash`).
- `package-lock.json` fija versiones exactas tras `npm install`.
- Deps en git clonado directo desde el repo oficial (no mirrors aleatorios).

**Mitigaciones recomendadas al operador**:
- Revisar `npm audit` periódicamente.
- Actualizar solo cuando el repo publica versión probada.
- Fijar `package-lock.json` en el control de versiones de tu fork si operas a escala.

### R4 — Warm-up con IDs predecibles

**Severidad**: Info.

El warm-up usa 5 IDs clásicos rotados al azar. Una red que observe tráfico de la IP del sidecar podría fingerprint'ear el patrón "al bootear pide siempre uno de estos 5 títulos".

**Mitigaciones**:
- Cantidad ampliable — editar `WARMUP_POOL` en `server.js` con más títulos.
- No es explotable sin acceso al provider de red.

### R5 — Denegación por exhausto de Chromium

**Severidad**: Baja.

Si un atacante con token válido envía 1000 requests simultáneas, los 997 que no tengan slot quedan en cola. La RAM crece hasta que `max_memory_restart` se dispare.

**Mitigaciones activas**:
- Concurrency cap = 3 (no importa cuántas lleguen, solo 3 consumen RAM simultáneamente).
- Rate limit = 120/min por IP (adicional).
- PM2 recicla a 800 MB.

**Mitigación adicional**: baja `CONCURRENCY` a 2 si el host es muy chico. Sube a 5-10 si tienes RAM sobrada.

### R6 — Token en `ecosystem.config.js` en texto plano

**Severidad**: Baja.

El archivo tiene permisos `600` (root-only). Cualquier atacante que ya sea root puede leerlo — pero a ese punto tiene todo el sistema.

**Mitigaciones**:
- Rotación periódica del token (cada 90 días recomendado para prod pública):
  ```bash
  NEW=$(openssl rand -hex 32)
  sudo sed -i "s/AUTH_TOKEN: '[^']*'/AUTH_TOKEN: '$NEW'/" /opt/imdb-waf-resolver/ecosystem.config.js
  sudo pm2 restart imdb-waf-resolver --update-env
  echo "Nuevo token: $NEW"
  ```
  Y propagar a todos los clientes.

### R7 — Chromium binary tamperproofing

**Severidad**: Info.

El binario de Chromium vive en `/root/.cache/ms-playwright/chromium-XXXX/`. Si un atacante con root reemplaza el binario, ejecutamos código arbitrario al siguiente scrape.

**Mitigaciones**:
- Si temes esto, ya estás fuera del modelo de amenaza (pre-compromiso root).
- Integridad del binario garantizada por Playwright download + SHA check propio.

---

## Hardening por escenario

### Plesk / shared hosting

**Reglas específicas**:

1. **Siempre bind a loopback**. PHP-FPM workers alcanzan `127.0.0.1` sin problema:
   ```bash
   HOST=127.0.0.1 bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
   ```

2. **Nunca corras `--purge`** en un Plesk — podría remover deps compartidas. Usa solo `--uninstall`.

3. **Verifica puerto libre**:
   ```bash
   sudo ss -tlnp | grep 3100
   ```

4. **Rate limit más estricto** si es un Plesk pequeño — un pool PHP-FPM que se vuelva loco puede saturar el resolver:
   ```bash
   RATE_LIMIT_MAX=60 HOST=127.0.0.1 bash <(curl ...)
   ```

5. **No expongas 3100 al internet** — usa nginx/Apache de Plesk como proxy si necesitas exponer.

### VPS dedicado

- `HOST=0.0.0.0` con `AUTH_TOKEN` auto-generado por el script.
- Firewall UFW allow-list a IPs específicas:
  ```bash
  sudo ufw default deny incoming
  sudo ufw allow from <IP_CLIENTE> to any port 3100 proto tcp
  sudo ufw allow OpenSSH
  sudo ufw enable
  ```
- TLS con Let's Encrypt + nginx proxy si el token va por internet.

### Red privada (VPC / WireGuard / Tailscale)

- Bind a IP privada (`HOST=10.0.0.5`) o a `0.0.0.0` con firewall al CIDR privado.
- Token corto (16 bytes) aceptable si la red es confiable y pequeña.

### Home server con IP pública

- Split-horizon DNS si tienes una (resolve LAN internamente, pública externamente).
- UFW allow-list a clientes específicos.
- Considera rotar el token tras cada cambio de IP pública.

---

## Operación segura

### Post-instalación

1. **Verifica el bind**:
   ```bash
   sudo ss -tlnp | grep imdb-waf-resolver
   # o
   sudo ss -tlnp | grep 3100
   ```

2. **Verifica permisos**:
   ```bash
   stat -c '%a %n' /opt/imdb-waf-resolver /opt/imdb-waf-resolver/ecosystem.config.js
   # Esperado: 700 /opt/imdb-waf-resolver  y  600 ecosystem.config.js
   ```

3. **Prueba el auth**:
   ```bash
   curl -v http://127.0.0.1:3100/scrape?imdb_id=tt0111161       # debe responder OK o 401 según bind
   curl -H "Authorization: Bearer fake" http://<host>:3100/scrape?imdb_id=tt0111161   # debe 401
   ```

4. **Verifica rate limit y health**:
   ```bash
   curl http://127.0.0.1:3100/health
   # {"ok":true,"browser":true,"context":true,"active":0,"queued":0}
   ```

### Rotación del token

**Cuándo rotar**:
- Sospecha de fuga (archivo compartido por error, log público, etc.).
- Cada 90 días en producción pública.
- Tras cualquier `--uninstall` + re-instalación.

**Cómo rotar**:
```bash
NEW=$(openssl rand -hex 32)
sudo sed -i "s/AUTH_TOKEN: '[^']*'/AUTH_TOKEN: '$NEW'/" /opt/imdb-waf-resolver/ecosystem.config.js
sudo pm2 restart imdb-waf-resolver --update-env
echo "Nuevo token: $NEW"
```

Luego propaga `$NEW` a todos los clientes. Si operas múltiples, pon el token en un secrets manager (Vault, SOPS, AWS Secrets Manager).

### Monitoreo

**Health check externo**:
```bash
# cron cada 5 min en un monitor externo
curl -fsS --max-time 10 http://<host>:3100/health > /dev/null || alert
```

**Métricas a vigilar** (via `/health` o `pm2 monit`):
- `queued > 0` persistente → subir `CONCURRENCY`.
- `active` = `CONCURRENCY` constante → bottleneck, subir límite o añadir un segundo instancia.
- `browser: false` / `context: false` → Chromium murió, ya debería haberse reiniciado.

**Logs** (via `pm2 logs` o `/opt/imdb-waf-resolver/logs/out.log`):
- `scrape` con `ld_json: false` repetitivo → WAF bloquea. Puede requerir cambiar UA o IP.
- `scrape failed` → resetea el context automáticamente; investiga si se repite.

### Actualización segura

```bash
# Antes: snapshot del estado
pm2 status
sudo cat /opt/imdb-waf-resolver/ecosystem.config.js | grep -v AUTH_TOKEN   # sin exponer el token

# Actualizar
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash

# Después: verificar que el token y la config se preservaron
sudo grep -E "HOST|PORT|AUTH_TOKEN|CONCURRENCY" /opt/imdb-waf-resolver/ecosystem.config.js
curl http://127.0.0.1:3100/health
```

Si el token cambia (bug conocido en migraciones pre-v1.4.1), propaga el nuevo a todos los clientes antes de declarar "listo".

### Cuando se compromete el server

1. Detén el proceso: `sudo pm2 stop imdb-waf-resolver`.
2. Rota el token inmediatamente.
3. Investiga `pm2 logs --err` y `/var/log/syslog`.
4. Considera `--purge` + reinstalación limpia si hay señales de persistencia.

---

## Historial de parches de seguridad

### v1.4.1 (actual)
- **Fix regresión**: el instalador preserva `HOST`, `PORT`, `CONCURRENCY`, `AUTH_TOKEN` existentes. Corrige flip silencioso introducido en v1.4.0.
- Ver: [4f2690f](https://github.com/doothemes/imdb-waf-resolver/commit/4f2690f).

### v1.4.0
- **[High]** `DEFAULT_HOST` cambiado de `0.0.0.0` → `127.0.0.1`. Deploys nuevos no exponen el puerto sin opt-in.
- **[High]** `ecosystem.config.js` creado con `umask 077` + `chmod 600` explícito. Token ya no legible por otros usuarios del host.
- **[High]** `/opt/imdb-waf-resolver/` con `chmod 700`. Defense in depth.
- **[High]** Rate limit por IP (`@fastify/rate-limit`, 120 req/min default) sobre `/scrape`.
- **[High]** Semáforo de concurrencia (`CONCURRENCY=3` default) — protege RAM contra bursts.
- **[Medium]** `timingSafeEqual` envuelto en try/catch + `Buffer.byteLength` — cierra edge case UTF-8 que podía crashear el hook de auth.
- **[Medium]** `pm2 startup` ya no ejecuta `sudo ... | bash` parseando stdout — elimina vector supply-chain.
- **[Medium]** `AUTH_TOKEN` NO se imprime en stdout del instalador — evita TTY/journald/cron leaks.
- **[Medium]** `--purge` ya no toca Node.js ni PM2 global — previene rotura en entornos compartidos (Plesk).
- **[Medium]** `pm2-logrotate` auto-instalado (10 MB, 7 retain, compress) — evita disk-fill.
- **[Low]** `bodyLimit: 1024` en Fastify.
- **[Low]** `max_memory_restart` subido de 500M a 800M — menos restarts prematuros por spikes legítimos.
- **[Low]** Warm-up rotado entre 5 IDs clásicos — reduce fingerprint determinista.
- Ver: [bc7d2bb](https://github.com/doothemes/imdb-waf-resolver/commit/bc7d2bb).

### v1.3.0
- Añadidos flags `--uninstall` y `--purge` al instalador. Ver: [82e2156](https://github.com/doothemes/imdb-waf-resolver/commit/82e2156).

### v1.2.0
- Soporte `GET /scrape?imdb_id=...` (además de POST). Ver: [dc169de](https://github.com/doothemes/imdb-waf-resolver/commit/dc169de).

### v1.1.0
- Warm-up en boot + `waitUntil: 'commit'` + devuelve `ld_json` parseado (reduce 1.5 MB → 2 KB por request). Ver: [f959eb5](https://github.com/doothemes/imdb-waf-resolver/commit/f959eb5).

### v1.0.0
- Release inicial: Chromium persistente + `/scrape` POST + Bearer auth + PM2 + `install.sh`.

---

## Auditoría externa recomendada

Si vas a desplegar esto en un entorno de producción **crítico** (alto tráfico, datos sensibles, obligaciones regulatorias), considera:

1. **Audit manual de `server.js`** — 250 LOC, scope acotado.
2. **Audit manual de `install.sh`** — 240 LOC.
3. **`npm audit`** periódico sobre `/opt/imdb-waf-resolver/node_modules/`.
4. **Pentest** del endpoint expuesto si lo pones en internet.
5. **Monitoring** de integridad (AIDE / Tripwire) sobre `/opt/imdb-waf-resolver/` si el host es multi-tenant.

---

**Última revisión**: v1.4.1 — 2026-04-23.
