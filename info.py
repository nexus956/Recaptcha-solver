#!/usr/bin/env python3
"""
info.py - CAPTCHA Analyzer & Sitekey Inspector
Inspects any webpage URL to identify:
- reCAPTCHA (v2 Checkbox, v2 Invisible, v2 Callback, v2 Enterprise, v3, v3 Enterprise)
- Cloudflare Turnstile
- hCaptcha
Extracts site keys, callbacks, actions, script sources, and suggests solve.py commands.
"""

import sys
import re
import json
import argparse
import urllib.parse
from urllib.parse import urlparse, parse_qs

# Third-party imports
try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("\033[31m[ERROR]\033[0m Missing dependencies. Run: pip install requests beautifulsoup4")
    sys.exit(1)

# Playwright availability
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def parse_proxy(proxy_str: str) -> dict:
    """
    Parses proxy string into:
    - playwright: { 'server': 'http://...', 'username': '...', 'password': '...' }
    - requests: { 'http': 'http://...', 'https': 'http://...' }
    Supports:
    - host:port:user:pass
    - user:pass:host:port
    - user:pass@host:port
    - http://user:pass@host:port
    - socks5://...
    - host:port
    """
    if not proxy_str or not proxy_str.strip():
        return {"playwright": None, "requests": None, "raw": None}

    s = proxy_str.strip()
    protocol = "http:"

    m = re.match(r"^([a-zA-Z0-9+.-]+)://", s)
    if m:
        protocol = m.group(1).lower() + ":"
        s = s[len(m.group(0)):]

    pw_cfg = {}

    if "@" in s:
        auth_str, host_port = s.rsplit("@", 1)
        pw_cfg["server"] = f"{protocol}//{host_port}"
        if ":" in auth_str:
            pw_cfg["username"], pw_cfg["password"] = auth_str.split(":", 1)
        else:
            pw_cfg["username"] = auth_str
    else:
        parts = s.split(":")
        if len(parts) >= 4:
            is_port1 = parts[1].isdigit() and 1 <= int(parts[1]) <= 65535
            is_port_last = parts[-1].isdigit() and 1 <= int(parts[-1]) <= 65535
            if is_port1 and (not is_port_last or "." in parts[0] or "." not in parts[-2]):
                host = parts[0]
                port = parts[1]
                user = parts[2]
                password = ":".join(parts[3:])
                pw_cfg["server"] = f"{protocol}//{host}:{port}"
                pw_cfg["username"] = user
                pw_cfg["password"] = password
            elif is_port_last:
                port = parts[-1]
                host = parts[-2]
                user = parts[0]
                password = ":".join(parts[1:-2])
                pw_cfg["server"] = f"{protocol}//{host}:{port}"
                pw_cfg["username"] = user
                pw_cfg["password"] = password
        elif len(parts) == 2 and parts[1].isdigit():
            pw_cfg["server"] = f"{protocol}//{parts[0]}:{parts[1]}"
        else:
            raw_url = proxy_str if "://" in proxy_str else f"{protocol}//{proxy_str}"
            parsed = urllib.parse.urlparse(raw_url)
            pw_cfg["server"] = f"{parsed.scheme}://{parsed.hostname}" + (f":{parsed.port}" if parsed.port else "")
            if parsed.username:
                pw_cfg["username"] = urllib.parse.unquote(parsed.username)
            if parsed.password:
                pw_cfg["password"] = urllib.parse.unquote(parsed.password)

    if "username" in pw_cfg and "password" in pw_cfg:
        user_enc = urllib.parse.quote(pw_cfg["username"], safe="")
        pass_enc = urllib.parse.quote(pw_cfg["password"], safe="")
        server_netloc = pw_cfg["server"].split("://", 1)[1]
        scheme = pw_cfg["server"].split("://", 1)[0]
        req_proxy_url = f"{scheme}://{user_enc}:{pass_enc}@{server_netloc}"
    else:
        req_proxy_url = pw_cfg.get("server", s)

    req_proxies = {
        "http": req_proxy_url,
        "https": req_proxy_url
    }

    return {"playwright": pw_cfg, "requests": req_proxies, "raw": proxy_str}


