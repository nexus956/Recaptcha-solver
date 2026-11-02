# 🛡️ reCAPTCHA Solver & Captcha Inspector

A lightweight, production-grade microservice and automated inspector for Google reCAPTCHA (v2 Checkbox, Invisible, Callback, Enterprise, v3, and v3 Enterprise), Cloudflare Turnstile, and hCaptcha.

Built with **rebrowser-playwright**, an **in-memory browser context pool**, and a **persistent offline Vosk speech-to-text engine** for sub-second, zero-cost audio challenge solving.

---

## ⚡ Highlights

- **Complete reCAPTCHA Support**: Solves `v2` (Checkbox), `v2-callback`, `v2-invisible`, `v2-enterprise`, `v3`, and `v3-enterprise`.
- **Zero-Cost Offline STT**: Powered by a long-running, in-memory **Vosk** engine. No paid third-party transcription APIs (2Captcha, Anti-Captcha, OpenAI Whisper) required.
- **Sub-Second Browser Context Pooling**: Reuses pre-warmed stealth browser contexts from a pool, avoiding cold-start chromium overhead.
- **Multi-Round Audio Resolver**: Automatically handles Google's *"Multiple correct solutions required"* prompts with retry and reload logic.
- **Universal Proxy Parser**: Native support for `host:port:user:pass`, `user:pass:host:port`, `user:pass@host:port`, `http://`, and `socks5://`.
- **Dynamic Captcha Inspector (`info.py`)**: Two-tier scanner (static HTML + headless browser + SPA `localStorage` inspection) to identify captcha types, sitekeys, actions, and output ready-to-run API commands.
- **Built-in Dark Web Dashboard**: Lightweight, monospace UI served directly at `http://localhost:6868/` with live timers, presets, token copy, and metrics.
- **Daemon / Production Ready**: Pre-configured PM2 `ecosystem.config.js` for 24/7 uptime.

---

## 🏗️ Architecture & Execution Figures

### Figure 1: Component Pipeline & Context Lifecycle
```mermaid
graph TD
    Client["Client / Bot / Scraper"] -->|GET /solve| Server["Express API Server (:6868)"]
    Server -->|Fetch Context| Pool["Stealth Context Pool (rebrowser-playwright)"]
    
    subgraph Solving Engine
        Pool -->|v3 / v3-Enterprise| V3Solver["Execute grecaptcha.execute() -> Token"]
        Pool -->|v2 / Invisible / Enterprise| V2Solver["Render & Click Anchor Frame"]
        V2Solver -->|Bypass / Audio Challenge| AudioPipeline["Audio Challenge Handler"]
        AudioPipeline -->|Download MP3| AudioConvert["SoX Audio Conversion (16kHz Mono WAV)"]
        AudioConvert -->|Stdin JSON IPC| VoskWorker["Persistent vosk_worker.py (Model in RAM)"]
        VoskWorker -->|Transcribed Text| AudioPipeline
        AudioPipeline -->|Verify Response| ExtractToken["Token Extraction (DOM / Callback)"]
    end
    
    V3Solver -->|JSON Response| Client
    ExtractToken -->|JSON Response| Client
```

