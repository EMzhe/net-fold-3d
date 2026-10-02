/* 浏览器端基准测试：多种展开图形状 × 多种干扰，统计识别成功率
 * 用法：在页面里 eval 本文件内容 */
(function () {
  const SHAPES = {
    '1-4-1十字': [[0,1],[1,0],[1,1],[1,2],[1,3],[2,1]],
    '1-4-1偏':   [[0,0],[1,0],[1,1],[1,2],[1,3],[2,3]],
    '2-3-1':     [[0,0],[0,1],[1,1],[1,2],[1,3],[2,3]],
    '2-2-2':     [[0,0],[0,1],[1,1],[1,2],[2,2],[2,3]],
    '3-3':       [[0,0],[0,1],[0,2],[1,2],[1,3],[1,4]],
    '1-3-2':     [[0,0],[1,0],[1,1],[1,2],[2,2],[2,3]],
    'Z字':       [[0,0],[0,1],[1,1],[2,1],[2,2],[3,2]],
    'T型':       [[0,1],[1,1],[2,0],[2,1],[2,2],[3,1]]
  };
  const VARIANTS = ['plain', 'thin', 'thick', 'shade', 'hatch', 'frame', 'pattern',
    'small', 'large', 'blur', 'lightline', 'paperbg', 'multi',
    'text', 'noise', 'dash', 'multi3', 'photo'];
  /* 需要额外顶部空间的变体：题干文字 */
  const TOP_PAD = { text: 40, photo: 26 };

  /* 确定性伪随机，保证浏览器/Node 两端一致 */
  function rng(seed) {
    let x = seed >>> 0;
    return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
  }

  function draw(cells, variant) {
    let s = variant === 'small' ? 26 : variant === 'large' ? 92 : 44;
    const maxR = Math.max(...cells.map(c => c[0])), maxC = Math.max(...cells.map(c => c[1]));
    const pad = variant === 'frame' ? 26 : 12;
    const top = TOP_PAD[variant] || 0;
    let W = (maxC + 2) * s + pad * 2, H = (maxR + 2) * s + pad * 2 + top;
    if (variant === 'multi') W = Math.round(W * 2.1);       // 右侧再放一个展开图
    if (variant === 'multi3') W = Math.round(W * 3.0);      // 右侧再放两个
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = variant === 'paperbg' ? '#f6f1e4' : (variant === 'photo' ? '#efefef' : '#fff');
    ctx.fillRect(0, 0, W, H);
    if (variant === 'blur') ctx.filter = 'blur(1.2px)';
    ctx.strokeStyle = variant === 'lightline' ? '#8a8a8a' : '#000';
    ctx.lineJoin = 'miter';
    const lw = variant === 'thin' ? 1 : variant === 'thick' ? 4 : variant === 'large' ? 3 : 2;
    ctx.lineWidth = lw;
    const x0 = pad + s * 0.5, y0 = pad + s * 0.5 + top;
    const cell = (r, c) => [x0 + c * s, y0 + r * s];
    if (variant === 'dash') ctx.setLineDash([6, 4]);
    for (const [r, c] of cells) {
      const [x, y] = cell(r, c);
      ctx.strokeRect(x, y, s, s);
    }
    ctx.setLineDash([]);
    if (variant === 'shade') {
      ctx.fillStyle = '#7a7a7a';
      const [r, c] = cells[0]; const [x, y] = cell(r, c);
      ctx.fillRect(x + lw, y + lw, s - 2 * lw, s - 2 * lw);
      const [r2, c2] = cells[3]; const [x2, y2] = cell(r2, c2);
      ctx.fillRect(x2 + lw, y2 + lw, s - 2 * lw, s - 2 * lw);
    }
    if (variant === 'hatch') {
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
      cells.forEach((rc, k) => {
        if (k % 2) return;
        const [x, y] = cell(rc[0], rc[1]);
        ctx.save();
        ctx.beginPath(); ctx.rect(x + 3, y + 3, s - 6, s - 6); ctx.clip();   // 图案限制在格子内
        for (let d = -s; d < s; d += 5) {
          ctx.beginPath(); ctx.moveTo(x + 4 + d, y + 4); ctx.lineTo(x + 4 + d + s - 8, y + s - 4); ctx.stroke();
        }
        ctx.restore();
      });
      ctx.strokeStyle = '#000'; ctx.lineWidth = lw;
    }
    if (variant === 'pattern') {
      ctx.lineWidth = 3; ctx.lineCap = 'round';
      cells.forEach((rc, k) => {
        const [x, y] = cell(rc[0], rc[1]); const cx = x + s / 2, cy = y + s / 2;
        ctx.beginPath();
        if (k % 3 === 0) { ctx.arc(cx, cy, s * 0.26, 0, 7); }
        else if (k % 3 === 1) { ctx.moveTo(cx - s * 0.26, cy - s * 0.26); ctx.lineTo(cx + s * 0.26, cy + s * 0.26); ctx.moveTo(cx + s * 0.26, cy - s * 0.26); ctx.lineTo(cx - s * 0.26, cy + s * 0.26); }
        else { ctx.moveTo(cx, cy - s * 0.28); ctx.lineTo(cx + s * 0.26, cy + s * 0.2); ctx.lineTo(cx - s * 0.26, cy + s * 0.2); ctx.closePath(); }
        ctx.stroke();
      });
      ctx.lineWidth = lw;
    }
    if (variant === 'frame') {
      ctx.lineWidth = 2;
      ctx.strokeRect(4, 4, W - 8, H - 8);
    }
    /* 右侧再画较小的展开图（模拟题目里的多个选项） */
    const drawOptions = (n) => {
      const s2 = Math.round(s * 0.8);
      ctx.lineWidth = 2;
      for (let k = 0; k < n; k++) {
        const sx = x0 + (maxC + 3 + k * 4) * s, sy = y0;
        for (const [r, c] of [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1], [3, 1]]) {
          ctx.strokeRect(sx + c * s2, sy + r * s2, s2, s2);
        }
      }
    };
    if (variant === 'multi') drawOptions(1);
    if (variant === 'multi3') drawOptions(2);

    /* 题干 / 选项字母等文字：用小色块模拟字形笔画 */
    if (variant === 'text' || variant === 'photo') {
      const rnd = rng(12345);
      ctx.fillStyle = '#222';
      for (let k = 0; k < 22; k++) {              // 顶部一行“题干”
        const gx = 8 + k * 11, gy = 8 + (k % 3 === 0 ? 0 : 3);
        ctx.fillRect(gx, gy, 7, 12 - (k % 2) * 3);
        if (rnd() > 0.6) ctx.fillRect(gx + 1, gy - 4, 5, 3);
      }
      for (let k = 0; k < 9; k++) {               // 第二行
        ctx.fillRect(8 + k * 11, 26, 7, 10);
      }
      if (variant === 'photo') {                   // 选项字母
        ctx.fillRect(x0 - 14, y0 + 4, 9, 13);
      }
    }

    /* 椒盐噪点（模拟拍照/压缩） */
    if (variant === 'noise' || variant === 'photo') {
      const d = ctx.getImageData(0, 0, W, H);
      const rnd = rng(987);
      const amount = variant === 'photo' ? 0.05 : 0.03;
      for (let i = 0; i < d.data.length; i += 4) {
        if (rnd() < amount) {
          const v = rnd() < 0.5 ? 0 : 255;
          d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
        } else if (variant === 'photo') {
          const n = (rnd() - 0.5) * 26;
          d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n;
        }
      }
      ctx.putImageData(d, 0, 0);
    }
    return ctx.getImageData(0, 0, W, H);
  }

  if (typeof window !== 'undefined') window.__bench = { draw, SHAPES };

  const results = [];
  const times = [];
  let pass = 0, total = 0;
  for (const [name, cells] of Object.entries(SHAPES)) {
    for (const v of VARIANTS) {
      total++;
      const d = draw(cells, v);
      let net = null, err = '';
      const t0 = performance.now();
      try { net = Detect.detectSquare(d); } catch (e) { err = e.message; }
      const ms = Math.round(performance.now() - t0);
      times.push(ms);
      let ok = false, n = 0, fixed = false;
      if (net) {
        n = net.mask.size;
        let res = Fold.foldNet(net, 1);
        if (!res.valid) {
          const rep = Fold.autoRepair(net, net.extras);
          if (rep) { net = rep.net; res = Fold.foldNet(net, 1); fixed = true; n = net.mask.size; }
        }
        ok = res.valid;
      }
      if (ok) pass++;
      results.push({
        shape: name, variant: v, n, ok, fixed, err,
        s: net ? net.s : 0, keys: net ? [...net.mask.keys()].join(' ') : '',
        extras: net && net.extras ? net.extras.length : 0, weak: net ? (net.weakCount || 0) : 0
      });
    }
  }
  const fails = results.filter(r => !r.ok);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / (times.length || 1));
  const max = Math.max(...times);
  return JSON.stringify({ summary: pass + '/' + total, avgMs: avg, maxMs: max, fails }, null, 1);
})()
