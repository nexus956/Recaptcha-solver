// language: JavaScript (Node.js), file: recaptcha_solver.js, target: Node 18+
// reCAPTCHA solver — v2 checkbox, v2 invisible, v2 enterprise,
// v3, v3 enterprise. Single /solve endpoint, rebrowser-playwright pool.
// Audio challenge auto-solver: persistent offline Vosk STT daemon + SoX.

const express = require('express');
const { chromium } = require('rebrowser-playwright');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const readline = require('readline');

const PORT = process.env.PORT || 6868;
const POOL = parseInt(process.env.POOL_SIZE || '10', 10);
const TO = parseInt(process.env.TIMEOUT || '35', 10);

const TRANSCRIBE_PY = path.join(__dirname, 'transcribe.py');
const VOSK_PYTHON   = path.join(__dirname, 'venv', 'bin', 'python');
const VOSK_WORKER   = path.join(__dirname, 'vosk_worker.py');

// ─── Persistent Vosk Worker Client ────────────────────────────────────────────

class VoskWorkerClient {
    constructor() {
        this.process = null;
        this.rl = null;
        this.pending = [];
        this.ready = false;
        this.seq = 0;
        this.init();
    }

    init() {
        if (!fs.existsSync(VOSK_WORKER)) return;
        try {
            const pyBin = fs.existsSync(VOSK_PYTHON) ? VOSK_PYTHON : (process.env.PYTHON_BIN || 'python3');
            this.process = spawn(pyBin, [VOSK_WORKER], {
                stdio: ['pipe', 'pipe', 'inherit']
            });

            this.rl = readline.createInterface({
                input: this.process.stdout,
                terminal: false
            });

            this.rl.on('line', line => {
                try {
                    const data = JSON.parse(line.trim());
                    if (data.ready) {
                        this.ready = true;
                        console.log(`  [vosk] persistent worker ready (model loaded in ${data.load_time}s)`);
                        return;
                    }
                    let reqIndex = -1;
                    if (typeof data.id !== 'undefined') {
                        reqIndex = this.pending.findIndex(p => p.id === data.id);
                    }
                    if (reqIndex === -1 && this.pending.length > 0) {
                        reqIndex = 0;
                    }
                    if (reqIndex !== -1) {
                        const [req] = this.pending.splice(reqIndex, 1);
                        if (req) req.resolve(data);
                    }
                } catch (e) {
                    console.error('  [vosk] parse error:', e.message);
                }
            });

            this.process.on('exit', code => {
                this.ready = false;
                const err = new Error(`Vosk worker died (code ${code})`);
                while (this.pending.length) {
                    const req = this.pending.shift();
                    req.reject(err);
                }
                setTimeout(() => this.init(), 1000);
            });

            this.process.on('error', err => {
                console.error('  [vosk] process error:', err.message);
            });
        } catch (e) {
            console.error('  [vosk] failed to launch worker:', e.message);
        }
    }

    async transcribe(wavPath) {
        if (!this.process || this.process.killed || !this.ready) {
            return this.transcribeFallback(wavPath);
        }

        const reqId = ++this.seq;
        return new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                const idx = this.pending.findIndex(p => p.id === reqId);
                if (idx !== -1) this.pending.splice(idx, 1);
                resolve(this.transcribeFallback(wavPath));
            }, 6000);

            this.pending.push({
                id: reqId,
                resolve: data => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(data.text || data.raw || '');
                },
                reject: () => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(this.transcribeFallback(wavPath));
                }
            });

            try {
                this.process.stdin.write(JSON.stringify({ id: reqId, wav: wavPath }) + '\n');
            } catch {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    const idx = this.pending.findIndex(p => p.id === reqId);
                    if (idx !== -1) this.pending.splice(idx, 1);
                    resolve(this.transcribeFallback(wavPath));
                }
            }
        });
    }

    transcribeFallback(wavPath) {
        try {
            const out = execSync(`"${VOSK_PYTHON}" "${TRANSCRIBE_PY}" "${wavPath}"`, {
                timeout: 8000,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore']
            }).trim();
            return out || '';
        } catch {
            return '';
        }
    }

    destroy() {
        if (this.process) {
            try { this.process.kill(); } catch {}
            this.process = null;
        }
    }
}

const voskWorker = new VoskWorkerClient();

// ─── page builders ────────────────────────────────────────────────────────────

function buildV2Page(siteKey, isEnterprise) {
    const src = isEnterprise
        ? 'https://www.google.com/recaptcha/enterprise.js?onload=__rc_render&render=explicit'
        : 'https://www.google.com/recaptcha/api.js?onload=__rc_render&render=explicit';
    const ns = isEnterprise ? 'grecaptcha.enterprise' : 'grecaptcha';
    return `<!DOCTYPE html><html><head>
<script>
window.__rc_token = null;
window.__rc_rendered = false;
function __rc_cb(t) { window.__rc_token = t; }
function __rc_render() {
    if (window.__rc_rendered) return;
    try {
        var el = document.getElementById('rc');
        var api = ${ns};
        if (el && typeof api !== 'undefined' && typeof api.render === 'function') {
            window.__rc_rendered = true;
            api.render(el, { sitekey: '${siteKey}', callback: '__rc_cb', theme: 'dark' });
        }
    } catch(e) {}
}
var __rc_int = setInterval(function() {
    if (window.__rc_rendered) { clearInterval(__rc_int); return; }
    __rc_render();
}, 40);
window.addEventListener('DOMContentLoaded', __rc_render);
</script>
<script src="${src}" async defer></script>
</head><body style="background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div id="rc"></div></body></html>`;
}

