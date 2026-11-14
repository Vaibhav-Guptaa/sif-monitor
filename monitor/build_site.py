"""Build a self-contained static copy of the dashboard for any web host:  python3 monitor/build_site.py

Output: monitor/site/  (index.html, sif.js, shim.js, fonts.css, data/*.csv). Upload that folder as is.
The page code (monitor/dashboard/index.html, sif.js) is shared with the claude.ai dashboard; site_src/shim.js stands
in for the claude.ai runtime, and the design tokens below replace the runtime's theme.
"""
from __future__ import annotations

import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DASHSRC = HERE / "dashboard"
DATA = HERE.parent / "data" / "monitor" / "dash"
SITE = HERE / "site"
D3 = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"

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
<p class="note" style="margin-top:24px;color:var(--color-fg-muted);font-size:12px">Built {built}.</p>
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
    size = sum(p.stat().st_size for p in SITE.rglob("*") if p.is_file())
    print(f"site built: {SITE}  ({size/1024:.0f} KB, {len(files)} data files)")


if __name__ == "__main__":
    main()
