# imdb-waf-resolver

Microservicio Node + Chromium que navega a IMDb y devuelve el HTML renderizado de una ficha de título, resolviendo transparentemente el challenge de AWS WAF que IMDb sirve a clientes no-navegador.

Útil cuando necesitas el `ld+json` de una página de IMDb y cURL/wget se topan con HTTP 202 + challenge JavaScript.

---

## Instalación (Ubuntu / Debian, como root)

```bash
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash
```

El instalador:
- Instala Node 20 LTS (si falta)
- Instala PM2 global + `pm2-logrotate` (10 MB por archivo, 7 retenidos, comprimidos)
- Clona el repo a `/opt/imdb-waf-resolver` con permisos `700` (solo root)
- Instala deps npm + Chromium headless (via Playwright)
- Genera `ecosystem.config.js` con permisos `600` (el token solo lo lee root)
- Arranca con PM2 bindeado por defecto a **`127.0.0.1`** (solo loopback — seguro por defecto)
- Lo deja persistente en boot (systemd)
- Verifica que el puerto esté libre antes de arrancar

Correrlo otra vez actualiza al último `main` y preserva el token existente.

## Desinstalación

**Sidecar + código** (conserva Node, PM2 y caché de Chromium):

```bash
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash -s -- --uninstall
```

**Purga** — lo anterior + PM2 systemd unit + caché de Chromium + `~/.pm2`:

```bash
curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh | sudo bash -s -- --purge
```

**`--purge` NO toca Node.js ni PM2 global** — pueden ser usados por otros servicios (especialmente en Plesk). Si quieres removerlos, el script imprime los comandos manuales.

Las reglas de `ufw` nunca se tocan automáticamente — se removen a mano.

### Variables de entorno opcionales

```bash
# Exponer a la red (requiere AUTH_TOKEN)
HOST=0.0.0.0 AUTH_TOKEN=$(openssl rand -hex 32) \
  bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

| Var            | Default       | Descripción                                                |
|----------------|---------------|------------------------------------------------------------|
| `HOST`         | `127.0.0.1`   | Interfaz de bind. Para exponer: `0.0.0.0` (exige token).   |
| `PORT`         | `3100`        | Puerto TCP. Verifica colisión antes de instalar.           |
| `AUTH_TOKEN`   | (auto o vacío)| Bearer token. Auto-generado si `HOST != 127.0.0.1`.        |
| `CONCURRENCY`  | `3`           | Scrapes paralelos máximo. Excesos van a cola.              |
| `RATE_LIMIT_MAX` | `120`       | Requests por ventana/IP. `0` para desactivar.              |
| `RATE_LIMIT_WIN` | `1 minute`  | Ventana del rate limit.                                    |

---

## API

### `POST /scrape` o `GET /scrape`

**Auth:** `Authorization: Bearer <AUTH_TOKEN>` en ambos.

**POST body:**
```json
{ "imdb_id": "tt0111161" }
```

**GET query:**
```
/scrape?imdb_id=tt0111161
```

Ambos endpoints son equivalentes y retornan la misma estructura. Usa GET para pruebas rápidas en browser/curl, POST en producción.

**Response:**
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

- `status`: status HTTP de la navegación inicial (puede ser 202 aunque el contenido final sea la ficha real — Chromium resuelve el challenge transparentemente).
- `ld_json`: **objeto JSON-LD ya parseado** de la ficha, o `null` si no se encontró.
- `final_url`: URL final tras redirects.
- `elapsed_ms`: tiempo total de la operación.

### `GET /health`

Sin auth. Retorna:
```json
{ "ok": true, "browser": true, "context": true }
```

---

## Ejemplos de cliente

**cURL (POST):**
```bash
curl -X POST http://127.0.0.1:3100/scrape \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"imdb_id":"tt0111161"}'
```

**cURL (GET, más corto para testing):**
```bash
curl -H "Authorization: Bearer $AUTH_TOKEN" \
  "http://127.0.0.1:3100/scrape?imdb_id=tt0111161"
