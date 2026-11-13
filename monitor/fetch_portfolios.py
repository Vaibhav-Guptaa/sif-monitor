"""Download new official monthly portfolio files where the AMC publishes plain links.

Automated today: Arudha (arudhasif.com/downloads/ links every monthly file). The other AMCs serve files through
JavaScript apps or token-gated APIs, so their files are added by hand to data/monitor/portfolios/<fund>/ as
<fund>_hybrid_<YYYY-MM>.xlsx (see monitor/README.md for each AMC's page).

groww() snapshots every hybrid fund's latest portfolio and AUM from Groww's scheme record (same AMFI code) into
data/monitor/portfolios/<fund>/groww_<portfolio date>.json. Groww shows only the latest portfolio, so each run keeps
any new one; the history builds up from the first run (30 Sep 2026). AUM readings go to raw/groww_aum.csv.
"""
from __future__ import annotations

import csv
import json
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).parent))
import sources as S  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PORT = ROOT / "data" / "monitor" / "portfolios"
IDS = ROOT / "data" / "monitor" / "ref" / "groww_ids.json"
AUMLOG = ROOT / "data" / "monitor" / "raw" / "groww_aum.csv"
WBSEEN = ROOT / "data" / "monitor" / "ref" / "wayback_seen.json"
MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def month_of(fname: str) -> str | None:
    f = fname.lower()
    m = re.search(r"(\d{1,2})-(\d{1,2})-(20\d\d)", f)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}"
    m = re.search(r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ]+(20\d\d)", f)
    if m:
        return f"{m.group(2)}-{MONTHS[m.group(1)]:02d}"
    return None


def arudha() -> list[str]:
    base = "https://arudhasif.com/downloads/"
    html = S.get(base).decode("utf-8", "replace")
    links = set(re.findall(r'(?:href|src)="([^"]*portfolio/month/[^"]*\.xlsx)"', html))
    got = []
    out = PORT / "arudha"
    out.mkdir(parents=True, exist_ok=True)
    for link in sorted(links):
        name = link.rsplit("/", 1)[-1]
        if "hybrid" not in name.lower() and "asif01" not in name.lower():
            continue
        ym = month_of(name)
        if not ym:
            print(f"  ? cannot date {name}")
            continue
        dest = out / f"arudha_hybrid_{ym}.xlsx"
        if dest.exists():
            continue
        url = base + quote(link, safe="/")
        data = S.get(url)
        if not data.startswith(b"PK"):
            print(f"  ! not an xlsx: {url}")
            continue
        dest.write_bytes(data)
        got.append(dest.name)
    return got


def groww(funds: dict[str, tuple]) -> list[str]:
    """funds: fund -> (AMFI code, brand, ...). Saves new Groww portfolio snapshots; logs AUM each run."""
    ids = json.loads(IDS.read_text()) if IDS.exists() else {}
    got, log = [], []
    for fund, (code, brand, *_rest) in funds.items():
        doc = None
        if fund in ids:
            doc = S.groww_scheme(ids[fund])
        else:
            for sid in S.groww_search(f"{brand} hybrid long short fund"):
                d = S.groww_scheme(sid)
                time.sleep(0.3)
                if d.get("scheme_code") == code:
                    ids[fund], doc = sid, d
                    break
        time.sleep(0.3)
        if not doc or doc.get("scheme_code") != code:
            print(f"  ? Groww: no scheme record for {brand} ({code})")
            continue
        H = doc.get("holdings") or []
        pdates = sorted({h["portfolio_date"] for h in H if h.get("portfolio_date")})
        pdate = S.datetime.fromisoformat(pdates[-1].replace("Z", "+00:00")).astimezone(S.IST).date().isoformat() if pdates else ""
        log.append(dict(fetched=date.today().isoformat(), fund=fund, code=code, aum_cr=doc.get("aum"),
                        nav=doc.get("nav"), nav_date=doc.get("nav_date"), portfolio_date=pdate, lines=len(H)))
        if not H:
            continue
        dest = PORT / fund / f"groww_{pdate}.json"
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        keep = {k: doc.get(k) for k in ("scheme_code", "scheme_name", "isin", "aum", "nav", "nav_date", "search_id")}
        keep.update(portfolio_date=pdate, fetched=datetime.now().isoformat(timespec="seconds"),
                    source=f"{S.GROWW}/data/mf/web/v4/scheme/search/{ids[fund]}", holdings=H)
        dest.write_text(json.dumps(keep, indent=1))
        got.append(dest.name if fund in dest.name else f"{fund}/{dest.name}")
    IDS.parent.mkdir(parents=True, exist_ok=True)
    IDS.write_text(json.dumps(ids, indent=1, sort_keys=True))
    new_file = not AUMLOG.exists()
    with open(AUMLOG, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(log[0]))
        if new_file:
            w.writeheader()
        w.writerows(log)
    return got


