"""LLM-assisted upkeep for the SIF monitor (optional; runs only when Anthropic API credentials are set).

The numbers on the dashboard stay rule-based. Claude does two judgement jobs, and code checks every answer
before it is used:

1. Renamed or unmatched stocks. A holding whose name is not on AMFI's market-cap list shows as "Unclassified".
   Claude picks the matching AMFI name from a short candidate list, or says it is a new listing. Accepted only
   if the pick is one of the candidates. Saved to data/monitor/ref/llm_aliases.json and read by holdings.py.

2. Industry AUM. AMFI's monthly SIF totals (all SIFs, hybrid long-short) come from press reports. Claude
   searches the web for the latest month-ends not yet held. Accepted only if hybrid <= all, the total covers
   the funds we track, and month-on-month growth is plausible. Saved to data/monitor/ref/industry_aum.json
   and read by build.py.

Each decision is cached, so a run only calls the API for something new. Without credentials this module does
nothing and the pipeline runs as before.
"""
from __future__ import annotations

import csv
import difflib
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "data" / "monitor"
REF = ROOT / "ref"
ALIASES = REF / "llm_aliases.json"
INDUSTRY = REF / "industry_aum.json"
MODEL = "claude-opus-5-5"
FALLBACK = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}  # reroute on a policy decline


def _client():
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        return None
    try:
        import anthropic
    except ImportError:
        print("  llm: anthropic package not installed; skipping")
        return None
    return anthropic.Anthropic(max_retries=3)


def _text(resp) -> str:
    if resp.stop_reason == "refusal":
        raise RuntimeError("model declined the request")
    return next((b.text for b in resp.content if b.type == "text"), "")


