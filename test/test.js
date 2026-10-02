/* Node 单元测试：折叠引擎 + 识别模块（无需浏览器） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console, Math, window: null };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['mathx.js', 'detect.js', 'fold.js']) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
  vm.runInContext(code, ctx, { filename: f });
}
const { Fold, Detect } = ctx;

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

/* ---------- 1. 正方体折叠：十字展开图 ---------- */
console.log('[正方体折叠]');
{
  const mask = new Map([['0,1', 1], ['1,1', 1], ['2,0', 1], ['2,1', 1], ['2,2', 1], ['3,1', 1]].map(([k]) => [k, true]));
  const net = { type: 'square', origin: [30, 20], s: 40, mask };
  const res = Fold.foldNet(net, 1);
  assert('十字展开图有效', res.valid, res.message);
  assert('生成 6 个面', res.faces.length === 6);
  assert('对面配对 = 3 组', res.opposite.length === 3, 'got ' + res.opposite.length);
  assert('动画 t=0 时全部共面(z≈0)', res.faces.every(f => Math.abs(f.verts3.every ? Math.max(...f.verts3.map(v => Math.abs(v[2]))) : 0) < 1e-9) ||
    Fold.foldNet(net, 0).faces.every(f => f.verts3.every(v => Math.abs(v[2]) < 1e-9)));
  const labels = res.labels.filter(Boolean).sort().join('');
  assert('六个方位标签齐全', labels === ['上', '下', '左', '右', '前', '后'].sort().join(''), labels);
}

/* 无效展开图：4 连排 + 一端叠 2 个（L 尾） */
{
  const mask = new Map([['0,0', 1], ['0,1', 1], ['0,2', 1], ['0,3', 1], ['1,3', 1], ['2,3', 1]].map(([k]) => [k, true]));
  const res = Fold.foldNet({ type: 'square', origin: [0, 0], s: 40, mask }, 1);
  assert('L 尾展开图判无效', !res.valid, res.message);
}

/* 只有 5 个面 */
{
  const mask = new Map([['0,0', 1], ['0,1', 1], ['0,2', 1], ['1,1', 1], ['2,1', 1]].map(([k]) => [k, true]));
  const res = Fold.foldNet({ type: 'square', origin: [0, 0], s: 40, mask }, 1);
  assert('5 个面提示不足', !res.valid && /6 个面/.test(res.message), res.message);
}

/* 折叠朝向：3D 里的摆放必须与图片一致，不能上下镜像（镜像会改变手性，折叠结论会反） */
{
  const cells = [[0, 1], [1, 0], [1, 1], [1, 2], [1, 3], [2, 1]];
  const mask = new Map(cells.map(([r, c]) => [r + ',' + c, true]));
  const net = { type: 'square', origin: [0, 0], s: 40, mask };
  const flat = Fold.foldNet(net, 0);
  const cy2 = (f) => f.poly2d.reduce((s, p) => s + p[1], 0) / f.poly2d.length;
  const cy3 = (f) => f.verts3.reduce((s, v) => s + v[1], 0) / f.verts3.length;
  const topInImg = flat.faces.reduce((a, b) => (cy2(a) < cy2(b) ? a : b));
  const ys = flat.faces.map(cy3);
  assert('平铺时朝向与图片一致（图上最上一格在屏幕最上方）',
    Math.abs(cy3(topInImg) - Math.max(...ys)) < 1e-6,
    'top y=' + cy3(topInImg).toFixed(2) + ' max=' + Math.max(...ys).toFixed(2));
  assert('平铺时所有面法线朝 +Z（图案面朝观察者）',
    flat.faces.every(f => f.normal[2] > 0.99), flat.faces.map(f => f.normal[2].toFixed(2)).join(','));
  const res = Fold.foldNet(net, 1);
  assert('折叠后图案朝外（各面法线背离立方体中心）',
    res.faces.every(f => {
      const off = [f.center[0] - res.meanCenter[0], f.center[1] - res.meanCenter[1], f.center[2] - res.meanCenter[2]];
      const l = Math.hypot(off[0], off[1], off[2]) || 1;
      return (f.normal[0] * off[0] + f.normal[1] * off[1] + f.normal[2] * off[2]) / l > 0.9;
    }),
    res.faces.map(f => {
      const off = [f.center[0] - res.meanCenter[0], f.center[1] - res.meanCenter[1], f.center[2] - res.meanCenter[2]];
      const l = Math.hypot(off[0], off[1], off[2]) || 1;
      return ((f.normal[0] * off[0] + f.normal[1] * off[1] + f.normal[2] * off[2]) / l).toFixed(2);
    }).join(','));
  /* 十字展开图：竖排的上下两片应变成「前 / 后」，横排四片绕成一圈 */
  const labelAt = (r, c) => res.labels[res.faces.findIndex(f => f.key === r + ',' + c)];
  assert('方位标签正确（上/下/左/右/前/后各一次）',
    [[0, 1], [1, 0], [1, 1], [1, 2], [1, 3], [2, 1]].map(([r, c]) => labelAt(r, c))
      .sort().join('') === ['上', '下', '左', '右', '前', '后'].sort().join(''),
    [[0, 1], [1, 0], [1, 1], [1, 2], [1, 3], [2, 1]].map(([r, c]) => r + ',' + c + '=' + labelAt(r, c)).join(' '));
  assert('十字竖排两片互为对面', labelAt(0, 1) !== labelAt(2, 1) &&
    [['前', '后'], ['上', '下'], ['左', '右']].some(p =>
      p.includes(labelAt(0, 1)) && p.includes(labelAt(2, 1))));
}