def wayback(funds: dict[str, tuple]) -> list[str]:
    """Past portfolios from Internet Archive (web.archive.org) copies of each fund's Groww page. Each archived page
    embeds the portfolio Groww showed that day (same fields as the live API). Saved as groww_<portfolio date>.json
    unless that month is already held. Archive timestamps already read are remembered in ref/wayback_seen.json."""
    ids = json.loads(IDS.read_text()) if IDS.exists() else {}
    seen = set(json.loads(WBSEEN.read_text())) if WBSEEN.exists() else set()
    got = []
    for fund, (code, brand, *_rest) in funds.items():
        sid = ids.get(fund)
        if not sid:
            continue
        cdx = ("https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp&filter=statuscode:200"
               f"&url=groww.in/mutual-funds/{sid}")
        try:
            rows = json.loads(S.get(cdx) or b"[]")[1:]
        except Exception as exc:
            print(f"  ? archive index {fund}: {exc}")
            continue
        time.sleep(1)
        have = {p.stem.split("_")[1][:7] for p in (PORT / fund).glob("groww_*.json")} if (PORT / fund).exists() else set()
        have |= {re.search(r"(\d{4}-\d{2})", p.name).group(1) for p in (PORT / fund).glob(f"{fund}_hybrid_*.xlsx")} if (PORT / fund).exists() else set()
        for (ts,) in rows:
            key = f"{fund}/{ts}"
            if key in seen:
                continue
            url = f"https://web.archive.org/web/{ts}id_/https://groww.in/mutual-funds/{sid}"
            try:
                html = S.get(url).decode("utf-8", "replace")
            except Exception as exc:
                print(f"  ? archive page {key}: {exc}")
                continue
            time.sleep(1)
            seen.add(key)
            m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
            doc = (json.loads(m.group(1)).get("props", {}).get("pageProps", {}).get("mfServerSideData") or {}) if m else {}
            H = doc.get("holdings") or []
            if doc.get("scheme_code") != code or not H:
                continue
            pd_ = max(h["portfolio_date"] for h in H if h.get("portfolio_date"))
            pdate = S.datetime.fromisoformat(pd_.replace("Z", "+00:00")).astimezone(S.IST).date().isoformat()
            if pdate[:7] in have:
                continue
            implied = sorted(h["market_value"] / (h["corpus_per"] / 100) for h in H
                             if h.get("corpus_per") and abs(h["corpus_per"]) > 2 and h.get("market_value"))
            aum = doc.get("aum") or (round(implied[len(implied) // 2], 2) if implied else None)
            keep = {k: doc.get(k) for k in ("scheme_code", "scheme_name", "isin", "nav", "nav_date", "search_id")}
            keep.update(aum=aum, portfolio_date=pdate, fetched=datetime.now().isoformat(timespec="seconds"),
                        source=f"Internet Archive copy of Groww's page, {ts}: {url}", holdings=H)
            dest = PORT / fund / f"groww_{pdate}.json"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(keep, indent=1))
            have.add(pdate[:7])
            got.append(f"{fund}/{dest.name}")
    WBSEEN.write_text(json.dumps(sorted(seen), indent=0))
    return got


if __name__ == "__main__":
    new = arudha()
    print("new files:", ", ".join(new) if new else "none")
