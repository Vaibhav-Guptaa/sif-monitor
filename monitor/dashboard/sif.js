/* SIF Competitor Monitor — drawings, controls and calcs. Data: funds, daily, alloc, holdings, trades, aum, sources. */
(function () {
  const root = document.getElementById('sif');
  // vivid, high-contrast series colours on a light page (fixed here so the claude.ai and static copies match)
  const C = ['#2563eb', '#ea580c', '#16a34a', '#c026d3', '#dc2626', '#0891b2', '#ca8a04', '#7c3aed', '#db2777', '#65a30d', '#0f766e', '#9a3412', '#1e3a8a', '#be123c', '#4d7c0f', '#a21caf'];
  const col = (i) => C[i % Math.max(C.length, 1)] || 'var(--color-fg)';
  if (root) {
    root.style.setProperty('--sif-c-open', col(0));
    root.style.setProperty('--sif-c-hedged', 'color-mix(in srgb, ' + col(0) + ' 40%, transparent)');
    root.style.setProperty('--sif-c-reit', col(3));
    root.style.setProperty('--sif-c-debt', col(1));
    root.style.setProperty('--sif-c-mm', 'color-mix(in srgb, ' + col(1) + ' 55%, transparent)');
    root.style.setProperty('--sif-c-cash', col(2));
    root.style.setProperty('--sif-c-resid', 'var(--cds-chart-muted)');
  }

  const CAT_SHORT = { 'Hybrid long-short': 'HLS', 'Equity long-short': 'ELS', 'Ex-top 100 long-short': 'Ex100', 'Active asset allocator': 'AAA', 'Sector rotation': 'SR' };
  const BENCH = ['nifty_tri', 'blend', 'debt65', 'arbitrage', 'liquid', 'nifty50'];
  const BENCH_STYLE = { nifty_tri: '6 3', blend: '3 3', debt65: '10 4', arbitrage: '1 3', liquid: '1 5', nifty50: '8 3 2 3' };
  const BENCH_COLOR = { nifty_tri: '#111827', blend: '#64748b', debt65: '#a16207', arbitrage: '#0f766e', liquid: '#94a3b8', nifty50: '#374151' };
  const DEFAULT_HL = ['SIF-9', 'SIF-79', 'SIF-139', 'SIF-14', 'SIF-145'];
  const S = window.SIF = {
    cat: 'Hybrid long-short', win: 'all', metric: 'idx', hl: [], slot: {}, range: null, annual: true, bench: new Set(['nifty_tri', 'blend', 'debt65', 'arbitrage']),
    sort: { key: 'ret_inception', dir: -1 }, fund: null, kind: 'all', period: null, catInit: null,
  };

  const num = (v) => (v === null || v === undefined || v === '' ? NaN : +v);
  const f1 = d3.format('.1f'), f2 = d3.format('.2f'), sg1 = d3.format('+.1f'), f0 = d3.format(',.0f'), fq = d3.format(',.0f');
  const fx = (v, f) => (Number.isFinite(v) ? f(v) : '–');
  const parseDate = d3.utcParse('%Y-%m-%d'), fmtDate = d3.utcFormat('%d %b %Y'), fmtMon = d3.utcFormat('%b %y');

  // ---------- data access ----------
  const cache = new WeakMap();
  function rows(id) {
    const r = dash.data(id);
    return r.status === 'ok' ? r.data : null;
  }
  function funds() {
    const d = rows('funds'); if (!d) return null;
    if (cache.has(d)) return cache.get(d);
    const out = d.map((r) => {
      const o = { ...r };
      for (const k of Object.keys(r)) if (!['id', 'kind', 'brand', 'sponsor', 'name', 'category', 'isin', 'first_date', 'last_date', 'fund'].includes(k) && !k.endsWith('_date')) o[k] = num(r[k]);
      if (r.first_date && r.last_date) o.span_days = Math.round((parseDate(r.last_date) - parseDate(r.first_date)) / 864e5);
      if (r.kind === 'SIF' && Number.isFinite(o.span_days)) o.days_live = o.span_days;
      return o;
    });
    cache.set(d, out); return out;
  }
  function daily() {
    const d = rows('daily'); if (!d) return null;
    if (cache.has(d)) return cache.get(d);
    const by = new Map();
    for (const r of d) {
      if (!by.has(r.id)) by.set(r.id, []);
      by.get(r.id).push({ date: parseDate(r.date), ds: r.date, nav: num(r.nav), idx: num(r.idx), dd: num(r.dd), vol20: num(r.vol20), vol60: num(r.vol60), beta20: num(r.beta20), beta60: num(r.beta60), ret6m: num(r.ret6m), ret12m: num(r.ret12m), sharpe6m: num(r.sharpe6m) });
    }
    for (const a of by.values()) a.sort((x, y) => x.date - y.date);
    cache.set(d, by); return by;
  }
  function allocLatest() {
    const d = rows('alloc'); if (!d) return null;
    const m = new Map();
    for (const r of d) { const p = m.get(r.fund); if (!p || r.asof > p.asof) m.set(r.fund, r); }
    return m;
  }
  const QRANK = (q) => (q === 'Official' ? 3 : q === 'Reported' ? 1 : 2);
  const QCLS = (q) => (q === 'Official' ? 'official' : q === 'Reported' ? 'reported' : 'disclosed');
  function aumLatest() {
    const d = rows('aum'); if (!d) return null;
    const m = new Map();
    for (const r of d) {
      if (r.kind !== 'Fund') continue;
      const p = m.get(r.fund);
      const better = !p || r.date > p.date || (r.date === p.date && QRANK(r.quality) > QRANK(p.quality));
      if (better) m.set(r.fund, r);
    }
    return m;
  }
  const CATS = [
    { key: 'Hybrid long-short', c: '#2563eb', what: 'Holds both shares and bonds, and may run a limited short book.',
      rule: 'At least 25% in equity and 25% in debt. Unhedged short derivatives up to 25% of NAV.',
      liq: 'Interval strategy: redemption at most twice a week, listed on an exchange.' },
    { key: 'Equity long-short', c: '#ea580c', what: 'Mainly a share portfolio, with the option of short positions through derivatives.',
      rule: 'At least 80% in equity. Unhedged short derivatives up to 25% of NAV.',
      liq: 'Open-ended or interval; daily redemption or less often.' },
    { key: 'Ex-top 100 long-short', c: '#16a34a', what: 'Shares outside the 100 largest companies (mid and small caps), plus shorts.',
      rule: 'At least 65% outside the top 100 by AMFI market-cap rank; up to 35% may be in the top 100, including index derivatives. Unhedged shorts up to 25%, only in stocks outside the top 100.',
      liq: 'Open-ended or interval; daily redemption or less often.' },
    { key: 'Active asset allocator', c: '#9333ea', what: 'Moves freely between shares, bonds, InvITs and commodity derivatives.',
      rule: 'No minimum in any asset class. Unhedged shorts up to 25%, in equity and debt only (not commodities).',
      liq: 'Interval strategy: redemption at most twice a week, listed on an exchange.' },
    { key: 'Sector rotation', c: '#db2777', what: 'Shares in at most four sectors at a time, rotated as views change.',
      rule: 'At least 80% in equity of at most four sectors. Unhedged shorts up to 25%, taken at sector level: cannot be long and short the same sector.',
      liq: 'Open-ended or interval; daily redemption or less often.' },
    { key: 'Debt long-short', c: '#0f766e', what: 'Bonds across maturities, with short positions through exchange-traded debt derivatives.',
      rule: 'Unhedged short through exchange-traded debt derivatives up to 25%.', liq: 'Interval strategy: redemption at most once a week.' },
    { key: 'Sectoral debt long-short', c: '#64748b', what: 'Bonds of at least two sectors, with sector-level shorts.',
      rule: 'At least two sectors, at most 75% in one. Unhedged shorts up to 25%, at sector level.', liq: 'Interval strategy: redemption at most once a week.' },
  ];
  const CATC = Object.fromEntries(CATS.map((c) => [c.key, c.c]));
  function fams() {
    const d = rows('families'); if (!d) return null;
    if (cache.has(d)) return cache.get(d);
    // aum: the latest figure Groww reports for the fund (read date in aum_read; Groww states no month-end);
    // aumSep: net assets in the fund's 30 Sep 2026 portfolio disclosure, the last confirmed, dated figure
    const out = d.map((r) => { const l = num(r.aum_latest_cr), sp = num(r.aum_sep_cr);
      return { ...r, aum: Number.isFinite(l) && l > 0 ? l : sp, aumSep: sp, moved: Number.isFinite(l) && Number.isFinite(sp) && Math.abs(l - sp) > 0.5, ter: num(r.ter_direct), risk: num(r.risk_level) }; });
    cache.set(d, out); return out;
  }
  const readDate = () => { const R = fams(); const d = R && d3.max(R, (r) => r.aum_read); return d ? fmtDate(parseDate(d)) : ''; };
  const fcr = (v) => (Number.isFinite(v) ? '₹' + f0(v) + ' cr' : '–');
  // Fund names always read 'Platform (fund house)', plus that fund's AUM where it helps identify it
  const AMC_SHORT = { 'Aditya Birla Sun Life': 'Aditya Birla', 'ICICI Prudential': 'ICICI Pru', 'Franklin Templeton': 'Franklin', 'Mahindra Manulife': 'Mahindra', 'Kotak Mahindra': 'Kotak', 'Quant': 'quant', 'JioBlackRock': 'Jio BlackRock' };
  function fmeta(code) { const R = fams(); const r = R ? R.find((x) => x.code === code) : null; return r ? { amc: AMC_SHORT[r.amc] || r.amc, aum: r.aum } : {}; }
  const withHouse = (brand, code, category) => { const m_ = fmeta(code); return brand + (m_.amc ? ' (' + m_.amc + ')' : '') + (S.cat === 'all' && category ? ' ' + (CAT_SHORT[category] || '') : ''); };
  const aumTxt = (code) => { const m_ = fmeta(code); return Number.isFinite(m_.aum) && m_.aum > 0 ? '₹' + d3.format(',.0f')(m_.aum) + ' cr' : ''; };
  const label = (f) => (f.kind === 'SIF' ? withHouse(f.brand, f.id, f.category) : f.brand);
  const labelAum = (f) => (f.kind === 'SIF' && aumTxt(f.id) ? label(f) + ' · ' + aumTxt(f.id) : label(f));
  const allocLabel = (r) => withHouse(r.brand, r.code, r.category || 'Hybrid long-short');
  const allocIn = (r) => S.cat === 'all' || (r.category || 'Hybrid long-short') === S.cat;
  const famLabel = () => (S.cat === 'all' ? 'All SIF funds' : S.cat);
  const inCat = (f) => f.kind === 'SIF' && (S.cat === 'all' || f.category === S.cat);

  function ensureHL(F) {
    if (S.catInit === S.cat) return;
    S.catInit = S.cat;
    const pool = F.filter(inCat);
    // every fund in the family is shown by default; colours go to the largest funds first
    const aumOf = (f) => { const R = fams(); const r = R ? R.find((x) => x.code === f.id) : null; return r && Number.isFinite(r.aum) ? r.aum : -1; };
    const hl = pool.slice().sort((a, b) => aumOf(b) - aumOf(a) || label(a).localeCompare(label(b))).map((f) => f.id);
    S.hl = hl; S.slot = {}; hl.forEach((c, i) => (S.slot[c] = i));
  }
  const colorOf = (id) => (id in S.slot ? col(S.slot[id]) : 'var(--cds-chart-muted)');
  function toggleHL(id) {
    const i = S.hl.indexOf(id);
    if (i >= 0) { S.hl.splice(i, 1); delete S.slot[id]; }
    else {
      const used = new Set(Object.values(S.slot));
      let s = 0; while (used.has(s)) s++;
      S.hl.push(id); S.slot[id] = s;
    }
  }
  function redraw(...names) { for (const n of names) dash.draw(n); }
  const ALL = ['chips', 'score', 'ts', 'scatter', 'scnote', 'cons', 'constitle', 'consnum', 'constable', 'fundsel', 'ddtiles', 'hist', 'histnote', 'periodsel', 'trades', 'hold', 'holdnote', 'aum', 'aumtitle', 'aumnote', 'attr'];

  function winStart(F, lastDate) {
    const days = { '1m': 30, '3m': 91, '6m': 182, '1y': 365 }[S.win];
    if (days) return d3.utcDay.offset(lastDate, -days);
    if (S.win === 'common') {
      const ds = F.filter((f) => S.hl.includes(f.id)).map((f) => parseDate(f.first_date));
      return ds.length ? d3.max(ds) : null;
    }
    return null;
  }

  // ---------- controls (static HTML; scripts only listen and set class/aria) ----------
  const catSel = document.getElementById('sif-cat');
  if (catSel) catSel.addEventListener('change', () => { S.cat = catSel.value; redraw(...ALL); });
  function seg(id, attr, key, after) {
    const g = document.getElementById(id); if (!g) return;
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button[' + attr + ']'); if (!b) return;
      for (const x of g.querySelectorAll('button')) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }
      S[key] = b.getAttribute(attr); after();
    });
  }
  seg('sif-win', 'data-win', 'win', () => { S.range = null; redraw('ts', 'scatter', 'scnote'); });
  function markWin(v) {
    for (const x of document.querySelectorAll('#sif-win button')) { const on = x.getAttribute('data-win') === v; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (v) S.win = v;
  }
  const inFrom = document.getElementById('sif-from'), inTo = document.getElementById('sif-to');
  for (const inp of [inFrom, inTo]) if (inp) inp.addEventListener('change', () => {
    const a = parseDate(inFrom.value), b = parseDate(inTo.value);
    if (a && b && b > a) { S.range = [a, b]; markWin(null); redraw('ts'); }
  });
  const btnReset = document.getElementById('sif-reset');
  if (btnReset) btnReset.addEventListener('click', () => { S.range = null; markWin('all'); redraw('ts', 'scatter', 'scnote'); });
  seg('sif-metric', 'data-metric', 'metric', () => redraw('ts', 'tstitle'));
  seg('sif-kind', 'data-kind', 'kind', () => redraw('hold', 'holdnote'));
  for (const th of document.querySelectorAll('#score-table th button[data-sort]')) {
    th.addEventListener('click', () => {
      const k = th.getAttribute('data-sort');
      S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'brand' || k === 'first_date' || k === 'days_live' ? 1 : -1) };
      redraw('score');
    });
  }

  // ---------- calc: construction table (latest disclosure + NAV-implied exposure) ----------
  dash.calc('construction', {
    title: 'Portfolio construction, latest disclosure',
    description: 'Latest portfolio row per fund, joined to its 60-day NAV beta (x 100) as the exposure the NAV implies.',
    inputs: ['alloc', 'funds'],
    fn: (alloc, funds) => {
      const latest = new Map();
      for (const r of alloc) { const p = latest.get(r.fund); if (!p || r.asof > p.asof) latest.set(r.fund, r); }
      const beta = new Map(funds.map((f) => [f.id, +f.beta_60d]));
      const r1 = (v) => (v === '' || v == null ? null : Math.round(+v * 10) / 10);
      return [...latest.values()].map((r) => ({
        fund: r.fund, code: r.code, brand: r.brand, category: r.category || 'Hybrid long-short', asof: r.asof, source: r.source,
        net_equity: r1(r.net_equity), implied: beta.has(r.code) && Number.isFinite(beta.get(r.code)) ? Math.round(beta.get(r.code) * 1000) / 10 : null,
        stock_fut_short: r1(r.stock_fut_short), index_fut: r1(r.index_fut),
        options: (+r.n_opt_written || 0) + ' / ' + (+r.n_opt_bought || 0) + ((r.index_put_bought === 'True') ? ' (index put)' : ''),
        n_stocks: +r.n_stocks, top10_share: r1(r.top10_share), eff_n: r1(r.eff_n),
        long_lms: [r.long_large, r.long_mid, r.long_small].map((v) => (+v || 0).toFixed(1)).join(' / '),
        net_lms: [r.net_large, r.net_mid, r.net_small].map((v) => (+v || 0).toFixed(1)).join(' / '),
      })).sort((a, b) => a.brand.localeCompare(b.brand));
    },
  });

  // ---------- header ----------
  dash.draw('asof', (el) => {
    const F = funds(); if (!F) { el.textContent = '—'; return; }
    const d = d3.max(F.filter((f) => f.kind === 'SIF'), (f) => f.last_date);
    el.textContent = d ? fmtDate(parseDate(d)) : '—';
    el.setAttribute('data-where', 'last_date=' + d);
  });
  dash.draw('takeaway', (el) => {
    const F = funds(); if (!F) { el.textContent = '—'; return; }
    ensureHL(F);
    const pool = F.filter((f) => inCat(f) && Number.isFinite(f.ret_3m));
    const tri = F.find((f) => f.id === 'nifty_tri'), arb = F.find((f) => f.id === 'arbitrage');
    el.replaceChildren();
    const add = (t, b, mark) => {
      if (t) el.append(t);
      if (b !== undefined) { const s = document.createElement('b'); s.className = 'num'; s.textContent = b; if (mark) for (const [k, v] of Object.entries(mark)) s.setAttribute(k, v); el.append(s); }
    };
    if (!pool.length) { add('No fund in this category has three months of NAVs yet.'); return; }
    const best = pool.reduce((a, b) => (b.ret_3m > a.ret_3m ? b : a));
    const m = (f, k) => ({ 'data-source': 'funds', 'data-field': k, 'data-where': 'id=' + f.id });
    add('Best 3-month return in ' + (S.cat === 'all' ? 'all SIFs' : S.cat.toLowerCase()) + ': ' + label(best) + ' ', sg1(best.ret_3m) + '%', m(best, 'ret_3m'));
    add(', with 60-day volatility of ', f1(best.vol_60d) + '%', m(best, 'vol_60d'));
    add(' and beta ', f2(best.beta_60d), m(best, 'beta_60d'));
    add('. Nifty 50 TRI ', sg1(tri.ret_3m) + '%', m(tri, 'ret_3m'));
    add(', arbitrage fund ', sg1(arb.ret_3m) + '%', m(arb, 'ret_3m'));
    add(' over the same three months.');
  });

  // ---------- chips ----------
  dash.draw('chips', (el) => {
    const F = funds(); if (!F) { el.textContent = '—'; return; }
    ensureHL(F);
    el.replaceChildren();
    const mk = (id, text, on, bench) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sif-chip' + (on ? ' on' : '') + (bench ? ' bench' : '');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const i = document.createElement('i');
      const c = bench ? BENCH_COLOR[id] : colorOf(id);
      if (on) { b.style.borderColor = c; b.style.background = 'color-mix(in srgb, ' + c + ' 10%, transparent)'; }
      if (!bench && on) i.style.background = c;
      if (bench && on) i.style.borderTopColor = c;
      b.append(i, document.createTextNode(text));
      b.addEventListener('click', () => {
        if (bench) { S.bench.has(id) ? S.bench.delete(id) : S.bench.add(id); }
        else toggleHL(id);
        redraw('chips', 'ts', 'scatter', 'score');
      });
      el.append(b);
    };
    F.filter(inCat).sort((a, b) => label(a).localeCompare(label(b))).forEach((f) => mk(f.id, labelAum(f), S.hl.includes(f.id), false));
    BENCH.forEach((id) => { const f = F.find((x) => x.id === id); if (f) mk(id, f.brand, S.bench.has(id), true); });
  });

  // ---------- scoreboard ----------
  // returns shown % a year (compound, actual days) by default; the toggle switches to plain period returns
  const retKey = (c) => (S.annual && c.startsWith('ret_') && c !== 'ret_1m' ? c + '_ann' : c);   // a month annualised (x12) is noise
  const NO_SHARPE = new Set(['debt65', 'liquid']);   // near-zero volatility makes their Sharpe meaningless
  seg('sif-annual', 'data-annual', 'annualStr', () => { S.annual = S.annualStr !== 'period'; redraw('score', 'scatter', 'scnote'); });
  const SCORE_COLS = ['brand', 'first_date', 'days_live', 'aum', 'ret_1m', 'ret_3m', 'ret_6m', 'ret_1y', 'ret_inception', 'vol_life', 'vol_1y', 'vol_60d', 'vol60_max_12m', 'vol60_min_12m', 'beta_life', 'beta_dimson', 'beta_60d', 'beta_20d', 'beta60_max_12m', 'beta60_min_12m', 'alpha', 'sharpe_life', 'sharpe_6m', 'sharpe_1y', 'max_dd', 'dd_now', 'up_capture', 'down_capture'];
  dash.draw('score', (tb) => {
    const F = funds(); if (!F) { tb.replaceChildren(); return; }
    ensureHL(F);
    const A = aumLatest() || new Map();
    const k = S.sort.key, dir = S.sort.dir;
    const val = (f) => (k === 'aum' ? num((A.get(f.fund) || {}).aum_cr) : f[retKey(k)]);
    const sifs = F.filter(inCat).sort((a, b) => {
      const x = val(a), y = val(b);
      if (typeof x === 'string' || typeof y === 'string') return dir * String(x).localeCompare(String(y));
      const fx_ = Number.isFinite(x), fy = Number.isFinite(y);
      if (!fx_ && !fy) return 0; if (!fx_) return 1; if (!fy) return -1;
      return dir * (x - y);
    });
    const list = sifs.concat(BENCH.map((id) => F.find((f) => f.id === id)).filter(Boolean));
    tb.replaceChildren();
    for (const f of list) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-key', f.id);
      if (f.kind === 'Benchmark') tr.className = 'bench';
      else if (S.hl.includes(f.id)) tr.className = 'hl';
      for (const c of SCORE_COLS) {
        const td = document.createElement('td');
        if (c === 'brand') {
          const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = f.kind === 'SIF' && S.hl.includes(f.id) ? colorOf(f.id) : 'transparent';
          td.append(sw, document.createTextNode(labelAum(f)));
        } else if (c === 'first_date') { td.className = 'n'; td.textContent = f.kind === 'SIF' ? fmtMon(parseDate(f.first_date)) : '–'; }
        else if (c === 'aum') {
          td.className = 'n';
          let a = null;
          const fr = f.kind === 'SIF' ? (fams() || []).find((x) => x.code === f.id) : null;
          if (fr && Number.isFinite(fr.aum) && fr.aum > 0) a = { aum_cr: fr.aum, fund: f.fund, date: fr.aum_read || '', quality: 'Disclosed (via Groww)', source: 'Latest figure on Groww, read ' + (fr.aum_read || '') + (fr.moved ? '; newer than the 30 Sep portfolio (₹' + f0(fr.aumSep) + ' cr), month-end not stated' : '; same as the 30 Sep portfolio') };
          if (!a) a = A.get(f.fund);
          if (a) {
            const s = document.createElement('span'); s.textContent = f0(+a.aum_cr) + (fr && fr.moved ? '* ' : ' ');
            s.setAttribute('data-source', 'aum'); s.setAttribute('data-field', 'aum_cr'); s.setAttribute('data-where', 'fund=' + a.fund + '&date=' + a.date);
            const p = document.createElement('span'); p.className = 'pill ' + QCLS(a.quality); p.textContent = { official: 'off', disclosed: 'disc', reported: 'rep' }[QCLS(a.quality)];
            p.title = a.source + ', ' + a.date;
            td.append(s, p);
          } else td.textContent = '–';
        } else {
          td.className = 'n';
          const v = NO_SHARPE.has(f.id) && c.startsWith('sharpe') ? NaN : f[retKey(c)];
          const isRet = c.startsWith('ret_') || c === 'cagr' || c === 'alpha';
          const isBeta = c.startsWith('beta') || c.startsWith('sharpe');
          const isPct = isRet || c.startsWith('vol') || c === 'max_dd' || c === 'dd_now' || c.endsWith('capture');
          const young = Number.isFinite(f.span_days) && f.span_days < 365;
          const extrap = Number.isFinite(v) && ((S.annual && (c === 'ret_3m' || c === 'ret_6m' || (c === 'ret_inception' && young))) || c === 'sharpe_6m' || (c === 'sharpe_life' && young));
          td.textContent = c === 'days_live' ? fx(v, f0) : fx(v, isBeta ? f2 : isRet ? sg1 : (c.endsWith('capture') ? f0 : f1)) + (isPct && Number.isFinite(v) ? '%' : '') + (extrap ? '†' : '');
          if (extrap) td.title = 'Annualised from less than a year of data: an extrapolation, not a realised return';
          if (f[c + '_date']) td.title = 'on ' + fmtDate(parseDate(f[c + '_date']));
          if ((isRet || c === 'dd_now' || c === 'max_dd') && v < 0 && f.kind === 'SIF' && isRet) td.classList.add('bad');
        }
        tr.append(td);
      }
      tb.append(tr);
    }
  });

  // ---------- time series ----------
  const TS_TITLE = { idx: 'Growth of ₹100', dd: 'Drawdown from peak, %', vol60: 'Rolling 60-day volatility, % a year', vol20: 'Rolling 20-day volatility, % a year', beta60: 'Rolling 60-day beta to Nifty 50', beta20: 'Rolling 20-day beta to Nifty 50', ret6m: 'Trailing 6-month return, %', ret12m: 'Trailing 12-month return, %', sharpe6m: 'Trailing 6-month Sharpe ratio (risk-free 5%)' };
  dash.draw('tstitle', (el) => { el.textContent = TS_TITLE[S.metric]; });

  function chartFrame(el, height) {
    el.replaceChildren();
    const W = Math.max(280, el.clientWidth || 600);
    const H = height || (W < 560 ? 260 : 340);
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img');
    const tip = d3.select(el).append('div').attr('class', 'sif-tip').attr('hidden', '');
    return { svg, tip, W, H };
  }
  function failNote(el, status) {
    el.replaceChildren();
    const p = document.createElement('p'); p.className = 'note';
    p.textContent = status === 'error' ? 'Failed to load.' : status === 'loading' ? 'Loading…' : '—';
    el.append(p);
  }

  const isoDay = d3.utcFormat('%Y-%m-%d');
  const tsColor = (s) => (s.kind === 'hl' ? colorOf(s.id) : BENCH_COLOR[s.id] || 'var(--color-fg-muted)');
  // Full span = earliest launch among highlighted funds (or the benchmark history) to the last NAV date.
  function tsDomain(F, D) {
    const ref = D.get('nifty50') || [];
    const last = d3.max(ref, (r) => r.date);
    const firsts = S.hl.map((id) => D.get(id)).filter((a) => a && a.length).map((a) => a[0].date);
    const full = [firsts.length ? d3.min(firsts) : (ref[0] || {}).date, last];
    let a, b;
    if (S.range) [a, b] = S.range; else { a = winStart(F, last) || full[0]; b = last; }
    if (a < full[0]) a = full[0];
    if (b > full[1]) b = full[1];
    return { full, a, b };
  }
  function syncRange(dom) {
    if (!inFrom || !inTo) return;
    for (const inp of [inFrom, inTo]) { inp.min = isoDay(dom.full[0]); inp.max = isoDay(dom.full[1]); }
    inFrom.value = isoDay(dom.a); inTo.value = isoDay(dom.b);
  }
  function tsSeries(F, D, a, b, metric) {
    const ids = BENCH.filter((x) => S.bench.has(x)).map((id) => [id, 'bench']).concat(S.hl.map((id) => [id, 'hl']));
    const out = [];
    for (const [id, kind] of ids) {
      if (metric === 'sharpe6m' && NO_SHARPE.has(id)) continue;
      const arr = (D.get(id) || []).filter((r) => r.date >= a && r.date <= b);
      if (arr.length < 2) continue;
      let vals;
      if (metric === 'idx' || metric === 'dd') {
        const base = arr[0].idx; let peak = -Infinity;
        vals = arr.map((r) => { const v = (r.idx / base) * 100; peak = Math.max(peak, v); return { date: r.date, v: metric === 'idx' ? v : (v / peak - 1) * 100 }; });
      } else vals = arr.map((r) => ({ date: r.date, v: r[metric] })).filter((p) => Number.isFinite(p.v));
      if (vals.length < 2) continue;
      const f = F.find((x) => x.id === id);
      out.push({ id, kind, vals, raw: arr, name: f ? labelAum(f) : id });
    }
    return out;
  }

  function drawMain(el, series, metric) {
    el.replaceChildren();
    if (!series.length) { failNote(el, 'empty'); return null; }
    const W0 = Math.max(280, el.clientWidth || 520);
    // tall and narrow so the slopes of low-volatility funds are readable
    const { svg, tip, W, H } = chartFrame(el, W0 < 430 ? Math.round(W0 * 1.2) : Math.min(600, Math.round(W0 * 1.15)));
    svg.attr('aria-label', TS_TITLE[metric] + ' for highlighted SIFs and benchmarks');
    const all = series.flatMap((s) => s.vals);
    const x = d3.scaleUtc().domain(d3.extent(all, (p) => p.date));
    const ext = d3.extent(all, (p) => p.v);       // only what is shown: hiding a fund rescales the axis
    const pad = (ext[1] - ext[0]) * 0.06 || 1;
    const y = d3.scaleLinear().domain([ext[0] - pad, ext[1] + pad]).nice();
    const meas = svg.append('g');
    const widths = series.map((s) => meas.append('text').text(s.name).node().getComputedTextLength());
    meas.remove();
    const m = { t: 12, r: Math.min(W0 < 430 ? 120 : 210, (d3.max(widths) || 40) + 14), b: 26, l: 46 };
    x.range([m.l, W - m.r]); y.range([H - m.b, m.t]);
    const nx = Math.max(2, Math.floor((W - m.l - m.r) / 70));
    svg.append('g').attr('class', 'grid').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(10).tickSize(-(W - m.l - m.r)).tickFormat(''));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(nx).tickFormat(d3.utcFormat((x.domain()[1] - x.domain()[0]) / 864e5 > 150 ? '%b %y' : '%d %b')));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(10));
    const ref = metric === 'idx' ? 100 : ['beta60', 'beta20', 'dd', 'ret6m', 'ret12m', 'sharpe6m'].includes(metric) ? 0 : null;
    if (ref !== null && ref >= y.domain()[0] && ref <= y.domain()[1]) svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(ref)).attr('y2', y(ref)).style('stroke', 'var(--cds-chart-reference)');
    const line = d3.line().x((p) => x(p.date)).y((p) => y(p.v));
    for (const s of series) {
      const p = svg.append('path').datum(s.vals).attr('d', line).attr('fill', 'none').style('stroke', tsColor(s));
      if (s.kind === 'bench') p.style('stroke-width', 1.6).style('stroke-dasharray', BENCH_STYLE[s.id]);
      else p.style('stroke-width', 2.4);
    }
    const ends = series.map((s) => ({ s, y: y(s.vals[s.vals.length - 1].v), x: x(s.vals[s.vals.length - 1].date) }));
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    for (let i = ends.length - 2; i >= 0; i--) if (ends[i].y > H - m.b) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - 12);
    for (const e of ends) {
      svg.append('circle').attr('cx', e.x).attr('cy', y(e.s.vals[e.s.vals.length - 1].v)).attr('r', 2.8).style('fill', tsColor(e.s));
      svg.append('text').attr('x', W - m.r + 6).attr('y', e.y).attr('dy', '0.32em').text(e.s.name).style('fill', tsColor(e.s)).style('font-weight', e.s.kind === 'hl' ? 600 : 400);
    }
    const vline = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).style('stroke', 'var(--cds-chart-axis)').style('display', 'none'); // SVG ignores the hidden attribute
    const bis = d3.bisector((p) => p.date).right;
    const fmtV = metric.startsWith('beta') || metric === 'sharpe6m' ? f2 : f1;
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b).style('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [px] = d3.pointer(ev); const dt = x.invert(px);
        vline.attr('x1', px).attr('x2', px).style('display', null);
        const lines = series.map((s) => { const i = bis(s.vals, dt) - 1; return i >= 0 ? [s, s.vals[i].v] : null; }).filter(Boolean).sort((a, b) => b[1] - a[1]);
        tip.attr('hidden', null).html('');
        tip.append('div').attr('class', 'muted').text(fmtDate(dt));
        for (const [s, v] of lines) { const r = tip.append('div').attr('class', 'row'); r.append('span').text(s.name).style('color', tsColor(s)); r.append('span').text(fmtV(v)); }
        const tw = tip.node().offsetWidth; const left = px + 14 + tw > W ? px - tw - 14 : px + 14;
        tip.style('left', Math.max(0, left) + 'px').style('top', m.t + 'px');
      })
      .on('pointerleave', () => { tip.attr('hidden', ''); vline.style('display', 'none'); });
    return { m, W };
  }

  // Period strip: Nifty 50 over the full span; drag to choose dates, drag the box to move it, click outside to reset.
  function drawNav(el, D, dom, geom, onPick) {
    el.replaceChildren();
    const { m, W } = geom; const h = 58, base = h - 18;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${h}`).attr('role', 'img').attr('aria-label', 'Period selector: drag to choose the dates shown');
    const xb = d3.scaleUtc().domain(dom.full).range([m.l, W - m.r]);
    const ref = (D.get('nifty50') || []).filter((r) => r.date >= dom.full[0] && r.date <= dom.full[1]);
    if (ref.length > 1) {
      const yb = d3.scaleLinear().domain(d3.extent(ref, (r) => r.idx)).range([base, 6]);
      svg.append('path').datum(ref).attr('d', d3.area().x((r) => xb(r.date)).y0(base).y1((r) => yb(r.idx))).style('fill', 'var(--cds-chart-grid)').style('stroke', 'var(--cds-chart-muted)');
    }
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${base})`).call(d3.axisBottom(xb).ticks(Math.max(2, Math.floor((W - m.l - m.r) / 70))).tickFormat(d3.utcFormat('%b %y')));
    svg.append('text').attr('x', 2).attr('y', base / 2).attr('dy', '0.32em').text('Period');
    const brush = d3.brushX().extent([[m.l, 2], [W - m.r, base]]).on('brush end', (ev) => {
      if (!ev.sourceEvent) return;
      if (!ev.selection) { if (ev.type === 'end') onPick(null); return; }
      const [a, b] = ev.selection.map((v) => d3.utcDay.round(xb.invert(v)));
      if (b - a < 5 * 864e5) return;
      onPick([a, b]);
    });
    // no box when the whole span is shown, so a drag anywhere starts a new selection
    const whole = dom.a <= dom.full[0] && dom.b >= dom.full[1];
    svg.append('g').attr('class', 'sif-brush').call(brush).call(brush.move, whole ? null : [xb(dom.a), xb(dom.b)]);
  }

  // Stats over the chosen period, for every line on the chart.
  function drawStats(series, dom) {
    const tb = document.getElementById('ts-stats'), cap = document.getElementById('ts-period');
    if (cap) cap.textContent = fmtDate(dom.a) + ' to ' + fmtDate(dom.b) + ' (' + Math.round((dom.b - dom.a) / 864e5) + ' days)';
    if (!tb) return;
    const D = daily(); const nr = new Map();
    const nf = (D.get('nifty50') || []);
    for (let i = 1; i < nf.length; i++) nr.set(nf[i].ds, nf[i].idx / nf[i - 1].idx - 1);
    tb.replaceChildren();
    const rowsS = series.map((s) => {
      const a = s.raw, rets = [];
      for (let i = 1; i < a.length; i++) rets.push([a[i].ds, a[i].idx / a[i - 1].idx - 1]);
      const ret = (a[a.length - 1].idx / a[0].idx - 1) * 100;
      const vol = rets.length > 4 ? d3.deviation(rets, (r) => r[1]) * Math.sqrt(252) * 100 : NaN;
      let peak = -Infinity, mdd = 0;
      for (const r of a) { peak = Math.max(peak, r.idx); mdd = Math.min(mdd, (r.idx / peak - 1) * 100); }
      const pr = rets.filter((r) => nr.has(r[0]));
      let beta = NaN;
      if (pr.length >= 10 && s.id !== 'nifty50') {
        const mx = d3.mean(pr, (r) => nr.get(r[0])), my = d3.mean(pr, (r) => r[1]);
        let cv = 0, vv = 0; for (const r of pr) { const dx = nr.get(r[0]) - mx; cv += dx * (r[1] - my); vv += dx * dx; }
        beta = vv ? cv / vv : NaN;
      } else if (s.id === 'nifty50') beta = 1;
      const days = Math.max((a[a.length - 1].date - a[0].date) / 864e5, 1);
      const ann = (Math.pow(1 + ret / 100, 365 / days) - 1) * 100;
      const sh = NO_SHARPE.has(s.id) || !Number.isFinite(vol) || vol <= 0 ? NaN : (ann / 100 - 0.05) / (vol / 100);
      return { s, ret, ann, vol, sh, mdd, beta, from: a[0].date, short: days < 365 };
    }).sort((p, q) => q.ann - p.ann);
    for (const r of rowsS) {
      const tr = document.createElement('tr'); if (r.s.kind === 'bench') tr.className = 'bench';
      const td0 = document.createElement('td'); const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = tsColor(r.s);
      td0.append(sw, document.createTextNode(r.s.name + (r.from > dom.a ? ' *' : ''))); tr.append(td0);
      for (const [v, f, bad, dag] of [[r.ann, sg1, r.ann < 0, r.short], [r.ret, sg1, r.ret < 0], [r.vol, f1, false], [r.sh, f2, r.sh < 0, r.short], [r.mdd, f1, r.mdd < -2], [r.beta, f2, false]]) {
        const td = document.createElement('td'); td.className = 'n' + (bad && r.s.kind === 'hl' ? ' bad' : ''); td.textContent = fx(v, f) + (dag && Number.isFinite(v) ? '†' : ''); if (dag) td.title = 'Annualised from less than a year: an extrapolation'; tr.append(td);
      }
      tb.append(tr);
    }
  }

  dash.draw('ts', (el) => {
    const F = funds(), D = daily();
    if (!F || !D) { failNote(el, dash.data(!F ? 'funds' : 'daily').status); return; }
    ensureHL(F);
    const metric = S.metric;
    const dom = tsDomain(F, D);
    el.replaceChildren();
    const main = document.createElement('div'); main.className = 'sif-ts-main';
    const nav = document.createElement('div'); nav.className = 'sif-ts-nav';
    el.append(main, nav);
    syncRange(dom);
    const render = (d) => { const ser = tsSeries(F, D, d.a, d.b, metric); const g = drawMain(main, ser, metric); drawStats(tsSeries(F, D, d.a, d.b, 'idx'), d); return g; };
    const geom = render(dom);
    if (!geom) return;
    drawNav(nav, D, dom, geom, (r) => {
      if (!r) { S.range = null; markWin('all'); redraw('ts', 'scatter', 'scnote'); return; }
      S.range = r; markWin(null);
      const d = { full: dom.full, a: r[0], b: r[1] };
      syncRange(d); render(d);
    });
  });

  // ---------- scatter ----------
  const WIN_FIELD = { '1m': 'ret_1m_ann', '3m': 'ret_3m_ann', '6m': 'ret_6m_ann', '1y': 'ret_1y_ann', all: 'ret_inception_ann', common: 'ret_inception_ann' };
  const WIN_NAME = { '1m': '1 month', '3m': '3 months', '6m': '6 months', '1y': '1 year', all: 'since launch', common: 'since launch' };
  dash.draw('scnote', (el) => { el.textContent = 'CAGR over ' + WIN_NAME[S.win] + (['3m', '6m'].includes(S.win) ? ' (annualised from under a year: extrapolated)' : ''); });
  dash.draw('scatter', (el) => {
    const F = funds(); if (!F) { failNote(el, dash.data('funds').status); return; }
    ensureHL(F);
    const k = WIN_FIELD[S.win];
    const pts = F.filter((f) => inCat(f) || (f.kind === 'Benchmark' && S.bench.has(f.id)))
      .map((f) => ({ f, x: Number.isFinite(f.vol_1y) ? f.vol_1y : f.vol_life, y: f[k] }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!pts.length) { failNote(el, 'empty'); return; }
    const { svg, tip, W, H } = chartFrame(el, el.clientWidth < 560 ? 260 : 300);
    svg.attr('aria-label', 'Return over ' + WIN_NAME[S.win] + ' against volatility');
    const m = { t: 14, r: 16, b: 34, l: 40 };
    const x = d3.scaleLinear().domain([0, d3.max(pts, (p) => p.x) * 1.08]).nice().range([m.l, W - m.r]);
    const ye = d3.extent(pts, (p) => p.y); const yp = (ye[1] - ye[0]) * 0.1 || 1;
    const y = d3.scaleLinear().domain([Math.min(0, ye[0] - yp), ye[1] + yp]).nice().range([H - m.b, m.t]);
    svg.append('g').attr('class', 'grid').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(''));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(6));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5));
    svg.append('text').attr('x', W - m.r).attr('y', H - 4).attr('text-anchor', 'end').text('Volatility, % a year');
    svg.append('text').attr('x', m.l + 4).attr('y', m.t + 2).attr('dy', '0.7em').text('Return, %');
    if (y.domain()[0] < 0) svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0)).style('stroke', 'var(--cds-chart-reference)');
    const placed = [];
    for (const p of pts.sort((a, b) => (S.hl.includes(a.f.id) ? 1 : 0) - (S.hl.includes(b.f.id) ? 1 : 0))) {
      const hl = S.hl.includes(p.f.id), bench = p.f.kind === 'Benchmark';
      const cx = x(p.x), cy = y(p.y);
      const c = svg.append('circle').attr('cx', cx).attr('cy', cy).attr('r', hl ? 5.5 : 4);
      if (bench) c.style('fill', 'none').style('stroke', 'var(--color-fg-muted)').style('stroke-width', 1.5);
      else c.style('fill', hl ? colorOf(p.f.id) : 'var(--cds-chart-muted)');
      let ly = cy - 8; while (placed.some((q) => Math.abs(q.y - ly) < 11 && Math.abs(q.x - cx) < 70)) ly -= 11;
      placed.push({ x: cx, y: ly });
      const t = svg.append('text').attr('x', cx + (cx > W - 90 ? -6 : 6)).attr('y', ly).attr('text-anchor', cx > W - 90 ? 'end' : 'start').text(label(p.f));
      if (hl) t.style('fill', colorOf(p.f.id));
      c.on('pointerenter', () => {
        tip.attr('hidden', null).html('');
        tip.append('div').text(label(p.f)).style('font-weight', 600);
        const r1 = tip.append('div').attr('class', 'row'); r1.append('span').text('CAGR' + (Number.isFinite(p.f.span_days) && p.f.span_days < 365 && !['1m'].includes(S.win) ? ' (extrapolated)' : '')); r1.append('span').text(sg1(p.y) + '%');
        const r2 = tip.append('div').attr('class', 'row'); r2.append('span').text('Volatility'); r2.append('span').text(f1(p.x) + '%');
        const r3 = tip.append('div').attr('class', 'row'); r3.append('span').text('Beta 60d'); r3.append('span').text(fx(p.f.beta_60d, f2));
        const tw = tip.node().offsetWidth; tip.style('left', (cx + 12 + tw > W ? cx - tw - 12 : cx + 12) + 'px').style('top', Math.max(0, cy - 30) + 'px');
      }).on('pointerleave', () => tip.attr('hidden', ''));
    }
  });

  // ---------- AUM (30 Sep 2026 disclosures, every fund in the selected family) ----------
  dash.draw('aumtitle', (el) => { el.textContent = 'Assets under management, latest: ' + famLabel(); });
  dash.draw('aum', (el) => {
    const R = fams(); if (!R) { failNote(el, dash.data('families').status); return; }
    const pts = R.filter((r) => (S.cat === 'all' || r.category === S.cat) && Number.isFinite(r.aum) && r.aum > 0)
      .map((r) => ({ r, v: r.aum, lab: r.family + ' (' + r.amc + ')' + (S.cat === 'all' ? ' · ' + (CAT_SHORT[r.category] || '') : '') })).sort((p, q) => q.v - p.v);
    if (!pts.length) { el.replaceChildren(); const p = document.createElement('p'); p.className = 'note'; p.textContent = 'No AUM disclosed yet in this family.'; el.append(p); return; }
    const { svg, tip, W } = chartFrame(el, 20 * pts.length + 12);
    svg.attr('aria-label', 'AUM on 30 Sep 2026 by fund, ' + famLabel());
    const meas = svg.append('g'); const lw = d3.max(pts, (p) => meas.append('text').text(p.lab).node().getComputedTextLength()) + 10; meas.remove();
    const m = { t: 4, r: 80, b: 6, l: lw };
    const x = d3.scaleLinear().domain([0, d3.max(pts, (p) => p.v)]).range([m.l, W - m.r]);
    pts.forEach((p, i) => {
      const yy = m.t + i * 20;
      svg.append('text').attr('x', m.l - 8).attr('y', yy + 8).attr('dy', '0.32em').attr('text-anchor', 'end').text(p.lab);
      svg.append('rect').attr('x', m.l).attr('y', yy + 2).attr('height', 13).attr('width', Math.max(1, x(p.v) - m.l)).attr('rx', 2).style('fill', CATC[p.r.category] || col(0));
      svg.append('text').attr('x', x(p.v) + 6).attr('y', yy + 8).attr('dy', '0.32em').text('₹' + f0(p.v) + (p.r.moved ? ' *' : ''));
    });
  });
  dash.draw('aumnote', (el) => {
    const R = fams(); if (!R) { el.textContent = '—'; return; }
    const sel = R.filter((r) => S.cat === 'all' || r.category === S.cat);
    const moved = sel.filter((r) => r.moved).length;
    el.textContent = '₹ crore. Latest figure Groww reports for each fund, read ' + readDate() + '; ' + moved + ' of these have moved past the fund\'s 30 Sep 2026 portfolio (marked *), and Groww does not state the month-end. Total ₹' + f0(d3.sum(sel, (r) => r.aum || 0)) + ' cr across ' + sel.filter((r) => r.aum > 0).length + ' funds (₹' + f0(d3.sum(sel, (r) => r.aumSep || 0)) + ' cr in their 30 Sep portfolios). Funds launched after September have no figure yet.';
  });

  // ---------- trading-strategy breakdown: every rupee of NAV in one bucket; the buckets add to 100 ----------
  // Equity buckets are built stock by stock from the disclosed stock, futures and options lines.
  const SEGS = [
    ['arb', 'Arbitrage', 'Buys a share and sells its future (same stock). Earns the futures premium, about a money-market rate; no market risk.', '#60a5fa', 'eq'],
    ['cc', 'Covered call', 'Holds the share and sells a call on it. Earns the premium plus gains up to the strike; keeps the full fall.', '#f97316', 'eq'],
    ['cc_put', 'Covered call + put written', 'Holds the share, sells a call and a put on it (covered strangle). More premium; more loss if the share falls.', '#9a3412', 'eq'],
    ['collar', 'Collar', 'Holds the share, sells a call and buys a put on it. Gains capped above, losses capped below.', '#eab308', 'eq'],
    ['prot', 'Protective put', 'Holds the share and buys a put on it. Pays premium to cap the loss.', '#14b8a6', 'eq'],
    ['pheld', 'Share + put written', 'Holds the share and also sells a put on it: more exposure to a fall.', '#be185d', 'eq'],
    ['ow', 'Share + options written, type not disclosed', 'Holds the share and has sold options on it; the source (Groww\'s copy) does not say calls or puts.', '#fdba74', 'eq'],
    ['ipo', 'IPO / new listing', 'Shares first traded in the 12 months before the portfolio date (mostly IPOs, plus demerger listings), not held against a future. Usually unhedgeable: new listings have no futures yet.', '#1e293b', 'eq'],
    ['open', 'Plain long stock', 'Owns the share with nothing against it: the full gain and the full loss. This is what drives beta.', '#dc2626', 'eq'],
    ['optb', 'Options bought, premium', 'Premium paid for options, mostly puts (Nifty or stock). Can be lost in full.', '#0891b2', 'eq'],
    ['reit', 'REITs and InvITs', 'Listed trusts that own offices, roads or power lines and pay out rent or tolls.', '#a855f7', 'fi'],
    ['units', 'Fund units', 'Units of other funds (liquid, debt or equity ETFs).', '#c4b5fd', 'fi'],
    ['gsec', 'G-secs and state loans', 'Government bonds.', '#166534', 'fi'],
    ['corp', 'Corporate bonds', 'Loans to companies, usually one to five years.', '#16a34a', 'fi'],
    ['mm', 'Money market', 'Treasury bills, commercial paper, certificates of deposit: loans of under a year.', '#86efac', 'fi'],
    ['cash', 'Cash, TREPS, margin', 'Overnight lending and margin posted for futures; net of option premium received.', '#94a3b8', 'fi'],
    ['resid', 'Debt and cash, not split', 'Older snapshots only.', '#cbd5e1', 'fi'],
  ];
  const SEGC = Object.fromEntries(SEGS.map((x) => [x[0], x[3]]));
  const SEGN = Object.fromEntries(SEGS.map((x) => [x[0], x[1]]));
  function segVals(r) {
    const n_ = (k) => num(r[k]) || 0;
    if (r.s_plain !== undefined && r.s_plain !== '' && r.source !== 'groww_page') {
      const prem = n_('s_opt_premium');
      return { arb: n_('s_arb'), cc: n_('s_cc'), cc_put: n_('s_cc_put'), collar: n_('s_collar'), prot: n_('s_prot_put'), pheld: n_('s_put_on_held'),
        ow: n_('s_opt_untyped'), ipo: n_('s_ipo'), open: n_('s_plain'), optb: Math.max(prem, 0), reit: n_('f_reit'), units: n_('f_units'), gsec: n_('f_gsec'),
        corp: n_('f_corp'), mm: n_('f_mm'), cash: n_('f_cash') + Math.min(prem, 0), resid: 0 };
    }
    const eq = n_('equity_long'), arb = Math.min(n_('hedged_same_stock'), eq), opt = n_('options_premium');
    return { arb, open: eq - arb, reit: n_('reit_invit'), units: n_('mf_units'), corp: n_('debt'), mm: n_('money_market'),
      optb: Math.max(opt, 0), cash: n_('cash') + n_('irs') + Math.min(opt, 0), resid: r.source === 'groww_page' ? n_('debt_cash_residual') : 0 };
  }
  function overlay(r) {
    const n_ = (k) => num(r[k]) || 0;
    const has = r.ov_long_fut !== undefined && r.ov_long_fut !== '';
    return { longFut: has ? n_('ov_long_fut') : n_('stock_fut_long'), shortFut: has ? n_('ov_short_fut') : n_('naked_stock_short'), idx: n_('index_fut'), net: n_('net_equity'),
      nPut: n_('n_naked_put'), nCall: n_('n_naked_call'), nStr: n_('n_short_strangle'), nU: n_('n_untyped_unheld'),
      idxPB: n_('n_idx_p_bought') + n_('n_idx_u_bought'), idxCB: n_('n_idx_c_bought'), idxW: n_('n_idx_p_written') + n_('n_idx_c_written') + n_('n_idx_u_written'),
      premIdxB: n_('prem_idx_p_bought') + n_('prem_idx_u_bought') + n_('prem_idx_c_bought') };
  }
  dash.draw('conskey', (el) => {
    el.replaceChildren();
    for (const [grp, title] of [['eq', 'Equity, by trading strategy'], ['fi', 'Debt, cash and other income']]) {
      const h = document.createElement('div'); h.className = 'sif-key-h'; h.textContent = title; el.append(h);
      const box = document.createElement('div'); box.className = 'sif-key';
      for (const [k, name, desc, c, g] of SEGS) {
        if (g !== grp || k === 'resid') continue;
        const d = document.createElement('div'); const i = document.createElement('i'); i.style.background = c;
        const b = document.createElement('b'); b.textContent = name; const sp = document.createElement('span'); sp.textContent = desc;
        d.append(i, b, sp); box.append(d);
      }
      el.append(box);
    }
  });
  dash.draw('constitle', (el) => { el.textContent = 'How each fund\'s money is invested: ' + famLabel(); });
  dash.draw('cons', (el) => {
    const L = allocLatest(); if (!L) { failNote(el, dash.data('alloc').status); return; }
    const F = funds() || [];
    const beta = new Map(F.map((f) => [f.fund, f.beta_60d]));
    const list = [...L.values()].filter(allocIn);
    if (!list.length) { el.replaceChildren(); const p = document.createElement('p'); p.className = 'note'; p.textContent = 'No portfolio disclosed yet in this family.'; el.append(p); return; }
    const eqOf = (v) => SEGS.filter((x) => x[4] === 'eq').reduce((t, x) => t + (v[x[0]] || 0), 0);
    list.sort((a, b) => eqOf(segVals(b)) - eqOf(segVals(a)));
    // AUM-weighted family total first
    const wsum = d3.sum(list, (r) => +r.aum_cr || 0);
    const tot = { brand: 'Family total', total: true, asof: d3.max(list, (r) => r.asof), source: '' };
    const tv = {}; const to = { longFut: 0, shortFut: 0, idx: 0, net: 0 };
    for (const r of list) { const w = (+r.aum_cr || 0) / (wsum || 1); const v = segVals(r); for (const k in v) tv[k] = (tv[k] || 0) + w * v[k]; const o = overlay(r); for (const k in to) to[k] += w * o[k]; }
    const rowsAll = (list.length > 1 && wsum > 0 ? [{ r: tot, v: tv, o: to }] : []).concat(list.map((r) => ({ r, v: segVals(r), o: overlay(r) })));
    const RH = 40;
    const { svg, tip, W } = chartFrame(el, RH * rowsAll.length + 34);
    svg.attr('aria-label', 'Trading-strategy breakdown of each fund in ' + famLabel());
    const meas = svg.append('g');
    const lw = d3.max(rowsAll, (x) => meas.append('text').text(x.r.total ? x.r.brand : allocLabel(x.r)).node().getComputedTextLength()) + 14; meas.remove();
    const wide = W > 760;
    const m = { t: 18, r: wide ? 250 : 10, b: 24, l: Math.max(lw, 70) };
    const x = d3.scaleLinear().domain([0, 100]).range([m.l, W - m.r]);
    svg.append('g').attr('class', 'grid').attr('transform', `translate(0,${m.t + RH * rowsAll.length})`).call(d3.axisBottom(x).ticks(10).tickSize(-(RH * rowsAll.length)).tickFormat(''));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${m.t + RH * rowsAll.length + 2})`).call(d3.axisBottom(x).ticks(10).tickFormat((d) => d + '%'));
    if (wide) svg.append('text').attr('x', W - m.r + 12).attr('y', 6).text('Beyond the 100').style('font-weight', 600).style('fill', 'var(--color-fg)');
    rowsAll.forEach(({ r, v, o }, i) => {
      const yy = m.t + i * RH; let acc = 0;
      if (r.total) svg.append('rect').attr('x', 0).attr('y', yy - 6).attr('width', W).attr('height', RH - 2).style('fill', 'var(--cds-chart-grid)');
      svg.append('text').attr('x', m.l - 8).attr('y', yy + 10).attr('dy', '0.32em').attr('text-anchor', 'end').text(r.total ? r.brand : allocLabel(r)).style('fill', 'var(--color-fg)').style('font-weight', 600);
      svg.append('text').attr('x', m.l - 8).attr('y', yy + 25).attr('text-anchor', 'end').text(r.total ? 'AUM-weighted · ₹' + f0(wsum) + ' cr' : (r.aum_cr ? fmtDate(parseDate(r.asof)) + ': ₹' + f0(+r.aum_cr) + ' cr' : aumTxt(r.code))).style('font-size', '10px');
      const b = r.total ? NaN : beta.get(r.fund);
      const show = (ev) => {
        tip.attr('hidden', null).html('');
        tip.append('div').text(r.total ? famLabel() + ', AUM-weighted · ' + list.length + ' funds' : allocLabel(r) + ' · ' + fmtDate(parseDate(r.asof)) + ' · ' + (r.source === 'official' ? 'AMC file' : 'via Groww') + (r.aum_cr ? ' · ₹' + f0(+r.aum_cr) + ' cr' : '')).style('font-weight', 600);
        let t = 0;
        for (const [grp, title] of [['eq', 'Equity'], ['fi', 'Debt, cash, other']]) {
          const g = SEGS.filter((s_) => s_[4] === grp && v[s_[0]] > 0.05); if (!g.length) continue;
          const sub = d3.sum(g, (s_) => v[s_[0]]);
          const hr = tip.append('div').attr('class', 'row').style('margin-top', '4px').style('font-weight', 600); hr.append('span').text(title); hr.append('span').text(f1(sub) + '%');
          for (const [k, nn, , c] of g) { t += v[k]; const row = tip.append('div').attr('class', 'row'); row.append('span').html('<i style="display:inline-block;width:8px;height:8px;border-radius:2px;margin:0 6px 0 8px;background:' + c + '"></i>' + nn); row.append('span').text(f1(v[k]) + '%'); }
        }
        const tr = tip.append('div').attr('class', 'row').style('border-top', '1px solid var(--color-border-line)').style('margin-top', '4px'); tr.append('span').text('Total'); tr.append('span').text(f1(t) + '%');
        tip.append('div').attr('class', 'muted').style('margin-top', '6px').text('Beyond the 100 (futures at full value; options not tied to a held share):');
        const items = [['Long stock futures', sg1(o.longFut) + '%'], ['Naked short stock futures', sg1(o.shortFut) + '%'], ['Index futures', sg1(o.idx) + '%']];
        if (!r.total) items.push(['Naked puts written (stocks not held)', String(o.nPut)], ['Naked calls written (stocks not held)', String(o.nCall)], ['Short strangles on stocks not held', String(o.nStr)], ['Options written on stocks not held, type n/a', String(o.nU)], ['Nifty / index puts bought', String(o.idxPB) + (o.premIdxB ? ' (premium ' + f2(o.premIdxB) + '%)' : '')], ['Index options written', String(o.idxW)]);
        for (const [nn, val] of items) { const row = tip.append('div').attr('class', 'row'); row.append('span').text(nn); row.append('span').text(val); }
        const n1 = tip.append('div').attr('class', 'row').style('margin-top', '4px'); n1.append('span').text('Equity exposure before options (black line)'); n1.append('span').text(f1(o.net) + '%');
        if (!r.total) { const n2 = tip.append('div').attr('class', 'row'); n2.append('span').text('Exposure the NAV shows, 60d beta x100 (diamond)'); n2.append('span').text(Number.isFinite(b) ? f1(b * 100) + '%' : '–'); }
        const [px] = d3.pointer(ev, el); const tw = tip.node().offsetWidth; tip.style('left', Math.max(0, Math.min(px + 12, W - tw - 4)) + 'px').style('top', yy + RH - 4 + 'px');
      };
      for (const [k] of SEGS) {
        const w = Math.max(0, v[k] || 0); if (w <= 0.05) continue;
        const x0 = x(acc), x1 = x(Math.min(100.5, acc + w));
        svg.append('rect').attr('x', x0).attr('y', yy + 1).attr('height', 20).attr('width', Math.max(0.5, x1 - x0 - 0.6)).style('fill', SEGC[k])
          .on('pointerenter', show).on('pointermove', show).on('pointerleave', () => tip.attr('hidden', ''));
        if (x1 - x0 > 26) svg.append('text').attr('x', (x0 + x1) / 2).attr('y', yy + 11).attr('dy', '0.32em').attr('text-anchor', 'middle').text(f0(w)).style('fill', ['open', 'cc', 'cc_put', 'corp', 'gsec', 'optb', 'arb', 'pheld', 'reit', 'ipo'].includes(k) ? '#ffffff' : '#111827').style('font-size', '10.5px').style('pointer-events', 'none');
        acc += w;
      }
      const ne = Math.max(-5, Math.min(100, o.net));
      svg.append('line').attr('x1', x(ne)).attr('x2', x(ne)).attr('y1', yy - 2).attr('y2', yy + 24).style('stroke', '#111827').style('stroke-width', 2.5).style('pointer-events', 'none');
      if (Number.isFinite(b)) svg.append('path').attr('d', d3.symbol(d3.symbolDiamond, 46)()).attr('transform', `translate(${x(Math.max(-5, Math.min(100, b * 100)))},${yy + 29})`).style('fill', '#ffffff').style('stroke', '#111827').style('stroke-width', 1.5);
      if (wide) {
        const parts = [];
        if (o.longFut > 0.05) parts.push('long fut +' + f1(o.longFut));
        if (o.shortFut < -0.05) parts.push('short fut ' + f1(o.shortFut));
        if (Math.abs(o.idx) > 0.05) parts.push('index ' + sg1(o.idx));
        const opts = r.total ? [] : [o.nPut ? o.nPut + ' naked puts' : null, o.nCall ? o.nCall + ' naked calls' : null, o.nStr ? o.nStr + ' strangles' : null, o.nU ? o.nU + ' opts on unheld' : null, o.idxPB ? o.idxPB + ' Nifty puts' : null].filter(Boolean);
        svg.append('text').attr('x', W - m.r + 12).attr('y', yy + 8).attr('dy', '0.32em').text(parts.join(', ') || 'no futures').style('font-size', '10px');
        if (opts.length) svg.append('text').attr('x', W - m.r + 12).attr('y', yy + 22).attr('dy', '0.32em').text(opts.join(', ')).style('font-size', '10px');
      }
    });
  });

  // the same breakdown as a table with named columns (readable without colours, copies cleanly)
  dash.draw('consnum', (el) => {
    const L = allocLatest(); el.replaceChildren(); if (!L) return;
    const list = [...L.values()].filter(allocIn);
    if (!list.length) return;
    const vals = list.map((r) => ({ r, v: segVals(r), o: overlay(r) }));
    const cols = SEGS.filter(([k]) => vals.some((x) => (x.v[k] || 0) > 0.05));
    const eqSum = (v) => SEGS.filter((s_) => s_[4] === 'eq').reduce((t_, s_) => t_ + (v[s_[0]] || 0), 0);
    vals.sort((a, b) => eqSum(b.v) - eqSum(a.v));
    const tab = document.createElement('table');
    const hr = document.createElement('tr');
    for (const h of ['Fund', 'Portfolio date', 'AUM then, ₹ cr', ...cols.map((c) => c[1] + ', %'), 'Total, %', 'Beyond the 100: futures, % of NAV', 'Options on stocks not held / Nifty puts']) { const th = document.createElement('th'); th.textContent = h; hr.append(th); }
    const thead = document.createElement('thead'); thead.append(hr); tab.append(thead);
    const tb = document.createElement('tbody');
    for (const { r, v, o } of vals) {
      const tr = document.createElement('tr');
      const fut = [o.longFut > 0.05 ? 'long ' + sg1(o.longFut) : '', o.shortFut < -0.05 ? 'short ' + f1(o.shortFut) : '', Math.abs(o.idx) > 0.05 ? 'index ' + sg1(o.idx) : ''].filter(Boolean).join(', ') || 'none';
      const opt = [o.nPut ? o.nPut + ' naked puts' : '', o.nCall ? o.nCall + ' naked calls' : '', o.nStr ? o.nStr + ' strangles' : '', o.nU ? o.nU + ' options (type n/a)' : '', o.idxPB ? o.idxPB + ' Nifty puts' : ''].filter(Boolean).join(', ') || 'none';
      const cells = [allocLabel(r), fmtDate(parseDate(r.asof)), r.aum_cr ? f0(+r.aum_cr) : '–', ...cols.map(([k]) => ((v[k] || 0) > 0.05 ? f1(v[k]) : '–')), f1(d3.sum(Object.values(v))), fut, opt];
      cells.forEach((c, i) => { const td = document.createElement('td'); td.textContent = c; if (i >= 2 && i < 3 + cols.length + 1) td.className = 'n'; else if (i > 0) td.className = 'l'; tr.append(td); });
      tb.append(tr);
    }
    tab.append(tb); el.append(tab);
  });
  dash.draw('constable', (tb) => {
    const c = dash.data('construction');
    tb.replaceChildren(); if (c.status !== 'ok' || !Array.isArray(c.data)) return;
    for (const r of c.data.filter((x) => S.cat === 'all' || x.category === S.cat)) {
      const tr = document.createElement('tr'); tr.setAttribute('data-key', r.fund);
      const cells = [withHouse(r.brand, r.code, r.category) + (aumTxt(r.code) ? ' · ' + aumTxt(r.code) : ''), r.asof ? fmtDate(parseDate(r.asof)) : '–', null, fx(r.net_equity, f1), fx(r.implied, f1), fx(r.stock_fut_short, f1), fx(r.index_fut, f1), r.options, String(r.n_stocks), fx(r.top10_share, f1), fx(r.eff_n, f1), r.long_lms, r.net_lms];
      cells.forEach((t, i) => {
        const td = document.createElement('td');
        if (i === 2) { td.className = 'l'; const p = document.createElement('span'); p.className = 'pill ' + r.source; p.textContent = r.source === 'official' ? 'AMC file' : 'via Groww'; td.append(p); }
        else { td.textContent = t; if (i > 0) td.className = 'n'; if (i === 1) td.className = 'l'; }
        tr.append(td);
      });
      tb.append(tr);
    }
  });


  // ---------- what drove recent returns ----------
  const ATTR = [
    ['carry', 'Carry: debt, cash, arbitrage (est. 6.5% a year)', '#86efac'],
    ['top', 'Largest single stock', '#f97316'],
    ['ipo', 'IPO / new listings', '#1e293b'],
    ['other', 'All other stocks', '#dc2626'],
    ['fut', 'Futures and shorts', '#60a5fa'],
    ['rem', 'Options and trading since the disclosure', '#a8a29e'],
  ];
  const FLAG_C = { 'Single-stock driven': '#c2410c', 'IPO-driven': '#1e293b', 'Event-driven': '#7c3aed', 'Market-driven': '#2563eb', 'Options or trading dominant': '#57534e' };
  dash.draw('attrkey', (el) => {
    el.replaceChildren();
    for (const [, n, c] of ATTR) { const s1 = document.createElement('span'); const i = document.createElement('i'); i.style.background = c; s1.append(i, document.createTextNode(n)); el.append(s1); }
    const s2 = document.createElement('span'); s2.innerHTML = '<i style="background:#111827;width:3px"></i>Actual NAV return'; el.append(s2);
  });
  dash.draw('attr', (el) => {
    const A = rows('attrib'), T = rows('attrib_top'); el.replaceChildren();
    if (!A) { failNote(el, dash.data('attrib').status); return; }
    const list = A.filter((r) => S.cat === 'all' || r.category === S.cat).map((r) => {
      const n_ = (k) => num(r[k]) || 0;
      return { r, v: { carry: n_('carry'), top: n_('top_c'), ipo: n_('ipo_c'), other: n_('other'), fut: n_('futures'), rem: n_('remainder') }, nav: n_('r_nav') };
    }).sort((a, b) => b.nav - a.nav);
    if (!list.length) { const p = document.createElement('p'); p.className = 'note'; p.textContent = 'No disclosed portfolio in this family yet.'; el.append(p); return; }
    let lo = 0, hi = 0;
    for (const x of list) { const pos = d3.sum(Object.values(x.v).filter((v) => v > 0)), neg = d3.sum(Object.values(x.v).filter((v) => v < 0)); lo = Math.min(lo, neg, x.nav); hi = Math.max(hi, pos, x.nav); }
    const W = Math.max(280, el.clientWidth || 800);
    const x = d3.scaleLinear().domain([lo * 1.05, hi * 1.05]).range([8, W - 8]);
    for (const { r, v, nav } of list) {
      const row = document.createElement('div'); row.className = 'sif-attr';
      const head = document.createElement('div'); head.className = 'sif-attr-h';
      const nm = document.createElement('b'); nm.textContent = withHouse(r.brand, r.code, r.category) + (aumTxt(r.code) ? ' · ' + aumTxt(r.code) : ''); head.append(nm);
      const ret = document.createElement('span'); ret.className = 'num'; ret.textContent = sg1(nav) + '% from ' + fmtDate(parseDate(r.asof)) + ' to ' + fmtDate(parseDate(r.to)) + (r.r_nifty !== '' ? ' (Nifty ' + sg1(num(r.r_nifty)) + '%)' : ''); head.append(ret);
      for (const f of (r.flags || '').split(';').map((s) => s.trim()).filter(Boolean)) {
        const pill = document.createElement('span'); pill.className = 'pill flag'; pill.textContent = f; pill.style.borderColor = pill.style.color = FLAG_C[f.replace(/ \(.*\)$/, '')] || '#57534e'; head.append(pill);
      }
      row.append(head);
      const svg = d3.select(row).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} 30`).attr('role', 'img').attr('aria-label', 'Return contributions for ' + r.brand);
      svg.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', 0).attr('y2', 30).style('stroke', 'var(--cds-chart-reference)');
      let pos = 0, neg = 0;
      for (const [k, n, c] of ATTR) {
        const val = v[k]; if (!val || Math.abs(val) < 0.005) continue;
        const a0 = val > 0 ? pos : neg + val, a1 = val > 0 ? pos + val : neg;
        svg.append('rect').attr('x', x(a0)).attr('y', 6).attr('height', 16).attr('width', Math.max(1, x(a1) - x(a0) - 0.5)).style('fill', c).append('title').text(n + ': ' + sg1(val) + ' pts' + (k === 'top' ? ' (' + r.top_name + ')' : ''));
        if (val > 0) pos += val; else neg += val;
      }
      svg.append('rect').attr('x', x(nav) - 1.5).attr('y', 1).attr('width', 3).attr('height', 26).style('fill', '#111827').append('title').text('Actual NAV return ' + sg1(nav) + '%');
      const det = document.createElement('p'); det.className = 'note';
      const parts = [];
      if (r.top_name) parts.push('Largest: ' + r.top_name + (String(r.top_ipo) === 'True' ? ' (IPO)' : '') + ' ' + sg1(num(r.top_c)) + ' pts (' + f1(num(r.top_w)) + '% of NAV, stock ' + sg1(num(r.top_ret)) + '%)');
      parts.push('IPO / new listings ' + sg1(num(r.ipo_total)) + ' pts');
      parts.push('options and trading ' + sg1(num(r.remainder)) + ' pts');
      if (num(r.unpriced_w) > 0.5) parts.push(f1(num(r.unpriced_w)) + '% of NAV unpriced');
      if (r.market !== '') parts.push('beta × Nifty would give ' + sg1(num(r.market)) + '%');
      let ev = []; try { ev = JSON.parse(r.events || '[]'); } catch (e) {}
      det.textContent = parts.join(' · ') + '.' + (ev.length ? ' Event days, last 3 months (3M return ' + sg1(num(r.r_91)) + '%): ' + ev.map((e) => fmtDate(parseDate(e.date)) + ' ' + sg1(e.ret) + '%' + (e.listing ? ' (listing day of ' + e.listing + ')' : '')).join(', ') + '.' : '');
      row.append(det);
      if (T) {
        const tops = T.filter((t) => t.fund === r.fund).slice(0, 5);
        if (tops.length) { const p = document.createElement('p'); p.className = 'note muted'; p.textContent = 'Top contributors: ' + tops.map((t) => t.name + (String(t.ipo) === 'True' ? ' (IPO)' : '') + ' ' + sg1(num(t.contrib)) ).join(', ') + ' pts.'; row.append(p); }
      }
      el.append(row);
    }
  });

  // ---------- deep dive ----------
  function fundRows() { const d = rows('alloc'); return d ? d.filter((r) => r.fund === S.fund).sort((a, b) => (a.asof < b.asof ? -1 : 1)) : null; }
  dash.draw('fundsel', (sel) => {
    const d = rows('alloc'); if (!d) { sel.replaceChildren(); return; }
    const dd = d.filter(allocIn);
    const cnt = d3.rollup(dd, (v) => v.length, (r) => r.fund);
    const names = d3.rollup(dd, (v) => allocLabel(v[0]) + (aumTxt(v[0].code) ? ' · ' + aumTxt(v[0].code) : ''), (r) => r.fund);
    if (!cnt.size) { sel.replaceChildren(new Option('No disclosure in this family yet', '')); S.fund = null; return; }
    if (!S.fund || !cnt.has(S.fund)) S.fund = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
    sel.replaceChildren(...[...names.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([k, n]) => new Option(n + (cnt.get(k) > 1 ? ' (' + cnt.get(k) + ' disclosures)' : ''), k)));
    sel.value = S.fund;
    sel.onchange = () => { S.fund = sel.value; S.period = null; redraw('ddtiles', 'hist', 'histnote', 'periodsel', 'trades', 'hold', 'holdnote'); };
  });
  dash.draw('ddtiles', (el) => {
    const R = fundRows(), F = funds(); el.replaceChildren(); if (!R || !R.length || !F) return;
    const r = R[R.length - 1]; const f = F.find((x) => x.id === r.code);
    const where = 'fund=' + r.fund + '&asof=' + r.asof;
    const tile = (lab, val, src, field, w) => {
      const d = document.createElement('div'); d.className = 'tile';
      const s = document.createElement('span'); s.textContent = lab;
      const b = document.createElement('b'); b.textContent = val; if (src) { b.setAttribute('data-source', src); b.setAttribute('data-field', field); b.setAttribute('data-where', w); }
      d.append(s, b); el.append(d);
    };
    tile('AUM, ₹ cr', r.aum_cr ? f0(+r.aum_cr) : 'not in file', r.aum_cr ? 'alloc' : null, 'aum_cr', where);
    tile('Stocks held', String(+r.n_stocks), 'alloc', 'n_stocks', where);
    tile('Top 10, % of stock book', f1(+r.top10_share), 'alloc', 'top10_share', where);
    tile('Stocks held as arbitrage, % of stock book', f1(+r.hedged_share) + '%', 'alloc', 'hedged_share', where);
    tile('Equity exposure before options', f1(+r.net_equity) + '%', 'alloc', 'net_equity', where);
    if (f) tile('Beta 60d (NAV)', fx(f.beta_60d, f2), 'funds', 'beta_60d', 'id=' + f.id);
  });
  dash.draw('hist', (el) => {
    const R = fundRows(); if (!R) { failNote(el, dash.data('alloc').status); return; }
    const { svg, tip, W, H } = chartFrame(el, el.clientWidth < 560 ? 230 : 260);
    svg.attr('aria-label', 'Asset mix by disclosure date for the selected fund');
    const m = { t: 22, r: 12, b: 26, l: 40 };
    const x = d3.scaleBand().domain(R.map((r) => r.asof)).range([m.l, W - m.r]).padding(0.3);
    const y = d3.scaleLinear().domain([0, 100]).range([H - m.b, m.t]);
    svg.append('g').attr('class', 'grid').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(''));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((d) => fmtMon(parseDate(d))));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat((d) => d + '%'));
    for (const r of R) {
      const v = segVals(r); let acc = 0; const bx = x(r.asof), bw = x.bandwidth();
      for (const [k] of SEGS) { const w = Math.max(0, v[k]); if (w <= 0.05) continue; svg.append('rect').attr('x', bx).attr('width', bw).attr('y', y(Math.min(100, acc + w))).attr('height', Math.max(0.5, y(acc) - y(Math.min(100, acc + w)))).style('fill', SEGC[k] || 'var(--cds-chart-muted)'); acc += w; }
      if (r.aum_cr) svg.append('text').attr('x', bx + bw / 2).attr('y', m.t - 6).attr('text-anchor', 'middle').text('₹' + f0(+r.aum_cr));
      svg.append('rect').attr('x', bx).attr('width', bw).attr('y', m.t).attr('height', H - m.t - m.b).style('fill', 'transparent')
        .on('pointerenter', () => {
          tip.attr('hidden', null).html('');
          tip.append('div').text(fmtDate(parseDate(r.asof)) + (r.aum_cr ? ' · ₹' + f0(+r.aum_cr) + ' cr' : '')).style('font-weight', 600);
          for (const [kk, nn] of SEGS) if (v[kk] > 0.05) { const row = tip.append('div').attr('class', 'row'); row.append('span').text(nn); row.append('span').text(f1(v[kk]) + '%'); }
          const row = tip.append('div').attr('class', 'row'); row.append('span').text('Equity exposure before options'); row.append('span').text(f1(+r.net_equity) + '%');
          const tw = tip.node().offsetWidth; tip.style('left', Math.min(bx + bw + 6, W - tw - 4) + 'px').style('top', m.t + 'px');
        }).on('pointerleave', () => tip.attr('hidden', ''));
    }
  });
  dash.draw('histnote', (el) => {
    const R = fundRows(); if (!R) { el.textContent = '—'; return; }
    el.textContent = R.length > 1
      ? R.length + ' disclosures from ' + fmtDate(parseDate(R[0].asof)) + ' to ' + fmtDate(parseDate(R[R.length - 1].asof)) + '. AUM above each bar where the file states net assets.'
      : 'One disclosure held so far (' + (R[0] ? fmtDate(parseDate(R[0].asof)) : '–') + '). History builds as each new portfolio file is added.';
  });
  function tradeRows() { const d = rows('trades'); return d ? d.filter((r) => r.fund === S.fund) : null; }
  dash.draw('periodsel', (sel) => {
    const T = tradeRows(); if (!T) { sel.replaceChildren(); return; }
    const per = [...new Set(T.map((r) => r.from_date + '|' + r.to_date))].sort().reverse();
    if (!per.includes(S.period)) S.period = per[0] || null;
    sel.replaceChildren(...(per.length ? per.map((p) => { const [a, b] = p.split('|'); return new Option(fmtMon(parseDate(a)) + ' to ' + fmtMon(parseDate(b)), p); }) : [new Option('No official file pairs yet', '')]));
    sel.disabled = !per.length;
    sel.value = S.period || '';
    sel.onchange = () => { S.period = sel.value; redraw('trades'); };
  });
  dash.draw('trades', (tb) => {
    const T = tradeRows(); tb.replaceChildren(); if (!T || !S.period) return;
    const [a, b] = S.period.split('|');
    const list = T.filter((r) => r.from_date === a && r.to_date === b).sort((p, q) => Math.abs(+q.trade_value_cr) - Math.abs(+p.trade_value_cr)).slice(0, 40);
    for (const r of list) {
      const tr = document.createElement('tr');
      const cells = [r.name, r.leg, r.status, r.band, fq(+r.qty_from), fq(+r.qty_to), f2(+r.pct_from), f2(+r.pct_to), d3.format('+,.2f')(+r.trade_value_cr)];
      cells.forEach((t, i) => { const td = document.createElement('td'); td.textContent = t; td.className = i >= 4 ? 'n' : (i ? 'l' : ''); if (i === 2) td.classList.add(r.status === 'new' || r.status === 'added' ? 'good' : 'bad'); tr.append(td); });
      tb.append(tr);
    }
  });
  const KIND_GROUP = { EQ: ['EQ'], FUT: ['FUT', 'IDXFUT'], OPT: ['OPT', 'IDXOPT'], DEBT: ['DEBT', 'GSEC', 'MM', 'CASH', 'IRS'], REIT: ['REIT', 'MF'] };
  const KIND_NAME = { EQ: 'Stock', FUT: 'Stock future', IDXFUT: 'Index future', OPT: 'Stock option', IDXOPT: 'Index option', DEBT: 'Bond', GSEC: 'G-sec / SDL', MM: 'Money market', CASH: 'Cash / TREPS', IRS: 'Rate swap', REIT: 'REIT / InvIT', MF: 'Fund units', OTHER: 'Other' };
  function holdRows() {
    const d = rows('holdings'); if (!d) return null;
    return d.filter((r) => r.fund === S.fund && (S.kind === 'all' || KIND_GROUP[S.kind].includes(r.kind)));
  }
  dash.draw('hold', (tb) => {
    const H = holdRows(); tb.replaceChildren(); if (!H) return;
    const list = H.slice().sort((a, b) => Math.abs(+b.pct) - Math.abs(+a.pct)).slice(0, 60);
    for (const r of list) {
      const tr = document.createElement('tr');
      const kind = KIND_NAME[r.kind] + (r.opt ? (r.opt === 'C' ? ' (call)' : ' (put)') : '');
      const cells = [r.name, kind, r.band || '', r.industry || '', f2(+r.pct), r.qty ? fq(+r.qty) : '–', r.mv_lakh ? d3.format(',.2f')(+r.mv_lakh / 100) : '–'];
      cells.forEach((t, i) => { const td = document.createElement('td'); td.textContent = t; td.className = i >= 4 ? 'n' : (i ? 'l' : ''); if (i === 4 && +r.pct < 0) td.classList.add('bad'); tr.append(td); });
      if (String(r.ipo) === 'True' || r.ipo === true) {   // flag IPO / new listings next to the name
        const pill = document.createElement('span'); pill.className = 'pill ipo'; pill.textContent = 'IPO · listed ' + fmtDate(parseDate(r.listed));
        pill.title = 'First traded ' + r.listed + ', within 12 months of the portfolio date (Yahoo Finance first trading day)';
        tr.children[0].append(' ', pill);
      }
      tb.append(tr);
    }
  });
  dash.draw('holdnote', (el) => {
    const d = rows('holdings'); if (!d) { el.textContent = '—'; return; }
    const all = d.filter((r) => r.fund === S.fund), H = holdRows() || [];
    if (!all.length) { el.textContent = 'No disclosure held for this fund yet.'; return; }
    el.textContent = 'Showing ' + Math.min(60, H.length) + ' of ' + H.length + ' lines, largest first, as of ' + fmtDate(parseDate(all[0].asof)) + ' (' + (all[0].source === 'official' ? 'AMC portfolio file' : 'AMC disclosure via Groww: every line with value and % of NAV, no quantities') + '). Negative % = short position or written option.';
  });

  // ---------- sources ----------
  dash.draw('src', (tb) => {
    const d = rows('sources'); tb.replaceChildren(); if (!d) return;
    for (const r of d) {
      const tr = document.createElement('tr'); tr.setAttribute('data-key', r.fund);
      const cells = [withHouse(r.brand, r.amfi_code, null), r.amfi_code, r.nav_from, r.nav_to, r.nav_groww_check || '–', r.holdings_source, r.holdings_asof || '–', (r.official_months || '').split(';').filter(Boolean).length + ' file(s)'];
      cells.forEach((t, i) => { const td = document.createElement('td'); td.textContent = t; if (i) td.className = 'l'; tr.append(td); });
      const td = document.createElement('td'); td.className = 'l';
      if (r.disclosure_page) { const a = document.createElement('a'); a.href = r.disclosure_page; a.target = '_blank'; a.rel = 'noopener'; a.textContent = new URL(r.disclosure_page).hostname.replace('www.', ''); td.append(a); } else td.textContent = 'not yet listed';
      tr.append(td); tb.append(tr);
    }
  });
  // ---------- SIF families: every strategy, its family, SEBI type, official facts, 30 Sep AUM ----------
  dash.draw('famasof', (el) => {
    const R = fams(); if (!R) { el.textContent = '—'; return; }
    const f = R.find((r) => r.amfi_fetched)?.amfi_fetched;
    const moved = R.filter((r) => r.moved).length;
    el.textContent = 'AUM: the latest figure Groww reports for each fund, read ' + readDate() + '; ' + moved + ' funds have moved past their 30 Sep 2026 portfolio, and Groww does not state the month-end. Fund facts from AMFI summary documents' + (f ? ', fetched ' + fmtDate(parseDate(f)) : '') + '. Rules: SEBI Master Circular, 20 Mar 2026.';
  });
  dash.draw('famtiles', (el) => {
    const R = fams(); if (!R) { el.textContent = '—'; return; }
    const live = new Set(R.map((r) => r.category));
    const t = [['Families (SEBI types) with a fund', live.size + ' of ' + CATS.length], ['SIF houses', String(new Set(R.map((r) => r.family)).size)], ['Funds with a NAV', String(R.length)],
      ['AUM, latest reported (Groww, read ' + readDate() + ')', fcr(d3.sum(R, (r) => r.aum || 0))], ['AUM in 30 Sep 2026 portfolios', fcr(d3.sum(R, (r) => r.aumSep || 0))]];
    el.replaceChildren();
    for (const [k, v] of t) { const d = document.createElement('div'); d.className = 'tile'; const s1 = document.createElement('span'); s1.textContent = k; const b = document.createElement('b'); b.textContent = v; d.append(s1, b); el.append(d); }
  });
  dash.draw('famlegend', (el) => { el.replaceChildren(); });
  // one bar per family, split into its funds (largest first), each fund labelled by its SIF house
  dash.draw('famchart', (el) => {
    const R = fams(); if (!R) { failNote(el, dash.data('families').status); return; }
    const G = CATS.map((c) => ({ c, rs: R.filter((r) => r.category === c.key).sort((a, b) => (b.aum || 0) - (a.aum || 0)) })).map((g) => ({ ...g, aum: d3.sum(g.rs, (r) => r.aum || 0) }));
    const RH = 30;
    const { svg, tip, W } = chartFrame(el, RH * G.length + 28);
    svg.attr('aria-label', 'AUM by family, split by fund');
    const meas = svg.append('g'); const lw = d3.max(G, (g) => meas.append('text').text(g.c.key).node().getComputedTextLength()) + 14; meas.remove();
    const m = { t: 4, r: 210, b: 22, l: lw };
    const x = d3.scaleLinear().domain([0, d3.max(G, (g) => g.aum) || 1]).nice().range([m.l, W - m.r]);
    svg.append('g').attr('class', 'grid').attr('transform', `translate(0,${m.t + RH * G.length})`).call(d3.axisBottom(x).ticks(6).tickSize(-(RH * G.length)).tickFormat(''));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${m.t + RH * G.length + 2})`).call(d3.axisBottom(x).ticks(6).tickFormat((d) => '₹' + d3.format(',')(d)));
    G.forEach((g, i) => {
      const yy = m.t + i * RH; let acc = 0;
      svg.append('text').attr('x', m.l - 8).attr('y', yy + 11).attr('dy', '0.32em').attr('text-anchor', 'end').text(g.c.key).style('fill', 'var(--color-fg)').style('font-weight', S.cat === g.c.key ? 700 : 500);
      g.rs.forEach((r, j) => {
        if (!(r.aum > 0)) return;
        const x0 = x(acc), x1 = x(acc + r.aum);
        svg.append('rect').attr('x', x0).attr('y', yy + 2).attr('height', RH - 9).attr('width', Math.max(1, x1 - x0 - 1)).style('fill', g.c.c).style('opacity', j % 2 ? 0.62 : 1)
          .on('pointerenter pointermove', (ev) => {
            tip.attr('hidden', null).html('');
            tip.append('div').text(r.strategy).style('font-weight', 600);
            const a1 = tip.append('div').attr('class', 'row'); a1.append('span').text('SIF house'); a1.append('span').text(r.family + ' (' + r.amc + ')');
            const a2 = tip.append('div').attr('class', 'row'); a2.append('span').text('AUM, 30 Sep'); a2.append('span').text(fcr(r.aum));
            const a3 = tip.append('div').attr('class', 'row'); a3.append('span').text('Share of family'); a3.append('span').text(f0(r.aum / g.aum * 100) + '%');
            const [px] = d3.pointer(ev, el); const tw = tip.node().offsetWidth; tip.style('left', Math.max(0, Math.min(px + 12, W - tw - 4)) + 'px').style('top', yy + RH + 'px');
          }).on('pointerleave', () => tip.attr('hidden', ''));
        if (x1 - x0 > 44) svg.append('text').attr('x', (x0 + x1) / 2).attr('y', yy + 11).attr('dy', '0.32em').attr('text-anchor', 'middle').text(r.family).style('fill', '#fff').style('font-size', '10.5px').style('pointer-events', 'none');
        acc += r.aum;
      });
      const pending = g.rs.filter((r) => !(r.aum > 0)).length;
      svg.append('text').attr('x', x(acc) + 6).attr('y', yy + 11).attr('dy', '0.32em')
        .text(g.rs.length ? '₹' + f0(g.aum) + ' cr · ' + g.rs.length + (g.rs.length > 1 ? ' funds' : ' fund') + (pending ? ', ' + pending + ' new' : '') : 'no fund launched yet').style('fill', 'var(--color-fg)');
    });
  });
  dash.draw('famcats', (el) => {
    const R = fams(); if (!R) { el.textContent = '—'; return; }
    el.replaceChildren();
    for (const c of CATS) {
      const rs = R.filter((r) => r.category === c.key);
      const card = document.createElement('div'); card.className = 'sif-cat'; card.style.setProperty('--c', c.c);
      const h = document.createElement('h3'); h.append(document.createTextNode(c.key)); const hs = document.createElement('span'); hs.textContent = rs.length ? rs.length + ' funds · ' + fcr(d3.sum(rs, (r) => r.aum || 0)) : 'none yet'; h.append(hs);
      const benches = d3.rollups(rs.filter((r) => r.benchmark), (v) => v.length, (r) => r.benchmark.toUpperCase().replace(/TOTAL RETURN INDEX \(TRI\)/, 'TRI').replace(/\(TRI\)/, 'TRI').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').replace(/ TRI TRI/, ' TRI').trim())
        .sort((a, b) => b[1] - a[1]).map(([b, n]) => b.replace(/NIFTY/g, 'Nifty').replace(/HYBRID COMPOSITE DEBT/g, 'Hybrid Composite Debt').replace(/INDEX/g, 'Index') + (n > 1 ? ' (' + n + ')' : ''));
      const dl = document.createElement('dl');
      for (const [k, v] of [['What it is', c.what], ['SEBI rule', c.rule], ['Liquidity', c.liq], ['Benchmarks filed', benches.join('; ') || '–']]) {
        const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd);
      }
      card.append(h, dl); el.append(card);
    }
  });
  dash.draw('famlist', (el) => {
    const R = fams(); if (!R) { el.textContent = '—'; return; }
    el.replaceChildren();
    for (const c of CATS) {
      const rs = R.filter((r) => r.category === c.key).sort((a, b) => (b.aum || 0) - (a.aum || 0));
      if (!rs.length) continue;
      const det = document.createElement('details'); det.className = 'sif-fam'; if (S.cat === c.key) det.open = true;
      const sm = document.createElement('summary');
      const n = document.createElement('span'); const bb = document.createElement('b'); bb.textContent = c.key; bb.style.color = c.c; n.append(bb);
      const ch = document.createElement('span'); ch.className = 'chips';
      for (const r of rs) { const t = document.createElement('span'); t.style.background = c.c; t.textContent = r.family; ch.append(t); }
      const cnt = document.createElement('span'); cnt.className = 'n'; cnt.textContent = rs.length + (rs.length > 1 ? ' funds' : ' fund');
      const au = document.createElement('span'); au.className = 'n'; au.textContent = fcr(d3.sum(rs, (r) => r.aum || 0));
      sm.append(n, ch, cnt, au); det.append(sm);
      const box = document.createElement('div'); box.className = 'sif-strat';
      for (const r of rs) {
        const a = document.createElement('article'); a.style.setProperty('--c', c.c);
        const h = document.createElement('h4'); h.textContent = r.strategy + ' · ' + r.family + ' (' + r.amc + ')'; a.append(h);
        const facts = document.createElement('div'); facts.className = 'facts';
        const ter = Number.isFinite(r.ter) ? (r.ter > 5 ? f2(r.ter) + '% as filed (looks wrong)' : f2(r.ter) + '%' + (r.ter_source === 'Groww' ? ' (Groww)' : '')) : '–';
        const fr = (funds() || []).find((x) => x.id === r.code);
        for (const [k, v] of [['Type', r.type ? r.type.toLowerCase() : 'n/a'], ['NFO opened', r.launch ? fmtDate(parseDate(r.launch)) : '–'], ['Live for', fr && Number.isFinite(fr.days_live) ? fr.days_live + ' days' : '–'], ['AUM 30 Sep', Number.isFinite(r.aum) ? fcr(r.aum) : 'not yet disclosed'],
          ['Benchmark', r.benchmark || 'not on AMFI'], ['Expense, direct', ter], ['Risk level (1-5)', Number.isFinite(r.risk) ? String(r.risk) : '–'], ['Exit load', r.exit_load || '–']]) {
          const s1 = document.createElement('span'); s1.append(document.createTextNode(k + ': ')); const b = document.createElement('b'); b.textContent = v; s1.append(b); facts.append(s1);
        }
        a.append(facts);
        if (r.objective) { const p2 = document.createElement('p'); p2.textContent = r.objective.replace(/There is no assurance.*$/i, '').trim(); a.append(p2); }
        if (r.allocation) { const p2 = document.createElement('p'); p2.className = 'muted'; p2.textContent = 'Stated allocation: ' + r.allocation.replace(/\s+/g, ' '); a.append(p2); }
        if (r.ssd) { const l = document.createElement('a'); l.href = r.ssd; l.target = '_blank'; l.rel = 'noopener'; l.textContent = 'AMFI summary document'; l.style.fontSize = '12px'; a.append(l); }
        box.append(a);
      }
      det.append(box); el.append(det);
    }
  });
})();
