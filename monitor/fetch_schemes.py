"""Scheme facts for every SIF strategy from Groww's scheme record (same AMFI code): AUM with its disclosure date,
benchmark, expense ratio, exit load, fund manager, minimum investment, launch date.

Output: data/monitor/raw/schemes.csv (one row per strategy, Direct Plan Growth). Groww search ids are cached in
data/monitor/ref/groww_scheme_ids.json so later runs make one call per strategy.
"""
from __future__ import annotations

import csv
import html
import json
import re
import time
from datetime import date
from pathlib import Path

import sources as S

ROOT = Path(__file__).resolve().parent.parent / "data" / "monitor"
STRAT = ROOT / "raw" / "strategies.csv"
OUT = ROOT / "raw" / "schemes.csv"
IDS = ROOT / "ref" / "groww_scheme_ids.json"
PORT = ROOT / "portfolios"
AMFI_META = ROOT / "ref" / "amfi_strategies.json"   # official facts per AMFI strategy id (S-n), refreshed weekly
COLS = ["code", "brand", "sponsor", "scheme", "category", "first_nav_date", "aum_cr", "aum_date", "benchmark",
        "expense_ratio", "exit_load", "fund_manager", "min_investment", "fund_house", "nav", "nav_date", "fetched", "found",
        "portfolio_date", "portfolio_net_assets_cr"]


def _pdate(doc: dict) -> str:
    ds = sorted({h["portfolio_date"] for h in (doc.get("holdings") or []) if h.get("portfolio_date")})
    if not ds:
        return ""
    return S.datetime.fromisoformat(ds[-1].replace("Z", "+00:00")).astimezone(S.IST).date().isoformat()


def _find(code: str, scheme: str, ids: dict) -> dict | None:
    if code in ids:
        try:
            d = S.groww_scheme(ids[code])
            if d.get("scheme_code") == code:
                return d
        except Exception:
            pass
    for q in (scheme, scheme.replace(" - ", " ").replace("-", " ")):
        try:
            hits = S.groww_search(q)
        except Exception:
            hits = []
        for sid in hits:
            time.sleep(0.3)
            try:
                d = S.groww_scheme(sid)
            except Exception:
                continue
            if d.get("scheme_code") == code:
                ids[code] = sid
                return d
        time.sleep(0.3)
    return None


def _ist_date(ts: str) -> str:
    """AMFI returns launch dates as UTC midnight-IST timestamps (2026-03-05T18:30:00Z = 6 Mar IST)."""
    if not ts:
        return ""
    try:
        return S.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(S.IST).date().isoformat()
    except ValueError:
        return ts[:10]


def _ssd(scheme_id: str) -> dict:
    """AMFI 'Investment Strategy Summary Document' (SSD_S-n.xml): label -> text."""
    x = S.get(f"https://portal.amfiindia.com/spages/SSD_{scheme_id}.xml").decode("utf-8", "replace").lstrip("\ufeff")
    out: dict[str, str] = {}
    if "<Workbook" not in x[:2000]:  # AMFI's plain XML layout: one tag per field
        for t, v in re.findall(r"<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)</\1>", x):
            v = html.unescape(html.unescape(v)).strip()
            if v and t not in out:
                out[t.replace("_", " ")] = v
        return out
    for r in re.findall(r"<Row[^>]*>(.*?)</Row>", x, re.S):
        c = [re.sub(r"[ \t]{3,}", " | ", html.unescape(re.sub(r"<[^>]+>", "", v)).strip()) for v in re.findall(r"<Data[^>]*>(.*?)</Data>", r, re.S)]
        c = [v for v in c if v]
        if len(c) >= 3 and c[0].strip().isdigit():
            key = c[1].strip()
            if key not in out:
                out[key] = " ".join(c[2:]).strip()
        elif len(c) == 2 and c[0] in ("Regular", "Direct"):
            out["TER " + c[0]] = c[1]
    return out


