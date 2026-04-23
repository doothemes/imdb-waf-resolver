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
- Instala PM2 global
- Clona el repo a `/opt/imdb-waf-resolver`
- Instala deps npm + Chromium headless (via Playwright)
- Genera un `AUTH_TOKEN` aleatorio (`openssl rand -hex 32`)
- Arranca con PM2 y lo deja persistente en boot
- Imprime URL, token, y ejemplo de `curl`

Correrlo otra vez actualiza al último `main` y preserva el token existente.

### Variables de entorno opcionales

```bash
HOST=0.0.0.0 PORT=3100 AUTH_TOKEN="mi-token-manual" \
  bash <(curl -fsSL https://raw.githubusercontent.com/doothemes/imdb-waf-resolver/main/install.sh)
```

| Var         | Default          | Descripción                                      |
|-------------|------------------|--------------------------------------------------|
| `HOST`      | `0.0.0.0`        | Interfaz donde escucha el servidor.              |
| `PORT`      | `3100`           | Puerto TCP.                                      |
| `AUTH_TOKEN`| aleatorio        | Bearer token obligatorio si `HOST != 127.0.0.1`. |

---

## API

### `POST /scrape`

**Auth:** `Authorization: Bearer <AUTH_TOKEN>`

**Body:**
```json
{ "imdb_id": "tt0111161" }
```

**Response:**
```json
{
  "status": 200,
  "html": "<!DOCTYPE html>...",
  "final_url": "https://www.imdb.com/title/tt0111161/",
  "ld_json": true,
  "elapsed_ms": 6041
}
```

- `status`: status HTTP de la navegación inicial (puede ser 202 aunque el HTML final sea la ficha real — Chromium resuelve el challenge).
- `html`: DOM renderizado final.
- `ld_json`: `true` si se encontró el `<script type="application/ld+json">` (tu señal de éxito).
- `elapsed_ms`: tiempo total de la operación.

### `GET /health`

Sin auth. Retorna:
```json
{ "ok": true, "browser": true, "context": true }
```

---

## Ejemplos de cliente

**cURL:**
```bash
curl -X POST http://127.0.0.1:3100/scrape \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"imdb_id":"tt0111161"}'
```

**PHP (CodeIgniter 4):**
```php
$client = \Config\Services::curlrequest();
$response = $client->post('http://127.0.0.1:3100/scrape', [
    'headers' => [
        'Authorization' => 'Bearer ' . env('imdbResolverToken'),
        'Content-Type'  => 'application/json',
    ],
    'json' => ['imdb_id' => $imdb_id],
    'timeout' => 90,
]);
$data = json_decode($response->getBody(), true);
preg_match('/<script type="application\/ld\+json">(.*?)<\/script>/s', $data['html'], $m);
$ldJson = json_decode($m[1] ?? '{}', true);
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
const { html } = await res.json();
```

---

## Seguridad

Si expones el puerto a internet, **configura tu firewall** para aceptar solo desde las IPs de tus clientes:

```bash
sudo ufw allow from <IP_DEL_CLIENTE> to any port 3100 proto tcp
sudo ufw reload
```

El `AUTH_TOKEN` se valida con comparación tiempo-constante. El servidor rechaza arrancar si `HOST != 127.0.0.1` y no hay `AUTH_TOKEN` definido.

---

## Arquitectura

Chromium persistente + context reusable. Abre un solo browser al primer request y atiende N requests concurrentes con pages separadas. Bloquea imágenes / fonts / CSS / media para acelerar (solo interesa el HTML).

La primera request tras el arranque tarda ~5–10 s (Chromium cold start). Siguientes con el context caliente: ~1–3 s.

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

**Memoria alta (>500 MB sostenido)**  
PM2 reinicia automáticamente (`max_memory_restart: '500M'`). Si se repite, abre un issue con `pm2 monit`.

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
