/* SIF Competitor Monitor — drawings, controls and calcs. Data: funds, daily, alloc, holdings, trades, aum, sources. */
(function () {
  const root = document.getElementById('sif');
  const C = dash.colors || [];
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
  const DEFAULT_HL = ['SIF-9', 'SIF-79', 'SIF-139', 'SIF-14', 'SIF-145'];
  const S = window.SIF = {
    cat: 'Hybrid long-short', win: 'all', metric: 'idx', hl: [], slot: {}, bench: new Set(['nifty_tri', 'blend', 'debt65', 'arbitrage']),
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
      for (const k of Object.keys(r)) if (!['id', 'kind', 'brand', 'sponsor', 'name', 'category', 'isin', 'first_date', 'last_date', 'fund'].includes(k)) o[k] = num(r[k]);
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
      by.get(r.id).push({ date: parseDate(r.date), ds: r.date, nav: num(r.nav), idx: num(r.idx), dd: num(r.dd), vol20: num(r.vol20), vol60: num(r.vol60), beta60: num(r.beta60) });
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
  const label = (f) => (S.cat === 'all' && f.kind === 'SIF' ? f.brand + ' ' + (CAT_SHORT[f.category] || '') : f.brand);
  const inCat = (f) => f.kind === 'SIF' && (S.cat === 'all' || f.category === S.cat);

  function ensureHL(F) {
    if (S.catInit === S.cat) return;
    S.catInit = S.cat;
    const pool = F.filter(inCat);
    let hl = DEFAULT_HL.filter((c) => pool.some((f) => f.id === c));
    if (!hl.length) hl = pool.slice().sort((a, b) => (b.ret_inception || -1e9) - (a.ret_inception || -1e9)).slice(0, 5).map((f) => f.id);
    S.hl = hl; S.slot = {}; hl.forEach((c, i) => (S.slot[c] = i));
  }
  const colorOf = (id) => (id in S.slot ? col(S.slot[id]) : 'var(--cds-chart-muted)');
  function toggleHL(id) {
    const i = S.hl.indexOf(id);
    if (i >= 0) { S.hl.splice(i, 1); delete S.slot[id]; }
    else {
      if (S.hl.length >= 6) { const out = S.hl.shift(); delete S.slot[out]; }
      const used = new Set(Object.values(S.slot));
      let s = 0; while (used.has(s)) s++;
      S.hl.push(id); S.slot[id] = s;
    }
  }
  function redraw(...names) { for (const n of names) dash.draw(n); }
  const ALL = ['chips', 'score', 'ts', 'scatter', 'scnote', 'takeaway'];

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
  seg('sif-win', 'data-win', 'win', () => redraw('ts', 'scatter', 'scnote'));
  seg('sif-metric', 'data-metric', 'metric', () => redraw('ts', 'tstitle'));
  seg('sif-kind', 'data-kind', 'kind', () => redraw('hold', 'holdnote'));
  for (const th of document.querySelectorAll('#score-table th button[data-sort]')) {
    th.addEventListener('click', () => {
      const k = th.getAttribute('data-sort');
      S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'brand' || k === 'first_date' ? 1 : -1) };
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
        fund: r.fund, brand: r.brand, asof: r.asof, source: r.source,
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
      if (!bench && on) i.style.background = colorOf(id);
      b.append(i, document.createTextNode(text));
      b.addEventListener('click', () => {
        if (bench) { S.bench.has(id) ? S.bench.delete(id) : S.bench.add(id); }
        else toggleHL(id);
        redraw('chips', 'ts', 'scatter', 'score');
      });
      el.append(b);
    };
    F.filter(inCat).sort((a, b) => label(a).localeCompare(label(b))).forEach((f) => mk(f.id, label(f), S.hl.includes(f.id), false));
    BENCH.forEach((id) => { const f = F.find((x) => x.id === id); if (f) mk(id, f.brand, S.bench.has(id), true); });
  });

  // ---------- scoreboard ----------
  const SCORE_COLS = ['brand', 'first_date', 'aum', 'ret_1m', 'ret_3m', 'ret_6m', 'ret_1y', 'ret_inception', 'cagr', 'vol_life', 'vol_1y', 'vol_60d', 'beta_life', 'beta_dimson', 'beta_60d', 'alpha', 'max_dd', 'dd_now', 'up_capture', 'down_capture'];
  dash.draw('score', (tb) => {
    const F = funds(); if (!F) { tb.replaceChildren(); return; }
    ensureHL(F);
    const A = aumLatest() || new Map();
    const k = S.sort.key, dir = S.sort.dir;
    const val = (f) => (k === 'aum' ? num((A.get(f.fund) || {}).aum_cr) : f[k]);
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
          td.append(sw, document.createTextNode(label(f)));
        } else if (c === 'first_date') { td.className = 'n'; td.textContent = f.kind === 'SIF' ? fmtMon(parseDate(f.first_date)) : '–'; }
        else if (c === 'aum') {
          td.className = 'n';
          const a = A.get(f.fund);
          if (a) {
            const s = document.createElement('span'); s.textContent = f0(+a.aum_cr) + ' ';
            s.setAttribute('data-source', 'aum'); s.setAttribute('data-field', 'aum_cr'); s.setAttribute('data-where', 'fund=' + a.fund + '&date=' + a.date);
            const p = document.createElement('span'); p.className = 'pill ' + QCLS(a.quality); p.textContent = { official: 'off', disclosed: 'disc', reported: 'rep' }[QCLS(a.quality)];
            p.title = a.source + ', ' + a.date;
            td.append(s, p);
          } else td.textContent = '–';
        } else {
          td.className = 'n';
          const v = f[c];
          const isRet = c.startsWith('ret_') || c === 'cagr' || c === 'alpha';
          const isBeta = c.startsWith('beta');
          td.textContent = fx(v, isBeta ? f2 : isRet ? sg1 : (c.endsWith('capture') ? f0 : f1));
          if ((isRet || c === 'dd_now' || c === 'max_dd') && v < 0 && f.kind === 'SIF' && isRet) td.classList.add('bad');
        }
        tr.append(td);
      }
      tb.append(tr);
    }
  });

  // ---------- time series ----------
  const TS_TITLE = { idx: 'Growth of ₹100', dd: 'Drawdown from peak, %', vol60: 'Rolling 60-day volatility, % a year', vol20: 'Rolling 20-day volatility, % a year', beta60: 'Rolling 60-day beta to Nifty 50' };
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

  dash.draw('ts', (el) => {
    const F = funds(), D = daily();
    if (!F || !D) { failNote(el, dash.data(!F ? 'funds' : 'daily').status); return; }
    ensureHL(F);
    const metric = S.metric;
    const lastDate = d3.max(D.get('nifty50') || [], (r) => r.date);
    const start = winStart(F, lastDate);
    const others = S.cat === 'all' ? [] : F.filter((f) => inCat(f) && !S.hl.includes(f.id)).map((f) => f.id);
    const series = [];
    const pushS = (id, kind) => {
      let a = (D.get(id) || []).filter((r) => !start || r.date >= start);
      if (a.length < 2) return;
      let vals;
      if (metric === 'idx' || metric === 'dd') {
        const base = a[0].idx; let peak = -Infinity;
        vals = a.map((r) => { const v = (r.idx / base) * 100; peak = Math.max(peak, v); return { date: r.date, v: metric === 'idx' ? v : (v / peak - 1) * 100 }; });
      } else vals = a.map((r) => ({ date: r.date, v: r[metric] })).filter((p) => Number.isFinite(p.v));
      if (vals.length < 2) return;
      const f = F.find((x) => x.id === id);
      series.push({ id, kind, vals, name: f ? label(f) : id });
    };
    others.forEach((id) => pushS(id, 'other'));
    BENCH.filter((b) => S.bench.has(b)).forEach((id) => pushS(id, 'bench'));
    S.hl.forEach((id) => pushS(id, 'hl'));
    if (!series.length) { failNote(el, 'empty'); return; }

    // tall and narrow so the slopes of low-volatility funds are readable
    const wNow = el.clientWidth || 600;
    const { svg, tip, W, H } = chartFrame(el, wNow < 560 ? 420 : Math.min(620, Math.round(wNow * 0.72)));
    svg.attr('aria-label', TS_TITLE[metric] + ' for highlighted SIFs and benchmarks');
    const all = series.flatMap((s) => s.vals);
    const x = d3.scaleUtc().domain(d3.extent(all, (p) => p.date));
    const focus = series.filter((s) => s.kind !== 'other');
    const ext = d3.extent((focus.length ? focus : series).flatMap((s) => s.vals), (p) => p.v);
    const pad = (ext[1] - ext[0]) * 0.06 || 1;
    const y = d3.scaleLinear().domain([ext[0] - pad, ext[1] + pad]).nice();
    // measure end labels for the right margin
    const hlS = series.filter((s) => s.kind === 'hl' || s.kind === 'bench');
    const meas = svg.append('g');
    const widths = hlS.map((s) => { const t = meas.append('text').text(s.name); const w = t.node().getComputedTextLength(); return w; });
    meas.remove();
    const yTick = svg.append('text').text(d3.format('.1f')(y.domain()[1])); const yw = yTick.node().getComputedTextLength(); yTick.remove();
    const m = { t: 12, r: Math.min(150, (d3.max(widths) || 40) + 14), b: 26, l: yw + 14 };
    x.range([m.l, W - m.r]); y.range([H - m.b, m.t]);
    const nx = Math.max(2, Math.floor((W - m.l - m.r) / 90));
    svg.append('g').attr('class', 'grid').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(W - m.l - m.r)).tickFormat(''));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(nx).tickFormat(d3.utcFormat('%b %y')));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6));
    const ref = metric === 'idx' ? 100 : metric === 'beta60' ? 0 : (metric === 'dd' ? 0 : null);
    if (ref !== null && ref >= y.domain()[0] && ref <= y.domain()[1]) svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(ref)).attr('y2', y(ref)).style('stroke', 'var(--cds-chart-reference)');
    const line = d3.line().x((p) => x(p.date)).y((p) => y(p.v));
    const clipId = 'ts-clip-' + Math.random().toString(36).slice(2, 8);
    svg.append('clipPath').attr('id', clipId).append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b);
    for (const s of series) {
      const p = svg.append('path').datum(s.vals).attr('d', line).attr('fill', 'none').attr('clip-path', 'url(#' + clipId + ')');
      if (s.kind === 'other') p.style('stroke', 'var(--cds-chart-muted)').style('stroke-width', 1).style('opacity', 0.55);
      else if (s.kind === 'bench') p.style('stroke', 'var(--color-fg-muted)').style('stroke-width', 1.4).style('stroke-dasharray', BENCH_STYLE[s.id]);
      else p.style('stroke', colorOf(s.id)).style('stroke-width', 2.2);
    }
    // end labels, nudged apart
    const ends = hlS.map((s) => ({ s, y: y(s.vals[s.vals.length - 1].v), x: x(s.vals[s.vals.length - 1].date) }));
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    for (let i = ends.length - 2; i >= 0; i--) if (ends[i].y > H - m.b) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - 12);
    for (const e of ends) {
      svg.append('circle').attr('cx', e.x).attr('cy', y(e.s.vals[e.s.vals.length - 1].v)).attr('r', 2.5).style('fill', e.s.kind === 'hl' ? colorOf(e.s.id) : 'var(--color-fg-muted)');
      svg.append('text').attr('x', W - m.r + 6).attr('y', e.y).attr('dy', '0.32em').text(e.s.name).style('fill', e.s.kind === 'hl' ? colorOf(e.s.id) : 'var(--cds-text-secondary)');
    }
    // tooltip
    const vline = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).style('stroke', 'var(--cds-chart-axis)').style('display', 'none'); // SVG ignores the hidden attribute
    const bis = d3.bisector((p) => p.date).right;
    const fmtV = metric === 'beta60' ? f2 : f1;
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b).style('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [px] = d3.pointer(ev); const dt = x.invert(px);
        vline.attr('x1', px).attr('x2', px).style('display', null);
        const lines = hlS.map((s) => { const i = bis(s.vals, dt) - 1; return i >= 0 ? [s, s.vals[i].v] : null; }).filter(Boolean).sort((a, b) => b[1] - a[1]);
        tip.attr('hidden', null).html('');
        tip.append('div').attr('class', 'muted').text(fmtDate(dt));
        for (const [s, v] of lines) { const r = tip.append('div').attr('class', 'row'); r.append('span').text(s.name).style('color', s.kind === 'hl' ? colorOf(s.id) : null); r.append('span').text(fmtV(v)); }
        const tw = tip.node().offsetWidth; const left = px + 14 + tw > W ? px - tw - 14 : px + 14;
        tip.style('left', left + 'px').style('top', m.t + 'px');
      })
      .on('pointerleave', () => { tip.attr('hidden', ''); vline.style('display', 'none'); });
  });

  // ---------- scatter ----------
  const WIN_FIELD = { '1m': 'ret_1m', '3m': 'ret_3m', '6m': 'ret_6m', '1y': 'ret_1y', all: 'ret_inception', common: 'ret_inception' };
  const WIN_NAME = { '1m': '1 month', '3m': '3 months', '6m': '6 months', '1y': '1 year', all: 'since launch', common: 'since launch' };
  dash.draw('scnote', (el) => { el.textContent = 'Return over ' + WIN_NAME[S.win]; });
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
        const r1 = tip.append('div').attr('class', 'row'); r1.append('span').text('Return'); r1.append('span').text(sg1(p.y) + '%');
        const r2 = tip.append('div').attr('class', 'row'); r2.append('span').text('Volatility'); r2.append('span').text(f1(p.x) + '%');
        const r3 = tip.append('div').attr('class', 'row'); r3.append('span').text('Beta 60d'); r3.append('span').text(fx(p.f.beta_60d, f2));
        const tw = tip.node().offsetWidth; tip.style('left', (cx + 12 + tw > W ? cx - tw - 12 : cx + 12) + 'px').style('top', Math.max(0, cy - 30) + 'px');
      }).on('pointerleave', () => tip.attr('hidden', ''));
    }
  });

  // ---------- AUM ----------
  dash.draw('aum', (el) => {
    const A = aumLatest(), F = funds();
    if (!A || !F) { failNote(el, dash.data('aum').status); return; }
    const pts = [...A.values()].map((a) => ({ a, v: +a.aum_cr })).sort((p, q) => q.v - p.v);
    const { svg, tip, W } = chartFrame(el, 22 * pts.length + 30);
    svg.attr('aria-label', 'Latest assets under management by hybrid long-short fund');
    const meas = svg.append('text').text('Platinum'); const lw = meas.node().getComputedTextLength() + 10; meas.remove();
    const m = { t: 6, r: 110, b: 6, l: lw };
    const x = d3.scaleLinear().domain([0, d3.max(pts, (p) => p.v)]).range([m.l, W - m.r]);
    pts.forEach((p, i) => {
      const yy = m.t + i * 22;
      svg.append('text').attr('x', m.l - 8).attr('y', yy + 9).attr('dy', '0.32em').attr('text-anchor', 'end').text(p.a.brand);
      svg.append('rect').attr('x', m.l).attr('y', yy + 2).attr('height', 14).attr('width', Math.max(1, x(p.v) - m.l)).attr('rx', 2)
        .style('fill', p.a.quality !== 'Reported' ? col(0) : 'color-mix(in srgb, ' + col(0) + ' 45%, transparent)');
      svg.append('text').attr('x', x(p.v) + 6).attr('y', yy + 9).attr('dy', '0.32em').text(f0(p.v) + (p.a.quality === 'Reported' ? ' (reported)' : '') + ' · ' + fmtMon(parseDate(p.a.date)))
        .attr('data-source', 'aum').attr('data-field', 'aum_cr').attr('data-where', 'fund=' + p.a.fund + '&date=' + p.a.date);
    });
  });
  dash.draw('aumnote', (el) => {
    const d = rows('aum'); if (!d) { el.textContent = '—'; return; }
    const ind = d.filter((r) => r.kind === 'Industry').sort((a, b) => (a.date < b.date ? 1 : -1));
    const h = ind.find((r) => r.brand === 'Hybrid long-short'), all = ind.find((r) => r.brand === 'All SIFs');
    el.replaceChildren();
    const b = (r) => { const s = document.createElement('b'); s.className = 'num'; s.textContent = '₹' + f0(+r.aum_cr) + ' cr'; s.setAttribute('data-source', 'aum'); s.setAttribute('data-field', 'aum_cr'); s.setAttribute('data-where', 'brand=' + encodeURIComponent(r.brand) + '&date=' + r.date); return s; };
    if (h && all) el.append('Category total on ' + fmtDate(parseDate(h.date)) + ': ', b(h), ' in hybrid long-short, ', b(all), ' across all SIFs (AMFI, as reported). Bars are month-end net assets of the latest disclosed portfolio: Arudha from its own file, the rest from the same disclosure via Groww. The 30 Sep fund figures sum to 99.5% of AMFI\'s hybrid long-short total.');
  });

  // ---------- construction chart ----------
  const SEGS = [['hedged', 'Hedged stocks'], ['open', 'Unhedged stocks'], ['reit', 'REITs, InvITs, units'], ['debt', 'Bonds, G-secs'], ['mm', 'Money market'], ['cash', 'Cash, TREPS, margin'], ['resid', 'Debt and cash']];
  function segVals(r) {
    const n_ = (k) => num(r[k]) || 0;
    const eq = n_('equity_long'), h = Math.min(n_('hedged_same_stock'), eq);
    return { hedged: h, open: eq - h, reit: n_('reit_invit') + n_('mf_units'), debt: n_('debt'), mm: n_('money_market'), cash: n_('cash') + n_('irs'), resid: r.source === 'groww_page' ? n_('debt_cash_residual') : 0 };
  }
  dash.draw('cons', (el) => {
    const L = allocLatest(); if (!L) { failNote(el, dash.data('alloc').status); return; }
    const list = [...L.values()].sort((a, b) => num(b.net_equity) - num(a.net_equity));
    const { svg, tip, W } = chartFrame(el, 24 * list.length + 34);
    svg.attr('aria-label', 'Asset mix of each hybrid long-short fund at its latest disclosure');
    const meas = svg.append('text').text('Platinum'); const lw = meas.node().getComputedTextLength() + 12; meas.remove();
    const m = { t: 4, r: 12, b: 24, l: lw };
    const x = d3.scaleLinear().domain([0, 100]).range([m.l, W - m.r]);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${m.t + 24 * list.length + 2})`).call(d3.axisBottom(x).ticks(5).tickFormat((d) => d + '%'));
    list.forEach((r, i) => {
      const yy = m.t + i * 24; const v = segVals(r); let acc = 0;
      svg.append('text').attr('x', m.l - 8).attr('y', yy + 10).attr('dy', '0.32em').attr('text-anchor', 'end').text(r.brand);
      for (const [k, name] of SEGS) {
        const w = Math.max(0, v[k]); if (w <= 0.05) continue;
        const rect = svg.append('rect').attr('x', x(acc)).attr('y', yy + 2).attr('height', 16).attr('width', Math.max(0.5, x(acc + w) - x(acc))).style('fill', 'var(--sif-c-' + k + ')');
        rect.on('pointerenter', (ev) => {
          tip.attr('hidden', null).html('');
          tip.append('div').text(r.brand + ' · ' + fmtDate(parseDate(r.asof))).style('font-weight', 600);
          for (const [kk, nn] of SEGS) if (v[kk] > 0.05) { const row = tip.append('div').attr('class', 'row'); row.append('span').text(nn); row.append('span').text(f1(v[kk]) + '%'); }
          const [px] = d3.pointer(ev, el); const tw = tip.node().offsetWidth; tip.style('left', Math.min(px + 12, W - tw - 4) + 'px').style('top', yy + 22 + 'px');
        }).on('pointerleave', () => tip.attr('hidden', ''));
        acc += w;
      }
    });
  });
  dash.draw('constable', (tb) => {
    const c = dash.data('construction');
    tb.replaceChildren(); if (c.status !== 'ok' || !Array.isArray(c.data)) return;
    for (const r of c.data) {
      const tr = document.createElement('tr'); tr.setAttribute('data-key', r.fund);
      const cells = [r.brand, r.asof ? fmtDate(parseDate(r.asof)) : '–', null, fx(r.net_equity, f1), fx(r.implied, f1), fx(r.stock_fut_short, f1), fx(r.index_fut, f1), r.options, String(r.n_stocks), fx(r.top10_share, f1), fx(r.eff_n, f1), r.long_lms, r.net_lms];
      cells.forEach((t, i) => {
        const td = document.createElement('td');
        if (i === 2) { td.className = 'l'; const p = document.createElement('span'); p.className = 'pill ' + r.source; p.textContent = r.source === 'official' ? 'AMC file' : 'via Groww'; td.append(p); }
        else { td.textContent = t; if (i > 0) td.className = 'n'; if (i === 1) td.className = 'l'; }
        tr.append(td);
      });
      tb.append(tr);
    }
  });

  // ---------- deep dive ----------
  function fundRows() { const d = rows('alloc'); return d ? d.filter((r) => r.fund === S.fund).sort((a, b) => (a.asof < b.asof ? -1 : 1)) : null; }
  dash.draw('fundsel', (sel) => {
    const d = rows('alloc'); if (!d) { sel.replaceChildren(); return; }
    const cnt = d3.rollup(d, (v) => v.length, (r) => r.fund);
    const names = d3.rollup(d, (v) => v[0].brand, (r) => r.fund);
    if (!S.fund) S.fund = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
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
    tile('Hedged share of stocks', f1(+r.hedged_share) + '%', 'alloc', 'hedged_share', where);
    tile('Net equity before options', f1(+r.net_equity) + '%', 'alloc', 'net_equity', where);
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
      for (const [k] of SEGS) { const w = Math.max(0, v[k]); if (w <= 0.05) continue; svg.append('rect').attr('x', bx).attr('width', bw).attr('y', y(Math.min(100, acc + w))).attr('height', Math.max(0.5, y(acc) - y(Math.min(100, acc + w)))).style('fill', 'var(--sif-c-' + k + ')'); acc += w; }
      if (r.aum_cr) svg.append('text').attr('x', bx + bw / 2).attr('y', m.t - 6).attr('text-anchor', 'middle').text('₹' + f0(+r.aum_cr));
      svg.append('rect').attr('x', bx).attr('width', bw).attr('y', m.t).attr('height', H - m.t - m.b).style('fill', 'transparent')
        .on('pointerenter', () => {
          tip.attr('hidden', null).html('');
          tip.append('div').text(fmtDate(parseDate(r.asof)) + (r.aum_cr ? ' · ₹' + f0(+r.aum_cr) + ' cr' : '')).style('font-weight', 600);
          for (const [kk, nn] of SEGS) if (v[kk] > 0.05) { const row = tip.append('div').attr('class', 'row'); row.append('span').text(nn); row.append('span').text(f1(v[kk]) + '%'); }
          const row = tip.append('div').attr('class', 'row'); row.append('span').text('Net equity'); row.append('span').text(f1(+r.net_equity) + '%');
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
      const cells = [r.brand, r.amfi_code, r.nav_from, r.nav_to, r.nav_groww_check || '–', r.holdings_source, r.holdings_asof || '–', (r.official_months || '').split(';').filter(Boolean).length + ' file(s)'];
      cells.forEach((t, i) => { const td = document.createElement('td'); td.textContent = t; if (i) td.className = 'l'; tr.append(td); });
      const td = document.createElement('td'); td.className = 'l';
      if (r.disclosure_page) { const a = document.createElement('a'); a.href = r.disclosure_page; a.target = '_blank'; a.rel = 'noopener'; a.textContent = new URL(r.disclosure_page).hostname.replace('www.', ''); td.append(a); } else td.textContent = 'not yet listed';
      tr.append(td); tb.append(tr);
    }
  });
})();