def normalize_url(raw_url: str) -> str:
    """Ensure URL has a valid http/https scheme."""
    raw = raw_url.strip()
    if not raw.startswith("http://") and not raw.startswith("https://"):
        return f"https://{raw}"
    return raw


def analyze_static(url: str, timeout: int = 10, proxy_info: dict = None) -> dict:
    """
    Tier 1: Fast static HTML parsing via requests + BeautifulSoup + regex.
    Runs in < 0.5 seconds.
    """
    results = {
        "url": url,
        "mode": "static",
        "found": False,
        "sitekey": None,
        "captcha_type": None,
        "system": None,
        "callback": None,
        "action": None,
        "size": None,
        "script_url": None,
        "element": None,
        "confidence": "low",
        "dynamic_hint": False,
        "proxy": proxy_info.get("raw") if proxy_info else None,
        "raw_matches": []
    }

    try:
        proxies = proxy_info.get("requests") if proxy_info else None
        try:
            resp = requests.get(url, headers=HEADERS, timeout=timeout, proxies=proxies)
        except requests.exceptions.SSLError:
            resp = requests.get(url, headers=HEADERS, timeout=timeout, proxies=proxies, verify=False)
        html = resp.text
        results["final_url"] = resp.url
        soup = BeautifulSoup(html, "html.parser")
    except Exception as e:
        results["error"] = f"Static fetch failed: {e}"
        return results

    # 1. Inspect script tags
    scripts = []
    for s in soup.find_all("script"):
        src = s.get("src", "")
        if src:
            scripts.append(src)
            # Check v3 / enterprise with render=
            if "recaptcha" in src:
                results["script_url"] = src
                if "render=" in src:
                    parsed = parse_qs(urlparse(src).query)
                    render_val = parsed.get("render", [None])[0]
                    if render_val and render_val != "explicit":
                        results["sitekey"] = render_val
                        results["found"] = True
                        if "enterprise" in src:
                            results["captcha_type"] = "v3-enterprise"
                            results["system"] = "Google reCAPTCHA Enterprise"
                        else:
                            results["captcha_type"] = "v3"
                            results["system"] = "Google reCAPTCHA"
                        results["confidence"] = "high"
            elif "challenges.cloudflare.com/turnstile" in src:
                results["system"] = "Cloudflare Turnstile"
                results["captcha_type"] = "turnstile"
                results["script_url"] = src
            elif "hcaptcha.com" in src:
                results["system"] = "hCaptcha"
                results["captcha_type"] = "hcaptcha"
                results["script_url"] = src
            elif "qrator" in src or "qauth" in src:
                results["system"] = "Qrator Labs (Qauth Anti-Bot WAF)"
                results["captcha_type"] = "qrator-image-captcha"
                results["script_url"] = src
                results["found"] = True
                results["sitekey"] = "N/A (Session Token / Image Challenge)"
                results["confidence"] = "high"

    # Check for WAF-level bot challenges (e.g. Qrator Labs)
    server_hdr = resp.headers.get("Server", "")
    if ("QRATOR" in server_hdr.upper() or "qauth" in html or "captcha-input" in html) and not results["found"]:
        results["system"] = "Qrator Labs (Qauth Anti-Bot WAF)"
        results["captcha_type"] = "qrator-image-captcha"
        results["found"] = True
        results["sitekey"] = "N/A (Session Token / Image Challenge)"
        results["element"] = "<img id='captcha-img'> + <input id='captcha-input'>"
        results["confidence"] = "high"

    # 2. Inspect DOM elements with data-sitekey or classes
    captcha_elements = soup.find_all(
        lambda el: el.has_attr("data-sitekey")
        or "g-recaptcha" in el.get("class", [])
        or "cf-turnstile" in el.get("class", [])
        or "h-captcha" in el.get("class", [])
    )

    for el in captcha_elements:
        sk = el.get("data-sitekey")
        size = el.get("data-size")
        cb = el.get("data-callback")
        action = el.get("data-action")
        cls = el.get("class", [])

        if sk and not results["sitekey"]:
            results["sitekey"] = sk
            results["found"] = True
            results["size"] = size
            results["callback"] = cb
            results["action"] = action
            results["element"] = f"<{el.name} class='{' '.join(cls)}'>"

            # Classify system and type
            if "cf-turnstile" in cls:
                results["system"] = "Cloudflare Turnstile"
                results["captcha_type"] = "turnstile"
                results["confidence"] = "high"
            elif "h-captcha" in cls:
                results["system"] = "hCaptcha"
                results["captcha_type"] = "hcaptcha"
                results["confidence"] = "high"
            else:
                results["system"] = "Google reCAPTCHA"
                if size == "invisible":
                    results["captcha_type"] = "v2-invisible"
                elif cb:
                    results["captcha_type"] = "v2-callback"
                else:
                    results["captcha_type"] = "v2"
                results["confidence"] = "medium"

    # 3. Check for inline grecaptcha.render or grecaptcha.execute
    render_matches = re.findall(r"grecaptcha(?:\.enterprise)?\.render\s*\(\s*[^,]+,\s*\{([^}]+)\}", html)
    for m in render_matches:
        sk_match = re.search(r"['\"]?sitekey['\"]?\s*:\s*['\"]([A-Za-z0-9_-]{40})['\"]", m)
        if sk_match and not results["sitekey"]:
            results["sitekey"] = sk_match.group(1)
            results["found"] = True
            if "invisible" in m:
                results["captcha_type"] = "v2-invisible"
            elif "callback" in m:
                results["captcha_type"] = "v2-callback"
            else:
                results["captcha_type"] = "v2"
            results["confidence"] = "medium"

    # Check if page is an SPA with dynamic hydration
    if not scripts and not captcha_elements:
        results["dynamic_hint"] = True
    elif results["found"] and not any("recaptcha" in s for s in scripts):
        # Sitekey found in HTML but script tag loaded dynamically (e.g. Next.js / React)
        results["dynamic_hint"] = True

    return results