function buildV2InvisiblePage(siteKey, isEnterprise) {
    const src = isEnterprise
        ? 'https://www.google.com/recaptcha/enterprise.js?onload=__rc_render&render=explicit'
        : 'https://www.google.com/recaptcha/api.js?onload=__rc_render&render=explicit';
    const ns = isEnterprise ? 'grecaptcha.enterprise' : 'grecaptcha';
    return `<!DOCTYPE html><html><head>
<script>
window.__rc_token = null;
window.__rc_rendered = false;
function __rc_cb(t) { window.__rc_token = t; }
function __rc_render() {
    if (window.__rc_rendered) return;
    try {
        var el = document.getElementById('rc');
        var api = ${ns};
        if (el && typeof api !== 'undefined' && typeof api.render === 'function') {
            window.__rc_rendered = true;
            var wid = api.render(el, { sitekey: '${siteKey}', size: 'invisible', callback: '__rc_cb' });
            setTimeout(function() { try { api.execute(wid); } catch(e) {} }, 100);
        }
    } catch(e) {}
}
var __rc_int = setInterval(function() {
    if (window.__rc_rendered) { clearInterval(__rc_int); return; }
    __rc_render();
}, 40);
window.addEventListener('DOMContentLoaded', __rc_render);
</script>
<script src="${src}" async defer></script>
</head><body style="background:#111"><div id="rc"></div></body></html>`;
}

function buildV3Page(siteKey, action, isEnterprise) {
    const src = isEnterprise
        ? `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}`
        : `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    const ns = isEnterprise ? 'grecaptcha.enterprise' : 'grecaptcha';
    return `<!DOCTYPE html><html><head>
<script>
window.__rc_token = null;
window.__rc_executed = false;
function __rc_go() {
    if (window.__rc_executed) return;
    try {
        var api = ${ns};
        if (typeof api !== 'undefined' && typeof api.ready === 'function') {
            window.__rc_executed = true;
            api.ready(function() {
                api.execute('${siteKey}', { action: '${action}' }).then(function(t) {
                    window.__rc_token = t;
                }).catch(function(e) {
                    window.__rc_err = String(e);
                });
            });
        }
    } catch(e) {}
}
var __rc_int = setInterval(function() {
    if (window.__rc_executed) { clearInterval(__rc_int); return; }
    __rc_go();
}, 40);
window.addEventListener('DOMContentLoaded', __rc_go);
</script>
<script src="${src}" async defer></script>
</head><body style="background:#111"></body></html>`;
}

// ─── browser pool ─────────────────────────────────────────────────────────────

let browser;
const ctxPool = [];

const DEFAULT_PROXY = process.env.PROXY || process.env.HTTP_PROXY || process.env.http_proxy || null;

async function extractToken(pg) {
    return await pg.evaluate(() => {
        if (window.__rc_token && window.__rc_token.length > 20) return window.__rc_token;
        try {
            if (typeof grecaptcha !== 'undefined' && typeof grecaptcha.getResponse === 'function') {
                const r = grecaptcha.getResponse();
                if (r && r.length > 20) return r;
            }
        } catch(e) {}
        try {
            const ta = document.querySelector('[name="g-recaptcha-response"], #g-recaptcha-response');
            if (ta && ta.value && ta.value.length > 20) return ta.value;
        } catch(e) {}
        return null;
    }).catch(() => null);
}

function parseProxy(proxyStr) {
    if (!proxyStr) return undefined;
    let s = proxyStr.trim();
    if (!s) return undefined;
    let protocol = 'http:';

    const protoMatch = s.match(/^([a-zA-Z0-9+.-]+):\/\//);
    if (protoMatch) {
        protocol = protoMatch[1].toLowerCase() + ':';
        s = s.slice(protoMatch[0].length);
    }

    if (s.includes('@')) {
        const atIdx = s.lastIndexOf('@');
        const auth = s.slice(0, atIdx);
        const hostPort = s.slice(atIdx + 1);
        const colonIdx = auth.indexOf(':');
        const cfg = { server: `${protocol}//${hostPort}` };
        if (colonIdx !== -1) {
            cfg.username = decodeURIComponent(auth.slice(0, colonIdx));
            cfg.password = decodeURIComponent(auth.slice(colonIdx + 1));
        } else {
            cfg.username = decodeURIComponent(auth);
        }
        return cfg;
    }

    const parts = s.split(':');
    if (parts.length >= 4) {
        const isPort1 = /^\d{2,5}$/.test(parts[1]) && parseInt(parts[1], 10) <= 65535;
        const isPortLast = /^\d{2,5}$/.test(parts[parts.length - 1]) && parseInt(parts[parts.length - 1], 10) <= 65535;

        if (isPort1 && (!isPortLast || parts[0].includes('.') || !parts[parts.length - 2].includes('.'))) {
            const host = parts[0];
            const port = parts[1];
            const user = parts[2];
            const pass = parts.slice(3).join(':');
            return {
                server: `${protocol}//${host}:${port}`,
                username: user,
                password: pass
            };
        } else if (isPortLast) {
            const port = parts[parts.length - 1];
            const host = parts[parts.length - 2];
            const auth = parts.slice(0, parts.length - 2);
            return {
                server: `${protocol}//${host}:${port}`,
                username: auth[0],
                password: auth.slice(1).join(':')
            };
        }
    }

    if (parts.length === 2 && /^\d{1,5}$/.test(parts[1])) {
        return { server: `${protocol}//${parts[0]}:${parts[1]}` };
    }

    try {
        const u = new URL(proxyStr.includes('://') ? proxyStr : `${protocol}//${proxyStr}`);
        const cfg = { server: `${u.protocol}//${u.host}` };
        if (u.username) cfg.username = decodeURIComponent(u.username);
        if (u.password) cfg.password = decodeURIComponent(u.password);
        return cfg;
    } catch {
        return { server: proxyStr };
    }
}

