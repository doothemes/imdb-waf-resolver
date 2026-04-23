'use strict';

/**
 * imdb-waf-resolver
 *
 * Microservicio interno que navega a IMDb con Chromium headless y devuelve el HTML
 * renderizado de la ficha. Chromium maneja transparentemente el challenge de AWS WAF:
 * el navegador resuelve el challenge en JS y espera a que aparezca el `ld+json` de
 * la página real antes de devolver el HTML.
 *
 * Por qué no hacemos token + cURL: AWS WAF fingerprint'ea el TLS del cliente; aunque
 * le pasemos la cookie válida a cURL, WAF rechaza porque la huella TLS no coincide
 * con Chromium. Hacer todo el fetch desde Chromium elimina esa fricción.
 *
 * Endpoints:
 *   POST /scrape     -> body { imdb_id } -> { status, html, final_url, elapsed_ms }
 *   GET  /health     -> { ok, browser: bool, context: bool }
 */

const fastify = require('fastify')({ logger: { level: 'info' } });
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();

chromiumExtra.use(StealthPlugin);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT           = parseInt(process.env.PORT || '3100', 10);
const HOST           = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN     = process.env.AUTH_TOKEN || '';
const NAV_TIMEOUT_MS = 60000;
const UA_REAL        = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

if(HOST !== '127.0.0.1' && HOST !== 'localhost' && !AUTH_TOKEN){
    console.error('[FATAL] HOST no-loopback sin AUTH_TOKEN. Define AUTH_TOKEN antes de exponer.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Browser context persistente — se abre una sola vez y se reutiliza
// ---------------------------------------------------------------------------

let browser     = null;
let context     = null;
let initPromise = null;

async function ensureContext() {
    if(context) return context;
    if(initPromise) return initPromise;

    initPromise = (async () => {
        browser = await chromiumExtra.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ],
        });
        context = await browser.newContext({
            userAgent: UA_REAL,
            locale:    'en-US',
            viewport:  { width: 1366, height: 768 },
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        });
        // Bloquear recursos pesados que no aportan al scraping de ld+json
        await context.route('**/*', (route) => {
            const t = route.request().resourceType();
            if(t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet'){
                return route.abort();
            }
            return route.continue();
        });
        fastify.log.info('browser + context listos');
        return context;
    })().catch(err => {
        initPromise = null;
        browser = null;
        context = null;
        throw err;
    }).finally(() => { initPromise = null; });

    return initPromise;
}

async function resetContext() {
    try { if(context) await context.close(); } catch(_) {}
    try { if(browser) await browser.close(); } catch(_) {}
    context = null;
    browser = null;
}

// ---------------------------------------------------------------------------
// Scrape — navega con Chromium y espera al ld+json de IMDb
// ---------------------------------------------------------------------------

async function scrapeImdb(imdbId) {
    const url = `https://www.imdb.com/title/${imdbId}/`;
    const ctx = await ensureContext();
    const page = await ctx.newPage();
    const start = Date.now();
    try {
        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout:   NAV_TIMEOUT_MS,
        });

        // Esperar al selector que solo existe en la ficha real de IMDb.
        // Si WAF sirvió challenge, el JS del navegador lo resuelve y
        // la navegación termina recargando al HTML legítimo.
        let ldJsonFound = false;
        try {
            await page.waitForSelector('script[type="application/ld+json"]', {
                timeout: NAV_TIMEOUT_MS,
                state:   'attached',
            });
            ldJsonFound = true;
        } catch(_) {
            // timeout — probablemente WAF no dejó pasar
        }

        const html  = await page.content();
        const final = page.url();
        const status = response ? response.status() : 0;
        return {
            status,
            html,
            final_url:  final,
            ld_json:    ldJsonFound,
            elapsed_ms: Date.now() - start,
        };
    } finally {
        await page.close().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

if(AUTH_TOKEN){
    fastify.addHook('onRequest', async (req, reply) => {
        if(req.url === '/health') return;
        const hdr  = req.headers['authorization'] || '';
        const sent = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
        if(sent.length !== AUTH_TOKEN.length ||
           !require('crypto').timingSafeEqual(Buffer.from(sent), Buffer.from(AUTH_TOKEN))){
            return reply.code(401).send({ error: 'unauthorized' });
        }
    });
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const IMDB_ID_RE = /^tt\d{7,8}$/;

fastify.post('/scrape', async (req, reply) => {
    const imdbId = req.body && req.body.imdb_id;
    if(!imdbId || !IMDB_ID_RE.test(imdbId)){
        return reply.code(400).send({ error: 'invalid_imdb_id' });
    }
    try {
        const r = await scrapeImdb(imdbId);
        req.log.info({
            imdb_id: imdbId,
            status:  r.status,
            ms:      r.elapsed_ms,
            bytes:   r.html.length,
            ld_json: r.ld_json,
        }, 'scrape');
        return r;
    } catch(err) {
        req.log.error({ imdb_id: imdbId, err: err.message }, 'scrape failed');
        // Si el context se rompió, resetear para que la próxima request relance Chromium
        await resetContext();
        return reply.code(502).send({ error: 'scrape_failed', message: err.message });
    }
});

fastify.get('/health', async () => ({
    ok:      true,
    browser: !!browser,
    context: !!context,
}));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

fastify.listen({ port: PORT, host: HOST })
    .then(() => fastify.log.info(`imdb-waf-resolver escuchando en http://${HOST}:${PORT}`))
    .catch(err => { fastify.log.error(err); process.exit(1); });

async function shutdown() {
    try { await fastify.close(); } catch(_) {}
    await resetContext();
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