/* ---------- 2. 四面体折叠 ---------- */
console.log('[四面体折叠]');
{
  /* 大三角展开图：up(0,0), up(1,0), up(0,1), down(0,0) */
  const tris = new Map([['0,0,1', 1], ['1,0,1', 1], ['0,1,1', 1], ['0,0,0', 1]].map(([k]) => [k, true]));
  const res = Fold.foldNet({ type: 'tri', origin: [40, 30], s: 60, theta: 0, tris }, 1);
  assert('大三角展开图有效', res.valid, res.message);
  assert('生成 4 个面', res.faces.length === 4);
}
{
  /* 条带展开图：up(0,0), down(0,0), up(1,0), down(1,0) */
  const tris = new Map([['0,0,1', 1], ['0,0,0', 1], ['1,0,1', 1], ['1,0,0', 1]].map(([k]) => [k, true]));
  const res = Fold.foldNet({ type: 'tri', origin: [40, 30], s: 60, theta: 0, tris }, 1);
  assert('条带展开图有效', res.valid, res.message);
}
{
  /* 4 个同向三角形排一排（无效） */
  const tris = new Map([['0,0,1', 1], ['1,0,1', 1], ['2,0,1', 1], ['3,0,1', 1]].map(([k]) => [k, true]));
  const res = Fold.foldNet({ type: 'tri', origin: [40, 30], s: 60, theta: 0, tris }, 1);
  assert('同向排排列判无效', !res.valid, res.message);
}

/* ---------- 3. 截图识别（合成图） ---------- */
console.log('[截图识别]');
function makeNetImage(cells, W, H, x0, y0, s, lw) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = (y * W + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = 0;
  };
  for (const [r, c] of cells) {
    const x = x0 + c * s, y = y0 + r * s;
    for (let k = 0; k < lw; k++) {
      for (let d = 0; d <= s; d++) {
        set(x + d, y + k); set(x + k, y + d);
        set(x + d, y + s - k); set(x + s - k, y + d);
      }
    }
  }
  return { width: W, height: H, data };
}
{
  /* 十字展开图截图 */
  const cells = [[0, 1], [1, 1], [2, 0], [2, 1], [2, 2], [3, 1]];
  const img = makeNetImage(cells, 260, 240, 40, 30, 40, 2);
  const net = Detect.detectSquare(img);
  assert('识别出正方体网格', !!net);
  if (net) {
    assert('识别出 6 个面', net.mask.size === 6, 'got ' + net.mask.size);
    /* 归一化比较形状（忽略原点偏移） */
    const shape = k => k.split(',').map(Number).map((v, i) => i === 0 ? v : v).join(',');
    const got = [...net.mask.keys()].map(k => {
      const [r, c] = k.split(',').map(Number);
      return (r - Math.round((30 - net.origin[1]) / 40)) + ',' + (c - Math.round((40 - net.origin[0]) / 40));
    }).sort();
    const want = cells.map(([r, c]) => r + ',' + c).sort();
    assert('网格形状与原图一致', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    const res = Fold.foldNet(net, 1);
    assert('识别结果可折叠为有效正方体', res.valid, res.message);
  }
}
{
  /* 四面体大三角展开图截图：边长 2s=120 */
  const W = 240, H = 220, s = 60;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = (y * W + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = 0;
  };
  const line = (a, b) => {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set(x + dx, y + dy);
    }
  };
  const O = [60, 40];
  const hgt = s * Math.sqrt(3) / 2;
  const P = (i, j) => [O[0] + i * s + j * s / 2, O[1] + j * hgt];
  /* 外框 */
  line(P(0, 0), P(2, 0)); line(P(2, 0), P(0, 2)); line(P(0, 2), P(0, 0));
  /* 内线 */
  line(P(1, 0), P(0, 1)); line(P(1, 0), P(1, 1)); line(P(0, 1), P(1, 1));
  const net = Detect.detectTriangle({ width: W, height: H, data });
  assert('识别出四面体网格', !!net);
  if (net) {
    assert('识别出 4 个三角形', net.tris.size === 4, 'got ' + net.tris.size);
    const res = Fold.foldNet(net, 1);
    assert('识别结果可折叠为有效四面体', res.valid, res.message);
  }
}

