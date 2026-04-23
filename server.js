'use strict';

/**
 * imdb-waf-resolver
 *
 * Microservicio Node + Chromium que navega a IMDb y devuelve el `ld+json`
 * renderizado de la ficha de un título, resolviendo transparentemente el
 * challenge de AWS WAF.
 *
 * Diseño:
 *   - Un único Chromium persistente con context reusable (cookies sobreviven
 *     entre requests, incluyendo aws-waf-token → los scrapes después del
 *     primero saltan el challenge).
 *   - Warm-up en boot: un scrape dummy en background al arrancar para que
 *     el primer request real llegue con WAF ya superado.
 *   - `waitUntil: 'commit'` + `waitForSelector('script[type=application/ld+json]')`:
 *     retornamos apenas aparece el ld+json en el DOM, sin esperar load/DOMContentLoaded.
 *   - Extracción en el navegador (`page.evaluate`): solo cruzamos ~2KB por la
 *     red Node↔cliente en vez de 1.5MB de HTML renderizado.
 *
 * Endpoints:
 *   POST /scrape   body { imdb_id } → { status, ld_json, final_url, elapsed_ms }
 *   GET  /health                    → { ok, browser, context }
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
const WARMUP_IMDB_ID = 'tt0111161'; // The Shawshank Redemption — estable, pocos cambios
const UA_REAL        = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

if(HOST !== '127.0.0.1' && HOST !== 'localhost' && !AUTH_TOKEN){
    console.error('[FATAL] HOST no-loopback sin AUTH_TOKEN. Define AUTH_TOKEN antes de exponer.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Browser context persistente
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
                '--disable-extensions',
                '--disable-background-timer-throttling',
            ],
        });
        context = await browser.newContext({
            userAgent: UA_REAL,
            locale:    'en-US',
            viewport:  { width: 1366, height: 768 },
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        });
        // Bloquear recursos que no aportan al scraping — acelera challenge + page load
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
// Scrape
// ---------------------------------------------------------------------------

async function scrapeImdb(imdbId) {
    // El `?ref_=` hace que WAF trate la request como navegación orgánica (tolerante,
    // sirve challenge resoluble) en vez de "acceso directo" (202 con body vacío).
    const url = `https://www.imdb.com/title/${imdbId}/?ref_=tt_sims_tt_t_1`;
    const ctx = await ensureContext();
    const page = await ctx.newPage();
    const start = Date.now();
    try {
        const response = await page.goto(url, {
            waitUntil: 'commit',   // retorna al primer byte — no espera DOMContentLoaded
            timeout:   NAV_TIMEOUT_MS,
        });

        // Espera a que el ld+json aparezca en el DOM.
        // Si WAF sirvió challenge, el JS del browser lo resuelve y la
        // navegación termina reemplazando el DOM con el HTML real.
        let ldJson = null;
        try {
            await page.waitForSelector('script[type="application/ld+json"]', {
                timeout: NAV_TIMEOUT_MS,
                state:   'attached',
            });
            // Extraer el JSON directamente en el browser — evita serializar ~1.5MB de HTML
            const raw = await page.evaluate(() => {
                const s = document.querySelector('script[type="application/ld+json"]');
                return s ? s.textContent : null;
            });
            if(raw){
                try { ldJson = JSON.parse(raw); } catch(_) { /* keep null */ }
            }
        } catch(_) {
            // timeout — WAF bloqueó o la página no tiene ld+json
        }

        return {
            status:     response ? response.status() : 0,
            ld_json:    ldJson,
            final_url:  page.url(),
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

async function handleScrape(imdbId, req, reply) {
    if(!imdbId || !IMDB_ID_RE.test(imdbId)){
        return reply.code(400).send({ error: 'invalid_imdb_id' });
    }
    try {
        const r = await scrapeImdb(imdbId);
        req.log.info({
            imdb_id: imdbId,
            status:  r.status,
            ms:      r.elapsed_ms,
            ld_json: !!r.ld_json,
        }, 'scrape');
        return r;
    } catch(err) {
        req.log.error({ imdb_id: imdbId, err: err.message }, 'scrape failed');
        await resetContext();
        return reply.code(502).send({ error: 'scrape_failed', message: err.message });
    }
}

fastify.post('/scrape', async (req, reply) => {
    return handleScrape(req.body && req.body.imdb_id, req, reply);
});

fastify.get('/scrape', async (req, reply) => {
    return handleScrape(req.query && req.query.imdb_id, req, reply);
});

fastify.get('/health', async () => ({
    ok:      true,
    browser: !!browser,
    context: !!context,
}));

// ---------------------------------------------------------------------------
// Boot + warm-up
// ---------------------------------------------------------------------------

fastify.listen({ port: PORT, host: HOST })
    .then(() => {
        fastify.log.info(`imdb-waf-resolver escuchando en http://${HOST}:${PORT}`);
        // Warm-up en background: resuelve el challenge antes del primer request real
        setTimeout(() => {
            fastify.log.info({ imdb_id: WARMUP_IMDB_ID }, 'warm-up iniciando');
            scrapeImdb(WARMUP_IMDB_ID)
                .then(r => fastify.log.info({ ms: r.elapsed_ms, ld_json: !!r.ld_json }, 'warm-up listo'))
                .catch(err => fastify.log.warn({ err: err.message }, 'warm-up falló'));
        }, 1500);
    })
    .catch(err => { fastify.log.error(err); process.exit(1); });

async function shutdown() {
    try { await fastify.close(); } catch(_) {}
    await resetContext();
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
