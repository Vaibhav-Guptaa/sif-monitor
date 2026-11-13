"""Portfolio construction, concentration, market-cap split and month-on-month trades for the hybrid long-short SIFs.

Sources, in order of preference (each output row says which one it used):
  1. official   The AMC's own portfolio disclosure (.xlsx, SEBI format: section headings, ISIN, industry/rating,
                quantity, market value in Rs lakh, % to net assets). SEBI makes it mandatory as at the end of every
                alternate month (May, Jul, Sep, Nov, Jan, Mar), on the AMC's and AMFI's sites within 10 calendar days;
                some AMCs (Arudha, Altiva) publish monthly. Files live in data/monitor/portfolios/<fund>/, named
                <fund>_hybrid_<YYYY-MM>.xlsx. Arudha's are downloaded automatically (fetch_portfolios.py); for the
                rest, drop the AMC's file in that folder.
  2. groww      Groww's scheme record (JSON, same AMFI code), snapshotted by fetch_portfolios.groww() into
                data/monitor/portfolios/<fund>/groww_<date>.json: every line of the latest disclosed portfolio with
                market value (Rs cr) and % of NAV, plus AUM. No ISINs, quantities or debt ratings, so no trades.
  3. groww_page Older hand transcription of Groww's page, data/holdings/<fund>.txt; used only if 1 and 2 are absent.

Market-cap bands: AMFI's official list of average market cap for Jan-Jun 2026 (ranks 1-100 large, 101-250 mid,
251+ small), matched by ISIN, or by name for Groww rows. Shorts count in the band of the stock shorted; Nifty and
Bank Nifty count as large, Midcap Select as mid.

Outputs in data/monitor/out/: hold_summary.csv, hold_lines.csv, hold_changes.csv, hold_sources.csv
"""
from __future__ import annotations

import csv
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
PORT = ROOT / "data" / "monitor" / "portfolios"
GROWW = ROOT / "data" / "holdings"
REF = ROOT / "data" / "monitor" / "ref" / "amfi_mcap_jun2026.xlsx"
OUT = ROOT / "data" / "monitor" / "out"

# hybrid long-short funds: AMFI strategy code of the Direct Growth class, brand, official disclosure page
FUNDS = {
    "altiva": ("SIF-9", "Altiva", "https://www.edelweissmf.com/altivasif/statutory/portfolio-of-schemes"),
    "apex": ("SIF-79", "Apex", "https://apexsif.adityabirlacapital.com/forms-and-downloads/portfolio"),
    "arudha": ("SIF-54", "Arudha", "https://arudhasif.com/downloads/"),
    "eminence": ("SIF-181", "Eminence", ""),
    "infinity": ("SIF-145", "Infinity", "https://www.kotakmf.com/sif/"),
    "isif": ("SIF-36", "iSIF", "https://www.isif.icicipruamc.com/media-center/downloads"),
    "magnum": ("SIF-14", "Magnum", "https://www.sbimf.com/magnumsif-portfolios"),
    "platinum": ("SIF-134", "Platinum", ""),
    "prism": ("SIF-139", "Prism", "https://www.jioblackrockamc.com/prismsif/statutory-disclosure/disclosures/monthly-portfolio-disclosure"),
    "qsif": ("SIF-5", "qsif", "https://www.qsif.com/statutory-disclosures"),
    "redhex": ("SIF-129", "RedHex", "https://www.assetmanagement.hsbc.co.in/en/redhex-sif"),
    "titanium": ("SIF-32", "Titanium", "https://www.tatamutualfund.com/titanium-sif/statutory-disclosures"),
}

