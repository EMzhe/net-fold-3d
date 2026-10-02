/* 单用例诊断：在 diag-page.html 里执行，输出 ASCII 图 + 格距候选打分明细 */
(function () {
  const q = new URLSearchParams(location.search);
  const shape = q.get('shape') || '2-2-2';
  const variant = q.get('variant') || 'dash';
  const step = +(q.get('step') || 3);
  const d = window.__bench.draw(window.__bench.SHAPES[shape], variant);
  const bi = Detect.binarize(d);
  const rows = [];
  for (let y = 0; y < bi.h; y += step) {
    let s = '';
    for (let x = 0; x < bi.w; x += step) {
      let dark = 0;
      for (let dy = 0; dy < step && y + dy < bi.h; dy++)
        for (let dx = 0; dx < step && x + dx < bi.w; dx++)
          dark += bi.bin[(y + dy) * bi.w + x + dx];
      s += dark >= 3 ? '#' : dark >= 1 ? '+' : '.';
    }
    rows.push(s);
  }
  const dbg = {};
  const net = Detect.detectSquare(d, dbg);
  const evals = (dbg.evals || []).slice().sort((a, b) => b.score - a.score).slice(0, 10);
  let res = null, fixed = null;
  if (net) {
    res = Fold.foldNet(net, 1);
    if (!res.valid) { const r = Fold.autoRepair(net, net.extras); if (r) { net = r.net; res = Fold.foldNet(net, 1); fixed = r.action + r.count; } }
  }
  return JSON.stringify({
    shape, variant, img: [bi.w, bi.h], ascii: rows,
    bbox: dbg.bbox, multi: dbg.multi, chosen: dbg.chosen, cells: dbg.cells,
    net: net ? { s: net.s, origin: net.origin, n: net.mask.size, keys: [...net.mask.keys()].join(' '), extras: net.extras ? net.extras.length : 0, valid: !!res && res.valid, fixed } : null,
    topEvals: evals
  });
})()
