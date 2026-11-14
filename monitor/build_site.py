"""Build a self-contained static copy of the dashboard for any web host:  python3 monitor/build_site.py

Output: monitor/site/  (index.html, sif.js, shim.js, fonts.css, data/*.csv). Upload that folder as is.
The page code (monitor/dashboard/index.html, sif.js) is shared with the claude.ai dashboard; site_src/shim.js stands
in for the claude.ai runtime, and the design tokens below replace the runtime's theme.
"""
from __future__ import annotations

import base64
import gzip
import json
import os
import re
import secrets
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DASHSRC = HERE / "dashboard"
DATA = HERE.parent / "data" / "monitor" / "dash"
SITE = HERE / "site"
D3 = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"
OWNER = "Owner: Vaibhav Gupta · Quant Research · WhiteOak Capital"
DISCLAIMER = "Internal research built from public AMFI, AMC and Groww disclosures. Not investment advice or an offer of any fund."
ITER = 600_000  # PBKDF2-SHA256 rounds for the access-code key

TOKENS = """
:root { color-scheme: light;
  --color-bg: #f5f7fb; --color-panel: #ffffff; --color-fg: #111827; --color-fg-muted: #5d6573; --color-border-line: #dde1e7;
  --color-ok: #1d8a5a; --color-warn: #b7791f; --color-bad: #c43d4b; --color-accent: #2f6fd6;
  --cds-text-secondary: #5d6573; --cds-border: #dde1e7; --cds-surface-popover: #ffffff; --cds-shadow-popover: 0 6px 24px rgba(16,24,40,.14);
  --cds-chart-muted: #b9c0cb; --cds-chart-reference: #8d95a3; --cds-chart-axis: #8d95a3; --cds-chart-grid: #eceff3;
  --cds-radius: 10px; --cds-gap-sm: 8px; --cds-gap-md: 12px; --cds-gap-lg: 16px; --cds-gap-xl: 20px; --cds-pad-md: 12px; --cds-pad-lg: 18px;
  --cds-font-size-caption: 12px; --cds-font-size-heading: 17px; --cds-font-size-title: 26px; --font-anthropic-sans: system-ui; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--color-bg); color: var(--color-fg); }
.site-wrap { max-width: 1240px; margin: 0 auto; padding: 24px 16px 48px; }
.dash-select { font: inherit; font-size: 13px; color: var(--color-fg); background: var(--color-panel); border: 1px solid var(--color-border-line);
  border-radius: 8px; padding: 6px 28px 6px 10px; max-width: 100%; }
a { color: var(--color-accent); }
svg text { fill: var(--color-fg-muted); font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px; }
.site-dl { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; }
"""


def main() -> None:
    src = (DASHSRC / "index.html").read_text()
    src = src.replace('<meta name="dash-one-writer">', "").replace('<link rel="stylesheet" href="fonts.css">', "")
    src = re.sub(r'<script src="sif.js"></script>\s*$', "", src.strip())
    files = sorted(p.name for p in DATA.glob("*.csv"))
    dl = "".join(f'<a href="data/{f}" download>{f}</a>' for f in files)
    src = src.replace('<details>\n      <summary>How the data is collected</summary>',
                      f'<p class="note">Download the data (CSV): <span class="site-dl">{dl}</span></p>\n    '
                      '<details>\n      <summary>How the data is collected</summary>', 1)
    built = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    html = f"""<!doctype html>
<html lang="en-IN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SIF Competitor Monitor</title>
<meta name="description" content="Daily NAV, risk, beta, construction and AUM of India's hybrid long-short SIFs, from AMFI and AMC disclosures.">
<meta name="robots" content="noindex">
<link rel="stylesheet" href="fonts.css">
<style>{TOKENS}</style>
</head>
<body>
<div class="site-wrap">
{src}
<p class="note" style="margin-top:24px;color:var(--color-fg-muted);font-size:12px"><b>{OWNER}</b>. {DISCLAIMER} Built {built}.</p>
</div>
<script src="{D3}"></script>
<script src="shim.js"></script>
<script>SIF_BOOT('sif.js');</script>
</body>
</html>
"""
    if SITE.exists():
        shutil.rmtree(SITE)
    (SITE / "data").mkdir(parents=True)
    (SITE / "index.html").write_text(html)
    for f in ("sif.js", "fonts.css"):
        shutil.copy(DASHSRC / f, SITE / f)
    shutil.copy(HERE / "site_src" / "shim.js", SITE / "shim.js")
    for f in files:
        shutil.copy(DATA / f, SITE / "data" / f)
    pw = os.environ.get("SITE_PASSWORD", "")
    if pw:
        lock(pw, html, files)
    elif "--require-password" in sys.argv:
        sys.exit("SITE_PASSWORD is not set: refusing to publish an unlocked site")
    size = sum(p.stat().st_size for p in SITE.rglob("*") if p.is_file())
    print(f"site built: {SITE}  ({size/1024:.0f} KB, {len(files)} data files, {'locked' if pw else 'open'})")


