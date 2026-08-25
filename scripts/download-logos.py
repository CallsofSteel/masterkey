#!/usr/bin/env python3
"""
Download brand logos for all services in the MasterKey registry.

Strategy (in order of preference):
1. Simple Icons SVG (for ~50 major tech brands with known slugs)
2. DuckDuckGo favicon ICO -> convert to PNG (universal, works for most domains)
3. Google favicon at 64px PNG (fallback, filtered by generic-icon hash)

Saves to: public/logos/{domain}.png or public/logos/{domain}.svg
"""

import json, os, sys, hashlib, urllib.request, urllib.error, time, subprocess

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGOS_DIR = os.path.join(BASE, "public", "logos")
INDEX_PATH = os.path.join(BASE, "data", "registry", "index.json")

os.makedirs(LOGOS_DIR, exist_ok=True)

# Google's generic fallback favicon MD5 (126px)
GOOGLE_GENERIC_MD5 = "b8a0bf372c762e966cc99ede8682bc71"

# Known Simple Icons slugs for popular services
# Full list at https://simpleicons.org — slug = icon filename without .svg
SIMPLE_ICONS = {
    "openai.com": "openai",
    "anthropic.com": "anthropic",
    "google.com": "google",
    "stripe.com": "stripe",
    "elevenlabs.io": "elevenlabs",
    "supabase.com": "supabase",
    "replicate.com": "replicate",
    "groq.com": "groq",
    "cohere.com": "cohere",
    "cloudflare.com": "cloudflare",
    "resend.com": "resend",
    "discord.com": "discord",
    "telegram.org": "telegram",
    "neon.tech": "neon",
    "render.com": "render",
    "mapbox.com": "mapbox",
    "turso.tech": "turso",
    "huggingface.co": "huggingface",
    "x.ai": "xai",
    "perplexity.ai": "perplexity",
    "together.ai": "togetherai",
    "mistral.ai": "mistral",
    "alchemy.com": "alchemy",
    "datadog.com": "datadog",
    "datadoghq.com": "datadog",
    "hunter.io": "hunterio",
    "sendgrid.com": "twilio",
    "quicknode.com": "quicknode",
    "nansen.ai": "nansen",
    "bytedance.com": "bytedance",
    "replit.app": "replit",
    "replit.com": "replit",
    "ts.net": "tailscale",
    "x402ads.io": None,  # no simple icon
}

# Provider → domain mapping for entries that don't have a domain set
PROVIDER_DOMAINS = {
    "PaySponge": "paysponge.com",
    "DefiLlama": "defillama.com",
    "Alpha Vantage": "alphavantage.co",
    "ScreenshotOne": "screenshotone.com",
    "ScrapeGraphAI": "scrapegraphai.com",
    "Olostep": "olostep.com",
    "Kuaishou": "kuaishou.com",
    "Liquid AI": "liquid.ai",
    "Baseten": "baseten.co",
    "Venice": "venice.ai",
    "Open-Meteo": "open-meteo.com",
    "LivePortrait": "liveportrait.org",
    "Z.ai": "z.ai",
    "OKLink": "oklink.com",
    "Wavespeed": "wavespeed.ai",
    "Notte": "notte.cc",
    "Andi": "andisearch.com",
    "Context.dev": "context.dev",
    "Scrape Creators": "scrapecreators.com",
    "MyShell": "myshell.ai",
    "Hugging Face": "huggingface.co",
    "Orbis": "orbisgroup.io",
    "SlinkyLayer": "slinkylayer.com",
    "Spraay": "spraay.io",
    "Kasandell": "kasandell.com",
    "CivicMerge": "civicmerge.com",
    "HTTPay": "httppay.io",
    "Dome": "domeprotocol.xyz",
    "Surf": "surf.tech",
    "OneSource": "onesource.io",
    "VpsAgent": "vpsagent.io",
    "Precip AI": "precip.ai",
    "Agentic Reservations": "agentres.dev",
    "x402node": "x402node.com",
    "gg402": "gg402.com",
    "Brack Hive": "brackhive.com",
}

