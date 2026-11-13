"""Daily-NAV analytics for every SIF strategy and the benchmarks.

Inputs  data/monitor/raw/{strategies,sif_nav,bench}.csv   (from fetch_nav.py)
Outputs data/monitor/out/
  funds.csv    one row per strategy and benchmark: returns, volatility, beta, alpha, drawdown, capture
  daily.csv    date x series: NAV, index (100 at first NAV), daily return, drawdown, rolling vol and beta

Conventions (kept from the SIF study, see CLAUDE.md):
  - Returns are on official AMFI NAVs of the Direct Plan Growth option, from the first published NAV.
  - Market = Nifty 50 price index. Debt leg = 7.5% a year.
  - Beta = OLS slope of the fund's daily return on Nifty's return over the same NAV dates.
    Lag-adjusted (Dimson) beta adds the slope on the previous day's Nifty return, which captures stale
    pricing in mid and small caps and options marked at settlement.
  - Alpha (annualised) = fund CAGR - [beta x Nifty CAGR + (1 - beta) x 7.5%], same window.
  - 50:50 blend = Nifty 50 + debt at 7.5%, rebalanced monthly.
  - Debt at 6.5% = a fixed 6.5% a year, accrued daily on calendar days (a plain debt hurdle line).
  - Volatility = standard deviation of daily returns x sqrt(252).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "monitor" / "raw"
OUT = ROOT / "data" / "monitor" / "out"
DEBT = 0.075
AN = 252


def load():
    strat = pd.read_csv(RAW / "strategies.csv")
    nav = pd.read_csv(RAW / "sif_nav.csv", parse_dates=["date"])
    bench = pd.read_csv(RAW / "bench.csv", parse_dates=["date"])
    b = bench.pivot(index="date", columns="series", values="value").sort_index()
    # trading calendar = days Nifty 50 closed
    cal = b["nifty50"].dropna().index
    b = b.reindex(b.index.union(cal)).ffill().reindex(cal)  # liquid fund has calendar-day NAVs
    return strat, nav, b, cal


def blend_series(nifty: pd.Series) -> pd.Series:
    """50% Nifty 50 + 50% debt at 7.5% a year, rebalanced at each month end."""
    r = nifty.pct_change().fillna(0)
    days = nifty.index.to_series().diff().dt.days.fillna(0)
    rd = (1 + DEBT) ** (days / 365) - 1
    val, eq, de, out, month = 100.0, 50.0, 50.0, [], None
    for d, rn, rdd in zip(nifty.index, r, rd):
        if month is not None and d.month != month:
            eq, de = val / 2, val / 2
        eq *= 1 + rn
        de *= 1 + rdd
        val = eq + de
        out.append(val)
        month = d.month
    return pd.Series(out, index=nifty.index)


def ols_beta(y: np.ndarray, x: np.ndarray) -> float:
    if len(y) < 15 or np.var(x) == 0:
        return np.nan
    return float(np.cov(y, x, ddof=1)[0, 1] / np.var(x, ddof=1))


def stats(s: pd.Series, nifty: pd.Series, liquid: pd.Series) -> dict:
    """s: NAV series on its own dates (sorted). nifty, liquid: on the trading calendar."""
    s = s.dropna()
    n = nifty.reindex(s.index).ffill()
    lq = liquid.reindex(s.index).ffill()
    r = s.pct_change().dropna()
    rn = n.pct_change().reindex(r.index)
    rn_lag = n.pct_change().shift(1).reindex(r.index)
    last, first = s.iloc[-1], s.iloc[0]
    d0, d1 = s.index[0], s.index[-1]
    yrs = (d1 - d0).days / 365.25

    def ret_since(days):
        cut = d1 - pd.Timedelta(days=days)
        if d0 > cut + pd.Timedelta(days=3):
            return np.nan
        base = s[s.index <= cut]
        return (last / (base.iloc[-1] if len(base) else first) - 1) * 100

    def vol(x):
        return float(x.std(ddof=1) * np.sqrt(AN) * 100) if len(x) >= 15 else np.nan

    beta = ols_beta(r.values, rn.values)
    mask = rn_lag.notna()
    if mask.sum() >= 20:
        X = np.column_stack([np.ones(mask.sum()), rn[mask].values, rn_lag[mask].values])
        coef = np.linalg.lstsq(X, r[mask].values, rcond=None)[0]
        beta_dimson = float(coef[1] + coef[2])
    else:
        beta_dimson = np.nan
    r60, rn60 = r.iloc[-60:], rn.iloc[-60:]
    cagr = ((last / first) ** (1 / yrs) - 1) * 100 if yrs > 0 else np.nan
    n_cagr = ((n.iloc[-1] / n.iloc[0]) ** (1 / yrs) - 1) * 100 if yrs > 0 else np.nan
    alpha = cagr - (beta * n_cagr + (1 - beta) * DEBT * 100) if not np.isnan(beta) else np.nan
    up, dn = rn > 0, rn < 0
    up_cap = r[up].sum() / rn[up].sum() * 100 if rn[up].sum() else np.nan
    dn_cap = r[dn].sum() / rn[dn].sum() * 100 if rn[dn].sum() else np.nan
    dd = s / s.cummax() - 1
    lq_ret = (lq.iloc[-1] / lq.iloc[0]) ** (1 / yrs) - 1 if yrs > 0 else np.nan
    v = vol(r)
    return dict(
        first_date=d0.date().isoformat(), last_date=d1.date().isoformat(), months=round(yrs * 12, 1),
        n_days=len(s), nav=round(float(last), 4),
        ret_1d=round(float(r.iloc[-1] * 100), 3) if len(r) else np.nan,
        ret_1w=ret_since(7), ret_1m=ret_since(30), ret_3m=ret_since(91), ret_6m=ret_since(182),
        ret_1y=ret_since(365), ret_inception=(last / first - 1) * 100,
        cagr=cagr if yrs >= 0.5 else np.nan,
        vol_life=v, vol_1y=vol(r.iloc[-AN:]), vol_60d=vol(r.iloc[-60:]), vol_20d=vol(r.iloc[-20:]),
        beta_life=beta, beta_dimson=beta_dimson, beta_60d=ols_beta(r60.values, rn60.values),
        corr=float(np.corrcoef(r, rn)[0, 1]) if len(r) > 15 else np.nan,
        alpha=alpha if yrs >= 0.5 else np.nan,
        up_capture=up_cap, down_capture=dn_cap,
        max_dd=float(dd.min() * 100), dd_now=float(dd.iloc[-1] * 100),
        worst_day=float(r.min() * 100) if len(r) else np.nan, best_day=float(r.max() * 100) if len(r) else np.nan,
        pos_days=float((r > 0).mean() * 100) if len(r) else np.nan,
        sharpe=((cagr / 100 - lq_ret) / (v / 100)) if (yrs >= 0.5 and v) else np.nan,
    )


def rolling(s: pd.Series, nifty: pd.Series) -> pd.DataFrame:
    s = s.dropna()
    n = nifty.reindex(s.index).ffill()
    r, rn = s.pct_change(), n.pct_change()
    cov = r.rolling(60, min_periods=40).cov(rn)
    var = rn.rolling(60, min_periods=40).var()
    return pd.DataFrame(dict(
        nav=s, idx=s / s.iloc[0] * 100, ret=r * 100, dd=(s / s.cummax() - 1) * 100,
        vol20=r.rolling(20, min_periods=15).std() * np.sqrt(AN) * 100,
        vol60=r.rolling(60, min_periods=40).std() * np.sqrt(AN) * 100,
        beta60=cov / var,
    ))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    strat, nav, b, cal = load()
    nifty, liquid = b["nifty50"], b["liquid"]
    series = {}
    meta = []
    for _, st in strat.iterrows():
        s = nav[nav.code == st.code].set_index("date")["nav"].sort_index()
        s = s[~s.index.duplicated(keep="last")]
        series[st.code] = s
        meta.append(dict(id=st.code, kind="SIF", brand=st.brand, sponsor=st.sponsor if isinstance(st.sponsor, str) else "",
                         name=st.scheme, category=st.category, isin=st.isin))
    bench_meta = {
        "nifty50": ("Nifty 50", "Nifty 50 price index (Yahoo ^NSEI)"),
        "nifty_tri": ("Nifty 50 TRI", "UTI Nifty 50 Index Fund, Direct (AMFI 120716)"),
        "blend": ("50:50 blend", "Nifty 50 + debt at 7.5%, rebalanced monthly"),
        "debt65": ("Debt at 6.5%", "Fixed 6.5% a year, accrued daily on calendar days"),
        "arbitrage": ("Arbitrage fund", "Kotak Arbitrage Fund, Direct (AMFI 119771)"),
        "liquid": ("Liquid fund", "HDFC Liquid Fund, Direct (AMFI 119091)"),
    }
    b["blend"] = blend_series(nifty)
    days = (nifty.index - nifty.index[0]).days
    b["debt65"] = pd.Series(100 * (1.065 ** (days / 365)), index=nifty.index)
    start = nav.date.min() - pd.Timedelta(days=5)
    for k, (label, desc) in bench_meta.items():
        series[k] = b[k][b.index >= start].dropna()
        meta.append(dict(id=k, kind="Benchmark", brand=label, sponsor="", name=desc, category="Benchmark", isin=""))

    rows, daily = [], []
    for m in meta:
        s = series[m["id"]]
        if len(s) < 2:
            continue
        rows.append({**m, **stats(s, nifty, liquid)})
        rd = rolling(s, nifty)
        rd.insert(0, "id", m["id"])
        daily.append(rd)
    funds = pd.DataFrame(rows)
    funds.to_csv(OUT / "funds.csv", index=False, float_format="%.4f")
    d = pd.concat(daily).rename_axis("date").reset_index()
    d["date"] = d["date"].dt.strftime("%Y-%m-%d")
    d.to_csv(OUT / "daily.csv", index=False, float_format="%.4f")
    print(funds[funds.category.isin(["Hybrid long-short", "Benchmark"])][
        ["brand", "first_date", "months", "ret_inception", "cagr", "vol_life", "vol_60d", "beta_life", "beta_dimson",
         "beta_60d", "alpha", "max_dd"]].round(2).to_string(index=False))
    print(f"funds.csv {len(funds)} rows; daily.csv {len(d)} rows")


if __name__ == "__main__":
    main()
