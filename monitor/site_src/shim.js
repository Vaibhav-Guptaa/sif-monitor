/* Stand-alone runtime for the SIF Competitor Monitor.
   Provides the four calls sif.js uses (dash.data, dash.draw, dash.calc, dash.colors) so the same page code runs on
   any static host. Datasets are the CSVs in ./data/, loaded once; drawings rerun on resize. */
(function () {
  const NAMES = ['funds', 'daily', 'alloc', 'holdings', 'trades', 'aum', 'sources', 'families', 'attrib', 'attrib_top', 'monthly'];
  const store = {};          // name -> {status, data}
  const calcs = {};          // name -> {inputs, fn}
  const draws = new Map();   // name -> fn, in registration order
  let ready = false;

  function run(name) {
    const fn = draws.get(name);
    if (!fn) return;
    document.querySelectorAll('[data-draw="' + name + '"]').forEach((el) => {
      try { fn(el); } catch (e) { console.error('draw ' + name, e); }
    });
  }

  window.dash = {
    colors: ['#2f6fd6', '#d9822b', '#1a9e8f', '#8e5bd6', '#cc4b5c', '#7d8f1f', '#c2569e', '#8a6a4f', '#4e9bd1', '#b08a1c'],
    data(name) {
      if (calcs[name]) {
        const c = calcs[name];
        const ins = c.inputs.map((i) => store[i]);
        if (ins.some((x) => !x || x.status !== 'ok')) return { status: ins.some((x) => x && x.status === 'error') ? 'error' : 'loading', data: null };
        if (!c.cache) c.cache = { status: 'ok', data: c.fn(...ins.map((x) => x.data)) };
        return c.cache;
      }
      return store[name] || { status: 'loading', data: null };
    },
    draw(name, fn) {
      if (fn) { draws.set(name, fn); if (ready) run(name); return; }
      run(name);
    },
    calc(name, spec) { calcs[name] = { inputs: spec.inputs, fn: spec.fn }; },
  };

  window.SIF_BOOT = async function (pageScript) {
    await Promise.all(NAMES.map(async (n) => {
      try {
        if (window.SIF_DATA) {   // locked site: CSV text comes from the decrypted bundle
          if (window.SIF_DATA[n] === undefined) throw new Error('missing');
          store[n] = { status: 'ok', data: d3.csvParse(window.SIF_DATA[n]) };
          return;
        }
        const r = await fetch('data/' + n + '.csv', { cache: 'no-cache' });
        if (!r.ok) throw new Error(r.status);
        store[n] = { status: 'ok', data: d3.csvParse(await r.text()) };
      } catch (e) {
        console.error('load ' + n, e);
        store[n] = { status: 'error', data: null };
      }
    }));
    ready = true;
    await new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = pageScript; s.onload = res; s.onerror = rej; document.body.append(s);
    });
    // second pass: drawings registered early can depend on state set by ones registered later
    for (const n of draws.keys()) run(n);
    const root = document.getElementById('sif');
    let w = root.clientWidth, t = null;
    new ResizeObserver(() => {
      if (Math.abs(root.clientWidth - w) < 8) return;
      w = root.clientWidth; clearTimeout(t);
      t = setTimeout(() => { for (const n of draws.keys()) run(n); }, 150);
    }).observe(root);
  };
})();