const CTX_OPTS = {
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    ...(DEFAULT_PROXY ? { proxy: parseProxy(DEFAULT_PROXY) } : {}),
};

async function launchBrowser() {
    const b = await chromium.launch({
        headless: process.env.HEADLESS !== 'false',
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--disable-extensions',
            '--no-first-run',
        ]
    });
    b.on('disconnected', () => {
        console.log('  [browser] disconnected — relaunching in 2s…');
        ctxPool.length = 0;
        setTimeout(async () => {
            try {
                browser = await launchBrowser();
                for (let i = 0; i < POOL; i++)
                    ctxPool.push(await browser.newContext(CTX_OPTS));
                console.log('  [browser] relaunched ok');
            } catch (e) { console.error('  [browser] relaunch failed:', e.message); }
        }, 2000);
    });
    return b;
}

async function grabCtx(customProxy) {
    if (!browser || !browser.isConnected()) {
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            if (browser && browser.isConnected()) break;
        }
    }
    const ctx = customProxy
        ? await browser.newContext({ ...CTX_OPTS, proxy: parseProxy(customProxy) })
        : (ctxPool.length > 0 ? ctxPool.shift() : await browser.newContext(CTX_OPTS));

    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    }).catch(() => {});

    return { ctx, isPooled: !customProxy };
}

async function dropCtx(handle) {
    if (!handle || !handle.ctx) return;
    if (handle.isPooled && ctxPool.length < POOL) {
        await handle.ctx.clearCookies().catch(() => {});
        ctxPool.push(handle.ctx);
    } else {
        await handle.ctx.close().catch(() => {});
    }
}

// ─── human mouse movement ─────────────────────────────────────────────────────

async function fastHumanClick(pg, box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const sx = cx + 50 + rand(40);
    const sy = cy - 25 + rand(35);

    await pg.mouse.move(sx, sy);
    await sleep(25 + rand(25));

    const steps = 6 + Math.floor(rand(4));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mx = sx + (cx - sx) * t + Math.sin(t * Math.PI) * (4 + rand(5));
        const my = sy + (cy - sy) * t + Math.cos(t * Math.PI) * (2 + rand(3));
        await pg.mouse.move(mx, my);
        await sleep(5 + rand(8));
    }

    await sleep(15 + rand(20));
    await pg.mouse.click(cx, cy);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = n => Math.random() * n;

// ─── audio challenge solver ───────────────────────────────────────────────────

function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const tmp = path.join(os.tmpdir(), `rc_audio_${Date.now()}_${Math.floor(rand(10000))}.mp3`);
        const file = fs.createWriteStream(tmp);
        const getter = url.startsWith('https') ? https : http;
        const req = getter.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close(() => {
                    try { fs.unlinkSync(tmp); } catch {}
                    downloadFile(res.headers.location).then(resolve, reject);
                });
                return;
            }
            if (res.statusCode !== 200) {
                file.close(() => {
                    try { fs.unlinkSync(tmp); } catch {}
                    reject(new Error(`HTTP ${res.statusCode}`));
                });
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve(tmp));
            });
        });
        req.setTimeout(6000, () => {
            req.destroy(new Error('audio download timeout'));
        });
        req.on('error', err => {
            file.close(() => {
                try { fs.unlinkSync(tmp); } catch {}
                reject(err);
            });
        });
    });
}

// ─── solvers ──────────────────────────────────────────────────────────────────

async function solveV2(siteUrl, siteKey, invisible, isEnterprise, timeout, proxy) {
    const t0 = Date.now();
    const dl = t0 + timeout * 1000;
    let attempt = 0;
    let lastErr = 'timeout';

    while (Date.now() < dl - 4000) {
        attempt++;
        const remainingSec = Math.max(5, (dl - Date.now()) / 1000);
        const res = await solveV2Single(siteUrl, siteKey, invisible, isEnterprise, remainingSec, proxy);
        if (res.success) {
            return { ...res, time: elapsed(t0) };
        }
        lastErr = res.err;

        if (Date.now() < dl - 4000) {
            console.log(`  [v2] attempt ${attempt} failed (${res.err}), ${proxy ? 'rotating proxy IP...' : 'retrying...'}`);
            await sleep(100);
            continue;
        }
        break;
    }
    return { success: false, err: lastErr };
}

