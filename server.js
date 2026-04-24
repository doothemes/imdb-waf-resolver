'use strict';

/**
 * imdb-waf-resolver
 *
 * Microservicio Node + Chromium que navega a IMDb y devuelve el `ld+json`
 * renderizado de la ficha de un título, resolviendo transparentemente el
 * challenge de AWS WAF.
 *
 * Endpoints:
 *   POST /scrape   body { imdb_id } → { status, ld_json, final_url, elapsed_ms }
 *   GET  /scrape?imdb_id=tt...       → idem
 *   GET  /health                     → { ok, browser, context }
 *
 * Protecciones:
 *   - Auth Bearer (obligatorio si HOST != loopback) con comparación tiempo-constante
 *   - Rate-limit por IP (configurable) — @fastify/rate-limit
 *   - Semáforo de concurrencia (CONCURRENCY, default 3) — evita OOM por bursts
 *   - bodyLimit 1KB — previene payloads inflados
 */

const crypto = require('crypto');
const fastify = require('fastify')({
    logger:    { level: 'info' },
    bodyLimit: 1024, // 1KB es más que suficiente para {"imdb_id":"tt..."}
});
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();

chromiumExtra.use(StealthPlugin);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT            = parseInt(process.env.PORT || '3100', 10);
const HOST            = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN      = process.env.AUTH_TOKEN || '';
const CONCURRENCY     = parseInt(process.env.CONCURRENCY || '3', 10);
const RATE_LIMIT_MAX  = parseInt(process.env.RATE_LIMIT_MAX || '120', 10);
const RATE_LIMIT_WIN  = process.env.RATE_LIMIT_WIN || '1 minute';
const NAV_TIMEOUT_MS  = 60000;
const UA_REAL         = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Warm-up rotado: el primer scrape al boot usa uno de estos al azar para no
// fingerprint'ear al sidecar ante WAF como "siempre el mismo cliente".
const WARMUP_POOL = [
    'tt0111161', // The Shawshank Redemption
    'tt0068646', // The Godfather
    'tt0071562', // The Godfather Part II
    'tt0468569', // The Dark Knight
    'tt0108052', // Schindler's List
];

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
// Semáforo de concurrencia — protege RAM contra bursts
// ---------------------------------------------------------------------------

let activeSlots = 0;
const slotQueue = [];

async function acquireSlot() {
    if(activeSlots < CONCURRENCY){
        activeSlots++;
        return;
    }
    return new Promise((resolve) => {
        slotQueue.push(() => {
            activeSlots++;
            resolve();
        });
    });
}

function releaseSlot() {
    activeSlots--;
    const next = slotQueue.shift();
    if(next) next();
}

// ---------------------------------------------------------------------------
// Scrape
// ---------------------------------------------------------------------------

async function scrapeImdb(imdbId) {
    // WAF distingue entre URL limpia (202 + 0 bytes, rechazo silencioso) y URL
    // con ?ref_= (202 + challenge resoluble). Imitamos navegación orgánica.
    const url = `https://www.imdb.com/title/${imdbId}/?ref_=tt_sims_tt_t_1`;
    await acquireSlot();
    const ctx  = await ensureContext();
    const page = await ctx.newPage();
    const start = Date.now();
    try {
        const response = await page.goto(url, {
            waitUntil: 'commit',
            timeout:   NAV_TIMEOUT_MS,
        });

        let ldJson = null;
        try {
            await page.waitForSelector('script[type="application/ld+json"]', {
                timeout: NAV_TIMEOUT_MS,
                state:   'attached',
            });
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
        releaseSlot();
    }
}

// ---------------------------------------------------------------------------
// Auth (obligatoria si AUTH_TOKEN está seteado)
// ---------------------------------------------------------------------------

function checkAuth(req) {
    if(!AUTH_TOKEN) return true; // modo loopback sin token
    const hdr  = req.headers['authorization'] || '';
    const sent = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
    try {
        const sentBuf  = Buffer.from(sent, 'utf8');
        const tokenBuf = Buffer.from(AUTH_TOKEN, 'utf8');
        if(sentBuf.length !== tokenBuf.length) return false;
        return crypto.timingSafeEqual(sentBuf, tokenBuf);
    } catch(_) {
        return false;
    }
}

if(AUTH_TOKEN){
    fastify.addHook('onRequest', async (req, reply) => {
        if(req.url === '/health' || req.url.startsWith('/health?')) return;
        if(!checkAuth(req)){
            return reply.code(401).send({ error: 'unauthorized' });
        }
    });
}

// ---------------------------------------------------------------------------
// Rate limit (por IP)
// ---------------------------------------------------------------------------

fastify.register(require('@fastify/rate-limit'), {
    max:        RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WIN,
    allowList:  (req) => req.url === '/health' || req.url.startsWith('/health?'),
    // Mensaje limpio en 429
    errorResponseBuilder: (req, ctx) => ({
        error:       'rate_limited',
        retry_after: ctx.after,
    }),
});

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
    active:  activeSlots,
    queued:  slotQueue.length,
}));

// ---------------------------------------------------------------------------
// Boot + warm-up
// ---------------------------------------------------------------------------

fastify.listen({ port: PORT, host: HOST })
    .then(() => {
        fastify.log.info(`imdb-waf-resolver escuchando en http://${HOST}:${PORT} — concurrency=${CONCURRENCY} rate=${RATE_LIMIT_MAX}/${RATE_LIMIT_WIN}`);
        setTimeout(() => {
            const warmupId = WARMUP_POOL[Math.floor(Math.random() * WARMUP_POOL.length)];
            fastify.log.info({ imdb_id: warmupId }, 'warm-up iniciando');
            scrapeImdb(warmupId)
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
