"""Daily closing prices and first trading dates for every stock the SIFs hold (Yahoo Finance via yfinance).

Used for two things:
  * IPO-related positions: a stock whose first trading day falls in the 12 months before a portfolio's date.
  * Return attribution: each holding's price move from the fund's last disclosure to the latest NAV date.

Symbols: the NSE symbol on AMFI's market-cap list where the holding matches it; otherwise a Yahoo name search,
accepted only if it returns an NSE (.NS) listing. Every lookup is cached in data/monitor/ref/yahoo_symbols.json
(name -> symbol or "") and first trading dates in data/monitor/ref/listing_dates.json, so each is fetched once.

Writes data/monitor/raw/stock_px.csv: date x symbol closing prices from 1 Jun 2026.
"""
from __future__ import annotations

import csv
import json
import time
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent / "data" / "monitor"
SYM = ROOT / "ref" / "yahoo_symbols.json"
LIST = ROOT / "ref" / "listing_dates.json"
PX = ROOT / "raw" / "stock_px.csv"
HIST_FROM = "2025-01-01"   # a stock with prices on this date counts as listed before 2025
KEEP_FROM = "2026-06-01"


def _load(p: Path) -> dict:
    return json.loads(p.read_text()) if p.exists() else {}


OVR = ROOT / "ref" / "symbol_overrides.json"


def symbol_for(name: str, sym_cache: dict) -> str:
    import holdings as HM
    ovr = _load(OVR)
    if name in ovr and isinstance(ovr[name], dict):
        return ovr[name]["symbol"]
    rec = HM.cap_by_name(name)
    if rec and rec.get("nse"):
        return rec["nse"] + ".NS"
    if name in sym_cache:
        return sym_cache[name]
    import yfinance as yf
    import re
    q = re.sub(r"\([^)]*\)", " ", HM.underlying_name(name))
    q = " ".join(w for w in re.sub(r"[^A-Za-z0-9& ]", " ", q).split()
                 if w.lower() not in ("ltd", "limited", "eq", "equity", "new", "fv", "rs", "india", "co", "corp", "corporation"))
    sym = ""
    try:
        hits = yf.Search(q, max_results=5).quotes
        nse = [h for h in hits if str(h.get("symbol", "")).endswith(".NS")]
        sym = nse[0]["symbol"] if nse else ""
    except Exception:
        sym = ""
    sym_cache[name] = sym
    time.sleep(0.4)
    return sym


def main() -> None:
    import yfinance as yf
    lines = ROOT / "out" / "hold_lines.csv"
    if not lines.exists():
        return
    names = sorted({r["name"] for r in csv.DictReader(lines.open()) if r["kind"] == "EQ"}
                   | {r["underlying"] for r in csv.DictReader(lines.open()) if r["kind"] == "FUT" and r["underlying"]})
    sym_cache = _load(SYM)
    import holdings as HM
    name_sym = {n: symbol_for(n, sym_cache) for n in names}
    on_amfi = {sym for n, sym in name_sym.items() if sym and HM.cap_by_name(n)}   # listed by 30 Jun 2026
    bse_only = {sym for n, sym in name_sym.items() if sym and HM.cap_by_name(n) and not HM.cap_by_name(n).get("nse")}
    SYM.write_text(json.dumps(sym_cache, indent=1, sort_keys=True))
    syms = sorted({s for s in name_sym.values() if s})
    frames = []
    for i in range(0, len(syms), 150):
        batch = syms[i:i + 150]
        try:
            d = yf.download(batch, start=HIST_FROM, progress=False, auto_adjust=False, threads=True)["Close"]
            frames.append(d if isinstance(d, pd.DataFrame) else d.to_frame(batch[0]))
        except Exception as e:
            print(f"  ! prices batch {i}: {e}")
        time.sleep(1)
    if not frames:
        return
    px = pd.concat(frames, axis=1)
    listing = _load(LIST)
    for s in px.columns:
        first = px[s].first_valid_index()
        if first is not None:
            fd = first.date().isoformat()
            if fd <= "2025-01-03":
                listing[s] = "before 2025"
            elif s in bse_only:
                # AMFI lists it on BSE only for Jan-Jun 2026: an older company newly traded on NSE, not a new listing
                listing[s] = "before 2026 (BSE-listed per AMFI)"
            elif s in on_amfi and fd > "2026-06-30":
                # on AMFI's Jan-Jun 2026 list, so listed by June: Yahoo's history is incomplete, not a new listing
                listing[s] = "by Jun 2026 (Yahoo history incomplete)"
            else:
                listing[s] = fd
    LIST.write_text(json.dumps(listing, indent=1, sort_keys=True))
    keep = px[px.index >= KEEP_FROM]
    keep.index = keep.index.strftime("%Y-%m-%d")
    keep.round(4).to_csv(PX, index_label="date")
    (ROOT / "ref" / "name_symbol.json").write_text(json.dumps(name_sym, indent=1, sort_keys=True))
    new = sum(1 for v in listing.values() if v != "before 2025" and v >= "2025-11-01")
    print(f"prices: {len(syms)} symbols ({sum(1 for v in name_sym.values() if not v)} names unresolved); {new} listed since Nov 2025")


if __name__ == "__main__":
    main()