STOP = {"ltd", "limited", "the", "co", "company", "corporation", "corp", "of", "india", "and", "inc", "plc", "pvt"}
# Former names (as Groww still lists some holdings) -> current names on AMFI's list. Keys and values are norm() forms.
ALIAS = {
    "zomato": "eternal", "adani transmission": "adani energy solutions",
    "shriram transport finance": "shriram finance", "tata global beverages": "tata consumer products",
    "bharti infratel": "indus towers", "larsen toubro infotech": "ltm", "ltimindtree": "ltm",
    "iifl wealth management": "360 one wam", "ge t d": "ge vernova t d", "macrotech developers": "lodha developers",
    "sbi cards payments services": "sbi cards payment services", "l t finance holdings": "l t finance",
    "rural electrification corpn": "rec", "national thermal power": "ntpc",
    "idea cellular": "vodafone idea", "l i c housing finance": "lic housing finance",
    "icici prudential life insrnce": "icici prudential life insurance",
    "sun pharmaceuticals industries": "sun pharmaceutical industries",
    "apollo hospitals enterprise": "apollo hospitals enterprises", "shree cement": "shree cements",
    "akzo nobel": "jsw dulux",
}
# Groww shows ISIN INE155A01022 (now Tata Motors Passenger Vehicles, after the Oct 2025 demerger) as "Tata Motors Ltd";
# checked against Arudha's official Sep 2026 file. Applied to Groww lines only, since "Tata Motors Ltd" is also the
# listed commercial-vehicle company.
GROWW_RENAME = {"tata motors": "Tata Motors Passenger Vehicles Ltd"}


def norm(name: str) -> str:
    n = name.lower().replace("&", " and ").replace("'", "")
    n = re.sub(r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}", " ", n)          # expiry dates
    n = re.sub(r"\b\d{1,2}[- ]?[a-z]{3}[- ]?\d{2,4}\b", " ", n)    # 27-Oct-2026
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = " ".join({"inds": "industries"}.get(w, w) for w in n.split() if w not in STOP)
    return ALIAS.get(n, n)


def ukey(name: str) -> str:
    """Matching key for a stock, a future or an option on it: name without expiry, strike, option words."""
    return norm(underlying_name(name))


# ---------- reference: AMFI market-cap list ----------
def load_caps():
    wb = openpyxl.load_workbook(REF, read_only=True, data_only=True)
    by_isin, by_name = {}, {}
    for row in wb.worksheets[0].iter_rows(min_row=3, values_only=True):
        if not row or not isinstance(row[0], (int, float)):
            continue
        rank, name, isin, cat, mcap = int(row[0]), row[1], row[2], row[10], row[9]
        band = {"Large Cap": "Large", "Mid Cap": "Mid", "Small Cap": "Small"}.get(cat, "Small")
        rec = dict(rank=rank, name=name, band=band, mcap_cr=mcap)
        by_isin[isin] = rec
        by_name.setdefault(norm(name), rec)
    return by_isin, by_name


CAP_ISIN, CAP_NAME = load_caps()


def cap_by_name(name: str):
    n = norm(name)
    if n in CAP_NAME:
        return CAP_NAME[n]
    for k, rec in CAP_NAME.items():  # prefix match either way, longest key first would be slower; ranks break ties
        if n and (k.startswith(n + " ") or n.startswith(k + " ")) and len(min(k, n, key=len)) >= 5:
            return rec
    return None


# ---------- line classification ----------
def index_band(name: str):
    n = name.lower()
    if "nifty" not in n and "sensex" not in n and "bankex" not in n:
        return None
    if "midcap" in n or "mid cap" in n or "midcpnifty" in n:
        return "Mid"
    if "smallcap" in n:
        return "Small"
    return "Large"


def opt_type(name: str):
    n = " " + name.upper() + " "
    if re.search(r"\bCALL\b|\bCE\b|\d\s*CE\b", n):
        return "C"
    if re.search(r"\bPUT\b|\bPE\b|\d\s*PE\b", n):
        return "P"
    return None