```

**PHP (CodeIgniter 4):**
```php
$client = \Config\Services::curlrequest();
$response = $client->post('http://127.0.0.1:3100/scrape', [
    'headers' => [
        'Authorization' => 'Bearer ' . env('imdbResolverToken'),
        'Content-Type'  => 'application/json',
    ],
    'json'    => ['imdb_id' => $imdb_id],
    'timeout' => 90,
]);
$data   = json_decode($response->getBody(), true);
$ldJson = $data['ld_json'] ?? null;  // array ya parseado, listo para usar
```

**Node:**
```js
const res = await fetch('http://127.0.0.1:3100/scrape', {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${process.env.AUTH_TOKEN}`,
        'Content-Type':  'application/json',
    },
    body: JSON.stringify({ imdb_id: 'tt0111161' }),
});
const { ld_json } = await res.json();
```

---

## Seguridad

**Defaults seguros**:
- Bind a `127.0.0.1` — no expuesto a la red sin opt-in explícito
- `ecosystem.config.js` con permisos `600` — token solo legible por root
- Dir `/opt/imdb-waf-resolver/` con permisos `700`
- Rate-limit por IP: 120 req/min (ajustable)
- Semáforo de concurrencia (3 simultáneas) — frena DoS por ráfagas
- Comparación tiempo-constante del Bearer token (`timingSafeEqual`)
- `bodyLimit: 1024` — rechaza payloads inflados
- El servidor **se niega a arrancar** si `HOST != 127.0.0.1` y no hay `AUTH_TOKEN`

**Si expones el puerto a internet** (HOST=0.0.0.0):

```bash
# Allow-list tu firewall a IPs específicas
sudo ufw allow from <IP_DEL_CLIENTE> to any port 3100 proto tcp
sudo ufw reload

# Considerar HTTPS con nginx reverse proxy + Let's Encrypt
# (no incluido en este repo — documentación pendiente)
```

---

## Arquitectura

Chromium persistente + context reusable. Abre un solo browser al primer request y atiende N requests concurrentes con pages separadas. Bloquea imágenes / fonts / CSS / media para acelerar.

**Warm-up al arrancar:** el servicio dispara un scrape dummy en background apenas termina de bootear. Así el `aws-waf-token` queda en el context antes del primer request real — el cold-start lo paga el warm-up, no el usuario.

**Fast path:** una vez el context tiene el cookie de WAF, IMDb sirve HTML directo sin challenge. Scrapes típicos: ~1–3 s. Cuando WAF rota el token (raro), paga el costo de challenge una vez (~5–8 s) y vuelve al fast path.

**Payload mínimo:** el ld+json se extrae dentro del navegador con `page.evaluate()`. El cliente recibe solo el JSON parseado (~2 KB), no el HTML entero (~1.5 MB).

Stack:
- [Fastify 4](https://fastify.dev/) — servidor HTTP
- [Playwright](https://playwright.dev/) + [playwright-extra](https://github.com/berstend/puppeteer-extra/tree/master/packages/playwright-extra) + [stealth plugin](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth)
- [PM2](https://pm2.keymetrics.io/) — gestor de procesos

---

## Troubleshooting

**`aws-waf-token no aparece` / HTML con `gokuProps`**  
WAF no dejó pasar. Prueba con otra IP de origen; residenciales pasan mejor que datacenter. Revisa `pm2 logs imdb-waf-resolver`.

**`ECONNREFUSED 127.0.0.1:3100`**  
El sidecar no está corriendo. `pm2 status`, `pm2 logs imdb-waf-resolver`.

**Memoria alta (>800 MB sostenido)**  
PM2 reinicia automáticamente (`max_memory_restart: '800M'`). Si se repite frecuentemente, baja `CONCURRENCY` o revisa con `pm2 monit`.

**HTTP 429 (rate limited)**  
Estás sobre el límite de 120 req/min/IP. Sube con `RATE_LIMIT_MAX=300 … bash <(curl …)` y `pm2 restart imdb-waf-resolver --update-env`.

**Requests en cola**  
El endpoint `/health` reporta `active` (scrapes corriendo) y `queued` (en espera). Si `queued` crece, sube `CONCURRENCY` — asegúrate que la RAM lo tolere.

**Comandos útiles:**
```bash
pm2 status
pm2 logs imdb-waf-resolver --lines 100
pm2 restart imdb-waf-resolver
pm2 delete imdb-waf-resolver
```

---

## Licencia

MIT © 2026 Doothemes