async function solveV2Single(siteUrl, siteKey, invisible, isEnterprise, timeout, proxy) {
    const t0 = Date.now();
    const handle = await grabCtx(proxy);
    const pg = await handle.ctx.newPage();

    try {
        const html = invisible
            ? buildV2InvisiblePage(siteKey, isEnterprise)
            : buildV2Page(siteKey, isEnterprise);

        const origin = new URL(siteUrl).origin;
        await pg.route('**', route => {
            const req = route.request();
            const u = req.url();
            if (u.includes('/recaptcha/api2/') || u.includes('/recaptcha/enterprise/') || u.includes('/recaptcha/api.js')) {
                return route.continue();
            }
            if (req.frame() === pg.mainFrame() && req.resourceType() === 'document' && u.startsWith(origin)) {
                return route.fulfill({ body: html, contentType: 'text/html', status: 200 });
            }
            return route.continue();
        });

        await pg.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const dl = t0 + timeout * 1000;

        // If checkbox mode, find anchor frame reactively
        if (!invisible) {
            let anchorFrame = null;
            const anchorDeadline = Math.min(dl, t0 + 12000);
            while (Date.now() < anchorDeadline) {
                anchorFrame = pg.frames().find(f =>
                    f.url().includes('recaptcha/api2/anchor') || f.url().includes('recaptcha/enterprise/anchor'));
                if (anchorFrame) break;

                const iframeHandle = await pg.$('iframe[src*="anchor"], iframe[title*="reCAPTCHA"]').catch(() => null);
                if (iframeHandle) {
                    const cf = await iframeHandle.contentFrame().catch(() => null);
                    if (cf) {
                        anchorFrame = cf;
                        break;
                    }
                }

                // If still not rendered after 800ms, actively nudge the render function
                if (Date.now() - t0 > 800) {
                    await pg.evaluate(() => window.__rc_render && window.__rc_render()).catch(() => {});
                }

                await sleep(40);
            }

            if (!anchorFrame) {
                const hasGrecaptcha = await pg.evaluate(() => typeof grecaptcha !== 'undefined').catch(() => false);
                return { 
                    success: false, 
                    err: hasGrecaptcha ? 'anchor_frame_not_found' : 'google_recaptcha_api_failed_to_load' 
                };
            }

            const anchorBtn = anchorFrame.locator('#recaptcha-anchor');
            let anchorBox = null;
            for (let i = 0; i < 25; i++) {
                anchorBox = await anchorBtn.boundingBox().catch(() => null);
                if (anchorBox && anchorBox.width > 0) break;
                await sleep(40);
            }

            if (anchorBox) {
                await fastHumanClick(pg, anchorBox);
            } else {
                await anchorBtn.click({ force: true, timeout: 3000 }).catch(() => {});
            }
        }

        // Wait reactively for instant solve OR challenge bframe
        let bframe = null;
        const bframeDeadline = invisible ? Math.min(dl, Date.now() + 14000) : Math.min(dl, Date.now() + 6000);
        while (Date.now() < bframeDeadline) {
            const token = await extractToken(pg);
            if (token && token.length > 20)
                return { success: true, token, time: elapsed(t0) };

            bframe = pg.frames().find(f =>
                f.url().includes('/bframe') || f.url().includes('/enterprise/bframe'));
            if (bframe) {
                const blocked = await bframe.evaluate(() => 
                    !!document.querySelector('.rc-doscaptcha-body, .rc-doscaptcha-body-text') || 
                    (document.body && document.body.innerText.includes('automated queries'))
                ).catch(() => false);
                if (blocked) {
                    return { success: false, err: 'blocked_by_google_automated_queries' };
                }

                const audioBtn = bframe.locator('#recaptcha-audio-button');
                const audioBox = await audioBtn.boundingBox().catch(() => null);
                if (audioBox && audioBox.width > 0) {
                    await fastHumanClick(pg, audioBox);
                    break;
                } else if (await audioBtn.count().catch(() => 0) > 0) {
                    await audioBtn.click({ force: true, timeout: 3000 }).catch(() => {});
                    break;
                }

                const imageOnly = await bframe.locator('.rc-imageselect-challenge, #rc-imageselect').isVisible().catch(() => false);
                if (imageOnly) {
                    return { success: false, err: 'image_challenge_required_audio_blocked' };
                }
            }
            await sleep(40);
        }

        const earlyToken = await extractToken(pg);
        if (earlyToken && earlyToken.length > 20)
            return { success: true, token: earlyToken, time: elapsed(t0) };

        if (!bframe && !invisible) {
            return { success: false, err: 'bframe_not_opened' };
        }

        // Handle audio challenge inside bframe
        if (bframe) {
            let round = 1;
            let lastAudioUrl = null;

            while (Date.now() < dl - 2000 && round <= 3) {
                let mp3Url = null;
                const audioDeadline = Math.min(dl, Date.now() + 5000);
                while (Date.now() < audioDeadline) {
                    const token = await pg.evaluate(() => window.__rc_token).catch(() => null);
                    if (token && token.length > 20)
                        return { success: true, token, time: elapsed(t0) };

                    const curBframe = pg.frames().find(f => f.url().includes('/bframe') || f.url().includes('/enterprise/bframe')) || bframe;
                    const bfText = await curBframe.evaluate(() => (document.body ? document.body.innerText : '') + ' ' + (document.title || '')).catch(() => '');
                    if (bfText.includes('automated queries') || bfText.includes('Try again later') || bfText.includes('rc-doscaptcha')) {
                        return { success: false, err: 'blocked_by_google_automated_queries' };
                    }

                    let currentSrc = await curBframe.locator('audio').getAttribute('src').catch(() => null);
                    if (!currentSrc) {
                        currentSrc = await curBframe.locator('audio source').getAttribute('src').catch(() => null);
                    }
                    if (!currentSrc) {
                        currentSrc = await curBframe.locator('.rc-audiochallenge-tdownload-link, a[href*="audio.mp3"], a[href*="payload"]').getAttribute('href').catch(() => null);
                    }

                    if (currentSrc && currentSrc !== lastAudioUrl) {
                        mp3Url = currentSrc;
                        lastAudioUrl = currentSrc;
                        break;
                    }
                    await sleep(40);
                }

                const token = await pg.evaluate(() => window.__rc_token).catch(() => null);
                if (token && token.length > 20)
                    return { success: true, token, time: elapsed(t0) };

                if (!mp3Url) {
                    const curBframe = pg.frames().find(f => f.url().includes('/bframe') || f.url().includes('/enterprise/bframe')) || bframe;
                    const bfText = await curBframe.evaluate(() => (document.body ? document.body.innerText : '') + ' ' + (document.title || '')).catch(() => '');
                    if (bfText.includes('automated queries') || bfText.includes('Try again later') || bfText.includes('rc-doscaptcha')) {
                        return { success: false, err: 'blocked_by_google_automated_queries' };
                    }
                    const imageOnly = await curBframe.locator('.rc-imageselect-challenge, #rc-imageselect').isVisible().catch(() => false);
                    if (imageOnly) {
                        return { success: false, err: 'image_challenge_required_audio_blocked' };
                    }
                    return { success: false, err: 'audio_challenge_url_not_found' };
                }

                // Download MP3 and convert to WAV via SoX
                let mp3File = null, wavFile = null;
                let transcript = null;
                try {
                    const audioResp = await pg.request.get(mp3Url, { timeout: 6000 }).catch(() => null);
                    if (audioResp && audioResp.ok()) {
                        const buffer = await audioResp.body().catch(() => null);
                        if (buffer && buffer.length > 100) {
                            mp3File = path.join(os.tmpdir(), `rc_audio_${Date.now()}_${Math.floor(rand(10000))}.mp3`);
                            fs.writeFileSync(mp3File, buffer);
                        }
                    }
                    if (!mp3File) {
                        mp3File = await downloadFile(mp3Url).catch(() => null);
                    }
                    if (mp3File && fs.existsSync(mp3File) && fs.statSync(mp3File).size > 100) {
                        wavFile = mp3File.replace('.mp3', '.wav');
                        execSync(`sox "${mp3File}" -r 16000 -c 1 "${wavFile}"`, { timeout: 8000 });
                        transcript = await voskWorker.transcribe(wavFile);
                    }
                } catch (e) {
                    console.error('  [audio] conversion/transcribe error:', e.message);
                } finally {
                    try { if (mp3File) fs.unlinkSync(mp3File); } catch {}
                    try { if (wavFile) fs.unlinkSync(wavFile); } catch {}
                }

                if (!transcript) {
                    console.log('  [audio] empty transcript, clicking reload button');
                    await bframe.locator('#recaptcha-reload-button').click({ timeout: 3000 }).catch(() => {});
                    round++;
                    await sleep(300);
                    continue;
                }

                console.log(`  [audio] transcribed (round ${round}): "${transcript}"`);
                const input = bframe.locator('#audio-response');
                await input.fill(transcript, { timeout: 3000 }).catch(() => {});
                await sleep(60 + rand(50));

                await bframe.locator('#recaptcha-verify-button').click({ timeout: 3000 }).catch(() => {});

                // Wait reactively for token or retry requirement (up to 6 seconds)
                for (let j = 0; j < 120; j++) {
                    const tok = await extractToken(pg);
                    if (tok && tok.length > 20) {
                        return { success: true, token: tok, time: elapsed(t0) };
                    }

                    const curBframe = pg.frames().find(f => f.url().includes('/bframe') || f.url().includes('/enterprise/bframe')) || bframe;
                    const err = await curBframe.locator('.rc-audiochallenge-error-message').textContent().catch(() => '');
                    if (err && err.trim()) {
                        console.log(`  [audio] round ${round} verification feedback: ${err.trim()}`);
                        await curBframe.locator('#recaptcha-reload-button').click({ timeout: 2000 }).catch(() => {});
                        lastAudioUrl = null;
                        break;
                    }
                    await sleep(50);
                }

                round++;
                await sleep(200);
            }
        }

        const finalToken = await extractToken(pg);
        if (finalToken && finalToken.length > 20)
            return { success: true, token: finalToken, time: elapsed(t0) };

        return { success: false, err: 'timeout' };
    } catch (e) {
        return { success: false, err: e.message };
    } finally {
        await pg.close().catch(() => {});
        await dropCtx(handle);
    }
}