def underlying_name(name: str) -> str:
    n = re.sub(r"\b(CALL|PUT|CE|PE|FUT|FUTURES?|OPTIONS?|COVERED)\b", " ", name, flags=re.I)
    n = re.sub(r"\d{1,2}[./-]\d{1,2}[./-]\d{2,4}.*$", "", n)                       # 27.10.2026, 27/10/26
    n = re.sub(r"\d{1,2}[- ]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[- ]?\d{2,4}.*$", "", n, flags=re.I)
    n = re.sub(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{2}\b", " ", n, flags=re.I)  # Dec24
    n = re.sub(r"[- ]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{0,4}\s*$", "", n, flags=re.I)  # -OCT2026
    n = re.sub(r"[*$]+", " ", n)
    n = re.sub(r"\b\d+(\.\d+)?\b", " ", n)
    return " ".join(n.split())


# ---------- official SEBI-format parser ----------
SECTION_RULES = [  # (regex on a heading row, section)
    (r"^equity|equity & equity|equity and equity", "equity"),
    (r"^derivative", "deriv"),
    (r"futures", "fut"),
    (r"options?", "opt"),
    (r"^debt instrument|^bonds?|non.convertible|^corporate", "debt"),
    (r"money market|certificate of deposit|commercial paper", "mm"),
    (r"treasury bill|t-bill", "tbill"),
    (r"government securit|state development|^g-?sec", "gsec"),
    (r"reverse repo|treps|tri-party|cblo", "treps"),
    (r"reit|invit|real estate investment|infrastructure investment trust", "reit"),
    (r"mutual fund units?|units of mutual|investment funds", "mf"),
    (r"interest rate swap", "irs"),
    (r"preference", "pref"),
    (r"margin|cash and cash|net receivable|net current|others", "cash"),
]


def find_header(ws_rows):
    for i, row in enumerate(ws_rows[:40]):
        cells = [str(c).lower() if c is not None else "" for c in row]
        if any("name of" in c or "instrument" in c for c in cells) and any("net asset" in c or "% to" in c for c in cells):
            col = {}
            for j, c in enumerate(cells):
                if "name" in c or ("instrument" in c and "name" not in col):
                    col.setdefault("name", j)
                elif "isin" in c:
                    col["isin"] = j
                elif "industry" in c or "rating" in c:
                    col["ind"] = j
                elif "quantity" in c or "qty" in c:
                    col["qty"] = j
                elif "market" in c or "fair value" in c:
                    col["mv"] = j
                elif "net asset" in c or "% to" in c:
                    col["pct"] = j
            return i, col
    raise ValueError("header row not found")


def num(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).replace(",", "").replace("%", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def parse_official(path: Path, fund: str):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = [tuple(r) for r in ws.iter_rows(values_only=True)]
    asof = None
    for r in rows[:8]:
        for c in r:
            if isinstance(c, str):
                m = re.search(r"as on\s+(.+)$", c, re.I)
                if m:
                    for fmt in ("%d %B, %Y", "%d %B %Y", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%B %d, %Y"):
                        try:
                            asof = datetime.strptime(m.group(1).strip().rstrip("."), fmt).date()
                            break
                        except ValueError:
                            pass
    h, col = find_header(rows)
    lines, section, net_assets, scale = [], None, None, None
    for r in rows[h + 1:]:
        name = r[col["name"]] if col.get("name") is not None and col["name"] < len(r) else None
        if name is None:
            continue
        name = str(name).strip()
        low = name.lower()
        if low.startswith("grand total") or low.startswith("net assets"):
            net_assets = num(r[col["mv"]])
            break
        if low.startswith(("sub total", "subtotal", "total")) or low.startswith(("(b) unlisted", "(b) privately")):
            continue
        pct, mv = num(r[col["pct"]]) if "pct" in col else None, num(r[col["mv"]]) if "mv" in col else None
        if pct is None and mv is None:  # heading row
            for rx, sec in SECTION_RULES:
                if re.search(rx, low):
                    if sec in ("fut", "opt") and section not in ("deriv", "fut", "opt"):
                        break
                    section = sec
                    break
            continue
        if "net receivable" in low or "payable" in low or "margin" in low or "cash" == low:
            sec = "cash"
        else:
            sec = section
        isin = r[col["isin"]] if "isin" in col and col["isin"] < len(r) else None
        isin = str(isin).strip() if isin and re.match(r"^IN[A-Z0-9]{10}$", str(isin).strip()) else ""
        lines.append(dict(name=name, isin=isin, ind=str(r[col["ind"]]).strip() if "ind" in col and r[col["ind"]] else "",
                          qty=num(r[col["qty"]]) if "qty" in col else None, mv_lakh=mv, pct=pct, section=sec))
        if "hedging positions" in low:
            break
    # percent scale: fractions (0.0077) or percent (0.77)?
    tot = sum(abs(l["pct"] or 0) for l in lines)
    scale = 100.0 if tot < 5 else 1.0
    for l in lines:
        l["pct"] = (l["pct"] or 0) * scale
    return dict(fund=fund, asof=asof.isoformat() if asof else None, net_assets_cr=(net_assets or 0) / 100,
                lines=[classify(l) for l in lines], source="official", file=path.name)


def classify(l: dict) -> dict:
    name, sec = l["name"], l["section"]
    ib = index_band(name)
    ot = opt_type(name)
    if sec == "equity":
        kind = "EQ"
    elif sec in ("deriv", "fut", "opt"):
        if ot or sec == "opt":
            kind = "IDXOPT" if ib else "OPT"
        else:
            kind = "IDXFUT" if ib else "FUT"
    elif sec in ("debt",):
        kind = "GSEC" if (l.get("ind", "").lower() == "sovereign") else "DEBT"
    elif sec in ("gsec",):
        kind = "GSEC"
    elif sec in ("mm", "tbill"):
        kind = "MM"
    elif sec == "treps":
        kind = "CASH"
    elif sec == "reit":
        kind = "REIT"
    elif sec == "mf":
        kind = "MF"
    elif sec == "irs":
        kind = "IRS"
    elif sec == "pref":
        kind = "EQ"
    else:
        kind = "CASH"
    l["kind"] = kind
    l["opt"] = ot or ""
    l["under"] = underlying_name(name) if kind in ("FUT", "OPT", "IDXFUT", "IDXOPT") else name
    return l


# ---------- Groww snapshot reader ----------
GROWW_KIND = {"Equity": "EQ", "Futures": "FUT", "PutOption": "OPT", "CallOption": "OPT", "IndexDeriv": "IDXFUT",
              "IndexFutures": "IDXFUT", "IndexOptions": "IDXOPT", "IndexPutLong": "IDXOPT", "REIT": "REIT",
              "InvIT": "REIT", "DebtMF": "MF"}


def parse_groww(path: Path, fund: str):
    lines = []
    for raw in path.read_text().splitlines():
        p = [x.strip() for x in raw.split("|")]
        if len(p) < 3:
            continue
        try:
            pct = float(p[2])
        except ValueError:
            continue
        kind = GROWW_KIND.get(p[1], "OTHER")
        ot = "P" if p[1] in ("PutOption", "IndexPutLong") else "C" if p[1] == "CallOption" else opt_type(p[0]) or ""
        lines.append(dict(name=p[0], isin="", ind="", qty=None, mv_lakh=None, pct=pct, section="", kind=kind, opt=ot,
                          under=underlying_name(p[0]) if kind in ("FUT", "OPT", "IDXFUT", "IDXOPT") else p[0]))
    return dict(fund=fund, asof="2026-09-30", net_assets_cr=None, lines=lines, source="groww_page", file=path.name)


# ---------- Groww scheme-record snapshot ----------
def groww_kind(inst: str, nature: str, name: str):
    ib, ot = index_band(name), opt_type(name)
    if nature == "REALEST":
        return "REIT", ""
    if nature == "MF":
        return "MF", ""
    if nature == "CASH" or inst == "CBLO":
        return "CASH", ""
    if nature == "DEBT":
        if inst == "Interest Rate Swap":
            return "IRS", ""
        if inst in ("GOI Securities", "State Development Loan"):
            return "GSEC", ""
        if inst in ("Treasury Bills", "Certificate of Deposit", "Commercial Paper"):
            return "MM", ""
        return "DEBT", ""
    if inst == "Equity":
        return "EQ", ""
    if inst in ("Call Option", "Put Option", "Options"):
        o = "C" if inst == "Call Option" else "P" if inst == "Put Option" else (ot or "")
        return ("IDXOPT" if ib else "OPT"), o
    if inst == "Index Derivatives":
        return ("IDXOPT", ot) if ot else ("IDXFUT", "")
    if inst == "Futures":
        return ("IDXFUT" if ib else "FUT"), ""
    return "EQ", ""


def parse_groww_api(path: Path, fund: str):
    import json
    d = json.loads(path.read_text())
    lines = []
    for h in d["holdings"]:
        name = h["company_name"] or ""
        base = norm(underlying_name(name))
        if base in GROWW_RENAME:
            name = name.replace(re.match(r"\s*tata motors( ltd\.?| limited)?", name, re.I).group(0), GROWW_RENAME[base])
        kind, ot = groww_kind(h["instrument_name"] or "", h["nature_name"] or "", name)
        lines.append(dict(name=name, isin="", ind=h.get("sector_name") or "", qty=None,
                          mv_lakh=(h["market_value"] or 0) * 100, pct=h["corpus_per"] or 0.0, section="", kind=kind,
                          opt=ot, under=underlying_name(name) if kind in ("FUT", "OPT", "IDXFUT", "IDXOPT") else name))
    return dict(fund=fund, asof=d["portfolio_date"], net_assets_cr=d.get("aum"), lines=lines, source="groww",
                file=path.name)


# ---------- analytics ----------
def band_of(l: dict, eq_by_under: dict):
    if l["kind"] in ("IDXFUT", "IDXOPT"):
        return index_band(l["name"]) or "Large"
    if l.get("isin") and l["isin"] in CAP_ISIN:
        return CAP_ISIN[l["isin"]]["band"]
    e = eq_by_under.get(ukey(l["under"]))
    if e and e.get("isin") in CAP_ISIN:
        return CAP_ISIN[e["isin"]]["band"]
    rec = cap_by_name(l["under"]) or (cap_by_name(e["name"]) if e else None) or cap_by_name(l["name"])
    return rec["band"] if rec else "Unclassified"


def summarise(p: dict) -> tuple[dict, list[dict]]:
    L = p["lines"]
    eq = [l for l in L if l["kind"] == "EQ"]
    eq_by_under = {ukey(l["name"]): l for l in eq}
    agg = defaultdict(float)
    for l in L:
        agg[l["kind"]] += l["pct"]
        l["band"] = band_of(l, eq_by_under) if l["kind"] in ("EQ", "FUT", "OPT", "IDXFUT", "IDXOPT") else ""
    # same-stock hedge: futures on a stock the fund also holds
    fut_by = defaultdict(float)
    for l in L:
        if l["kind"] == "FUT":
            fut_by[ukey(l["under"])] += l["pct"]
    hedged = unhedged = 0.0
    for l in eq:
        f = fut_by.get(ukey(l["name"]), 0.0)
        h = min(l["pct"], -f) if f < 0 else 0.0
        hedged += max(h, 0)
        unhedged += l["pct"] - max(h, 0)
    naked_short = sum(v for k, v in fut_by.items() if v < 0 and k not in eq_by_under)
    long_fut = sum(v for v in fut_by.values() if v > 0)
    longs = sorted((l["pct"] for l in eq), reverse=True)
    eq_tot = sum(longs) or 1e-9
    w = [x / eq_tot for x in longs]
    net_by_stock = defaultdict(float)
    for l in eq:
        net_by_stock[ukey(l["name"])] += l["pct"]
    for k, v in fut_by.items():
        net_by_stock[k] += v
    net_sorted = sorted(net_by_stock.values(), key=abs, reverse=True)
    band_long, band_net = defaultdict(float), defaultdict(float)
    for l in L:
        if l["kind"] == "EQ":
            band_long[l["band"]] += l["pct"]
            band_net[l["band"]] += l["pct"]
        elif l["kind"] in ("FUT", "IDXFUT"):
            band_net[l["band"]] += l["pct"]
    opt = [l for l in L if l["kind"] in ("OPT", "IDXOPT")]
    debt_rating = defaultdict(float)
    for l in (L if p["source"] == "official" else []):  # Groww carries no ratings
        if l["kind"] in ("DEBT", "GSEC", "MM"):
            r = (l.get("ind") or "").upper()
            b = "Sovereign" if ("SOVEREIGN" in r or l["kind"] == "GSEC") else "AAA / A1+" if ("AAA" in r or "A1+" in r) \
                else "AA" if "AA" in r else "Below AA / unrated" if r else "Unrated"
            debt_rating[b] += l["pct"]
    stocks_etc = agg["EQ"] + agg["REIT"] + agg["MF"] + agg["OPT"] + agg["IDXOPT"]
    s = dict(
        fund=p["fund"], asof=p["asof"], source=p["source"], file=p["file"],
        aum_cr=round(p["net_assets_cr"], 2) if p["net_assets_cr"] else None,
        equity_long=agg["EQ"], stock_fut_short=sum(v for v in fut_by.values() if v < 0), stock_fut_long=long_fut,
        index_fut=agg["IDXFUT"], options_premium=agg["OPT"] + agg["IDXOPT"],
        n_opt_written=sum(1 for l in opt if l["pct"] < 0), n_opt_bought=sum(1 for l in opt if l["pct"] > 0),
        n_calls_written=sum(1 for l in opt if l["pct"] < 0 and l["opt"] == "C"),
        n_puts_written=sum(1 for l in opt if l["pct"] < 0 and l["opt"] == "P"),
        index_put_bought=any(l["kind"] == "IDXOPT" and l["pct"] > 0 for l in opt),
        debt=agg["DEBT"] + agg["GSEC"], money_market=agg["MM"],
        # Groww lists futures at notional with an offsetting cash line; cash is therefore the residual after stocks,
        # options, debt, money market, REITs/InvITs and fund units (the project's convention), as for official files.
        cash=(100 - stocks_etc - agg["DEBT"] - agg["GSEC"] - agg["MM"] - agg["IRS"]) if p["source"] == "groww" else agg["CASH"],
        reit_invit=agg["REIT"],
        mf_units=agg["MF"], irs=agg["IRS"],
        debt_cash_residual=(100 - stocks_etc) if p["source"] == "groww_page" else None,
        hedged_same_stock=hedged, unhedged_long=unhedged, naked_stock_short=naked_short,
        hedged_share=hedged / eq_tot * 100 if eq else 0,
        net_equity=agg["EQ"] + agg["FUT"] + agg["IDXFUT"],
        gross_equity=agg["EQ"] + sum(abs(l["pct"]) for l in L if l["kind"] in ("FUT", "IDXFUT")),
        n_stocks=len(eq), top10_long=sum(longs[:10]), top10_share=sum(w[:10]) * 100,
        hhi_long=sum(x * x for x in w) * 10000, eff_n=1 / sum(x * x for x in w) if w else 0,
        top10_net=sum(abs(x) for x in net_sorted[:10]),
        long_large=band_long["Large"], long_mid=band_long["Mid"], long_small=band_long["Small"],
        long_unclassified=band_long["Unclassified"],
        net_large=band_net["Large"], net_mid=band_net["Mid"], net_small=band_net["Small"],
        net_unclassified=band_net["Unclassified"],
        **{f"debt_{k.split()[0].lower().replace('/', '')}": v for k, v in debt_rating.items()},
    )
    return s, L


def trades(prev: dict, cur: dict) -> list[dict]:
    """Quantity changes between two official files of one fund (equity and stock futures)."""
    def book(p):
        b = {}
        for l in p["lines"]:
            if l["kind"] not in ("EQ", "FUT") or l["qty"] is None:
                continue
            k = (l["kind"], l["isin"] or norm(l["under"]))
            e = b.setdefault(k, dict(name=l["under"] if l["kind"] == "FUT" else l["name"], qty=0.0, pct=0.0, mv=0.0,
                                     band=l.get("band", "")))
            e["qty"] += l["qty"]
            e["pct"] += l["pct"]
            e["mv"] += l["mv_lakh"] or 0
        return b
    a, b = book(prev), book(cur)
    out = []
    for k in set(a) | set(b):
        pa, pb = a.get(k), b.get(k)
        qa, qb = (pa or {}).get("qty", 0.0), (pb or {}).get("qty", 0.0)
        if abs(qb - qa) < 1e-9:
            continue
        ref = pb or pa
        status = "new" if not pa else "exited" if not pb else ("added" if abs(qb) > abs(qa) else "reduced")
        px = (pb["mv"] / pb["qty"] * 1e5) if pb and pb["qty"] else (pa["mv"] / pa["qty"] * 1e5 if pa and pa["qty"] else 0)
        out.append(dict(fund=cur["fund"], from_date=prev["asof"], to_date=cur["asof"], leg="Stock" if k[0] == "EQ" else "Future",
                        name=ref["name"], band=ref.get("band", ""), qty_from=qa, qty_to=qb, qty_change=qb - qa,
                        pct_from=(pa or {}).get("pct", 0.0), pct_to=(pb or {}).get("pct", 0.0),
                        trade_value_cr=round((qb - qa) * px / 1e7, 3), status=status))
    out.sort(key=lambda r: -abs(r["trade_value_cr"]))
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    summaries, all_lines, changes, srcs = [], [], [], []
    for fund, (code, brand, page) in FUNDS.items():
        files = sorted((PORT / fund).glob(f"{fund}_hybrid_*.xlsx")) if (PORT / fund).exists() else []
        ports = []
        for f in files:
            try:
                ports.append(parse_official(f, fund))
            except Exception as exc:  # report and continue; a new AMC layout needs a look
                print(f"  ! {f.name}: {exc}")
        have = {(p["asof"] or "")[:7] for p in ports}  # an official file for the month wins
        for gf in sorted((PORT / fund).glob("groww_*.json")) if (PORT / fund).exists() else []:
            gp = parse_groww_api(gf, fund)
            if gp["asof"][:7] not in have:
                ports.append(gp)
                have.add(gp["asof"][:7])
        g = GROWW / f"{fund}.txt"
        if g.exists() and "2026-09" not in have:
            ports.append(parse_groww(g, fund))
        ports.sort(key=lambda p: p["asof"] or "")
        for p in ports:
            s, L = summarise(p)
            s["brand"], s["code"] = brand, code
            summaries.append(s)
        latest = ports[-1] if ports else None
        if latest:
            for l in latest["lines"]:
                all_lines.append(dict(fund=fund, brand=brand, asof=latest["asof"], source=latest["source"], name=l["name"],
                                      isin=l["isin"], industry=l["ind"], kind=l["kind"], opt=l["opt"], underlying=l["under"],
                                      band=l.get("band", ""), qty=l["qty"], mv_lakh=l["mv_lakh"], pct=round(l["pct"], 4)))
        off = [p for p in ports if p["source"] == "official"]
        for a, b in zip(off, off[1:]):
            for t in trades(a, b):
                t["brand"] = brand
                changes.append(t)
        srcs.append(dict(fund=fund, brand=brand, code=code, disclosure_page=page,
                         official_months=";".join(p["asof"] for p in off), latest_asof=latest["asof"] if latest else "",
                         latest_source=latest["source"] if latest else "none",
                         automated="yes (AMC file)" if fund == "arudha" else "yes (Groww)" if latest and latest["source"] == "groww"
                         else "no (drop the AMC file in data/monitor/portfolios/%s/)" % fund))
        print(f"  {brand:9s} {len(ports)} portfolio(s): " + ", ".join(f"{p['asof']}[{p['source'][0]}]" for p in ports))

    def write(name, rows):
        if not rows:
            return
        keys = []
        for r in rows:
            for k in r:
                if k not in keys:
                    keys.append(k)
        with open(OUT / name, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            for r in rows:
                w.writerow({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()})
    write("hold_summary.csv", summaries)
    write("hold_lines.csv", all_lines)
    write("hold_changes.csv", changes)
    write("hold_sources.csv", srcs)
    print(f"summaries {len(summaries)}, lines {len(all_lines)}, trades {len(changes)}")


if __name__ == "__main__":
    main()