### Figure 2: End-to-End Audio Challenge Sequence Flow
```mermaid
sequenceDiagram
    autonumber
    actor Client as Client / Worker
    participant API as Express API (:6868)
    participant Pool as Stealth Context Pool
    participant Browser as rebrowser-playwright
    participant Google as Google reCAPTCHA CDN
    participant SoX as SoX Engine
    participant Vosk as vosk_worker.py (RAM)

    Client->>API: GET /solve?url=...&sitekey=...&type=v2&proxy=...
    API->>Pool: grabCtx(proxy)
    Pool-->>API: Pre-warmed Stealth Browser Context
    API->>Browser: pg.route(origin) -> Return Minimal HTML Harness
    Browser->>Google: Fetch api.js / enterprise.js
    Google-->>Browser: Render Checkbox Frame
    Browser->>Browser: Humanized Bezier Move & Click (#recaptcha-anchor)
    Google-->>Browser: Trigger Audio/Image Challenge Popup
    Browser->>Browser: Click #recaptcha-audio-button
    Google-->>Browser: Stream MP3 Audio Payload
    Browser->>SoX: Download MP3 & Transcode to 16kHz Mono WAV
    SoX-->>API: Temporary WAV File Ready
    API->>Vosk: IPC Stdin: {"wav": "/tmp/rc_audio.wav"}
    Note over Vosk: Kaldi Model Pre-warmed in RAM (~0.25s)
    Vosk-->>API: IPC Stdout: {"text": "9 1 4 2 8", "time": 0.23}
    API->>Browser: Type Digit String & Click #recaptcha-verify-button
    Google-->>Browser: Validate Token & Write to DOM
    Browser-->>API: Extract g-recaptcha-response Token
    API->>Pool: dropCtx() -> Flush Cookies & Return to Pool
    API-->>Client: 200 OK {"success": true, "token": "0cAF...", "time": 12.3}
```

---

## ⚙️ How It Works (Deep Dive)

The solver achieves high speeds and high pass rates through a combination of browser automation tricks, origin routing, and in-memory speech recognition:

### 1. Zero-Overhead Origin Interception (Virtual Harness)
Instead of loading the target website's entire frontend (heavy stylesheets, ads, third-party analytics, videos, images), the solver intercepts document navigation (`pg.route`) targeting the target domain.
- When navigating to `https://target.com/login`, Playwright responds with an **ultra-lightweight, synthetic HTML harness** containing only the official Google reCAPTCHA scripts (`api.js` or `enterprise.js`).
- Because the origin of the page remains `https://target.com`, Google's API evaluates `window.location.origin` as genuine and validates the sitekey without errors.
- **Result**: Page load times drop from 5–10 seconds down to <100ms.

### 2. Stealth Browser Pooling (`rebrowser-playwright`)
Standard Chromium automation gets flagged by Google within seconds. This system solves this at two levels:
- **`rebrowser-playwright` Patches**: Low-level CDP (Chrome DevTools Protocol) automation artifacts, `Runtime.enable` leaks, and `navigator.webdriver` indicators are stripped from the browser binary.
- **Pre-warmed Context Pool**: A pool of pre-warmed contexts (`POOL_SIZE=10`) is held in RAM. When a request arrives, a context is claimed with **0ms launch delay**, cookies are wiped on return, and the context is recycled.
- **Proxy Isolation**: When a per-request `proxy` is supplied, a dedicated isolated browser context is spawned and immediately destroyed after execution to prevent proxy or cookie cross-contamination.