def _load(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


# ---------- 1. unmatched stock names -> AMFI market-cap list ----------
MAP_SCHEMA = {
    "type": "object",
    "properties": {"decisions": {"type": "array", "items": {
        "type": "object",
        "properties": {"holding": {"type": "string"}, "amfi_name": {"type": "string"}, "reason": {"type": "string"}},
        "required": ["holding", "amfi_name", "reason"], "additionalProperties": False}}},
    "required": ["decisions"], "additionalProperties": False,
}


def map_names(client) -> int:
    import holdings as HM
    lines = ROOT / "out" / "hold_lines.csv"
    if not lines.exists():
        return 0
    amfi_names = sorted(HM.CAP_NAME)          # normalised names on AMFI's list
    cache = _load(ALIASES)
    todo = sorted({r["name"] for r in csv.DictReader(lines.open()) if r["kind"] == "EQ" and r.get("band") == "Unclassified"}
                  - set(cache))
    if not todo:
        return 0
    cand = {n: difflib.get_close_matches(HM.norm(n), amfi_names, n=8, cutoff=0.45) for n in todo}
    # the whole AMFI list goes in the (cached) system prompt so renamed companies can be found, e.g. Adani Wilmar
    # -> AWL Agri Business; the close spellings are only hints
    system = [{"type": "text", "cache_control": {"type": "ephemeral"},
               "text": "AMFI average market-capitalisation list, Jan-Jun 2026 (normalised company names, one per line):\n"
                       + "\n".join(amfi_names)}]
    prompt = (
        "Each holding below is an Indian listed company named as a mutual-fund portfolio lists it; the name did not "
        "match the AMFI list in the system prompt. For each, give the AMFI list entry that is the same company "
        "(often a former or abbreviated name), copied exactly as it appears in the list, or an empty amfi_name if the "
        "company is not on the list (typically listed after June 2026, delisted, or not a company). Close spellings "
        "are given as hints only. Give a one-line reason.\n\n"
        + "\n".join(f"- {n} (close spellings: {', '.join(c) or 'none'})" for n, c in cand.items())
    )
    resp = client.beta.messages.create(
        model=MODEL, max_tokens=16000, **FALLBACK, system=system,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": MAP_SCHEMA}},
        messages=[{"role": "user", "content": prompt}],
    )
    got = 0
    for d in json.loads(_text(resp))["decisions"]:
        h, pick = d["holding"], d["amfi_name"].strip()
        if h not in cand:
            continue
        if pick and pick not in HM.CAP_NAME:   # the check: an exact AMFI list entry, or 'not on the list'
            continue
        cache[h] = {"amfi": pick, "reason": d["reason"], "model": MODEL, "at": date.today().isoformat()}
        got += 1
    ALIASES.write_text(json.dumps(cache, indent=1, sort_keys=True, ensure_ascii=False))
    print(f"  llm: {got} of {len(todo)} unmatched stock names settled ({sum(1 for v in cache.values() if v['amfi'])} mapped so far)")
    return got


# ---------- 2. AMFI monthly SIF AUM totals ----------
AUM_SCHEMA = {
    "type": "object",
    "properties": {"months": {"type": "array", "items": {
        "type": "object",
        "properties": {"month_end": {"type": "string"}, "found": {"type": "boolean"},
                       "all_sifs_cr": {"type": "number"}, "hybrid_long_short_cr": {"type": "number"},
                       "source_url": {"type": "string"}, "quote": {"type": "string"}},
        "required": ["month_end", "found", "all_sifs_cr", "hybrid_long_short_cr", "source_url", "quote"],
        "additionalProperties": False}}},
    "required": ["months"], "additionalProperties": False,
}


def _month_ends(n: int) -> list[str]:
    today = date.today()
    y, m, out = today.year, today.month, []
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        nxt = date(y + (m == 12), m % 12 + 1, 1)
        out.append((nxt.fromordinal(nxt.toordinal() - 1)).isoformat())
    return out


def industry_aum(client, known: dict[str, dict]) -> int:
    """known: month_end -> {'All SIFs': x, 'Hybrid long-short': y} already held (hand-entered or cached)."""
    cache = _load(INDUSTRY)
    have = set(known) | set(cache)
    want = [m for m in _month_ends(3) if m not in have and (date.today() - date.fromisoformat(m)).days >= 7]
    if not want:
        return 0
    fams = ROOT / "dash" / "families.csv"
    tracked = {"all": 0.0, "hybrid": 0.0}
    if fams.exists():
        for r in csv.DictReader(fams.open()):
            v = float(r["aum_sep_cr"]) if r.get("aum_sep_cr") else 0.0
            tracked["all"] += v
            tracked["hybrid"] += v if r["category"] == "Hybrid long-short" else 0.0
    prompt = (
        "Find AMFI's reported assets under management for India's Specialised Investment Funds (SIFs) at these "
        f"month-ends: {', '.join(want)}. For each month give the total AUM of all SIFs and of the hybrid long-short "
        "category, in rupees crore, as AMFI's monthly data reports them (AMFI's website, or press articles quoting "
        "AMFI's monthly SIF data). Set found=false and zeros if a month has not been published. Give the source URL "
        "and a short verbatim quote containing the figures."
    )
    messages = [{"role": "user", "content": prompt}]
    for _ in range(4):  # server-side search loop may pause; resume by resending the turn
        resp = client.beta.messages.create(
            model=MODEL, max_tokens=16000, **FALLBACK,
            tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 6}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": AUM_SCHEMA}},
            messages=messages,
        )
        if resp.stop_reason != "pause_turn":
            break
        messages = [messages[0], {"role": "assistant", "content": resp.content}]
    rows = json.loads(_text(resp))["months"]
    seq = {**{k: v for k, v in known.items()}, **{k: {"All SIFs": v["all_sifs_cr"], "Hybrid long-short": v["hybrid_long_short_cr"]}
                                                    for k, v in cache.items()}}
    got = 0
    for r in rows:
        m, a, h = r["month_end"], float(r["all_sifs_cr"]), float(r["hybrid_long_short_cr"])
        if not r["found"] or m not in want or a <= 0 or h <= 0:
            continue
        prev = [seq[k] for k in sorted(seq) if k < m]
        checks = [h <= a,
                  a >= 0.9 * tracked["all"] if tracked["all"] else True,      # covers the funds we track
                  h >= 0.9 * tracked["hybrid"] if tracked["hybrid"] else True,
                  (0.8 <= a / prev[-1]["All SIFs"] <= 1.5) if prev else True]  # month-on-month sanity
        if not all(checks):
            print(f"  llm: rejected {m} industry AUM {a:.0f} / {h:.0f} (failed checks {checks})")
            continue
        cache[m] = {"all_sifs_cr": a, "hybrid_long_short_cr": h, "source_url": r["source_url"], "quote": r["quote"],
                    "model": MODEL, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        got += 1
    INDUSTRY.write_text(json.dumps(cache, indent=1, sort_keys=True, ensure_ascii=False))
    print(f"  llm: industry AUM for {got} new month-end(s)")
    return got


def main(known_industry: dict | None = None) -> dict:
    """Returns how many new decisions each job made, so the caller can rerun what depends on them."""
    out = {"names": 0, "industry": 0}
    client = _client()
    if client is None:
        print("  llm: no Anthropic credentials; skipping LLM upkeep")
        return out
    import anthropic
    for key, job in (("names", lambda: map_names(client)), ("industry", lambda: industry_aum(client, known_industry or {}))):
        try:
            out[key] = job()
        except (anthropic.APIStatusError, anthropic.APIConnectionError, RuntimeError, ValueError, KeyError) as e:
            print(f"  llm: {key} job skipped ({type(e).__name__}: {e})")
    return out


if __name__ == "__main__":
    main()
