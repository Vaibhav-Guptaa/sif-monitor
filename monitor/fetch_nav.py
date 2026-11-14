"""Pull the full daily NAV history of every SIF strategy (Direct Plan Growth) and the benchmarks.

Writes, under data/monitor/raw/:
  universe.csv     every SIF share class in today's AMFI file (code, ISIN, AMC, category, plan, option)
  strategies.csv   one row per strategy: the Direct Growth share class we track
  sif_nav.csv      date, code, nav, amfi_upload_time, source   (all tracked share classes, since launch)
                   source = amfi (the record) or groww (only for a date AMFI does not have yet, e.g. the
                   latest NAV when AMFI's history service is behind Groww)
  groww_nav.csv    date, code, nav   (Groww's own series, kept for audit)
  nav_check.csv    per strategy: dates in both, exact matches, largest gap, dates only in one source
  bench.csv        date, series, value                 (Nifty 50 price, Nifty 50 TRI proxy, arbitrage, liquid)

Run:  python3 monitor/fetch_nav.py
"""
from __future__ import annotations

import csv
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sources as S  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "monitor" / "raw"

SPONSOR = {  # brand -> sponsoring AMC; fallback only: build.py takes the fund house from Groww's scheme record
    "Altiva": "Edelweiss", "Apex": "Aditya Birla Sun Life", "Arudha": "Bandhan", "Magnum": "SBI",
    "Platinum": "Mirae Asset", "Titanium": "Tata", "iSIF": "ICICI Prudential", "qsif": "quant",
    "Infinity": "Kotak", "Prism": "Jio BlackRock", "RedHex": "HSBC", "DynaSIF": "360 ONE",
    "Summit": "Invesco", "Sapphire": "Franklin Templeton", "Select": "Sundaram", "WSIF": "The Wealth Company",
}


def brand(amc_line: str, scheme: str) -> str:
    a = amc_line.replace(" SIF", "").strip()
    if a.upper() == "SUMMIT":
        return "Summit"
    if a == "Sundaram Mutual Fund":
        return "Select"
    return a


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    uni = S.sif_universe()
    with open(RAW / "universe.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(uni[0]))
        w.writeheader()
        w.writerows(uni)

    # one Direct Growth share class per strategy; iSIF leaves plan blank, so resolve from the NAV name
    by_scheme: dict[str, list[dict]] = {}
    for r in uni:
        by_scheme.setdefault(r["scheme"], []).append(r)

    strategies, navrows = [], []
    for scheme, rows in by_scheme.items():
        pick = [r for r in rows if S.is_direct_growth(r)]
        hist = None
        if not pick:  # blank plan/option: ask AMFI for each and read its NAV name
            for r in rows:
                h = S.sif_history(r["code"])
                time.sleep(0.3)
                if h["nav_name"] and "direct" in h["nav_name"].lower() and "growth" in h["nav_name"].lower():
                    pick, hist = [r], h
                    break
        if not pick:
            print(f"  no Direct Growth class for {scheme}; skipped", file=sys.stderr)
            continue
        r = pick[0]
        hist = hist or S.sif_history(r["code"])
        time.sleep(0.3)
        b = brand(r["amc"], scheme)
        recs = hist["records"]
        strategies.append(dict(code=r["code"], isin=r["isin"], brand=b, sponsor=SPONSOR.get(b, ""),
                               scheme=scheme, category=r["category"], nav_name=hist["nav_name"],
                               first_nav_date=recs[0][0] if recs else "", n_navs=len(recs)))
        navrows += [(d, r["code"], nav, up) for d, nav, up in recs]
        print(f"  {r['code']:8s} {b:10s} {r['category']:24s} {len(recs):4d} NAVs  {recs[0][0] if recs else '-'} -> {recs[-1][0] if recs else '-'}")

    with open(RAW / "strategies.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(strategies[0]))
        w.writeheader()
        w.writerows(strategies)
    # second source: Groww, keyed by the same AMFI code. AMFI wins every conflict; Groww only fills missing dates.
    amfi = {(d, c): nav for d, c, nav, _ in navrows}
    grows, checks = [], []
    for st in strategies:
        c = st["code"]
        try:
            g = S.groww_nav(c)
        except Exception as exc:
            print(f"  ! Groww NAV {c}: {exc}", file=sys.stderr)
            g = []
        time.sleep(0.3)
        grows += [(d, c, v) for d, v in g]
        a_dates = {d for d, cc in amfi if cc == c}
        g_map = dict(g)
        both = [d for d in a_dates if d in g_map]
        gaps = [abs(g_map[d] / amfi[(d, c)] - 1) for d in both]
        only_g = sorted(d for d in g_map if d not in a_dates)
        checks.append(dict(code=c, brand=st["brand"], amfi_n=len(a_dates), groww_n=len(g_map), both=len(both),
                           exact=sum(x < 1e-9 for x in gaps), max_gap_pct=round(max(gaps) * 100, 4) if gaps else "",
                           mismatch_dates=";".join(sorted(d for d in both if abs(g_map[d] / amfi[(d, c)] - 1) >= 1e-9)),
                           only_amfi=len(a_dates) - len(both), only_groww=";".join(only_g)))
        navrows += [(d, c, g_map[d], "") for d in only_g]
    with open(RAW / "sif_nav.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "code", "nav", "amfi_upload_time", "source"])
        w.writerows(sorted((d, c, nav, up, "amfi" if (d, c) in amfi else "groww") for d, c, nav, up in navrows))
    with open(RAW / "groww_nav.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "code", "nav"])
        w.writerows(sorted(grows))
    with open(RAW / "nav_check.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(checks[0]))
        w.writeheader()
        w.writerows(checks)
    nb, ne = sum(c["both"] for c in checks), sum(c["exact"] for c in checks)
    print(f"  Groww cross-check: {ne}/{nb} shared dates identical; filled {sum(len(c['only_groww'].split(';')) for c in checks if c['only_groww'])} dates AMFI lacks")

    bench = []
    for sid, (code, _label) in S.BENCH_FUNDS.items():
        bench += [(d, sid, v) for d, v in S.mf_history(code)]
        time.sleep(0.3)
    bench += [(d, "nifty50", v) for d, v in S.nifty_price()]
    with open(RAW / "bench.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "series", "value"])
        w.writerows(sorted(bench))
    print(f"strategies {len(strategies)}, SIF NAV rows {len(navrows)}, benchmark rows {len(bench)}")


if __name__ == "__main__":
    main()
