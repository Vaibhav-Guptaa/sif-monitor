# SIF Competitor Monitor: data pipeline

Dashboard: https://claude.ai/artifact/JV7Nfc4mBAcneR8yVgjjqp

## Refresh

```
python3 monitor/run.py        # fetch NAVs, portfolios, rebuild everything (about 1 minute)
```

Outputs land in `data/monitor/dash/`. Upload the seven CSVs to the dashboard. In Claude Code, ask: "refresh the SIF monitor". Run it after 11 pm IST on business days, once AMFI has the day's NAVs.

Needs Python 3.10+, pandas, numpy, openpyxl and yfinance (all already installed here).

## Where each number comes from

| Data | Source | How it is fetched | Frequency |
|---|---|---|---|
| SIF universe (every strategy, AMC, category, ISIN) | AMFI `portal.amfiindia.com/spages/SIF_NAVAll.txt` | Plain download | Daily, by 11 pm IST |
| SIF daily NAV since launch | AMFI SIF NAV history API: `amfiindia.com/api/sif-nav-history?query_type=historical_period&from_date=..&to_date=..&sd_id=SIF-n` (the service behind amfiindia.com/sif/latest-nav/nav-history; 5 years per call) | One call per strategy | Daily |
| SIF daily NAV, second source | Groww `groww.in/v1/api/data/mf/web/v1/scheme/SIF-n/graph` (same AMFI code) | One call per strategy; compared date by date with AMFI (`raw/nav_check.csv`); fills only a date AMFI has not published yet | Daily |
| Nifty 50 price | Yahoo Finance `^NSEI` | yfinance | Daily |
| Nifty 50 TRI proxy, arbitrage, liquid | AMFI MF NAV history API: `amfiindia.com/api/nav-history?...&sd_id=120716 / 119771 / 119091` | One call each | Daily |
| Strategy documents, launch date, exit load | AMFI `api/investment-strategy-detail?sif_id=..&scheme_id=S-n`, `api/sif-schemes/S-n/documents` | Not yet used | On change |
| Portfolio holdings | AMC portfolio disclosure (.xlsx, SEBI format) | Arudha: automatic. Others: download by hand (see below) | SEBI minimum: every alternate month (May, Jul, Sep, Nov, Jan, Mar), within 10 days. Some AMCs monthly |
| Portfolio holdings, all hybrid funds | Groww scheme record `groww.in/v1/api/data/mf/web/v4/scheme/search/<id>`: every line of the latest disclosure (value in Rs cr, % of NAV) plus net assets | Automatic; each new disclosure saved as `portfolios/<fund>/groww_<date>.json`, so history builds up from 30 Sep 2026. No ISINs, quantities or ratings; an AMC file for the same month wins | As the AMCs disclose |
| Fund AUM | Net assets of each disclosed portfolio (AMC file or Groww's copy); each run also logs Groww's AUM to `raw/groww_aum.csv` | With holdings | Monthly / alternate months |
| Category AUM | AMFI monthly SIF data (via press) | By hand in `build.py` | Monthly |
| Market-cap bands | AMFI average market cap list, Jan–Jun 2026 (`portal.amfiindia.com/spages/AverageMarketCapitalization30Jun2026.xlsx`) | Saved in `data/monitor/ref/` | Every six months (next: Dec 2026 list, out early Jan) |

SEBI's SIF FAQ (Sep 2026), A26: "The SIF is required to disclose the portfolio of each investment strategy, including derivative positions, as at the end of every alternate month - May, July, September, November, January and March. Such disclosures are also made available on the AMC's and AMFI's websites within 10 calendar days after the end of the relevant month."

Not public anywhere: daily holdings, daily AUM and option strikes in a usable form. The NAV-implied 60-day beta is the closest daily read of each fund's actual market exposure.

## Adding a portfolio file by hand

Save the AMC's Excel file as `data/monitor/portfolios/<fund>/<fund>_hybrid_<YYYY-MM>.xlsx`, for example `altiva/altiva_hybrid_2026-11.xlsx`, then run `python3 monitor/run.py`. The parser reads any SEBI-format sheet (header row with "Name of the Instrument" and "% to Net Assets"). If an AMC's layout breaks it, the run prints the file name.

| Fund | Disclosure page | Why not automatic |
|---|---|---|
| Altiva (Edelweiss) | edelweissmf.com/altivasif/statutory/portfolio-of-schemes | Site returns 403 to scripts |
| Apex (Aditya Birla SL) | apexsif.adityabirlacapital.com/forms-and-downloads/portfolio | JavaScript app; blocks scripts |
| Arudha (Bandhan) | arudhasif.com/downloads/ | Automatic |
| Infinity (Kotak) | kotakmf.com/sif/ | JavaScript app |
| iSIF (ICICI Pru) | isif.icicipruamc.com/media-center/downloads | JavaScript app |
| Magnum (SBI) | sbimf.com/magnumsif-portfolios | Token-gated API |
| Platinum (Mirae Asset) | not yet listed by AMFI | Find page |
| Prism (Jio BlackRock) | jioblackrockamc.com/prismsif/statutory-disclosure/disclosures/monthly-portfolio-disclosure | JavaScript app |
| qsif (quant) | qsif.com/statutory-disclosures | JavaScript app |
| RedHex (HSBC) | assetmanagement.hsbc.co.in/en/redhex-sif | JavaScript app |
| Titanium (Tata) | tatamutualfund.com/titanium-sif/statutory-disclosures | JavaScript app |
| Eminence | not yet listed | Launched 9 Nov 2026 |

Until an official file is added, a fund shows Groww's copy of its latest disclosure (all lines and AUM, no quantities, so no trades). Checked against Arudha's official 30 Sep file: AUM identical, every asset class within 0.04 points. Groww shows some stocks under former names; `holdings.py` maps them (`ALIAS`, `GROWW_RENAME`).

Groww vs AMFI NAVs (Nov 2026): 4,884 of 4,893 shared dates identical. AMFI has dates Groww lacks (Altiva's first 3, RedHex's first 16, 8 May 2026). The 9 differing dates (Titanium 27 Jan, Prism 23–30 Jul, qsif 4 Nov 2025) are stale or revised values on Groww; AMFI's are consistent with the market and are kept.

## Files

- `sources.py`: fetchers (AMFI, Yahoo)
- `fetch_nav.py`: universe, NAV history, benchmarks → `data/monitor/raw/`
- `fetch_portfolios.py`: new official portfolio files (Arudha)
- `analytics.py`: returns, volatility, beta (OLS and lag-adjusted), alpha, drawdown, capture → `data/monitor/out/`
- `holdings.py`: portfolio parser, construction, cap split, concentration, trades
- `build.py`: dashboard CSVs → `data/monitor/dash/`
- `dashboard/`: the dashboard page (`index.html`, `sif.js`, `fonts.css`)
