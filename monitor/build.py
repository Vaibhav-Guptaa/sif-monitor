"""Shape the analytics into the files the dashboard reads (data/monitor/dash/).

  funds.csv       scoreboard: one row per SIF strategy and benchmark
  daily.csv       date-by-series NAV index, drawdown, rolling volatility and beta
  alloc.csv       portfolio construction per fund and disclosure date
  holdings.csv    latest line-by-line portfolio of each hybrid fund
  trades.csv      month-on-month quantity changes (official files only)
  aum.csv         assets under management: official month-ends plus reported figures, each with its source
  sources.csv     where every fund's NAV and holdings come from, and how fresh they are
  families.csv    every SIF strategy with its family, official AMFI facts (objective, type, benchmark, stated
                  allocation, risk band, managers, expense) and month-end AUM with its date
"""
from __future__ import annotations

import csv
import json
import re
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


def _nk(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", " ", (s or "").lower())
    return " ".join(w for w in s.split() if w not in ("fund", "sif", "the", "investment", "strategy"))


def _pick(d: dict, *need: str, avoid: tuple = ()) -> str:
    """First SSD field whose label contains every word in need and none in avoid (labels differ by AMC)."""
    for k, v in d.items():
        kl = re.sub(r"[^a-z0-9]+", " ", k.lower())
        if all(n in kl for n in need) and not any(a in kl for a in avoid):
            v = str(v).strip()
            if v and v.upper() not in ("NA", "N.A.", "--", "-", "NIL"):
                return re.sub(r"\s*\|\s*", " ", v)
    return ""


def _ter_direct(txt: str) -> str:
    """Direct-plan expense ratio from the SSD's free text, in % (some AMCs file 0.0043 for 0.43%)."""
    m = re.search(r"direct[^0-9]{0,40}?([0-9]*\.?[0-9]+(?:e-?\d+)?)", txt or "", re.I)
    if not m:
        m = re.fullmatch(r"\s*(?:upto\s*)?([0-9]*\.?[0-9]+)\s*%?\s*(?:\(groww\))?\s*", txt or "", re.I)
    if not m:
        return ""
    v = float(m.group(1))
    return f"{v * 100:.2f}" if v < 0.2 else f"{v:.2f}"


def _risk(txt: str) -> str:
    m = re.search(r"level\D{0,4}(\d)", txt or "", re.I)
    return m.group(1) if m else ""


def _house(groww: str, typed, brand: str) -> str:
    """Fund house from Groww's scheme record (same as AMFI's AMC listing); the hand-typed map is only a fallback,
    and any disagreement is printed so a wrong entry cannot slip through."""
    g = re.sub(r"\s*(Mutual Fund|Asset Management.*|AMC.*)$", "", str(groww or "")).strip()
    t = typed.strip() if isinstance(typed, str) else ""
    if g and t and not (t.lower().replace(" ", "") in g.lower().replace(" ", "") or g.lower().replace(" ", "") in t.lower().replace(" ", "")):
        print(f"  ! fund house for {brand}: typed '{t}' but Groww says '{g}'; using Groww")
    return g or t


def families() -> pd.DataFrame:
    st = pd.read_csv(RAW / "strategies.csv")
    sc = pd.read_csv(RAW / "schemes.csv") if (RAW / "schemes.csv").exists() else pd.DataFrame(columns=["code"])
    meta = json.loads((ROOT / "data" / "monitor" / "ref" / "amfi_strategies.json").read_text()) \
        if (ROOT / "data" / "monitor" / "ref" / "amfi_strategies.json").exists() else {"strategies": {}, "fetched": ""}
    by_name = {_nk(r["name"]): r for r in meta["strategies"].values()}
    sc = sc.set_index("code") if len(sc) else sc
    rows = []
    for _, s_ in st.iterrows():
        a = by_name.get(_nk(s_["scheme"]), {})
        d = a.get("ssd", {})
        g = sc.loc[s_["code"]] if s_["code"] in sc.index else {}
        gv = (lambda k: g.get(k) if hasattr(g, "get") and pd.notna(g.get(k)) else "")
        bench = _pick(d, "benchmark", avoid=("tier 2",)) or _pick(d, "bench")
        rows.append(dict(
            family=s_["brand"], amc=_house(gv("fund_house"), s_["sponsor"], s_["brand"]), code=s_["code"], strategy=s_["scheme"], category=s_["category"],
            type=("Interval" if "interval" in (a.get("type", "") or "").lower() else "Open-ended" if a.get("type") else ""),
            launch=a.get("launch") or s_.get("first_nav_date", ""), first_nav=s_.get("first_nav_date", ""),
            aum_sep_cr=gv("portfolio_net_assets_cr") if gv("portfolio_date") == "2026-09-30" else "",
            aum_latest_cr=gv("aum_cr"), aum_latest_basis=gv("aum_date"), portfolio_date=gv("portfolio_date"),
            benchmark=bench or gv("benchmark"), benchmark_source="AMFI summary document" if bench else ("Groww" if gv("benchmark") else ""),
            objective=re.sub(r"\s+", " ", a.get("objective", "")).strip(),
            allocation=_pick(d, "stated", "allocation") or _pick(d, "asset", "allocation"),
            risk_band=_pick(d, "risk", avoid=("launch", "potential")),
            managers=_pick(d, "manager", "name"),
            expense=_pick(d, "expense") or (("Direct " + d["TER Direct"]) if d.get("TER Direct") else "") or (f"{gv('expense_ratio')}% (Groww)" if gv("expense_ratio") else ""),
            ter_direct=_ter_direct(_pick(d, "expense") or (("Direct " + d["TER Direct"]) if d.get("TER Direct") else "")) or (f"{float(gv('expense_ratio')):.2f}" if gv("expense_ratio") else ""),
            ter_source="AMFI summary document" if _ter_direct(_pick(d, "expense") or (("Direct " + d["TER Direct"]) if d.get("TER Direct") else "")) else ("Groww" if gv("expense_ratio") else ""),
            risk_level=_risk(_pick(d, "risk", avoid=("launch", "potential"))),
            exit_load=re.sub(r"\s+", " ", a.get("load", "") or gv("exit_load")).strip(),
            min_investment=a.get("min_amt", ""), ssd=("https://portal.amfiindia.com/spages/SSD_" + a["scheme_id"] + ".xml") if d else "",
            amfi_id=a.get("scheme_id", ""), amfi_fetched=meta.get("fetched", ""),
        ))
    return pd.DataFrame(rows)


def industry_totals() -> list[tuple]:
    """Hand-entered AMFI totals plus months settled by llm_assist.py (web search, checked), hand entries winning."""
    rows = list(INDUSTRY)
    have = {(d, lab) for d, lab, _ in rows}
    f = ROOT / "data" / "monitor" / "ref" / "industry_aum.json"
    if f.exists():
        for m, d in json.loads(f.read_text()).items():
            for lab, k in (("All SIFs", "all_sifs_cr"), ("Hybrid long-short", "hybrid_long_short_cr")):
                if (m, lab) not in have:
                    rows.append((m, lab, d[k]))
    return rows


def main() -> None:
    DASH.mkdir(parents=True, exist_ok=True)
    f = pd.read_csv(OUT / "funds.csv")
    f["fund"] = f["id"].map(FUNDID).fillna(f["id"].where(f["kind"] == "SIF", "").str.lower())
    f.to_csv(DASH / "funds.csv", index=False, float_format="%.4f")

    d = pd.read_csv(OUT / "daily.csv")
    d = d[["id", "date", "nav", "idx", "dd", "vol20", "vol60", "beta20", "beta60", "ret6m", "ret12m", "sharpe6m"]]
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
    for dt, label, v in industry_totals():
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
    families().to_csv(DASH / "families.csv", index=False)
    for p in sorted(DASH.glob("*.csv")):
        print(f"  {p.name:14s} {p.stat().st_size/1024:7.1f} KB")


if __name__ == "__main__":
    main()