def fetch(url, timeout=10):
    """Fetch URL, return (bytes, content_type) or (None, None) on error."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.headers.get("Content-Type", "")
    except Exception:
        return None, None

def md5(data):
    return hashlib.md5(data).hexdigest()

def is_real_logo(data, content_type):
    """Return True if the data looks like a real branded logo (not a generic fallback)."""
    if not data or len(data) < 100:
        return False
    # Filter Google's generic globe icon
    if md5(data) == GOOGLE_GENERIC_MD5:
        return False
    # Filter very tiny images (1px×1px fallbacks)
    if len(data) < 150:
        return False
    return True

def save(domain, data, ext):
    path = os.path.join(LOGOS_DIR, f"{domain}.{ext}")
    with open(path, "wb") as f:
        f.write(data)
    return path

def already_have(domain):
    for ext in ("svg", "png", "ico"):
        if os.path.exists(os.path.join(LOGOS_DIR, f"{domain}.{ext}")):
            return True
    return False

def download_simple_icon(domain):
    slug = SIMPLE_ICONS.get(domain)
    if not slug:
        return False
    url = f"https://cdn.simpleicons.org/{slug}"
    data, ct = fetch(url)
    if data and "svg" in (ct or "").lower():
        save(domain, data, "svg")
        return True
    return False

def download_google_favicon(domain):
    url = f"https://www.google.com/s2/favicons?domain={domain}&sz=64"
    data, ct = fetch(url)
    if data and is_real_logo(data, ct):
        save(domain, data, "png")
        return True
    return False

def download_ddg_favicon(domain):
    url = f"https://icons.duckduckgo.com/ip3/{domain}.ico"
    data, ct = fetch(url)
    if not data or len(data) < 500:
        return False
    # DDG returns ICO files — check if it's actually a real icon (>500 bytes)
    # For domains with no custom favicon DDG still returns a small generic icon
    if len(data) < 500:
        return False
    save(domain, data, "png")  # save as .png even though it's ico (browsers handle it)
    return True

def download_apple_touch_icon(domain):
    url = f"https://{domain}/apple-touch-icon.png"
    data, ct = fetch(url)
    if data and "image" in (ct or "").lower() and len(data) > 1000:
        save(domain, data, "png")
        return True
    return False

def download_logo_for_domain(domain, label=""):
    if already_have(domain):
        print(f"  [SKIP] {domain} (already have)")
        return "cached"

    tag = f"{domain}" + (f" ({label})" if label else "")

    # 1. Simple Icons SVG (best quality for major brands)
    if download_simple_icon(domain):
        print(f"  [SVG]  {tag}")
        return "svg"

    # 2. Apple touch icon from website (high quality PNG, 180x180)
    if download_apple_touch_icon(domain):
        print(f"  [ICON] {tag}")
        return "apple"

    # 3. Google favicon (reliable, filters generics)
    if download_google_favicon(domain):
        print(f"  [GOOG] {tag}")
        return "google"

    # 4. DuckDuckGo favicon (last resort)
    if download_ddg_favicon(domain):
        print(f"  [DDG]  {tag}")
        return "ddg"

    print(f"  [MISS] {tag}")
    return None

def main():
    with open(INDEX_PATH) as f:
        index = json.load(f)

    entries = index.get("entries", [])

    # Collect domains to download
    domains_to_download = {}  # domain -> label

    # From entries with domains set
    for e in entries:
        d = e.get("domain")
        if d and d not in domains_to_download:
            domains_to_download[d] = e.get("name", d)

    # From no-domain entries via provider mapping
    for e in entries:
        if not e.get("domain"):
            provider = e.get("provider", "")
            mapped = PROVIDER_DOMAINS.get(provider)
            if mapped and mapped not in domains_to_download:
                domains_to_download[mapped] = f"[{provider}]"

    print(f"Downloading logos for {len(domains_to_download)} domains...")
    print(f"Logos dir: {LOGOS_DIR}")
    print()

    results = {"svg": 0, "apple": 0, "google": 0, "ddg": 0, "cached": 0, "miss": 0}

    for i, (domain, label) in enumerate(sorted(domains_to_download.items()), 1):
        print(f"[{i}/{len(domains_to_download)}]", end=" ")
        result = download_logo_for_domain(domain, label)
        key = result if result in results else "miss"
        results[key] = results.get(key, 0) + 1
        # Small delay to be polite to APIs
        if i % 10 == 0:
            time.sleep(0.5)

    print()
    print("=== Summary ===")
    print(f"  SVG (Simple Icons):    {results['svg']}")
    print(f"  Apple touch icon:      {results['apple']}")
    print(f"  Google favicon:        {results['google']}")
    print(f"  DDG favicon:           {results['ddg']}")
    print(f"  Cached (pre-existing): {results['cached']}")
    print(f"  Missing/generic:       {results['miss']}")
    print(f"  Total attempted:       {sum(results.values())}")
    print()

    # Print which domains are still missing
    missing = [d for d in domains_to_download if not already_have(d)]
    if missing:
        print(f"Still missing logos ({len(missing)}):")
        for d in sorted(missing):
            print(f"  {d} ({domains_to_download[d]})")

if __name__ == "__main__":
    main()
