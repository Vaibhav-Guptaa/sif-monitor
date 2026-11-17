"""Fetchers for the official data behind the SIF monitor.

Every series here comes from a named, public, primary source:

  SIF daily NAV        AMFI SIF NAV history API (the same endpoint amfiindia.com/sif/latest-nav/nav-history
                       calls). One call per scheme returns every NAV since launch, with AMFI's upload time.
  SIF universe         AMFI SIF_NAVAll.txt (portal.amfiindia.com/spages/SIF_NAVAll.txt), published each
                       business day by 23:00 IST: every SIF strategy, its category, AMC, plan, option, ISIN.
  Benchmarks (funds)   AMFI mutual-fund NAV history API: UTI Nifty 50 Index Fund Direct (Nifty 50 TRI
                       proxy), Kotak Arbitrage Fund Direct, HDFC Liquid Fund Direct.
  Nifty 50 price       Yahoo Finance ^NSEI daily close (NSE's own archive refuses scripted requests).
  Groww (second source) groww.in public JSON behind its fund pages, keyed by the same AMFI code (SIF-n):
                       daily NAV graph (cross-check and same-night fill when AMFI's file is late), and the scheme
                       record with AUM and the latest full portfolio (every line, with market value and % of NAV).

Standard library only, apart from yfinance for ^NSEI.
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone

AMFI = "https://www.amfiindia.com"
SIF_NAVALL = "https://portal.amfiindia.com/spages/SIF_NAVAll.txt"
UA = "sif-monitor/1.0 (research)"

BENCH_FUNDS = {
    # id: (AMFI code, label)
    "nifty_tri": (120716, "Nifty 50 TRI (UTI Nifty 50 Index Fund, Direct)"),
    "arbitrage": (119771, "Arbitrage fund (Kotak Arbitrage Fund, Direct)"),
    "liquid": (119091, "Liquid fund (HDFC Liquid Fund, Direct)"),
}

CATEGORY_SHORT = {
    "Hybrid Long-Short Fund": "Hybrid long-short",
    "Equity Long-Short Fund": "Equity long-short",
    "Equity Ex-Top 100 Long-Short Fund": "Ex-top 100 long-short",
    "Active Asset Allocator Long-Short Fund": "Active asset allocator",
    "Sector Rotation Long-Short Fund": "Sector rotation",
}


def get(url: str, timeout: int = 60, tries: int = 3) -> bytes:
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as exc:  # network hiccup: back off and retry
            last = exc
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"GET failed after {tries} tries: {url}: {last}")


def sif_universe() -> list[dict]:
    """Parse SIF_NAVAll.txt into one row per share class."""
    text = get(SIF_NAVALL).decode("utf-8", "replace")
    rows, category, amc = [], None, None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("Scheme Code"):
            continue
        if ";" not in line:
            m = re.match(r"(Open Ended|Interval Fund) Schemes\((.*?) - (.*)\)$", line)
            if m:
                category = CATEGORY_SHORT.get(m.group(3).strip(), m.group(3).strip())
            else:
                amc = line
            continue
        p = line.split(";")
        if len(p) < 8:
            continue
        rows.append(dict(code=p[0], isin=p[1] if p[1] != "-" else p[2], scheme=p[3].strip(),
                         plan=p[4].strip(), option=p[5].strip(), nav=float(p[6]), date=p[7],
                         amc=amc, category=category))
    return rows


def sif_history(code: str, start: str = "2025-01-01", end: str | None = None) -> dict:
    """All NAVs for one SIF share class (e.g. 'SIF-9') between two dates. AMFI allows 5 years per call."""
    end = end or date.today().isoformat()
    url = f"{AMFI}/api/sif-nav-history?query_type=historical_period&from_date={start}&to_date={end}&sd_id={code}"
    d = json.loads(get(url))["data"]
    groups = d.get("nav_groups") or []
    recs = groups[0]["historical_records"] if groups else []
    return dict(nav_name=groups[0]["nav_name"] if groups else None, scheme=d.get("scheme_name"),
                amc=d.get("mf_name"),
                records=[(r["date"], float(r["nav"]), r.get("upload_time")) for r in recs])


GROWW = "https://groww.in/v1/api"
IST = timezone(timedelta(hours=5, minutes=30))


def groww_nav(code: str) -> list[tuple[str, float]]:
    """Groww's daily NAV series for one SIF share class (AMFI code, e.g. 'SIF-9'), since its first NAV on Groww."""
    d = json.loads(get(f"{GROWW}/data/mf/web/v1/scheme/{code}/graph?benchmark=false&months=120"))
    pts = (d.get("folio") or {}).get("data") or []
    return [(datetime.fromtimestamp(t / 1000, IST).date().isoformat(), float(v)) for t, v in pts]


def groww_search(query: str) -> list[str]:
    from urllib.parse import quote
    d = json.loads(get(f"{GROWW}/search/v3/query/global/st_p_query?page=0&size=10&web=true&query={quote(query)}"))
    return [h["search_id"] for h in d["data"]["content"] if h.get("entity_type") == "Scheme"]


def groww_scheme(search_id: str) -> dict:
    """Groww's scheme record: scheme_code (AMFI), aum (Rs cr), nav, holdings[] (latest portfolio), etc."""
    return json.loads(get(f"{GROWW}/data/mf/web/v4/scheme/search/{search_id}"))


def mf_history(code: int, start: str = "2025-01-01", end: str | None = None) -> list[tuple[str, float]]:
    """All NAVs for one mutual-fund scheme by AMFI code."""
    end = end or date.today().isoformat()
    url = f"{AMFI}/api/nav-history?query_type=historical_period&from_date={start}&to_date={end}&sd_id={code}"
    d = json.loads(get(url))["data"]
    recs = d["nav_groups"][0]["historical_records"]
    return [(r["date"], float(r["nav"])) for r in recs]


def nifty_price(start: str = "2025-01-01", want: str | None = None) -> list[tuple[str, float]]:
    """Nifty 50 closes from Yahoo. The benchmark calendar is built on these dates, so a missing latest close would
    hold every benchmark at the previous day. want = the latest date AMFI has fund NAVs for: if Yahoo's series ends
    before it, retry a few times, then warn (the next scheduled run catches up)."""
    import time
    import yfinance as yf
    out: list[tuple[str, float]] = []
    for attempt in range(4):
        h = yf.Ticker("^NSEI").history(start=start, auto_adjust=False)
        out = [(d.strftime("%Y-%m-%d"), round(float(c), 2)) for d, c in zip(h.index, h["Close"])]
        if not want or (out and out[-1][0] >= want):
            return out
        time.sleep(60 * (attempt + 1))
    print(f"  WARNING: Yahoo Nifty 50 ends {out[-1][0] if out else 'empty'}, fund NAVs reach {want}; "
          "benchmarks stay at the earlier date until the next run")
    return out


def is_direct_growth(r: dict) -> bool:
    """Pick the Direct Plan Growth share class. iSIF leaves Plan/Option blank; its NAV name says it."""
    plan, opt = r["plan"].lower(), r["option"].lower()
    if plan or opt:
        return "direct" in plan and "growth" in opt and "idcw" not in opt
    return False