def analyze_browser(url: str, timeout: int = 15, proxy_info: dict = None) -> dict:
    """
    Tier 2: Full dynamic headless browser execution with Playwright.
    Executes JavaScript, intercepts all network calls, and evaluates DOM iframes.
    """
    if not PLAYWRIGHT_AVAILABLE:
        return {"error": "Playwright is not installed in current Python environment."}

    results = {
        "url": url,
        "mode": "browser (playwright)",
        "found": False,
        "sitekey": None,
        "captcha_type": None,
        "system": None,
        "callback": None,
        "action": None,
        "size": None,
        "script_url": None,
        "element": None,
        "confidence": "high",
        "proxy": proxy_info.get("raw") if proxy_info else None,
        "network_matches": []
    }

    try:
        pw_proxy = proxy_info.get("playwright") if proxy_info else None
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
            )
            ctx_args = {"user_agent": USER_AGENT}
            if pw_proxy:
                ctx_args["proxy"] = pw_proxy
            context = browser.new_context(**ctx_args)
            page = context.new_page()

            network_reqs = []
            page.on(
                "request",
                lambda req: network_reqs.append(req.url)
                if any(k in req.url for k in ["recaptcha", "turnstile", "hcaptcha"])
                else None
            )

            try:
                page.goto(url, wait_until="networkidle", timeout=timeout * 1000)
            except Exception:
                # If networkidle times out, proceed with current DOM state
                pass

            results["final_url"] = page.url
            results["network_matches"] = network_reqs

            # 1. Inspect network calls
            is_enterprise = any("enterprise" in r for r in network_reqs)
            render_url = next(
                (r for r in network_reqs if "render=" in r and ("api.js" in r or "enterprise.js" in r)),
                None
            )
            anchor_url = next(
                (r for r in network_reqs if "/anchor" in r),
                None
            )
            script_req = next(
                (r for r in network_reqs if "api.js" in r or "enterprise.js" in r or "turnstile" in r or "hcaptcha" in r),
                None
            )
            if script_req:
                results["script_url"] = script_req

            # 2. Inspect DOM attributes & SPA Client Storage
            dom_info = page.evaluate("""() => {
                const el = document.querySelector('[data-sitekey], .g-recaptcha, .cf-turnstile, .h-captcha');
                const iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src);

                let storageData = {};
                try {
                    for (let i = 0; i < window.localStorage.length; i++) {
                        const k = window.localStorage.key(i);
                        const v = window.localStorage.getItem(k);
                        if (v && (v.includes('recaptcha') || v.includes('turnstile') || v.includes('hcaptcha') || v.includes('sitekey') || v.includes('geetest'))) {
                            try {
                                storageData[k] = JSON.parse(v);
                            } catch {
                                storageData[k] = v;
                            }
                        }
                    }
                } catch(e) {}

                return {
                    sitekey: el ? el.getAttribute('data-sitekey') : null,
                    size: el ? el.getAttribute('data-size') : null,
                    callback: el ? el.getAttribute('data-callback') : null,
                    action: el ? el.getAttribute('data-action') : null,
                    tagName: el ? el.tagName : null,
                    classes: el ? Array.from(el.classList) : [],
                    iframes: iframes,
                    hasGrecaptcha: typeof window.grecaptcha !== 'undefined',
                    hasEnterprise: typeof window.grecaptcha !== 'undefined' && typeof window.grecaptcha.enterprise !== 'undefined',
                    hasTurnstile: typeof window.turnstile !== 'undefined',
                    hasHcaptcha: typeof window.hcaptcha !== 'undefined',
                    storage: storageData
                };
            }""")

            # 3. Extract sitekey
            sitekey = dom_info.get("sitekey") if dom_info else None
            anchor_size = None

            if anchor_url:
                parsed_anchor = parse_qs(urlparse(anchor_url).query)
                if not sitekey:
                    sitekey = parsed_anchor.get("k", [None])[0]
                anchor_size = parsed_anchor.get("size", [None])[0]

            if not sitekey and render_url:
                parsed_render = parse_qs(urlparse(render_url).query)
                render_key = parsed_render.get("render", [None])[0]
                if render_key and render_key != "explicit":
                    sitekey = render_key

            # 3b. Check SPA Storage configs (e.g. OnlyFans initObject)
            storage = dom_info.get("storage", {}) if dom_info else {}
            init_val = storage.get("initObject", {}).get("value", {}) if isinstance(storage.get("initObject"), dict) else {}
            if not isinstance(init_val, dict):
                init_val = {}
            if not init_val:
                for k, v in storage.items():
                    if isinstance(v, dict):
                        if any(x in v for x in ["recaptchaEPublic", "recaptchaV3Public", "turnstile", "hCaptchaSiteKey"]):
                            init_val = v
                            break

            if init_val:
                rc_e = init_val.get("recaptchaEPublic")
                rc_ec = init_val.get("recaptchaECPublic")
                rc_v3 = init_val.get("recaptchaV3Public")
                rc_v2 = init_val.get("recaptchaV2Public")
                turnstile_cfg = init_val.get("turnstile")
                hcaptcha_key = init_val.get("hCaptchaSiteKey")

                if rc_e or rc_v3 or rc_v2 or rc_ec:
                    results["system"] = "Google reCAPTCHA Enterprise" if (rc_e or rc_ec) else "Google reCAPTCHA"
                    results["captcha_type"] = "v3-enterprise" if rc_e else ("v3" if rc_v3 else "v2")
                    results["found"] = True
                    sitekey = rc_e or rc_v3 or rc_v2 or rc_ec
                    results["sitekey"] = sitekey
                    if rc_ec and rc_e:
                        results["note"] = f"Enterprise v3 score with v2 checkbox fallback (sitekey: {rc_ec})"
                    if turnstile_cfg:
                        t_managed = turnstile_cfg.get('managed') if isinstance(turnstile_cfg, dict) else turnstile_cfg
                        results["secondary_protection"] = f"Cloudflare Turnstile (Managed: {t_managed})"
                elif turnstile_cfg:
                    results["system"] = "Cloudflare Turnstile"
                    results["captcha_type"] = "turnstile"
                    results["found"] = True
                    sitekey = turnstile_cfg.get("managed") if isinstance(turnstile_cfg, dict) else turnstile_cfg
                    results["sitekey"] = sitekey

            # 4. Classify CAPTCHA type
            if not results["found"]:
                if any("qrator" in r or "qauth" in r for r in network_reqs) or (dom_info and ("captcha-input" in str(dom_info) or "qauth" in str(dom_info))):
                    results["system"] = "Qrator Labs (Qauth Anti-Bot WAF)"
                    results["captcha_type"] = "qrator-image-captcha"
                    results["found"] = True
                    results["sitekey"] = "N/A (Session Token / Image Challenge)"
                elif any("turnstile" in r for r in network_reqs) or (dom_info and dom_info.get("hasTurnstile")):
                    results["system"] = "Cloudflare Turnstile"
                    results["captcha_type"] = "turnstile"
                    results["found"] = True
                elif any("hcaptcha" in r for r in network_reqs) or (dom_info and dom_info.get("hasHcaptcha")):
                    results["system"] = "hCaptcha"
                    results["captcha_type"] = "hcaptcha"
                    results["found"] = True
                elif is_enterprise:
                    results["system"] = "Google reCAPTCHA Enterprise"
                    results["found"] = True
                    if render_url and "render=explicit" not in render_url:
                        results["captcha_type"] = "v3-enterprise"
                    elif (dom_info and dom_info.get("size") == "invisible") or anchor_size == "invisible":
                        results["captcha_type"] = "v2-enterprise"
                    else:
                        results["captcha_type"] = "v2-enterprise"
                elif render_url and "render=explicit" not in render_url:
                    results["system"] = "Google reCAPTCHA"
                    results["captcha_type"] = "v3"
                    results["found"] = True
                elif anchor_url or (dom_info and dom_info.get("hasGrecaptcha")):
                    results["system"] = "Google reCAPTCHA"
                    results["found"] = True
                    if (dom_info and dom_info.get("size") == "invisible") or anchor_size == "invisible":
                        results["captcha_type"] = "v2-invisible"
                    elif dom_info and dom_info.get("callback"):
                        results["captcha_type"] = "v2-callback"
                    else:
                        results["captcha_type"] = "v2"

            results["sitekey"] = sitekey
            results["callback"] = dom_info.get("callback") if dom_info else None
            results["size"] = dom_info.get("size") or anchor_size if dom_info else anchor_size
            results["action"] = dom_info.get("action") if dom_info else None

            browser.close()
    except Exception as e:
        results["error"] = f"Browser evaluation error: {e}"

    return results


