"""Shape the analytics into the files the dashboard reads (data/monitor/dash/).

  funds.csv       scoreboard: one row per SIF strategy and benchmark
  daily.csv       date-by-series NAV index, drawdown, rolling volatility and beta
  alloc.csv       portfolio construction per fund and disclosure date
  holdings.csv    latest line-by-line portfolio of each hybrid fund
  trades.csv      month-on-month quantity changes (official files only)
  aum.csv         assets under management: official month-ends plus reported figures, each with its source
  sources.csv     where every fund's NAV and holdings come from, and how fresh they are
"""
from __future__ import annotations

import csv
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "monitor" / "out"
RAW = ROOT / "data" / "monitor" / "raw"
DASH = ROOT / "data" / "monitor" / "dash"
FUNDID = {"SIF-9": "altiva", "SIF-79": "apex", "SIF-54": "arudha", "SIF-181": "eminence", "SIF-145": "infinity",
          "SIF-36": "isif", "SIF-14": "magnum", "SIF-134": "platinum", "SIF-139": "prism", "SIF-5": "qsif",
          "SIF-129": "redhex", "SIF-32": "titanium"}

# Reported AUM (Rs crore), secondary: aggregator pages quoting AMC factsheets, collected Oct 2026 for the landscape
# page. Replaced automatically by official month-end net assets wherever a portfolio file exists.
REPORTED_AUM = {"altiva": 11297, "apex": 176, "redhex": 1073, "magnum": 3982, "platinum": 385, "titanium": 541,
                "isif": 1323, "qsif": 298, "infinity": 859}
# Industry totals (Rs crore), AMFI monthly SIF data as reported by 5paisa / Angel One
INDUSTRY = [("2026-09-30", "All SIFs", 38287), ("2026-09-30", "Hybrid long-short", 23957),
            ("2026-10-31", "All SIFs", 42669.52), ("2026-10-31", "Hybrid long-short", 26678.90)]


def main() -> None:
    DASH.mkdir(parents=True, exist_ok=True)
    f = pd.read_csv(OUT / "funds.csv")
    f["fund"] = f["id"].map(FUNDID).fillna("")
    f.to_csv(DASH / "funds.csv", index=False, float_format="%.4f")

    d = pd.read_csv(OUT / "daily.csv")
    d = d[["id", "date", "nav", "idx", "dd", "vol20", "vol60", "beta60"]]
    d.to_csv(DASH / "daily.csv", index=False, float_format="%.4f")

    s = pd.read_csv(OUT / "hold_summary.csv")
    s.to_csv(DASH / "alloc.csv", index=False, float_format="%.3f")
    h = pd.read_csv(OUT / "hold_lines.csv")
    h.to_csv(DASH / "holdings.csv", index=False, float_format="%.4f")
    t = pd.read_csv(OUT / "hold_changes.csv") if (OUT / "hold_changes.csv").exists() else pd.DataFrame()
    t.to_csv(DASH / "trades.csv", index=False, float_format="%.3f")

    rows = []
    for _, r in s.dropna(subset=["aum_cr"]).iterrows():
        off = r["source"] == "official"
        rows.append(dict(fund=r["fund"], brand=r["brand"], date=r["asof"], aum_cr=r["aum_cr"], kind="Fund",
                         quality="Official" if off else "Disclosed (via Groww)",
                         source=f"AMC portfolio disclosure ({r['file']})" if off else
                         f"Groww scheme record: net assets of the {r['asof']} disclosed portfolio ({r['file']})"))
    have = {r["fund"] for r in rows}
    brands = dict(zip(s["fund"], s["brand"]))
    for k, v in REPORTED_AUM.items():
        if k not in have:
            rows.append(dict(fund=k, brand=brands.get(k, k), date="2026-10-15", aum_cr=v, kind="Fund", quality="Reported",
                             source="Aggregator page quoting the AMC factsheet, Oct 2026"))
    for dt, label, v in INDUSTRY:
        rows.append(dict(fund="", brand=label, date=dt, aum_cr=v, kind="Industry", quality="Reported",
                         source="AMFI monthly SIF data, as reported by 5paisa and Angel One"))
    pd.DataFrame(rows).to_csv(DASH / "aum.csv", index=False)

    strat = pd.read_csv(RAW / "strategies.csv").set_index("code")
    src = pd.read_csv(OUT / "hold_sources.csv")
    chk = {}
    if (RAW / "nav_check.csv").exists():
        for _, c in pd.read_csv(RAW / "nav_check.csv").fillna("").iterrows():
            t = f"Groww identical on {c['exact']}/{c['both']} shared dates"
            if c["exact"] < c["both"]:
                t += f" (differs on {c['mismatch_dates'].replace(';', ', ')}; AMFI kept)"
            if c["only_amfi"]:
                t += f"; {c['only_amfi']} dates only on AMFI"
            if c["only_groww"]:
                t += f"; filled from Groww: {c['only_groww'].replace(';', ', ')}"
            chk[c["code"]] = t
    fl = f.set_index("id")
    out = []
    for _, r in src.iterrows():
        st = strat.loc[r["code"]]
        out.append(dict(
            fund=r["fund"], brand=r["brand"], amfi_code=r["code"], isin=st["isin"],
            nav_source=f"AMFI SIF NAV history API, {r['code']} (Direct Plan Growth)",
            nav_groww_check=chk.get(r["code"], ""),
            nav_from=fl.loc[r["code"], "first_date"] if r["code"] in fl.index else "",
            nav_to=fl.loc[r["code"], "last_date"] if r["code"] in fl.index else "",
            holdings_source={"official": "AMC portfolio file", "groww": "Groww scheme record (AMC disclosure, all lines)",
                             "groww_page": "Groww holdings page (transcribed)", "none": "Not yet disclosed"}[r["latest_source"]],
            holdings_asof=r["latest_asof"] if isinstance(r["latest_asof"], str) else "",
            official_months=r["official_months"] if isinstance(r["official_months"], str) else "",
            holdings_automated=r["automated"], disclosure_page=r["disclosure_page"] if isinstance(r["disclosure_page"], str) else ""))
    pd.DataFrame(out).to_csv(DASH / "sources.csv", index=False)
    for p in sorted(DASH.glob("*.csv")):
        print(f"  {p.name:14s} {p.stat().st_size/1024:7.1f} KB")


if __name__ == "__main__":
    main()
