/* Node 端基准测试：自带极简画布光栅化，复刻浏览器 bench.js 的作图，
 * 用于在没有浏览器的情况下快速回归识别率。用法：node test/bench-node.js [--only 变体名] [--shape 形状名] */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console, Math, performance: require('perf_hooks').performance };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['mathx.js', 'detect.js', 'fold.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx, { filename: f });
}
const { Fold, Detect } = ctx;

/* ---------------- 极简画布 ---------------- */
class Surface {
  constructor(W, H, bg) {
    this.W = W; this.H = H;
    this.g = new Float32Array(W * H).fill(bg == null ? 255 : bg);
  }
  _blend(x, y, c, a) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H || a <= 0) return;
    if (a > 1) a = 1;
    const i = y * this.W + x;
    this.g[i] = this.g[i] * (1 - a) + c * a;
  }
  fillRect(x, y, w, h, c) {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this._blend(px, py, c, 1);
  }
  /* 矩形描边：外框减内框（含整数线宽无抗锯齿、非整数线宽带羽化） */
  strokeRect(x, y, w, h, lw, c) {
    const t = lw / 2;
    const ox0 = x - t, oy0 = y - t, ox1 = x + w + t, oy1 = y + h + t;
    const ix0 = x + t, iy0 = y + t, ix1 = x + w - t, iy1 = y + h - t;
    const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    const X0 = Math.floor(Math.min(ox0, ix0)), X1 = Math.ceil(Math.max(ox1, ix1));
    const Y0 = Math.floor(Math.min(oy0, iy0)), Y1 = Math.ceil(Math.max(oy1, iy1));
    for (let py = Y0; py < Y1; py++) {
      for (let px = X0; px < X1; px++) {
        const o = ov(px, px + 1, ox0, ox1) * ov(py, py + 1, oy0, oy1);
        const n = ov(px, px + 1, ix0, ix1) * ov(py, py + 1, iy0, iy1);
        const a = o - n;
        if (a > 0.001) this._blend(px, py, c, a);
      }
    }
  }
  /* 线段（用于斜线/图案），以 splat 方式近似 */
  line(a, b, lw, c) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const n = Math.max(2, Math.ceil(len * 3));
    const r = lw / 2;
    for (let k = 0; k <= n; k++) {
      const t = k / n, px = a[0] + dx * t, py = a[1] + dy * t;
      const rad = Math.ceil(r);
      for (let sy = -rad; sy <= rad; sy++) {
        for (let sx = -rad; sx <= rad; sx++) {
          const d = Math.hypot(px + sx + 0.5 - (px + 0.5), py + sy + 0.5 - (py + 0.5));
          if (d > r + 0.5) continue;
          const cov = Math.min(1, (r + 0.5 - d)) * (len / n) * 0.9;
          this._blend(Math.floor(px) + sx, Math.floor(py) + sy, c, cov);
        }
      }
    }
  }
  /* 虚线矩形（近似：按 dash 长度分段填充边框带） */
  strokeRectDash(x, y, w, h, lw, c, on, off) {
    const t = lw / 2;
    const oX0 = x - t, oY0 = y - t, oX1 = x + w + t, oY1 = y + h + t;
    const iX0 = x + t, iY0 = y + t, iX1 = x + w - t, iY1 = y + h - t;
    const band = (a, b, c2, d) => this.fillRect(a, b, c2 - a, d - b, c);
    for (let d = 0; d < w + lw; d += on + off) {
      const len = Math.min(on, w + lw - d);
      band(oX0 + d, oY0, oX0 + d + len, iY0);
      band(oX0 + d, iY1, oX0 + d + len, oY1);
    }
    for (let d = 0; d < h + lw; d += on + off) {
      const len = Math.min(on, h + lw - d);
      band(oX0, oY0 + d, iX0, oY0 + d + len);
      band(iX1, oY0 + d, oX1, oY0 + d + len);
    }
  }
  arc(cx, cy, r, lw, c) {
    const n = Math.max(24, Math.round(2 * Math.PI * r));
    for (let k = 0; k < n; k++) {
      const a0 = k / n * Math.PI * 2, a1 = (k + 1) / n * Math.PI * 2;
      this.line([cx + r * Math.cos(a0), cy + r * Math.sin(a0)],
                [cx + r * Math.cos(a1), cy + r * Math.sin(a1)], lw, c);
    }
  }
  blur(sigma) {
    const R = Math.max(1, Math.ceil(sigma * 2.5));
    const k = [];
    let sum = 0;
    for (let i = -R; i <= R; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(this.W * this.H), out = new Float32Array(this.W * this.H);
    for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) {
      let s = 0;
      for (let i = -R; i <= R; i++) { const xx = Math.min(this.W - 1, Math.max(0, x + i)); s += this.g[y * this.W + xx] * k[i + R]; }
      tmp[y * this.W + x] = s;
    }
    for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) {
      let s = 0;
      for (let i = -R; i <= R; i++) { const yy = Math.min(this.H - 1, Math.max(0, y + i)); s += tmp[yy * this.W + x] * k[i + R]; }
      out[y * this.W + x] = s;
    }
    this.g = out;
  }
  toImageData() {
    const d = new Uint8ClampedArray(this.W * this.H * 4);
    for (let i = 0; i < this.g.length; i++) {
      const v = Math.max(0, Math.min(255, Math.round(this.g[i])));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    return { width: this.W, height: this.H, data: d };
  }
}