### 3. The reCAPTCHA v2 Audio Solving Pipeline
For v2 checkboxes and invisible challenges that require manual interaction:
1. **Human-like Interaction**: The mouse moves to the reCAPTCHA checkbox using randomized Bezier curves (`fastHumanClick`) with natural deceleration and jitter.
2. **Audio Challenge Trigger**: When Google displays the image/audio challenge dialog, the solver automatically clicks `#recaptcha-audio-button`.
3. **Payload Extraction**: The audio challenge MP3 stream is fetched directly via Playwright's network context (inheriting proxy & session headers).
4. **Instant In-Memory Speech Recognition**:
   - The MP3 is converted to a 16kHz mono WAV using SoX in ~30ms.
   - The WAV is sent via stdin JSON IPC to [`vosk_worker.py`](file:///home/nexus/Desktop/files/vosk_worker.py), which keeps the Kaldi neural acoustic model resident in RAM.
   - Vosk transcribes the audio in **0.20s – 0.35s** (completely offline, $0 cost).
   - The transcript is processed by an intelligent digit normalizer converting spoken words and homophones (`"three to four"` ➔ `"324"`, `"for"` ➔ `"4"`, `"won"` ➔ `"1"`).
5. **Multi-Round Recovery**: If Google demands a second audio test (*"Multiple correct solutions required"*), the solver catches the reload state, triggers `#recaptcha-reload-button`, resets buffers, and transcribes Round 2 automatically.

### 4. reCAPTCHA v3 & Enterprise Score Execution
For invisible v3 and v3 Enterprise:
- No visual or audio challenges are shown. The harness automatically executes `grecaptcha.ready()` and calls `grecaptcha.execute(sitekey, { action })` or `grecaptcha.enterprise.execute(...)`.
- The token is retrieved from `window.__rc_token` or `grecaptcha.getResponse()` and returned in **3 to 7 seconds**.

---

## 📋 Supported CAPTCHA Types

| Type Parameter | Protected Service | Solving Mechanism | Typical Latency |
| :--- | :--- | :--- | :--- |
| `v2` | reCAPTCHA v2 Checkbox | Stealth click + Vosk offline audio STT | 10 – 18s |
| `v2-callback` | reCAPTCHA v2 with JS Callback | Anchor click + audio STT + callback hook | 10 – 18s |
| `v2-invisible` | reCAPTCHA v2 Invisible | Trigger render + audio challenge STT | 10 – 18s |
| `v2-enterprise` | reCAPTCHA Enterprise (v2 style) | Enterprise frame trigger + audio STT | 12 – 20s |
| `v3` | reCAPTCHA v3 Score | Score-based token execution (`grecaptcha.execute`) | 3 – 8s |
| `v3-enterprise` | reCAPTCHA Enterprise (v3 style) | Enterprise client execution (`grecaptcha.enterprise`) | 3 – 8s |

---

## 📦 Prerequisites

### 1. System Requirements (Linux / Ubuntu / Debian / Kali)
```bash
sudo apt-get update
sudo apt-get install -y nodejs npm python3 python3-pip python3-venv sox libsox-fmt-mp3
```

### 2. Install Node Dependencies
```bash
npm install
```

### 3. Setup Python Virtual Environment & Vosk
```bash
# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# Install requirements
pip install -r requirements.txt
pip install beautifulsoup4 playwright

# Install playwright browser binaries
playwright install chromium
```

### 4. Vosk Speech-to-Text Model
Ensure the offline English model exists at `models/vosk-model-small-en-us-0.15`:
```bash
mkdir -p models
cd models
wget https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
unzip vosk-model-small-en-us-0.15.zip
rm vosk-model-small-en-us-0.15.zip
cd ..
```

---

## 🚀 Running the Solver

### Quick Start (Development)
```bash
PORT=6868 POOL_SIZE=10 node recaptcha_solver.js
```

### Production with PM2
```bash
# Install PM2 globally if not already installed
npm install -g pm2

# Start service via ecosystem config
pm2 start ecosystem.config.js

# View live logs
pm2 logs recaptcha-solver

# Restart
pm2 restart recaptcha-solver
```

---

## 🌐 Web Dashboard

Navigate to `http://localhost:6868/` in your browser to access the built-in management interface:

### Figure 3: Terminal-Style Web UI & Real-Time Metrics
```text
┌────────────────────────────────────────────────────────────────────────┐
│ // recaptcha solver                                                    │
│ v2 checkbox · v2 callback · v2 invisible · v2 enterprise · v3          │
├────────────────────────────────────────────────────────────────────────┤
│ PRESETS: [v2 Checkbox] [v2 Invisible] [v2 Enterprise] [v3 Enterprise]  │
│                                                                        │
│ TARGET URL                                                             │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ https://2captcha.com/demo/recaptcha-v2                             │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ SITE KEY                                                               │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ 6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u                           │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ TYPE                       ACTION (v3)                                 │
│ ┌────────────────────────┐ ┌─────────────────────────────────────────┐ │
│ │ v2 checkbox          ▼ │ │ demo_action                             │ │
│ └────────────────────────┘ └─────────────────────────────────────────┘ │
│ PROXY (Auto-saved in localStorage)                                     │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ host:port:user:pass or http://user:pass@host:port                  │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ [SOLVE] (resolves in 10-15s)                                       │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│ RESULT: [ OK 11.4s ]                                    [ COPY TOKEN ] │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ 0cAFcWeA4N_zfxQWhDHnCRvKlOVEq-kIX53sgz9OPA8P7-HTga7iOKqS7XB0Hy...    │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────┬─────────────────────┬────────────────────────┐ │
│ │      28 SOLVED      │      11.2s AVG      │        97% RATE        │ │
│ └─────────────────────┴─────────────────────┴────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

- **Presets**: 1-click test configurations for 2Captcha demo targets.
- **Interactive Solves**: Test any target URL, sitekey, action, or custom proxy.
- **Proxy Persistence**: Automatically saves your proxy in `localStorage` across page refreshes.
- **Live Metrics**: Real-time counter of total solved requests, average latency, and success rates.

---

## 🔌 REST API Reference

### `GET /solve`
Solve a target reCAPTCHA and receive the response token.

#### Query Parameters:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `url` | `string` | **Yes** | — | Target page URL (e.g. `https://example.com/login`) |
| `sitekey` | `string` | **Yes** | — | Target reCAPTCHA sitekey |
| `type` | `string` | No | `v2` | `v2`, `v2-callback`, `v2-invisible`, `v2-enterprise`, `v3`, `v3-enterprise` |
| `action` | `string` | No | `homepage` | Expected action string for v3 / enterprise (e.g. `login`, `submit`) |
| `proxy` | `string` | No | `null` | Proxy address (supports multiple formats) |
| `timeout` | `number` | No | `35` | Maximum execution timeout in seconds |

#### Example: Solve reCAPTCHA v2
```bash
curl "http://localhost:6868/solve?url=https://2captcha.com/demo/recaptcha-v2&sitekey=6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u&type=v2"
```

#### Example: Solve reCAPTCHA v3 Enterprise with Proxy
```bash
curl "http://localhost:6868/solve?url=https://app.hushed.com/login&sitekey=6Lf3kAAsAAAAAEKetSTy4pyDMKxviNi0Vqcv3148&type=v3-enterprise&proxy=dc-fr1.redscrape.com:7777:rotating:0PZKiKEMb4KuSPSZiqDdqw"
```

#### Successful Response:
```json
{
  "success": true,
  "token": "0cAFcWeA4N_zfxQWhDHnCRvKlOVEq-kIX53sgz9OPA8P7-HTga7iOKqS7XB0HyL...",
  "time": 6.58
}
```

#### Error Response:
```json
{
  "success": false,
  "err": "blocked_by_google_automated_queries"
}
```

---

### `GET /health`
Returns system status, worker pool health, and active features.

```bash
curl http://localhost:6868/health
```

```json
{
  "ok": true,
  "pool": 10,
  "voskWorker": true,
  "types": ["v2", "v2-callback", "v2-invisible", "v2-enterprise", "v3", "v3-enterprise"]
}
```

---

## 🔒 Proxy Configuration Guide

### Why Use Residential Proxies?
- **reCAPTCHA v3 / Enterprise**: Generates tokens fine on VPN/datacenter IPs, but score quality will be lower (0.1–0.3). Clean residential IPs score 0.7–0.9.
- **reCAPTCHA v2 Audio**: Google strictly blocks audio challenges on known Datacenter/VPS/Hosting ASNs with `blocked_by_google_automated_queries`. **A residential or mobile proxy is mandatory for v2 on VPS hosts.**

### Supported Proxy Formats:
The parser automatically detects and handles all common formats:
- `host:port:user:pass` *(e.g. `geo.iproyal.com:12321:user:pass`)*
- `user:pass:host:port`
- `user:pass@host:port`
- `http://user:pass@host:port`
- `socks5://user:pass@host:port`
- `1.2.3.4:8080` *(IP whitelist authentication)*

### Global Proxy via Environment Variable:
If you want the entire service to route all requests through a default proxy:
```bash
PROXY="http://user:pass@proxy.example.com:8080" PORT=6868 node recaptcha_solver.js
```
Or in `ecosystem.config.js`:
```javascript
env: {
  PROXY: "http://user:pass@proxy.example.com:8080"
}
```

---

## 🔍 Captcha Inspector (`info.py`)

A fast inspection utility to analyze any URL, detect what captcha protection it uses, extract its sitekey, and generate the exact solver command.

### Features:
1. **Tier 1 (Fast Static Scan)**: Uses requests and regex to detect signatures in `<0.5s`.
2. **Tier 2 (Headless Browser Scan)**: Executes JavaScript with Playwright to catch dynamic reCAPTCHA injection.
3. **SPA Storage Inspection**: Extracts client-side configs directly from `localStorage` (e.g. OnlyFans `initObject`).
4. **Multi-Captcha Detection**: Detects reCAPTCHA, Cloudflare Turnstile, hCaptcha, and Qrator Labs.

### Usage:
```bash
# Basic inspection
python3 info.py -u https://2captcha.com/demo/recaptcha-v2

# Force browser scan (for React / SPA apps)
python3 info.py -u https://onlyfans.com/ -b

# Inspect using a proxy
python3 info.py -u https://example.com/ -p host:port:user:pass

# Output JSON
python3 info.py -u https://example.com/ -j
```

### Sample Output:
```text
=================================================================
 CAPTCHA DETECT & SITEKEY INSPECTION REPORT
=================================================================
  Target URL    : https://onlyfans.com/
  Inspect Mode  : browser (playwright)
  Status        : CAPTCHA DETECTED
-----------------------------------------------------------------
  Protection    : Google reCAPTCHA Enterprise
  CAPTCHA Type  : v3-enterprise
  Site Key      : 6LcvNcwdAAAAAMWAuNRXH74u3QePsEzTm6GEjx0J
  Secondary Sys : Cloudflare Turnstile (Managed: 0x4AAAAAAAxTpmbMvo7Qj6zy)
  Config Note   : Enterprise v3 score with v2 checkbox fallback (sitekey: 6LddGoYgAAAAAHD275rVBjuOYXiofr1u4pFS5lHn)
-----------------------------------------------------------------
 Recommended Solve API Request (Direct):
  curl "http://localhost:6868/solve?url=https://onlyfans.com/&sitekey=6LcvNcwdAAAAAMWAuNRXH74u3QePsEzTm6GEjx0J&type=v3-enterprise"

 With Proxy (Use Good / Residential IP):
  curl "http://localhost:6868/solve?url=https://onlyfans.com/&sitekey=6LcvNcwdAAAAAMWAuNRXH74u3QePsEzTm6GEjx0J&type=v3-enterprise&proxy=<proxy_url>"
=================================================================
```

---

## 🛠️ Project Structure

```
.
├── recaptcha_solver.js     # Express API server & Playwright context pool
├── vosk_worker.py          # Persistent offline speech-to-text worker daemon
├── transcribe.py           # Standalone Vosk audio transcription script
├── info.py                 # CLI CAPTCHA detector & sitekey inspector
├── ecosystem.config.js     # PM2 cluster and daemon configuration
├── package.json            # Node.js dependencies (rebrowser-playwright, express)
├── requirements.txt        # Python dependencies (vosk, requests, bs4, playwright)
└── models/                 # Offline Vosk speech-to-text models
    └── vosk-model-small-en-us-0.15/
```

---

## ❓ Troubleshooting

### 1. `blocked_by_google_automated_queries`
- **Cause**: Google blocks audio challenge downloads on datacenter/VPS IP ranges (AWS, DigitalOcean, Hetzner, etc.).
- **Fix**: Pass a residential or mobile proxy via `&proxy=host:port:user:pass`.

### 2. `audio_challenge_url_not_found`
- **Cause**: The audio button was not found or was blocked before the audio URL could load.
- **Fix**: The solver automatically performs multi-round retries with auto-reload. If recurring, ensure `sox` and `libsox-fmt-mp3` are installed.

### 3. Chromium Crash on Linux as Root
- **Cause**: Chromium sandboxing restrictions on headless Linux servers.
- **Fix**: Both `recaptcha_solver.js` and `info.py` include `--no-sandbox` and `--disable-setuid-sandbox` flags by default.

---

## 📄 License
MIT License. Free for educational and research purposes.