async function solveV3(siteUrl, siteKey, action, isEnterprise, timeout, proxy) {
    const t0 = Date.now();
    const dl = t0 + timeout * 1000;
    let attempt = 0;
    let lastErr = 'timeout';

    while (Date.now() < dl - 3000) {
        attempt++;
        const remainingSec = Math.max(4, (dl - Date.now()) / 1000);
        const res = await solveV3Single(siteUrl, siteKey, action, isEnterprise, remainingSec, proxy);
        if (res.success) {
            return { ...res, time: elapsed(t0) };
        }
        lastErr = res.err;
        if (Date.now() < dl - 5000) {
            console.log(`  [v3] attempt ${attempt} failed (${res.err}), ${proxy ? 'rotating proxy IP...' : 'retrying...'}`);
            await sleep(100);
            continue;
        }
        break;
    }
    return { success: false, err: lastErr };
}

async function solveV3Single(siteUrl, siteKey, action, isEnterprise, timeout, proxy) {
    const t0  = Date.now();
    const handle = await grabCtx(proxy);
    const pg  = await handle.ctx.newPage();

    try {
        const html = buildV3Page(siteKey, action || 'homepage', isEnterprise);

        const origin = new URL(siteUrl).origin;
        await pg.route('**', route => {
            const req = route.request();
            const u = req.url();
            if (u.includes('/recaptcha/api2/') || u.includes('/recaptcha/enterprise/') || u.includes('/recaptcha/api.js')) {
                return route.continue();
            }
            if (req.frame() === pg.mainFrame() && req.resourceType() === 'document' && u.startsWith(origin)) {
                return route.fulfill({ body: html, contentType: 'text/html', status: 200 });
            }
            return route.continue();
        });

        await pg.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const dl = t0 + timeout * 1000;
        while (Date.now() < dl) {
            const token = await pg.evaluate(() => window.__rc_token).catch(() => null);
            if (token && token.length > 20)
                return { success: true, token, time: elapsed(t0) };
            await sleep(40);
        }

        return { success: false, err: 'timeout' };
    } catch (e) {
        return { success: false, err: e.message };
    } finally {
        await pg.close().catch(() => {});
        await dropCtx(handle);
    }
}