def amfi_meta(force: bool = False) -> dict:
    """Every SIF strategy AMFI lists: objective, type, launch, load, minimum, plus the SSD (benchmark, stated
    allocation, risk band, managers, TER, AMFI codes). Cached; refetched when older than 7 days."""
    if AMFI_META.exists() and not force:
        m = json.loads(AMFI_META.read_text())
        if (date.today() - date.fromisoformat(m.get("fetched", "2000-01-01"))).days < 7:
            return m
    strategies, miss = {}, 0
    for sif_id in range(1, 120):
        try:
            lst = json.loads(S.get(f"{S.AMFI}/api/populate-investment-strategy?sif_id={sif_id}"))
        except Exception:
            lst = []
        miss = 0 if lst else miss + 1
        for it in lst or []:
            sid = it["scheme_id"]
            rec = {"sif_id": sif_id, "scheme_id": sid, "name": it.get("scheme_name", "")}
            try:
                d = (json.loads(S.get(f"{S.AMFI}/api/investment-strategy-detail?sif_id={sif_id}&scheme_id={sid}")).get("data") or [{}])[0]
                rec.update(objective=d.get("Scheme_Objective", ""), type=d.get("SchemeType_Desc", ""), category=d.get("SchemeCat_Desc", ""),
                           launch=_ist_date(d.get("Launch_Date") or ""), load=d.get("scheme_load", ""), min_amt=d.get("Scheme_min_amt", ""),
                           sif_name=d.get("SIF_Name", ""), amc_site=d.get("AMC_Website", ""))
            except Exception as e:
                rec["detail_error"] = str(e)[:80]
            try:
                rec["ssd"] = _ssd(sid)
            except Exception as e:
                rec["ssd_error"] = str(e)[:80]
            strategies[sid] = rec
            time.sleep(0.2)
        if miss >= 25 and sif_id > 60:
            break
        time.sleep(0.15)
    m = {"fetched": date.today().isoformat(), "strategies": strategies}
    AMFI_META.write_text(json.dumps(m, indent=1, ensure_ascii=False))
    print(f"amfi: {len(strategies)} strategies with official summary documents")
    return m


def main() -> None:
    ids = json.loads(IDS.read_text()) if IDS.exists() else {}
    old = {r["code"]: r for r in csv.DictReader(OUT.open())} if OUT.exists() else {}
    rows = []
    for s in csv.DictReader(STRAT.open()):
        d = _find(s["code"], s["scheme"], ids)
        time.sleep(0.3)
        base = {k: s.get(k, "") for k in ("code", "brand", "sponsor", "scheme", "category", "first_nav_date")}
        if not d:
            prev = old.get(s["code"])
            rows.append({**(prev or {c: "" for c in COLS}), **base, "found": "no" if not prev else "cached"})
            print(f"  ? Groww: no scheme record for {s['brand']} {s['category']} ({s['code']})")
            continue
        mgr = "; ".join(dict.fromkeys(m.get("person_name", "") for m in (d.get("fund_manager_details") or []) if m.get("person_name"))) or d.get("fund_manager") or ""
        H = d.get("holdings") or []
        pnet = round(sum((h.get("market_value") or 0) for h in H), 2) if H else ""
        pdate = _pdate(d)
        # Groww's AUM field is the month-end net assets of the portfolio it shows, until the AMC publishes a newer
        # month-end AUM; then it moves ahead of the portfolio. Date it accordingly.
        aum = d.get("aum")
        same = bool(aum and pnet and abs(float(aum) - pnet) < 0.5)
        if H and pdate and s["category"] != "Hybrid long-short":  # hybrid funds are snapshotted by fetch_portfolios
            dest = PORT / s["code"].lower() / f"groww_{pdate}.json"
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                keep = {k: d.get(k) for k in ("scheme_code", "scheme_name", "isin", "aum", "nav", "nav_date", "search_id")}
                keep.update(portfolio_date=pdate, fetched=date.today().isoformat(), source=f"{S.GROWW}/data/mf/web/v4/scheme/search/{ids.get(s['code'], '')}", holdings=H)
                dest.write_text(json.dumps(keep, indent=1))
        rows.append({**base, "aum_cr": aum or "", "aum_date": pdate if same else ("after " + pdate if pdate else ""),
                     "portfolio_date": pdate, "portfolio_net_assets_cr": pnet, "benchmark": d.get("benchmark_name") or d.get("benchmark") or "",
                     "expense_ratio": d.get("expense_ratio") or "", "exit_load": (d.get("exit_load") or "").strip(), "fund_manager": mgr,
                     "min_investment": d.get("min_investment_amount") or "", "fund_house": d.get("fund_house") or "",
                     "nav": d.get("nav") or "", "nav_date": d.get("nav_date") or "", "fetched": date.today().isoformat(), "found": "yes"})
    IDS.write_text(json.dumps(ids, indent=1, sort_keys=True))
    with OUT.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    amfi_meta()
    ok = sum(r["found"] == "yes" for r in rows)
    print(f"schemes: {ok}/{len(rows)} strategies from Groww -> {OUT.relative_to(ROOT.parent.parent)}")


if __name__ == "__main__":
    main()