/* ---------------- 作图（与浏览器 bench.js 保持一致） ---------------- */
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
const VARIANTS = ['plain','thin','thick','shade','hatch','frame','pattern',
  'small','large','blur','lightline','paperbg','multi',
  'text','noise','dash','multi3','photo'];
const TOP_PAD = { text: 40, photo: 26 };

function rng(seed) {
  let x = seed >>> 0;
  return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function draw(cells, variant) {
  const s = variant === 'small' ? 26 : variant === 'large' ? 92 : 44;
  const maxR = Math.max(...cells.map(c => c[0])), maxC = Math.max(...cells.map(c => c[1]));
  const pad = variant === 'frame' ? 26 : 12;
  const top = TOP_PAD[variant] || 0;
  let W = (maxC + 2) * s + pad * 2, H = (maxR + 2) * s + pad * 2 + top;
  if (variant === 'multi') W = Math.round(W * 2.1);
  if (variant === 'multi3') W = Math.round(W * 3.0);
  const S = new Surface(W, H, variant === 'paperbg' ? 246 : (variant === 'photo' ? 239 : 255));
  const C = variant === 'lightline' ? 138 : 0;
  const lw = variant === 'thin' ? 1 : variant === 'thick' ? 4 : variant === 'large' ? 3 : 2;
  const x0 = pad + s * 0.5, y0 = pad + s * 0.5 + top;
  const cell = (r, c) => [x0 + c * s, y0 + r * s];
  for (const [r, c] of cells) {
    const [x, y] = cell(r, c);
    if (variant === 'dash') S.strokeRectDash(x, y, s, s, lw, C, 6, 4);
    else S.strokeRect(x, y, s, s, lw, C);
  }

  if (variant === 'shade') {
    for (const idx of [0, 3]) {
      const [r, c] = cells[idx]; const [x, y] = cell(r, c);
      S.fillRect(x + lw, y + lw, s - 2 * lw, s - 2 * lw, 122);
    }
  }
  if (variant === 'hatch') {
    cells.forEach((rc, k) => {
      if (k % 2) return;
      const [x, y] = cell(rc[0], rc[1]);
      for (let d = -s; d < s; d += 5) {
        /* 裁剪到格子内 */
        const a = [x + 4 + d, y + 4], b = [x + 4 + d + s - 8, y + s - 4];
        const n = 64;
        for (let t = 0; t <= n; t++) {
          const px = a[0] + (b[0] - a[0]) * t / n, py = a[1] + (b[1] - a[1]) * t / n;
          if (px >= x + 3 && px <= x + s - 3 && py >= y + 3 && py <= y + s - 3) S._blend(Math.round(px), Math.round(py), 51, 1);
        }
      }
    });
  }
  if (variant === 'pattern') {
    cells.forEach((rc, k) => {
      const [x, y] = cell(rc[0], rc[1]); const cx = x + s / 2, cy = y + s / 2;
      if (k % 3 === 0) S.arc(cx, cy, s * 0.26, 3, C);
      else if (k % 3 === 1) {
        S.line([cx - s * 0.26, cy - s * 0.26], [cx + s * 0.26, cy + s * 0.26], 3, C);
        S.line([cx + s * 0.26, cy - s * 0.26], [cx - s * 0.26, cy + s * 0.26], 3, C);
      } else {
        const p = [[cx, cy - s * 0.28], [cx + s * 0.26, cy + s * 0.2], [cx - s * 0.26, cy + s * 0.2]];
        S.line(p[0], p[1], 3, C); S.line(p[1], p[2], 3, C); S.line(p[2], p[0], 3, C);
      }
    });
  }
  if (variant === 'frame') S.strokeRect(4, 4, W - 8, H - 8, 2, 0);
  const drawOptions = (n) => {
    const s2 = Math.round(s * 0.8);
    for (let k = 0; k < n; k++) {
      const sx = x0 + (maxC + 3 + k * 4) * s, sy = y0;
      for (const [r, c] of [[0,1],[1,0],[1,1],[1,2],[2,1],[3,1]]) S.strokeRect(sx + c * s2, sy + r * s2, s2, s2, 2, 0);
    }
  };
  if (variant === 'multi') drawOptions(1);
  if (variant === 'multi3') drawOptions(2);

  if (variant === 'text' || variant === 'photo') {
    S.fill = true;
    for (let k = 0; k < 22; k++) {
      const gx = 8 + k * 11, gy = 8 + (k % 3 === 0 ? 0 : 3);
      S.fillRect(gx, gy, 7, 12 - (k % 2) * 3, 34);
      if (k % 3 === 0) S.fillRect(gx + 1, gy - 4, 5, 3, 34);
    }
    for (let k = 0; k < 9; k++) S.fillRect(8 + k * 11, 26, 7, 10, 34);
    if (variant === 'photo') S.fillRect(x0 - 14, y0 + 4, 9, 13, 34);
  }
  if (variant === 'noise' || variant === 'photo') {
    const rnd = rng(987);
    const amount = variant === 'photo' ? 0.05 : 0.03;
    for (let i = 0; i < S.g.length; i++) {
      if (rnd() < amount) S.g[i] = rnd() < 0.5 ? 0 : 255;
      else if (variant === 'photo') S.g[i] += (rnd() - 0.5) * 26;
    }
  }
  if (variant === 'blur') S.blur(1.2);
  return S.toImageData();
}

/* ---------------- 跑分 ---------------- */
const args = process.argv.slice(2);
const only = (args.includes('--only') ? args[args.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const onlyShape = (args.includes('--shape') ? args[args.indexOf('--shape') + 1] : '').split(',').filter(Boolean);

const results = [], times = [];
let pass = 0, total = 0;
for (const [name, cells] of Object.entries(SHAPES)) {
  if (onlyShape.length && !onlyShape.includes(name)) continue;
  for (const v of VARIANTS) {
    if (only.length && !only.includes(v)) continue;
    total++;
    const d = draw(cells, v);
    let net = null, err = '';
    const t0 = performance.now();
    try { net = Detect.detectSquare(d); } catch (e) { err = e.message; }
    times.push(performance.now() - t0);
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
    results.push({ shape: name, variant: v, n, ok, fixed, err });
  }
}
const fails = results.filter(r => !r.ok);
const avg = times.reduce((a, b) => a + b, 0) / (times.length || 1);
console.log('summary:', pass + '/' + total, ' avgMs:', avg.toFixed(1), ' maxMs:', Math.max(...times).toFixed(1));
if (fails.length) {
  console.log('fails:');
  for (const f of fails) console.log('  -', f.shape, '/', f.variant, 'n=' + f.n, f.err || '');
}