function elapsed(t0) { return Math.round((Date.now() - t0) / 10) / 100; }

// ─── UI ───────────────────────────────────────────────────────────────────────

const HTML_UI = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>reCAPTCHA Solver</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"JetBrains Mono",monospace;background:#0a0a0a;color:#e5e7eb;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{background:#111215;border:1px solid #1f232b;border-radius:10px;padding:34px;width:100%;max-width:520px;box-shadow:0 12px 30px rgba(0,0,0,0.5)}
.hdr{border-bottom:1px solid #1a1e26;padding-bottom:18px;margin-bottom:22px}
.hdr h1{color:#10b981;font-size:18px;font-weight:700;letter-spacing:-0.3px}
.hdr p{color:#64748b;font-size:11px;margin-top:5px}
.field{margin-bottom:14px}
.field label{display:flex;justify-content:space-between;color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.field input,.field select{width:100%;padding:11px 13px;background:#0a0c10;border:1px solid #1e2430;border-radius:6px;color:#f3f4f6;font-size:12px;font-family:"JetBrains Mono",monospace;outline:none;transition:border-color .15s}
.field input:focus,.field select:focus{border-color:#10b981}
.field select option{background:#111215}
.field input::placeholder{color:#374151}
.row{display:flex;gap:10px}.row .field{flex:1}
.presets{display:flex;gap:6px;margin-bottom:14px}
.p-btn{background:#161b22;border:1px solid #242c38;border-radius:4px;padding:4px 9px;color:#94a3b8;font-size:10px;font-family:"JetBrains Mono",monospace;cursor:pointer;transition:all .15s}
.p-btn:hover{color:#10b981;border-color:#10b981}
.go-btn{width:100%;padding:13px;background:#059669;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:700;font-family:"JetBrains Mono",monospace;cursor:pointer;letter-spacing:1px;text-transform:uppercase;transition:background .15s;display:flex;align-items:center;justify-content:center;gap:8px}
.go-btn:hover{background:#047857}.go-btn:disabled{opacity:.4;cursor:not-allowed}
.go-btn .sp{width:13px;height:13px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:spin .65s linear infinite;display:none}
.go-btn.busy .sp{display:block}
@keyframes spin{to{transform:rotate(360deg)}}
.out{margin-top:18px;padding:14px;background:#0a0c10;border:1px solid #1e2430;border-radius:6px;display:none}
.out.show{display:block}
.out-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.badge{font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.8px}
.badge.ok{background:rgba(16,185,129,.12);color:#10b981;border:1px solid rgba(16,185,129,.25)}
.badge.fail{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.25)}
.el{color:#94a3b8;font-size:11px}
.tok{background:#07080a;border:1px solid #1a1e26;border-radius:5px;padding:10px;position:relative}
.tok code{color:#34d399;font-size:10px;font-family:"JetBrains Mono",monospace;word-break:break-all;display:block;max-height:75px;overflow-y:auto}
.cp{position:absolute;top:6px;right:6px;padding:3px 8px;background:#1e2430;border:none;border-radius:3px;color:#94a3b8;font-size:10px;font-family:"JetBrains Mono",monospace;cursor:pointer;transition:all .15s}
.cp:hover{color:#fff;background:#374151}
.err-txt{color:#f87171;font-size:11px;line-height:1.4}
.metrics{display:flex;gap:1px;margin-top:18px;background:#1e2430;border-radius:6px;overflow:hidden}
.m{flex:1;padding:11px;background:#111215;text-align:center}
.m-val{color:#10b981;font-size:18px;font-weight:700}
.m-lbl{color:#64748b;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-top:3px}
.ep{margin-top:14px;padding:11px 13px;background:#0a0c10;border:1px solid #1a1e26;border-radius:6px}
.ep span{color:#64748b;font-size:10px;display:block;margin-bottom:3px;word-break:break-all}
</style>
</head><body>
<div class="wrap">
  <div class="hdr">
    <h1>// recaptcha solver</h1>
    <p>v2 checkbox · v2 callback · v2 invisible · v2 enterprise · v3 · v3 enterprise</p>
  </div>
  <div class="presets">
    <button type="button" class="p-btn" onclick="setPreset('2captcha')">v2 Checkbox</button>
    <button type="button" class="p-btn" onclick="setPreset('2captcha-invisible')">v2 Invisible</button>
    <button type="button" class="p-btn" onclick="setPreset('2captcha-callback')">v2 Callback</button>
    <button type="button" class="p-btn" onclick="setPreset('2captcha-enterprise')">v2 Enterprise</button>
    <button type="button" class="p-btn" onclick="setPreset('2captcha-v3')">v3</button>
    <button type="button" class="p-btn" onclick="setPreset('2captcha-v3-enterprise')">v3 Enterprise</button>
  </div>
  <form id="f">
    <div class="field">
      <label>Target URL</label>
      <input type="url" id="url" placeholder="https://target.com/page" required>
    </div>
    <div class="field">
      <label>Site Key</label>
      <input type="text" id="sk" placeholder="6Le-..." required>
    </div>
    <div class="row">
      <div class="field">
        <label>Type</label>
        <select id="type" onchange="onType()">
          <option value="v2">v2 checkbox</option>
          <option value="v2-callback">v2 callback</option>
          <option value="v2-invisible">v2 invisible</option>
          <option value="v2-enterprise">v2 enterprise</option>
          <option value="v3">v3</option>
          <option value="v3-enterprise">v3 enterprise</option>
        </select>
      </div>
      <div class="field" id="actionField" style="display:none">
        <label>Action (v3)</label>
        <input type="text" id="action" placeholder="homepage">
      </div>
    </div>
    <div class="field">
      <label><span>Proxy</span><span style="color:#64748b;text-transform:none;font-size:9px">host:port:user:pass or http://</span></label>
      <input type="text" id="proxy" placeholder="host:port:user:pass or http://user:pass@host:port">
    </div>
    <div style="font-size:11px;color:#f59e0b;background:#18150d;border:1px solid #3d2f0f;border-radius:6px;padding:8px 12px;margin-bottom:14px;line-height:1.4">
      &#9888; <strong>Production Tip:</strong> For high-volume automated solving, always use a proxy to avoid Google IP rate limits and automated query blocks.
    </div>
    <button type="submit" class="go-btn" id="btn">
      <span class="sp"></span><span class="lbl" id="btnLbl">solve</span>
    </button>
  </form>
  <div class="out" id="out">
    <div class="out-row">
      <span class="badge" id="badge"></span>
      <span class="el" id="el"></span>
    </div>
    <div class="tok" id="tokBox">
      <code id="tok"></code>
      <button class="cp" onclick="cp(event)">copy</button>
    </div>
    <p class="err-txt" id="errTxt"></p>
  </div>
  <div class="metrics">
    <div class="m"><div class="m-val" id="cnt">0</div><div class="m-lbl">solved</div></div>
    <div class="m"><div class="m-val" id="avg">&#8212;</div><div class="m-lbl">avg</div></div>
    <div class="m"><div class="m-val" id="rate">&#8212;</div><div class="m-lbl">rate</div></div>
  </div>
  <div class="ep">
    <span>GET /solve?url=&lt;url&gt;&amp;sitekey=&lt;key&gt;&amp;type=&lt;type&gt;<strong>&amp;proxy=&lt;proxy_url&gt;</strong></span>
    <span>Supported types: v2 · v2-callback · v2-invisible · v2-enterprise · v3 · v3-enterprise</span>
  </div>
</div>
<script>
let s={ok:0,fail:0,t:0};
let timerInterval = null;

function setPreset(name) {
  if (name === '2captcha') {
    document.getElementById("url").value = "https://2captcha.com/demo/recaptcha-v2";
    document.getElementById("sk").value = "6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u";
    document.getElementById("type").value = "v2";
    onType();
  } else if (name === '2captcha-invisible') {
    document.getElementById("url").value = "https://2captcha.com/demo/recaptcha-v2-invisible";
    document.getElementById("sk").value = "6LdO5_IbAAAAAAeVBL9TClS19NUTt5wswEb3Q7C5";
    document.getElementById("type").value = "v2-invisible";
    onType();
  } else if (name === '2captcha-callback') {
    document.getElementById("url").value = "https://2captcha.com/demo/recaptcha-v2-callback";
    document.getElementById("sk").value = "6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u";
    document.getElementById("type").value = "v2-callback";
    onType();
  } else if (name === '2captcha-enterprise') {
    document.getElementById("url").value = "https://2captcha.com/demo/recaptcha-v2-enterprise";
    document.getElementById("sk").value = "6Lf26sUnAAAAAIKLuWNYgRsFUfmI-3Lex3xT5N-s";
    document.getElementById("type").value = "v2-enterprise";
    onType();
  } else if (name === '2captcha-v3') {
    document.getElementById("url").value = "https://2captcha.com/demo/recaptcha-v3";
    document.getElementById("sk").value = "6Lcyqq8oAAAAAJE7eVJ3aZp_hnJcI6LgGdYD8lge";
    document.getElementById("type").value = "v3";
    document.getElementById("action").value = "demo_action";
    onType();
  } else if (name === '2captcha-v3-enterprise') {
    document.getElementById("url").value = "https://2captcha.com/demo/recaptcha-v3-enterprise";
    document.getElementById("sk").value = "6Lel38UnAAAAAMRwKj9qLH2Ws4Tf2uTDQCyfgR6b";
    document.getElementById("type").value = "v3-enterprise";
    document.getElementById("action").value = "demo_action";
    onType();
  }
}

function onType(){
  const t=document.getElementById("type").value;
  document.getElementById("actionField").style.display=t.startsWith("v3")?"block":"none";
}

if(localStorage.getItem("rc_proxy")){
  const pInput = document.getElementById("proxy");
  if(pInput) pInput.value = localStorage.getItem("rc_proxy");
}

document.getElementById("f").addEventListener("submit",async e=>{
  e.preventDefault();
  const btn=document.getElementById("btn"),out=document.getElementById("out"),lbl=document.getElementById("btnLbl");
  btn.classList.add("busy");btn.disabled=true;out.classList.remove("show");
  
  const startTime = Date.now();
  timerInterval = setInterval(() => {
    lbl.textContent = "solving (" + ((Date.now() - startTime)/1000).toFixed(1) + "s)";
  }, 100);

  const type=document.getElementById("type").value;
  const action=document.getElementById("action").value||"homepage";
  const proxy=document.getElementById("proxy")?document.getElementById("proxy").value.trim():"";
  if(proxy) localStorage.setItem("rc_proxy", proxy);
  else localStorage.removeItem("rc_proxy");
  let qs="/solve?url="+encodeURIComponent(document.getElementById("url").value)
        +"&sitekey="+encodeURIComponent(document.getElementById("sk").value)
        +"&type="+type;
  if(action&&type.startsWith("v3")) qs+="&action="+encodeURIComponent(action);
  if(proxy) qs+="&proxy="+encodeURIComponent(proxy);
  try{
    const r=await fetch(qs),d=await r.json();
    clearInterval(timerInterval);
    out.classList.add("show");
    if(d.success){
      document.getElementById("badge").textContent="ok";document.getElementById("badge").className="badge ok";
      document.getElementById("el").textContent=d.time+"s";
      document.getElementById("tok").textContent=d.token;
      document.getElementById("tokBox").style.display="block";
      document.getElementById("errTxt").style.display="none";
      s.ok++;s.t+=d.time;
    }else{
      document.getElementById("badge").textContent="fail";document.getElementById("badge").className="badge fail";
      document.getElementById("tokBox").style.display="none";
      document.getElementById("errTxt").textContent=d.err;
      document.getElementById("errTxt").style.display="block";
      s.fail++;
    }
    upd();
  }catch(ex){
    clearInterval(timerInterval);
    out.classList.add("show");
    document.getElementById("badge").textContent="fail";document.getElementById("badge").className="badge fail";
    document.getElementById("tokBox").style.display="none";
    document.getElementById("errTxt").textContent=ex.message;
    document.getElementById("errTxt").style.display="block";
    s.fail++;upd();
  }
  btn.classList.remove("busy");btn.disabled=false;lbl.textContent="solve";
});

function upd(){
  const total=s.ok+s.fail;
  document.getElementById("cnt").textContent=s.ok;
  document.getElementById("avg").textContent=s.ok>0?(s.t/s.ok).toFixed(1)+"s":"—";
  document.getElementById("rate").textContent=total>0?Math.round(s.ok/total*100)+"%":"—";
}

function cp(e){
  navigator.clipboard.writeText(document.getElementById("tok").textContent);
  e.target.textContent="copied!";setTimeout(()=>e.target.textContent="copy",1400);
}
</script>
</body></html>`;

// ─── express ──────────────────────────────────────────────────────────────────

const app = express();

app.get('/', (req, res) => res.send(HTML_UI));

app.get('/solve', async (req, res) => {
    const { url, sitekey, type = 'v2', action, timeout, proxy } = req.query;
    if (!url)     return res.status(400).json({ success: false, err: 'missing url' });
    if (!sitekey) return res.status(400).json({ success: false, err: 'missing sitekey' });

    const to = timeout ? parseFloat(timeout) : TO;
    console.log(`[solve] >> ${type} | ${url}`);

    try {
        let result;
        switch (type) {
            case 'v2':
            case 'v2-callback':
                result = await solveV2(url, sitekey, false, false, to, proxy); break;
            case 'v2-invisible':
                result = await solveV2(url, sitekey, true,  false, to, proxy); break;
            case 'v2-enterprise':
                result = await solveV2(url, sitekey, false, true,  to, proxy); break;
            case 'v3':
                result = await solveV3(url, sitekey, action, false, to, proxy); break;
            case 'v3-enterprise':
                result = await solveV3(url, sitekey, action, true,  to, proxy); break;
            default:
                return res.status(400).json({ success: false, err: `unknown type: ${type}` });
        }
        console.log(`[solve] << ${type} | ${result.success ? 'OK in ' + result.time + 's' : 'FAIL: ' + result.err}`);
        res.json(result);
    } catch (e) {
        console.error(`[solve] << ${type} | EXCEPTION: ${e.message}`);
        res.status(500).json({ success: false, err: e.message });
    }
});

app.get('/health', (req, res) => res.json({
    ok: true,
    pool: ctxPool.length,
    voskWorker: voskWorker.ready,
    types: ['v2', 'v2-callback', 'v2-invisible', 'v2-enterprise', 'v3', 'v3-enterprise']
}));

// ─── boot ─────────────────────────────────────────────────────────────────────

async function main() {
    browser = await launchBrowser();

    for (let i = 0; i < POOL; i++) {
        ctxPool.push(await browser.newContext(CTX_OPTS));
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n  reCAPTCHA solver running`);
        console.log(`  http://localhost:${PORT}/\n`);
        console.log(`  audio challenge: persistent offline Vosk STT daemon`);
        console.log(`  types: v2 · v2-callback · v2-invisible · v2-enterprise · v3 · v3-enterprise`);
        console.log(`  GET /solve?url=<url>&sitekey=<key>&type=<type>[&action=<action>][&timeout=<s>]\n`);
    });

    const shutdown = async () => {
        console.log('\n  shutting down...');
        voskWorker.destroy();
        if (browser) await browser.close().catch(() => {});
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(e => { console.error(e); process.exit(1); });
