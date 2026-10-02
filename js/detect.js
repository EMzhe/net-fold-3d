/* 截图识别模块：从展开图截图中识别网格
 *
 * 思路：
 * 1. Otsu 二值化 → 深色(线条)掩码，膨胀 1px 封闭抗锯齿缝隙
 * 2. 白色连通域分析：被线条完全围住的白色区域 = 空白格子 → 推断格距
 * 3. 正方体：对格点上每个格子做“四边环检测”（有边线即为格子），去掉洞
 * 4. 四面体：对三角格点参数(角度/边长/相位)做小范围暴力搜索，取边线匹配最多的一组
 */
(function (global) {
  'use strict';

  /* ---------- 基础：灰度 + Otsu + 膨胀 ---------- */
  function binarize(imageData) {
    const { width: w, height: h, data } = imageData;
    const gray = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      const g = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000 | 0;
      gray[i] = g;
      hist[g]++;
    }
    // Otsu
    let total = w * h, sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, maxVar = -1, th = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; th = i; }
    }
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) bin[i] = gray[i] <= th ? 1 : 0;
    return { w, h, bin };
  }

  function dilate(bin, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let d = 0;
        for (let dy = -1; dy <= 1 && !d; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (bin[yy * w + xx]) { d = 1; break; }
          }
        }
        out[y * w + x] = d;
      }
    }
    return out;
  }

  /* 白色 4-连通域，返回 [{minX,minY,maxX,maxY,area,touchBorder}] */
  function whiteComponents(bin, w, h) {
    const label = new Int32Array(w * h).fill(-1);
    const comps = [];
    const stack = new Int32Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (bin[start] || label[start] !== -1) continue;
      const id = comps.length;
      let sp = 0;
      stack[sp++] = start;
      label[start] = id;
      const c = { minX: w, minY: h, maxX: 0, maxY: 0, area: 0, touchBorder: false };
      while (sp > 0) {
        const cur = stack[--sp];
        const cx = cur % w, cy = (cur / w) | 0;
        c.area++;
        if (cx < c.minX) c.minX = cx;
        if (cy < c.minY) c.minY = cy;
        if (cx > c.maxX) c.maxX = cx;
        if (cy > c.maxY) c.maxY = cy;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) c.touchBorder = true;
        if (cx > 0 && !bin[cur - 1] && label[cur - 1] === -1) { label[cur - 1] = id; stack[sp++] = cur - 1; }
        if (cx < w - 1 && !bin[cur + 1] && label[cur + 1] === -1) { label[cur + 1] = id; stack[sp++] = cur + 1; }
        if (cy > 0 && !bin[cur - w] && label[cur - w] === -1) { label[cur - w] = id; stack[sp++] = cur - w; }
        if (cy < h - 1 && !bin[cur + w] && label[cur + w] === -1) { label[cur + w] = id; stack[sp++] = cur + w; }
      }
      comps.push(c);
    }
    return comps;
  }

  function darkBBox(bin, w, h) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (bin[y * w + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY };
  }

  /* tol：像素容差（默认 ±1，用于正交线；斜线格点匹配可用 ±2 以容忍相位误差） */
  const isDark = (bin, w, h, x, y, tol) => {
    tol = tol || 1;
    x |= 0; y |= 0;
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return false;
    if (bin[y * w + x]) return true;
    for (let dy = -tol; dy <= tol; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -tol; dx <= tol; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        if (bin[yy * w + xx]) return true;
      }
    }
    return false;
  };

  /* 线段 p1→p2 上的深色像素比例 */
  function segDarkRatio(bin, w, h, p1, p2, n, tol) {
    n = n || 8;
    let hit = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      if (isDark(bin, w, h, p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t, tol)) hit++;
    }
    return hit / n;
  }

  const median = (arr) => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[a.length >> 1];
  };

  /* ---------- 正方体展开图 ---------- */
  function detectSquare(imageData) {
    const { w, h, bin: raw } = binarize(imageData);
    const bin = dilate(raw, w, h);
    const comps = whiteComponents(bin, w, h);
    let enclosed = comps.filter(c =>
      !c.touchBorder && c.area >= 30 &&
      (c.maxX - c.minX) >= 8 && (c.maxY - c.minY) >= 8);
    if (!enclosed.length) return null;

    /* 过滤掉格子内部图案（圆/方/三角等）形成的封闭区域：真实格子内框尺寸最大且一致 */
    const maxW = Math.max(...enclosed.map(c => c.maxX - c.minX));
    const maxH = Math.max(...enclosed.map(c => c.maxY - c.minY));
    let cellRegions = enclosed.filter(c =>
      (c.maxX - c.minX) >= 0.7 * maxW && (c.maxY - c.minY) >= 0.7 * maxH);
    if (!cellRegions.length) cellRegions = enclosed;

    /* 内框矩形：估算格距 s 与原点 */
    const xs = [...new Set(cellRegions.map(c => c.minX))].sort((a, b) => a - b);
    const ys = [...new Set(cellRegions.map(c => c.minY))].sort((a, b) => a - b);
    let diffs = [];
    for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] >= 10) diffs.push(xs[i] - xs[i - 1]);
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] >= 10) diffs.push(ys[i] - ys[i - 1]);
    let s = median(diffs.filter(d => d < 400));
    if (s) {
      /* 去掉跨列（缺列）造成的 2s 值：只保留接近中位数的间距 */
      const near = diffs.filter(d => d >= 0.75 * s && d <= 1.35 * s);
      if (near.length) s = median(near);
    }
    if (!s) s = median(cellRegions.map(c => c.maxX - c.minX)) + 6;
    if (s < 12) return null;
    const innerW = median(cellRegions.map(c => c.maxX - c.minX));
    const lw = Math.max(1, Math.min(6, Math.round((s - innerW) / 2)));
    const x0 = Math.min(...xs) - lw;
    const y0 = Math.min(...ys) - lw;

    const bbox = darkBBox(bin, w, h) || { minX: x0, minY: y0, maxX: x0 + s, maxY: y0 + s };
    const cols = Math.min(14, Math.max(1, Math.ceil((bbox.maxX - x0) / s) + 1));
    const rows = Math.min(14, Math.max(1, Math.ceil((bbox.maxY - y0) / s) + 1));

    const mask = new Map();
    /* 1) 白色封闭区域（格子内框）→ 格子 */
    for (const c of cellRegions) {
      const cc = Math.round((c.minX + (c.maxX - c.minX) / 2 - (x0 + s / 2)) / s);
      const cr = Math.round((c.minY + (c.maxY - c.minY) / 2 - (y0 + s / 2)) / s);
      if (cr >= 0 && cr < rows && cc >= 0 && cc < cols) mask.set(cr + ',' + cc, true);
    }
    /* 2) 环检测补齐（阴影面/带图案面：边框线全为深色） */
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = r + ',' + c;
        if (mask.has(key)) continue;
        if (cellRingDark(bin, w, h, x0 + c * s, y0 + r * s, s)) mask.set(key, true);
      }
    }
    if (!mask.size) return null;
    keepLargestComponent(mask);
    if (mask.size < 3) return null;
    return { type: 'square', origin: [x0, y0], s, mask };
  }

  /* 四条边是否都有线条 */
  function cellRingDark(bin, w, h, x, y, s) {
    const m = Math.max(2, s * 0.06), e = s - m;
    const n = Math.max(5, Math.round(s / 6));
    const edges = [
      [[x + m, y], [x + e, y]],
      [[x + s, y + m], [x + s, y + e]],
      [[x + m, y + s], [x + e, y + s]],
      [[x, y + m], [x, y + e]]
    ];
    return edges.every(ed => segDarkRatio(bin, w, h, ed[0], ed[1], n) >= 0.55);
  }

  /* 正方形 mask 的 4-连通最大组件 */
  function keepLargestComponent(mask) {
    if (mask.size <= 1) return;
    const keys = [...mask.keys()];
    const pos = new Map(keys.map(k => { const [r, c] = k.split(',').map(Number); return [k, [r, c]]; }));
    const seen = new Set();
    let best = null;
    for (const k of keys) {
      if (seen.has(k)) continue;
      const comp = [k];
      seen.add(k);
      for (let i = 0; i < comp.length; i++) {
        const [r, c] = pos.get(comp[i]);
        for (const d of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nk = (r + d[0]) + ',' + (c + d[1]);
          if (mask.has(nk) && !seen.has(nk)) { seen.add(nk); comp.push(nk); }
        }
      }
      if (!best || comp.length > best.length) best = comp;
    }
    mask.clear();
    for (const k of best) mask.set(k, true);
  }

  /* ---------- 四面体展开图（三角格点暴力搜索） ---------- */
  function detectTriangle(imageData) {
    const { w, h, bin: raw } = binarize(imageData);
    const bin = dilate(raw, w, h);
    const bbox = darkBBox(bin, w, h);
    if (!bbox) return null;
    const bw = bbox.maxX - bbox.minX, bh = bbox.maxY - bbox.minY;
    if (bw < 30 || bh < 25) return null;

    const comps = whiteComponents(bin, w, h);
    const enclosedAll = comps.filter(c =>
      !c.touchBorder && c.area >= 25 &&
      (c.maxX - c.minX) >= 7 && (c.maxY - c.minY) >= 5);
    let enclosed = enclosedAll.slice();
    /* 过滤格子内部图案形成的封闭区域 */
    if (enclosed.length > 1) {
      const mw = Math.max(...enclosed.map(c => c.maxX - c.minX));
      const mh = Math.max(...enclosed.map(c => c.maxY - c.minY));
      const filtered = enclosed.filter(c =>
        (c.maxX - c.minX) >= 0.65 * mw && (c.maxY - c.minY) >= 0.65 * mh);
      if (filtered.length) enclosed = filtered;
    }

    /* 候选边长：来自白色三角形内框 + 包围盒尺寸 */
    const sCands = new Set();
    if (enclosed.length) {
      const base = median(enclosed.map(c => c.maxX - c.minX)) + 5;
      if (base >= 15) {
        for (let k = 0; k < 7; k++) sCands.add(Math.round(base * (0.82 + k * 0.06)));
      }
    }
    for (const k of [2, 3, 4]) {
      sCands.add(Math.round(bw / k));
      sCands.add(Math.round(bh / (k * 0.866)));
    }
    const sList = [...sCands].filter(s => s >= 15 && s <= Math.max(bw, bh) + 10).sort((a, b) => a - b);

    /* 空白面的中心点：真实网格必须能“解释”这些面 */
    const regionCenters = enclosed.map(c => [(c.minX + c.maxX) / 2, (c.minY + c.maxY) / 2]);
    const needExplain = Math.min(4, regionCenters.length);

    /* 图形实际面积（各白色面区域 + 线条/涂色像素）：
     * 真实网格选出的面片总面积应当与之相当（≈1 倍） */
    let darkCount = 0;
    for (let i = 0; i < raw.length; i++) darkCount += raw[i];   // 用未膨胀图，避免线宽被高估
    let whiteArea = 0;
    for (const c of enclosedAll) whiteArea += c.area;
    const figureArea = Math.max(1, whiteArea + darkCount);

    /* 评估某一组格点参数：返回命中三角形、面数、解释长度等 */
    const evalCfg = (O, u, v, s, theta) => {
      const r = tryTriangleLattice(bin, w, h, O, u, v, bbox, s);
      if (r.tris.size < 3) return null;
      /* 只保留最大连通块：图案/文字造成的孤立伪三角形会被剔除 */
      keepLargestTriComponent(r.tris);
      const cnt = r.tris.size;
      if (cnt < 3) return null;
      /* 用“空白面中心落在哪些格点三角形内”反推真实的 4 个面，
       * 这样即使图案让格点多出伪三角形，也不会被选中 */
      const faceTris = trisOfRegions(r.tris, O, u, v, regionCenters);
      keepLargestTriComponent(faceTris);
      let fcnt = faceTris.size;
      if (fcnt > 6) fcnt = 0;                        // 面数明显过多 → 该格距不可信
      /* 涂色面没有白色区域：用相邻且边线完整的三角形补足到 4 个 */
      if (fcnt >= 1 && fcnt < 4) {
        for (const k of r.tris.keys()) {
          if (fcnt >= 4) break;
          if (faceTris.has(k)) continue;
          if (triNeighbors(k).some(nk => faceTris.has(nk))) { faceTris.set(k, true); fcnt++; }
        }
      }
      const useFaces = fcnt >= needExplain && needExplain >= 1;
      const faceArea = (useFaces ? fcnt : cnt) * 0.4330127 * s * s;
      const fill = faceArea / figureArea;
      return {
        tris: useFaces ? faceTris : r.tris, count: cnt, fcnt, useFaces,
        fill, ok: fill >= 0.72 && fill <= 1.35,
        coverage: r.coverage, s, theta, origin: O
      };
    };

    /* 打分：面片总面积贴合图形实际面积 > 面数为 4 > 能解释各空白面 > 解释线条长度 */
    const score = (r) => {
      const n = r.useFaces ? r.fcnt : r.count;
      return (r.ok ? 100 : 0) + (n === 4 ? 20 : 0) + (n <= 5 ? 10 : 0) +
        (r.useFaces ? 40 : 0) + Math.max(0, 30 - Math.abs(r.fill - 1) * 30) +
        Math.min(r.coverage, 4000) / 10000;
    };
    const better = (a, b) => !b || score(a) > score(b);

    /* 阶段 1：粗搜（角度 × 格距 × 相位） */
    let best = null;
    for (const thetaDeg of [0, 30]) {
      const theta = thetaDeg * Math.PI / 180;
      const ct = Math.cos(theta), st = Math.sin(theta);
      for (const s of sList) {
        const u = [s * ct, s * st];
        const v = [s * Math.cos(theta + Math.PI / 3), s * Math.sin(theta + Math.PI / 3)];
        for (let a = 0; a < 10; a++) {
          for (let b = 0; b < 10; b++) {
            const O = [
              bbox.minX + (a / 10) * u[0] + (b / 10) * v[0] - s,
              bbox.minY + (a / 10) * u[1] + (b / 10) * v[1] - s
            ];
            const r = evalCfg(O, u, v, s, theta);
            if (r && better(r, best)) best = r;
          }
        }
      }
    }
    /* 阶段 2：在最优结果附近做精细相位微调（粗搜相位步长 s/6 太粗） */
    if (best) {
      const theta = best.theta, s = best.s;
      const u = [s * Math.cos(theta), s * Math.sin(theta)];
      const v = [s * Math.cos(theta + Math.PI / 3), s * Math.sin(theta + Math.PI / 3)];
      for (let p = -6; p <= 6; p++) {
        for (let q = -6; q <= 6; q++) {
          const O = [best.origin[0] + (p / 36) * u[0] + (q / 36) * v[0],
                     best.origin[1] + (p / 36) * u[1] + (q / 36) * v[1]];
          const r = evalCfg(O, u, v, s, theta);
          if (r && better(r, best)) best = r;
        }
      }
    }
    if (!best) return null;
    if (best.tris.size < 3) return null;
    return { type: 'tri', origin: best.origin, s: best.s, theta: best.theta, tris: best.tris };
  }

  /* 三角格点中某格的三个邻接格（共享边） */
  function triNeighbors(key) {
    const [i, j, up] = key.split(',').map(Number);
    const k = (a, b, u2) => a + ',' + b + ',' + (u2 ? 1 : 0);
    return up ? [k(i, j - 1, 0), k(i, j, 0), k(i - 1, j, 0)]
              : [k(i, j, 1), k(i + 1, j, 1), k(i, j + 1, 1)];
  }

  /* 找出“内部含空白面中心”的格点三角形 */
  function trisOfRegions(tris, O, u, v, centers) {
    const out = new Map();
    if (!centers || !centers.length) return out;
    for (const k of tris.keys()) {
      const [i, j, up] = k.split(',').map(Number);
      const A = [O[0] + i * u[0] + j * v[0], O[1] + i * u[1] + j * v[1]];
      const B = [A[0] + u[0], A[1] + u[1]];
      const C = [O[0] + i * u[0] + (j + 1) * v[0], O[1] + i * u[1] + (j + 1) * v[1]];
      const poly = up ? [A, B, C] : [B, C, [B[0] + v[0], B[1] + v[1]]];
      if (centers.some(c => global.MX.pointInTriangle(c, poly[0], poly[1], poly[2]))) out.set(k, true);
    }
    return out;
  }

  function tryTriangleLattice(bin, w, h, O, u, v, bbox, s) {
    const P = (i, j) => [O[0] + i * u[0] + j * v[0], O[1] + i * u[1] + j * v[1]];
    const margin = s * 0.3;
    const iMax = Math.ceil((bbox.maxX - bbox.minX + 2 * s) / s) + 2;
    const jMax = Math.ceil((bbox.maxY - bbox.minY + 2 * s) / (s * 0.866)) + 2;
    const tris = new Map();
    const inBox = (p) => p[0] >= bbox.minX - margin && p[0] <= bbox.maxX + margin &&
                         p[1] >= bbox.minY - margin && p[1] <= bbox.maxY + margin;
    let coverage = 0;   // 该格点能解释的线条长度（按命中比例加权）
    const ratio = (a, b) => {
      const r = segDarkRatio(bin, w, h, a, b, 8, 2);
      coverage += r * Math.hypot(b[0] - a[0], b[1] - a[1]);
      return r;
    };
    for (let i = -2; i <= iMax; i++) {
      for (let j = -2; j <= jMax; j++) {
        const A = P(i, j), B = P(i + 1, j), C = P(i, j + 1), D = P(i + 1, j + 1);
        if (inBox(A) && inBox(B) && inBox(C)) {
          if (ratio(A, B) >= 0.5 && ratio(B, C) >= 0.5 && ratio(C, A) >= 0.5) tris.set(i + ',' + j + ',1', true);
        }
        if (inBox(B) && inBox(C) && inBox(D)) {
          if (ratio(B, C) >= 0.5 && ratio(C, D) >= 0.5 && ratio(D, B) >= 0.5) tris.set(i + ',' + j + ',0', true);
        }
      }
    }
    return { tris, coverage };
  }

  /* 三角 mask 的边邻接最大组件 */
  function keepLargestTriComponent(tris) {
    if (tris.size <= 1) return;
    /* 邻接：共享两个顶点。直接按格点坐标匹配 */
    const keyOf = (i, j, up) => i + ',' + j + ',' + (up ? 1 : 0);
    const neighborsOf = (key) => {
      const [i, j, up] = key.split(',').map(Number);
      return up
        ? [keyOf(i, j - 1, 0), keyOf(i, j, 0), keyOf(i - 1, j, 0)]
        : [keyOf(i, j, 1), keyOf(i + 1, j, 1), keyOf(i, j + 1, 1)];
    };
    const seen = new Set();
    let best = null;
    for (const k of tris.keys()) {
      if (seen.has(k)) continue;
      const comp = [k];
      seen.add(k);
      for (let x = 0; x < comp.length; x++) {
        for (const nk of neighborsOf(comp[x])) {
          if (nk && tris.has(nk) && !seen.has(nk)) { seen.add(nk); comp.push(nk); }
        }
      }
      if (!best || comp.length > best.length) best = comp;
    }
    tris.clear();
    for (const k of best) tris.set(k, true);
  }

  /* 线条方向统计：正方体展开图主要为正交线条，四面体展开图含大量 60° 斜线 */
  function orientationStats(bin, w, h) {
    let axis = 0, diag = 0;
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        if (!bin[y * w + x]) continue;
        const l = bin[y * w + x - 1], r = bin[y * w + x + 1];
        const u = bin[(y - 1) * w + x], d = bin[(y + 1) * w + x];
        if ((l && r) || (u && d)) axis++;
        else if ((bin[(y - 1) * w + x - 1] && bin[(y + 1) * w + x + 1]) ||
                 (bin[(y - 1) * w + x + 1] && bin[(y + 1) * w + x - 1])) diag++;
      }
    }
    return { axis, diag };
  }

  /* ---------- 自动：两套检测器都跑，按可信度打分择一 ---------- */
  function autoDetect(imageData) {
    const sq = detectSquare(imageData);
    const tr = detectTriangle(imageData);
    const scoreS = sq ? (sq.mask.size === 6 ? 5 : sq.mask.size === 5 ? 3 : sq.mask.size === 4 ? 2 : 1) : 0;
    const scoreT = tr ? (tr.tris.size === 4 ? 5 : tr.tris.size === 3 ? 3 : 2) : 0;
    if (scoreT > scoreS) return tr || sq;
    return sq || tr;
  }

  global.Detect = { binarize, detectSquare, detectTriangle, autoDetect, orientationStats };
})(window);