def lock(pw: str, html: str, files: list[str]) -> None:
    """Replace the open site with an access-code gate. The dashboard (page body, code, every data file) is gzipped
    and sealed with AES-256-GCM under a key derived from the code (PBKDF2-SHA256); only the sealed payload ships."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    import hashlib
    body = html.split('<div class="site-wrap">', 1)[1].rsplit("</div>\n<script", 1)[0]
    bundle = {"body": body, "js": (SITE / "sif.js").read_text(),
              "data": {f[:-4]: (SITE / "data" / f).read_text() for f in files}}
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ITER, 32)
    ct = AESGCM(key).encrypt(iv, gzip.compress(json.dumps(bundle).encode(), 9), None)
    b64 = lambda b: base64.b64encode(b).decode()
    (SITE / "payload.json").write_text(json.dumps({"v": 1, "iter": ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}))
    shutil.rmtree(SITE / "data")
    (SITE / "sif.js").unlink()
    head = html.split("<body>", 1)[0]
    (SITE / "index.html").write_text(head + GATE.replace("{OWNER}", OWNER).replace("{DISCLAIMER}", DISCLAIMER).replace("{D3}", D3))


GATE = """<body>
<style>
.gate { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; font-family: 'Chakra Petch', system-ui, sans-serif; font-weight: 500; }
.gate-card { width: min(440px, 100%); background: var(--color-panel); border: 1px solid var(--color-border-line); border-radius: 14px; padding: 28px 26px; display: grid; gap: 14px; box-shadow: 0 10px 40px rgba(16,24,40,.08); }
.gate-eyebrow { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: var(--color-fg-muted); }
.gate h1 { margin: 0; font-size: 26px; font-weight: 600; }
.gate p { margin: 0; line-height: 1.5; color: var(--color-fg-muted); font-size: 14px; }
.gate form { display: grid; gap: 10px; }
.gate input[type=password] { font: inherit; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 15px; padding: 10px 12px; border: 1px solid var(--color-border-line); border-radius: 9px; background: var(--color-bg); color: var(--color-fg); }
.gate input[type=password]:focus { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.gate button { font: inherit; font-weight: 600; padding: 10px 12px; border: 0; border-radius: 9px; background: var(--color-accent); color: #fff; cursor: pointer; }
.gate button[disabled] { opacity: .6; cursor: progress; }
.gate label.rem { font-size: 13px; color: var(--color-fg-muted); display: flex; gap: 8px; align-items: center; }
.gate .err { color: var(--color-bad); font-size: 13px; min-height: 1em; }
.gate .owner { border-top: 1px solid var(--color-border-line); padding-top: 12px; font-size: 13px; color: var(--color-fg); }
.gate .fine { font-size: 11.5px; }
</style>
<main class="gate" id="gate">
  <div class="gate-card">
    <div class="gate-eyebrow">Specialised Investment Funds · daily official NAVs</div>
    <h1>SIF Competitor Monitor</h1>
    <p>Private research. Enter the access code to open the dashboard.</p>
    <form id="gate-form" autocomplete="off">
      <input type="password" id="gate-code" aria-label="Access code" placeholder="Access code" autofocus>
      <label class="rem"><input type="checkbox" id="gate-rem"> Remember on this device</label>
      <button type="submit" id="gate-btn">Unlock</button>
      <div class="err" id="gate-err" role="alert"></div>
    </form>
    <div class="owner">{OWNER}</div>
    <p class="fine">{DISCLAIMER} The dashboard is encrypted; it opens only in your browser, with the code.</p>
  </div>
</main>
<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const store = { get(k) { try { return sessionStorage.getItem(k) || localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v, keep) { try { (keep ? localStorage : sessionStorage).setItem(k, v); } catch (e) {} },
    del(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch (e) {} } };
  let payload = null;
  async function getPayload() { if (!payload) { const r = await fetch('payload.json', { cache: 'no-cache' }); payload = await r.json(); } return payload; }
  async function unlock(code) {
    const p = await getPayload();
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(p.salt), iterations: p.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(p.iv) }, key, b64(p.ct));
    const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text);
  }
  function load(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.body.append(s); }); }
  async function open(bundle) {
    $('gate').remove();
    const wrap = document.createElement('div'); wrap.className = 'site-wrap'; wrap.innerHTML = bundle.body; document.body.prepend(wrap);
    for (const a of wrap.querySelectorAll('a[href^="data/"]')) {   // CSV downloads come from the unlocked bundle
      const name = a.getAttribute('href').slice(5, -4);
      if (bundle.data[name] !== undefined) a.href = URL.createObjectURL(new Blob([bundle.data[name]], { type: 'text/csv' }));
    }
    await load('{D3}');
    await load('shim.js');
    window.SIF_DATA = bundle.data;
    SIF_BOOT(URL.createObjectURL(new Blob([bundle.js], { type: 'text/javascript' })));
  }
  async function attempt(code, keep, quiet) {
    $('gate-btn').disabled = true; $('gate-err').textContent = quiet ? '' : 'Unlocking…';
    try { const b = await unlock(code); store.set('sif-code', code, keep); await open(b); }
    catch (e) { store.del('sif-code'); $('gate-btn').disabled = false; $('gate-err').textContent = quiet ? '' : 'That code did not unlock the dashboard.'; }
  }
  $('gate-form').addEventListener('submit', (e) => { e.preventDefault(); const c = $('gate-code').value; if (c) attempt(c, $('gate-rem').checked, false); });
  const saved = store.get('sif-code');
  if (saved) attempt(saved, false, true);
})();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    main()