/* ---------- 4. 自动模式仲裁 ---------- */
console.log('[自动模式仲裁]');
{
  const cells = [[0, 1], [1, 1], [2, 0], [2, 1], [2, 2], [3, 1]];
  const cube = makeNetImage(cells, 260, 240, 40, 30, 40, 2);
  const a = Detect.autoDetect(cube);
  assert('正方体截图 auto 判为正方体', a && a.type === 'square', a && a.type);
}
{
  /* 四面体大三角 */
  const W = 240, H = 220, s = 60;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = (y * W + x) * 4; data[p] = data[p + 1] = data[p + 2] = 0;
  };
  const line = (a, b) => {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        set(Math.round(a[0] + (b[0] - a[0]) * t) + dx, Math.round(a[1] + (b[1] - a[1]) * t) + dy);
    }
  };
  const O = [60, 40], hgt = s * Math.sqrt(3) / 2;
  const P = (i, j) => [O[0] + i * s + j * s / 2, O[1] + j * hgt];
  line(P(0, 0), P(2, 0)); line(P(2, 0), P(0, 2)); line(P(0, 2), P(0, 0));
  line(P(1, 0), P(0, 1)); line(P(1, 0), P(1, 1)); line(P(0, 1), P(1, 1));
  const a = Detect.autoDetect({ width: W, height: H, data });
  assert('四面体截图 auto 判为四面体', a && a.type === 'tri', a && a.type);
}

/* 面内有封闭图案（圆/方/三角）时不能干扰格距估算 */
{
  const W = 300, H = 260, s = 44;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = (y * W + x) * 4; data[p] = data[p + 1] = data[p + 2] = 0;
  };
  const x0 = 40, y0 = 30;
  for (const [r, c] of [[0, 1], [1, 1], [2, 0], [2, 1], [2, 2], [3, 1]]) {
    const x = x0 + c * s, y = y0 + r * s;
    for (const k of [-1, 0]) {
      for (let d = 0; d <= s; d++) {
        set(x + d, y + k); set(x + k, y + d);
        set(x + d, y + s - k); set(x + s - k, y + d);
      }
    }
  }
  /* 每个面中心画 14×14 的方框（封闭图案） */
  for (const [r, c] of [[0, 1], [1, 1], [2, 0], [2, 1], [2, 2], [3, 1]]) {
    const cx = x0 + c * s + s / 2, cy = y0 + r * s + s / 2;
    for (let d = -7; d <= 7; d++) {
      set(cx + d, cy - 7); set(cx + d, cy + 7);
      set(cx - 7, cy + d); set(cx + 7, cy + d);
    }
  }
  const net = Detect.detectSquare({ width: W, height: H, data });
  assert('面内封闭图案不干扰识别', !!net && net.mask.size === 6, net ? net.mask.size + ' cells, s=' + net.s : 'null');
  if (net) assert('带图案截图可折叠为有效正方体', Fold.foldNet(net, 1).valid);
}

console.log(`\n结果：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