def print_cli_report(res: dict):
    """Render a clean CLI summary with colors."""
    cyan = "\033[36m"
    green = "\033[32m"
    yellow = "\033[33m"
    red = "\033[31m"
    bold = "\033[1m"
    reset = "\033[0m"

    print("\n" + "=" * 65)
    print(f" {bold}CAPTCHA DETECT & SITEKEY INSPECTION REPORT{reset}")
    print("=" * 65)
    print(f"  {bold}Target URL{reset}    : {res.get('url')}")
    if res.get("final_url") and res.get("final_url") != res.get("url"):
        print(f"  {bold}Final URL{reset}     : {res.get('final_url')}")
    print(f"  {bold}Inspect Mode{reset}  : {res.get('mode')}")

    if not res.get("found"):
        print(f"\n  {yellow}[!] No CAPTCHA protection detected on this page.{reset}")
        if res.get("error"):
            print(f"  {red}Error Details:{reset} {res.get('error')}")
        print("=" * 65 + "\n")
        return

    print(f"  {bold}Status{reset}        : {green}CAPTCHA DETECTED{reset}")
    print("-" * 65)
    print(f"  {bold}Protection{reset}    : {cyan}{res.get('system')}{reset}")
    print(f"  {bold}CAPTCHA Type{reset}  : {green}{bold}{res.get('captcha_type')}{reset}")
    print(f"  {bold}Site Key{reset}      : {yellow}{bold}{res.get('sitekey')}{reset}")

    if res.get("callback"):
        print(f"  {bold}Callback JS{reset}   : {res.get('callback')}")
    if res.get("action"):
        print(f"  {bold}Action Name{reset}   : {res.get('action')}")
    if res.get("size"):
        print(f"  {bold}Badge Size{reset}    : {res.get('size')}")
    if res.get("script_url"):
        print(f"  {bold}Script URL{reset}    : {res.get('script_url')}")
    if res.get("secondary_protection"):
        print(f"  {bold}Secondary Sys{reset} : {cyan}{res.get('secondary_protection')}{reset}")
    if res.get("note"):
        print(f"  {bold}Config Note{reset}   : {yellow}{res.get('note')}{reset}")
    if res.get("proxy"):
        print(f"  {bold}Proxy Used{reset}    : {res.get('proxy')}")

    print("-" * 65)

    # Solve API Request
    sk = res.get("sitekey")
    ct = res.get("captcha_type")
    u = res.get("url")
    proxy_raw = res.get("proxy")

    if sk and ct in ["v2", "v2-callback", "v2-invisible", "v2-enterprise", "v3", "v3-enterprise"]:
        base_qs = f"url={u}&sitekey={sk}&type={ct}"
        if res.get("action") and ct.startswith("v3"):
            base_qs += f"&action={res.get('action')}"

        print(f" {bold}Recommended Solve API Request (Direct):{reset}")
        print(f"  {green}curl \"http://localhost:6868/solve?{base_qs}\"{reset}")

        proxy_val = proxy_raw if proxy_raw else "<proxy_url>"
        print(f"\n {bold}With Proxy (Use Good / Residential IP):{reset}")
        print(f"  {cyan}curl \"http://localhost:6868/solve?{base_qs}&proxy={proxy_val}\"{reset}")
    else:
        print(f" {yellow}[NOTE] This captcha type ({ct}) can be addressed via specialized handler.{reset}")

    print("=" * 65 + "\n")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Inspect a webpage to identify CAPTCHA type and site key."
    )
    parser.add_argument(
        "positional_url",
        nargs="?",
        default=None,
        help="Target URL (e.g. example.com or https://2captcha.com/demo/recaptcha-v2)"
    )
    parser.add_argument(
        "-u", "--url",
        type=str,
        default=None,
        help="Target URL"
    )
    parser.add_argument(
        "-p", "--proxy",
        type=str,
        default=None,
        help="Proxy in host:port:user:pass or http://user:pass@host:port format"
    )
    parser.add_argument(
        "-b", "--browser",
        action="store_true",
        help="Force full dynamic headless browser scan with Playwright"
    )
    parser.add_argument(
        "-s", "--static",
        action="store_true",
        help="Force fast static HTML scan only (no browser execution)"
    )
    parser.add_argument(
        "-j", "--json",
        action="store_true",
        help="Output raw JSON results"
    )
    parser.add_argument(
        "-t", "--timeout",
        type=int,
        default=15,
        help="Timeout in seconds (default: 15)"
    )
    return parser.parse_args()


