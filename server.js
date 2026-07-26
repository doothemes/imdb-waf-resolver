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
const QUEUE_MAX       = parseInt(process.env.QUEUE_MAX || '50', 10);
const QUEUE_WAIT_MS   = parseInt(process.env.QUEUE_WAIT_MS || '30000', 10);
const RATE_LIMIT_MAX  = parseInt(process.env.RATE_LIMIT_MAX || '120', 10);
const RATE_LIMIT_WIN  = process.env.RATE_LIMIT_WIN || '1 minute';
const NAV_TIMEOUT_MS  = 60000;
// Espera del ld+json, separada del timeout de navegación. Un scrape sano tarda
// ~2s; si el WAF nos sirve un captcha el selector NUNCA aparece, y esperar 60s
// por petición retenía un slot durante un minuto. Con CONCURRENCY=3 eso son 3
// peticiones/minuto de capacidad: la cola crece sola aunque no haya fuga.
const LD_WAIT_MS      = parseInt(process.env.LD_WAIT_MS || '20000', 10);
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
    // Comprobamos isConnected() y no solo `context != null`: si Chromium murió
    // hace un instante y el evento 'disconnected' aún no corrió, devolveríamos
    // un context inservible.
    if(context && browser && browser.isConnected()) return context;
    if(initPromise) return initPromise;
    if(context || browser) await resetContext();

    initPromise = (async () => {
        const b = await chromiumExtra.launch({
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
        // Chromium puede morir por OOM o crash. Sin esto, `browser`/`context`
        // seguirían no-nulos apuntando a un proceso muerto y ensureContext()
        // devolvería un context inservible en cada scrape posterior.
        b.on('disconnected', () => {
            if(browser !== b) return; // ya fue reemplazado por un relaunch
            fastify.log.warn('chromium desconectado — se relanzará en el próximo scrape');
            browser = null;
            context = null;
        });
        browser = b;
        context = await b.newContext({
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

// Rechazo explícito en vez de encolar sin fin. Antes la cola no tenía tope ni
// timeout: cuando los slots se filtraban, las peticiones se apilaban para
// siempre (5000+ observadas en producción) y el cliente veía 502 por timeout.
class SlotUnavailableError extends Error {
    constructor(reason) {
        super(reason);
        this.slotUnavailable = true;
    }
}

function acquireSlot() {
    if(activeSlots < CONCURRENCY){
        activeSlots++;
        return Promise.resolve();
    }
    if(slotQueue.length >= QUEUE_MAX){
        return Promise.reject(new SlotUnavailableError('queue_full'));
    }
    return new Promise((resolve, reject) => {
        const entry = { resolve, timer: null };
        entry.timer = setTimeout(() => {
            const i = slotQueue.indexOf(entry);
            if(i !== -1) slotQueue.splice(i, 1);
            reject(new SlotUnavailableError('queue_timeout'));
        }, QUEUE_WAIT_MS);
        slotQueue.push(entry);
    });
}

function releaseSlot() {
    activeSlots--;
    const next = slotQueue.shift();
    if(next){
        clearTimeout(next.timer);
        activeSlots++;
        next.resolve();
    }
}

// ---------------------------------------------------------------------------
// Scrape
// ---------------------------------------------------------------------------

async function scrapeImdb(imdbId) {
    // WAF distingue entre URL limpia (202 + 0 bytes, rechazo silencioso) y URL
    // con ?ref_= (202 + challenge resoluble). Imitamos navegación orgánica.
    const url = `https://www.imdb.com/title/${imdbId}/?ref_=tt_sims_tt_t_1`;
    // acquireSlot() va fuera del try; todo lo demás dentro. Si ensureContext()
    // o newPage() lanzan (chromium muerto), el slot DEBE volver igual — antes
    // quedaban fuera del finally y cada fallo filtraba un slot hasta colgar
    // el servicio de forma permanente.
    await acquireSlot();
    try {
        const ctx   = await ensureContext();
        const page  = await ctx.newPage();
        const start = Date.now();
        try {
            const response = await page.goto(url, {
                waitUntil: 'commit',
                timeout:   NAV_TIMEOUT_MS,
            });

            let ldJson = null;
            try {
                await page.waitForSelector('script[type="application/ld+json"]', {
                    timeout: LD_WAIT_MS,
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

            // Sin ld+json, distinguimos "el WAF nos frenó" de "esta ficha no lo
            // trae". Antes ambos casos devolvían ld_json:null sin más, que es
            // justo lo que hacía imposible diagnosticar el bloqueo.
            let blockedBy = null;
            if(!ldJson){
                blockedBy = await page.evaluate(() => {
                    const t = (document.title || '').toLowerCase();
                    const b = (document.body ? document.body.innerText : '').toLowerCase();
                    if(t.includes('human verification') || b.includes('confirm you are human')) return 'waf_captcha';
                    if(t.includes('robot') || b.includes('are you a robot')) return 'waf_captcha';
                    if(b.includes('request blocked') || b.includes('access denied')) return 'waf_blocked';
                    return null;
                }).catch(() => null);
            }

            return {
                status:     response ? response.status() : 0,
                ld_json:    ldJson,
                blocked_by: blockedBy,
                final_url:  page.url(),
                elapsed_ms: Date.now() - start,
            };
        } finally {
            await page.close().catch(() => {});
        }
    } finally {
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
            imdb_id:    imdbId,
            status:     r.status,
            ms:         r.elapsed_ms,
            ld_json:    !!r.ld_json,
            blocked_by: r.blocked_by,
        }, 'scrape');
        return r;
    } catch(err) {
        if(err.slotUnavailable){
            req.log.warn({ imdb_id: imdbId, reason: err.message, queued: slotQueue.length }, 'slot no disponible');
            return reply.code(503).send({ error: 'busy', reason: err.message });
        }
        req.log.error({ imdb_id: imdbId, err: err.message }, 'scrape failed');
        // Solo reciclamos el browser si de verdad murió. Resetear ante cualquier
        // error (p.ej. un timeout de navegación) cerraba el Chromium por debajo
        // de los otros scrapes en vuelo, generando más errores y más resets.
        if(!browser || !browser.isConnected()){
            await resetContext();
        }
        return reply.code(502).send({ error: 'scrape_failed', message: err.message });
    }
}

fastify.post('/scrape', async (req, reply) => {
    return handleScrape(req.body && req.body.imdb_id, req, reply);
});

fastify.get('/scrape', async (req, reply) => {
    return handleScrape(req.query && req.query.imdb_id, req, reply);
});

fastify.get('/health', async (req, reply) => {
    // `saturated` = todos los slots ocupados y la cola llena. Con la fuga de
    // slots arreglada esto solo debería verse bajo carga real, pero es la señal
    // que hay que monitorear: es el estado en el que el servicio deja de servir.
    const saturated = activeSlots >= CONCURRENCY && slotQueue.length >= QUEUE_MAX;
    if(saturated) reply.code(503);
    return {
        ok:      !saturated,
        browser: !!(browser && browser.isConnected()),
        context: !!context,
        active:  activeSlots,
        queued:  slotQueue.length,
    };
});

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
