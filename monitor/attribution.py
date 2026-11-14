"""What drove each fund's recent return: holdings-based attribution plus event days.

Window: from the fund's latest disclosed portfolio date to the latest NAV date (the stretch over which we know
what it held). The actual NAV return over that window is split, in percentage points of NAV, into:

  carry          debt, money market, cash, REITs/units and arbitrage legs, ESTIMATED at 6.5% a year
  largest stock  the single holding with the biggest contribution (unhedged weight x its price move)
  ipo            other IPO / new-listing holdings (first traded in the 12 months before the portfolio date)
  other stocks   every other unhedged stock (covered-call and collar stocks included at their stock move)
  futures        long stock futures, naked short futures, index futures
  remainder      'options and trading since the disclosure': NAV return minus all of the above, i.e. options
                 (covered calls capping gains, puts), trading after the disclosure, IPO allotments
                 received after it, stocks without a price, fees

Event days (last 91 days of NAVs): days the fund rose at least 4x its usual daily move (and by 0.25% or more),
labelled with the listing of an IPO stock the fund holds when the dates match.

Writes data/monitor/dash/attrib.csv (one row per fund) and attrib_top.csv (largest contributors per fund).
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent / "data" / "monitor"
CARRY = 0.065


def _px_at(px: pd.DataFrame, sym: str, d: str):
    if sym not in px.columns:
        return np.nan
    s = px[sym].dropna()
    s = s[s.index <= d]
    return float(s.iloc[-1]) if len(s) else np.nan


def main() -> None:
    import holdings as HM
    lines = pd.read_csv(ROOT / "out" / "hold_lines.csv")
    summ = pd.read_csv(ROOT / "out" / "hold_summary.csv").sort_values("asof").groupby("fund").tail(1).set_index("fund")
    daily = pd.read_csv(ROOT / "out" / "daily.csv", parse_dates=["date"])
    px = pd.read_csv(ROOT / "raw" / "stock_px.csv", index_col=0) if (ROOT / "raw" / "stock_px.csv").exists() else pd.DataFrame()
    nifty = daily[daily.id == "nifty50"].set_index("date")["nav"]
    name_sym = json.loads((ROOT / "ref" / "name_symbol.json").read_text()) if (ROOT / "ref" / "name_symbol.json").exists() else {}
    funds_out = pd.read_csv(ROOT / "out" / "funds.csv")
    rows, tops = [], []
    for fund, s in summ.iterrows():
        code = s["code"]
        nav = daily[daily.id == code].set_index("date")["nav"].sort_index()
        L = lines[lines.fund == fund]
        if nav.empty or L.empty:
            continue
        d0 = pd.Timestamp(s["asof"])
        base = nav[nav.index <= d0]
        if base.empty:
            continue
        t1 = nav.index[-1]
        r_nav = (nav.iloc[-1] / base.iloc[-1] - 1) * 100
        days = (t1 - base.index[-1]).days
        n0, n1 = nifty[nifty.index <= base.index[-1]], nifty[nifty.index <= t1]
        r_nifty = (n1.iloc[-1] / n0.iloc[-1] - 1) * 100 if len(n0) and len(n1) else np.nan
        d0s, t1s = base.index[-1].strftime("%Y-%m-%d"), t1.strftime("%Y-%m-%d")

        # per stock: weight, futures, price move
        book: dict[str, dict] = {}
        for _, l in L.iterrows():
            if not isinstance(l["name"], str) or not l["name"].strip():
                continue
            k = HM.ukey(l["underlying"] if l["kind"] in ("FUT", "OPT") and isinstance(l["underlying"], str) else l["name"])
            b = book.setdefault(k, {"w": 0.0, "fs": 0.0, "fl": 0.0, "name": None, "ipo": False, "listed": ""})
            if l["kind"] == "EQ":
                b["w"] += l["pct"]; b["name"] = b["name"] or l["name"]; b["ipo"] = b["ipo"] or bool(l.get("ipo"))
                b["listed"] = b["listed"] or (l.get("listed") if isinstance(l.get("listed"), str) else "")
            elif l["kind"] == "FUT":
                b["fs" if l["pct"] < 0 else "fl"] += l["pct"]; b["name"] = b["name"] or l["underlying"]
        contrib, unpriced_w = [], 0.0
        fut_c = 0.0
        for k, b in book.items():
            nm = b["name"] or k
            sym = name_sym.get(nm, "") or name_sym.get(str(nm), "")
            p0, p1 = _px_at(px, sym, d0s), _px_at(px, sym, t1s)
            r = (p1 / p0 - 1) * 100 if (p0 and p1 and np.isfinite(p0) and np.isfinite(p1)) else np.nan
            arb = max(min(b["w"], -b["fs"]), 0.0) if b["fs"] < 0 else 0.0
            unhedged = b["w"] - arb
            excess_short = b["fs"] + b["w"] if b["fs"] < -b["w"] else 0.0   # futures sold beyond the stock held
            if not np.isfinite(r):
                unpriced_w += abs(unhedged) + abs(b["fl"]) + abs(excess_short)
                continue
            if abs(unhedged) > 1e-9:
                contrib.append(dict(name=nm, weight=unhedged, ret=r, c=unhedged * r / 100, ipo=b["ipo"], listed=b["listed"]))
            fut_c += (b["fl"] + excess_short) * r / 100
        fut_c += float(s.get("ov_idx_fut", 0) or 0) * (r_nifty / 100 if np.isfinite(r_nifty) else 0)
        fi_w = sum(float(s.get(c, 0) or 0) for c in ("f_gsec", "f_corp", "f_mm", "f_cash", "f_reit", "f_units", "s_arb"))
        carry = fi_w * CARRY * days / 365
        cdf = pd.DataFrame(contrib)
        top = cdf.loc[cdf.c.abs().idxmax()] if len(cdf) else None
        ipo_c = float(cdf[cdf.ipo].c.sum()) if len(cdf) else 0.0
        stock_c = float(cdf.c.sum()) if len(cdf) else 0.0
        top_c = float(top.c) if top is not None else 0.0
        ipo_rest = ipo_c - (top_c if top is not None and top.ipo else 0.0)
        other = stock_c - top_c - ipo_rest
        remainder = r_nav - (carry + stock_c + fut_c)

        # event days over the last 91 days of NAVs
        r_d = nav.pct_change().dropna() * 100
        win = r_d[r_d.index > t1 - pd.Timedelta(days=91)]
        sig = r_d.rolling(120, min_periods=30).std().shift(1)
        ipo_listings = {b["listed"]: b["name"] for b in book.values() if b["ipo"] and b["listed"]}
        events = []
        for dt, v in win.items():
            sd = sig.get(dt, np.nan)
            if np.isfinite(sd) and sd > 0 and v >= 4 * sd and v >= 0.25:
                ds = dt.strftime("%Y-%m-%d")
                tag = ipo_listings.get(ds, "")
                events.append({"date": ds, "ret": round(float(v), 2), "z": round(float(v / sd), 1), "listing": tag})
        r_91 = (nav.iloc[-1] / nav[nav.index <= t1 - pd.Timedelta(days=91)].iloc[-1] - 1) * 100 if (nav.index <= t1 - pd.Timedelta(days=91)).any() else np.nan
        ev_sum = sum(e["ret"] for e in events)
        fr = funds_out[funds_out.id == code]
        beta = float(fr.beta_60d.iloc[0]) if len(fr) and np.isfinite(fr.beta_60d.iloc[0]) else np.nan
        market = beta * r_nifty if np.isfinite(beta) and np.isfinite(r_nifty) else np.nan

        flags = []
        if top is not None and abs(top_c) >= 0.3 and abs(stock_c) > 0 and abs(top_c) >= 0.4 * abs(stock_c):
            flags.append("Single-stock driven")
        if r_nav > 0 and ipo_c >= 0.3 and ipo_c >= 0.3 * r_nav:
            flags.append("IPO-driven")
        if events and ((np.isfinite(r_91) and r_91 > 0 and ev_sum >= 0.25 * r_91) or max(e["ret"] for e in events) >= 2):
            flags.append("Event-driven" + (" (IPO listing)" if any(e["listing"] for e in events) else ""))
        if np.isfinite(market) and r_nav > 0 and market >= 0.6 * r_nav:
            flags.append("Market-driven")
        if abs(remainder) >= 0.5 and abs(remainder) >= 0.5 * abs(r_nav):
            flags.append("Options or trading dominant")
        rows.append(dict(fund=fund, code=code, brand=s["brand"], category=s.get("category", ""), asof=d0s, to=t1s, days=days,
                         r_nav=round(r_nav, 3), r_nifty=round(r_nifty, 3) if np.isfinite(r_nifty) else "",
                         carry=round(carry, 3), top_name=top["name"] if top is not None else "", top_c=round(top_c, 3),
                         top_w=round(float(top.weight), 2) if top is not None else "", top_ret=round(float(top.ret), 2) if top is not None else "",
                         top_ipo=bool(top.ipo) if top is not None else False, ipo_c=round(ipo_rest, 3), ipo_total=round(ipo_c, 3),
                         other=round(other, 3), futures=round(fut_c, 3), remainder=round(remainder, 3),
                         beta60=round(beta, 3) if np.isfinite(beta) else "", market=round(market, 3) if np.isfinite(market) else "",
                         unpriced_w=round(unpriced_w, 2), r_91=round(r_91, 3) if np.isfinite(r_91) else "",
                         events=json.dumps(events), event_sum=round(ev_sum, 3), flags="; ".join(flags)))
        if len(cdf):
            for _, c in cdf.reindex(cdf.c.abs().sort_values(ascending=False).index).head(8).iterrows():
                tops.append(dict(fund=fund, name=c["name"], weight=round(c.weight, 2), ret=round(c.ret, 2), contrib=round(c.c, 3),
                                 ipo=bool(c.ipo), listed=c.listed))
    out = ROOT / "dash"
    out.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(out / "attrib.csv", index=False)
    pd.DataFrame(tops).to_csv(out / "attrib_top.csv", index=False)
    print(f"attribution: {len(rows)} funds")


if __name__ == "__main__":
    main()