def main():
    args = parse_args()
    target = args.url or args.positional_url

    if not target:
        try:
            target = input("Enter target website URL (e.g. example.com): ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            sys.exit(0)

    if not target:
        print("\033[31m[ERROR]\033[0m URL is required. Usage: python3 info.py -u <url>")
        sys.exit(1)

    url = normalize_url(target)
    proxy_info = parse_proxy(args.proxy) if args.proxy else None

    # Strategy:
    # 1. If --static is requested, run static only.
    # 2. If --browser is requested, run browser directly.
    # 3. Default: run static first (<0.5s). If dynamic indicators detected or low confidence, run browser.
    if args.static:
        res = analyze_static(url, timeout=args.timeout, proxy_info=proxy_info)
    elif args.browser:
        res = analyze_browser(url, timeout=args.timeout, proxy_info=proxy_info)
    else:
        # Hybrid smart mode
        res = analyze_static(url, timeout=args.timeout, proxy_info=proxy_info)
        # If static did not find anything, or found dynamic SPA behavior, verify via browser
        if (not res.get("found") or res.get("dynamic_hint")) and PLAYWRIGHT_AVAILABLE:
            browser_res = analyze_browser(url, timeout=args.timeout, proxy_info=proxy_info)
            if browser_res.get("found"):
                res = browser_res

    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print_cli_report(res)


if __name__ == "__main__":
    main()
