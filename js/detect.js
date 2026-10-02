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

  /* 孤立暗像素占比：椒盐噪点/压缩噪点会让绝大多数暗像素“没有邻居” */
  function isolatedRatio(bin, w, h) {
    let dark = 0, iso = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!bin[i]) continue;
        dark++;
        let c = 0;
        for (let dy = -1; dy <= 1 && c === 0; dy++) {
          const r = (y + dy) * w;
          for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && bin[r + x + dx]) { c++; break; }
        }
        if (c === 0) iso++;
      }
    }
    return dark ? iso / dark : 0;
  }

  /* 去孤立点：噪点像素周围没有同伴，真实线条像素至少有一个同方向邻居 */
  function denoise(bin, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!bin[i]) continue;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const r = (y + dy) * w;
          for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && bin[r + x + dx]) c++;
        }
        if (c >= 2) out[i] = 1;
      }
    }
    return out;
  }

  /* 把暗连通域按“空间邻近”聚成若干图形：
   * 同一张展开图被虚线/噪点切成很多碎块时会重新并成一个，
   * 而并排的两个选项（相距很远）会正确地分成两簇。 */
  function clusterComponents(comps, gap) {
    const n = comps.length;
    const par = new Int32Array(n);
    for (let i = 0; i < n; i++) par[i] = i;
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[b] = a; };
    for (let i = 0; i < n; i++) {
      const A = comps[i];
      for (let j = i + 1; j < n; j++) {
        const B = comps[j];
        if (A.minX - gap <= B.maxX && B.minX - gap <= A.maxX &&
            A.minY - gap <= B.maxY && B.minY - gap <= A.maxY) uni(i, j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let g = groups.get(r);
      if (!g) { g = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, area: 0 }; groups.set(r, g); }
      const c = comps[i];
      g.area += c.area;
      if (c.minX < g.minX) g.minX = c.minX;
      if (c.maxX > g.maxX) g.maxX = c.maxX;
      if (c.minY < g.minY) g.minY = c.minY;
      if (c.maxY > g.maxY) g.maxY = c.maxY;
    }
    return [...groups.values()];
  }

  /* 选出要分析的那个图形的包围盒（排除题干文字、其它选项等） */
  function selectFigure(bin, w, h) {
    const bbox = darkBBox(bin, w, h);
    if (!bbox) return null;
    const comps = darkComponents(bin, w, h).filter(c => c.area >= 4);
    if (!comps.length || comps.length > 3000) return { bbox, multi: false };
    const clusters = clusterComponents(comps, 10).sort((a, b) => b.area - a.area);
    const top = clusters[0];
    const total = clusters.reduce((s, c) => s + c.area, 0);
    const bw = top.maxX - top.minX, bh = top.maxY - top.minY;
    if (clusters.length > 1 && top.area >= total * 0.3 && bw >= 24 && bh >= 24 && top.area < total * 0.97) {
      return { bbox: { minX: top.minX, minY: top.minY, maxX: top.maxX, maxY: top.maxY }, multi: true };
    }
    /* 只有一簇（或碎块本来就紧挨着）：用整体包围盒，但剔除明显远离主体的碎屑 */
    if (clusters.length > 1 && top.area >= total * 0.85) {
      return { bbox: { minX: top.minX, minY: top.minY, maxX: top.maxX, maxY: top.maxY }, multi: false };
    }
    return { bbox, multi: false };
  }

  /* 二值化 →（必要时）降噪 → 膨胀，得到最终线条掩码 */
  function toBinary(imageData) {
    const { w, h, bin } = binarize(imageData);
    const clean = isolatedRatio(bin, w, h) > 0.12 ? denoise(bin, w, h) : bin;
    return { w, h, bin: dilate(clean, w, h), raw: clean };
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

  /* 把包围盒区域裁剪出来（带白边），后续分析只在裁剪图上进行。
   * 作用：一张截图里有多个图形（如选项 A/B/C/D 并排）时，
   * 其它图形的线条不会混进网格线集合、不会污染格距投票。
   * 返回 {bin,w,h,ox,oy,box}，box 为裁剪图内的相对包围盒。 */
  function cropRegion(bin, w, h, box, pad) {
    pad = pad == null ? 4 : pad;
    const ox = Math.max(0, box.minX - pad), oy = Math.max(0, box.minY - pad);
    const ex = Math.min(w - 1, box.maxX + pad), ey = Math.min(h - 1, box.maxY + pad);
    const cw = ex - ox + 1, chh = ey - oy + 1;
    const out = new Uint8Array(cw * chh);
    for (let y = 0; y < chh; y++) {
      const src = (oy + y) * w + ox, dst = y * cw;
      for (let x = 0; x < cw; x++) out[dst + x] = bin[src + x];
    }
    return {
      bin: out, w: cw, h: chh, ox, oy,
      box: { minX: box.minX - ox, minY: box.minY - oy, maxX: box.maxX - ox, maxY: box.maxY - oy }
    };
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

  /* ---------- 长直线检测：找出图中的网格线 ----------
   * 沿列(或行)扫描，取出长度 ≥ minLen 的连续暗段（允许 1px 缝隙）。
   * 返回统一格式 {pos, a, b, len, segs}，pos 为所在列号/行号，[a,b] 为另一方向的区间。 */
  function scanLongRuns(bin, w, h, minLen, vertical) {
    const out = [];
    const outer = vertical ? w : h;   // 扫描线数量
    const inner = vertical ? h : w;   // 每条线的长度
    for (let p = 0; p < outer; p++) {
      const segs = [];
      let start = -1, end = -1, gap = 0, cnt = 0;
      for (let q = 0; q < inner; q++) {
        const idx = vertical ? q * w + p : p * w + q;
        if (bin[idx]) {
          if (start < 0) { start = q; cnt = 0; }
          end = q; cnt++; gap = 0;
        } else if (start >= 0) {
          gap++;
          if (gap > 1) { segs.push([start, end, cnt]); start = -1; }
        }
      }
      if (start >= 0) segs.push([start, end, cnt]);
      /* 只保留“够长且够密实”的段：
       * 实线/虚线占空比高（≈1 / ≈0.6），斜线阴影之类的稀疏像素会被排除 */
      const long = segs.filter(s =>
        s[1] - s[0] + 1 >= minLen && s[2] / (s[1] - s[0] + 1) >= 0.45);
      if (!long.length) continue;
      let best = long[0];
      for (const s of long) if (s[1] - s[0] > best[1] - best[0]) best = s;

      /* 排除“色块”：在段中点处量一下横向厚度，真实线条很细，涂色面/实心图案很厚 */
      const mid = (best[0] + best[1]) >> 1;
      let th = 1;
      for (let d = 1; d <= 14; d++) {
        const q = vertical ? p - d : p - d;
        if (q < 0) break;
        const idx = vertical ? mid * w + q : q * w + mid;
        if (bin[idx]) th++; else break;
      }
      for (let d = 1; d <= 14; d++) {
        const q = vertical ? p + d : p + d;
        if (q >= (vertical ? w : h)) break;
        const idx = vertical ? mid * w + q : q * w + mid;
        if (bin[idx]) th++; else break;
      }
      if (th > 9) continue;   // 太厚 → 是色块不是线

      out.push({ pos: p, a: best[0], b: best[1], len: best[1] - best[0] + 1, segs: long, th });
    }
    return out;
  }

  /* 把相邻扫描线的段合并成“一条线”（线本身有宽度，膨胀后更宽） */
  function clusterLines(runs, tolPos) {
    tolPos = tolPos || 3;
    runs = [...runs].sort((a, b) => a.pos - b.pos);
    const groups = [];
    let cur = null;
    for (const r of runs) {
      if (cur && r.pos - cur.lastPos <= tolPos) { cur.lastPos = r.pos; cur.items.push(r); }
      else { cur = { lastPos: r.pos, items: [r] }; groups.push(cur); }
    }
    const lines = groups.map(g => {
      let best = g.items[0];
      for (const it of g.items) if (it.len > best.len) best = it;
      let a = Infinity, b = -Infinity;
      for (const it of g.items) { a = Math.min(a, it.a); b = Math.max(b, it.b); }
      /* 线位置取组内中位，避免线宽造成的偏移 */
      const poss = g.items.map(it => it.pos).sort((x, y) => x - y);
      const first = poss[0], last = poss[poss.length - 1];
      return { pos: poss[poss.length >> 1], a, b, len: best.len, span: b - a + 1, w: last - first + 1 };
    });
    /* 过滤过宽的“线”：涂色块 / 实心图案的横向宽度远大于真实线条 */
    if (lines.length >= 3) {
      const ws = lines.map(l => l.w).sort((x, y) => x - y);
      const wm = ws[ws.length >> 1];
      const limit = Math.max(wm + 2, Math.min(12, wm * 3));
      const kept = lines.filter(l => l.w <= limit);
      if (kept.length >= 2) return kept;
    }
    return lines;
  }

  /* 图形最外侧那条线的位置：沿图形中部若干扫描线取首个/末个暗像素的中位数。
   * 比包围盒更准（包围盒被膨胀放大了一圈），且虚线也能测到。 */
  function boundaryLines(bin, w, h, box) {
    const bw = box.maxX - box.minX, bh = box.maxY - box.minY;
    const y0 = box.minY + Math.round(bh * 0.2), y1 = box.minY + Math.round(bh * 0.8);
    const x0 = box.minX + Math.round(bw * 0.2), x1 = box.minX + Math.round(bw * 0.8);
    const L = [], R = [], T = [], B = [];
    const lim = 12;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
      for (let x = box.minX; x <= Math.min(w - 1, box.minX + lim); x++) if (bin[y * w + x]) { L.push(x); break; }
      for (let x = Math.min(w - 1, box.maxX); x >= Math.max(0, box.maxX - lim); x--) if (bin[y * w + x]) { R.push(x); break; }
    }
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
      for (let y = box.minY; y <= Math.min(h - 1, box.minY + lim); y++) if (bin[y * w + x]) { T.push(y); break; }
      for (let y = Math.min(h - 1, box.maxY); y >= Math.max(0, box.maxY - lim); y--) if (bin[y * w + x]) { B.push(y); break; }
    }
    return {
      left: L.length ? median(L) : box.minX, right: R.length ? median(R) : box.maxX,
      top: T.length ? median(T) : box.minY, bottom: B.length ? median(B) : box.maxY
    };
  }

  /* 由一组线的位置投票出可能的格距（返回按票数排序的候选） */
  function spacingCandidates(positions, minGap, maxGap) {
    const votes = new Map();
    const uniq = [...new Set(positions)].sort((a, b) => a - b);
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const d = uniq[j] - uniq[i];
        if (d < minGap || d > maxGap) continue;
        let hit = null;
        for (const k of votes.keys()) {
          if (Math.abs(k - d) <= Math.max(2, d * 0.05)) { hit = k; break; }
        }
        votes.set(hit === null ? d : hit, (votes.get(hit === null ? d : hit) || 0) + 1);
      }
    }
    const list = [...votes.entries()].map(([d, v]) => ({ d, v })).sort((a, b) => b.v - a.v || a.d - b.d);
    /* 若第一名的近似一半也有较多票，则把一半也作为候选（相邻列缺失导致的 2s） */
    const out = [];
    for (const item of list.slice(0, 6)) {
      out.push(item.d);
      const half = item.d / 2;
      if (half >= minGap && list.some(x => Math.abs(x.d - half) <= Math.max(2, half * 0.08))) out.push(half);
    }
    return [...new Set(out.map(Math.round))];
  }

  /* 计算网格中每个格子的四边完整度（tol 越大越能容忍相位误差） */
  function gridCellScores(bin, w, h, x0, y0, s, rows, cols, tol) {
    const m = Math.max(2, s * 0.05), e = s - m;
    const n = Math.max(5, Math.round(s / 6));
    tol = tol || 1;
    const map = new Map();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = x0 + c * s, y = y0 + r * s;
        const edges = [
          segDarkRatio(bin, w, h, [x + m, y], [x + e, y], n, tol),
          segDarkRatio(bin, w, h, [x + s, y + m], [x + s, y + e], n, tol),
          segDarkRatio(bin, w, h, [x + m, y + s], [x + e, y + s], n, tol),
          segDarkRatio(bin, w, h, [x, y + m], [x, y + e], n, tol)
        ];
        const min = Math.min(...edges);
        const avg = (edges[0] + edges[1] + edges[2] + edges[3]) / 4;
        map.set(r + ',' + c, { min, avg });
      }
    }
    return map;
  }

  /* 用不同阈值切分，得到最优网格（偏好 6 面、完整度高）
   * ctx = {box, x0, y0, s}：给“格子铺满整个图形”加权，
   * 可压制噪点造成的格距误判（错格距往往只能盖住图形的一部分） */
  function pickBestGrid(scores, rows, cols, ctx) {
    let best = null;
    for (const T of [0.62, 0.5, 0.42, 0.34, 0.26]) {
      const mask = new Map();
      for (const [k, sc] of scores) if (sc.min >= T) mask.set(k, true);
      keepLargestComponent(mask);
      const n = mask.size;
      if (n < 3) continue;
      let sum = 0;
      for (const k of mask.keys()) sum += (scores.get(k) || { min: 0 }).min;
      let fit = 0;
      if (ctx) {
        let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
        for (const k of mask.keys()) {
          const [r, c] = k.split(',').map(Number);
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
        const b = ctx.box, s = ctx.s;
        const err = Math.abs(ctx.x0 + minC * s - b.minX) +
                    Math.abs(ctx.x0 + (maxC + 1) * s - b.maxX) +
                    Math.abs(ctx.y0 + minR * s - b.minY) +
                    Math.abs(ctx.y0 + (maxR + 1) * s - b.maxY);
        fit = Math.max(0, 34 - err * 0.8);
      }
      const score = (n === 6 ? 100 : 0) + (n === 5 ? 35 : 0) + n * 8 + sum * 12 -
        (n > 6 ? (n - 6) * 22 : 0) + (T === 0.62 ? 3 : 0) + fit;
      if (!best || score > best.score) best = { mask, n, score, T };
    }
    return best;
  }

  /* 暗像素连通域（8 连通）：用于把一张图里的多个图形分开 */
  function darkComponents(bin, w, h) {
    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    const comps = [];
    for (let start = 0; start < w * h; start++) {
      if (!bin[start] || label[start]) continue;
      const id = comps.length + 1;
      let sp = 0;
      stack[sp++] = start;
      label[start] = id;
      const c = { minX: w, minY: h, maxX: 0, maxY: 0, area: 0 };
      while (sp > 0) {
        const cur = stack[--sp];
        const cx = cur % w, cy = (cur / w) | 0;
        c.area++;
        if (cx < c.minX) c.minX = cx;
        if (cx > c.maxX) c.maxX = cx;
        if (cy < c.minY) c.minY = cy;
        if (cy > c.maxY) c.maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const ni = ny * w + nx;
            if (bin[ni] && !label[ni]) { label[ni] = id; stack[sp++] = ni; }
          }
        }
      }
      comps.push(c);
    }
    return comps;
  }

  /* ---------- 正方体展开图 ----------
   * 新策略：① 检测长直线得到网格线位置 → ② 由线间距投票出格距候选
   * ③ 对每组 (格距, 原点, 阈值) 给每个格子打“四边完整度”分并选最优网格
   * ④ 附带 extras（疑似但没入选的相邻格），供上层自动补全 */
  function detectSquare(imageData, dbg) {
    const { w, h, bin } = toBinary(imageData);
    if (dbg) dbg.evals = [];
    /* 一张截图里可能有多个图形（选项 A/B/C/D 并排、题干文字等）：
     * 墨迹最多的未必是展开图（文字往往更多），所以取前几个候选分别识别，择优录取 */
    const cands = figureCandidates(bin, w, h);
    if (!cands.length) return null;
    let best = null, bestScore = -Infinity;
    const limit = Math.min(3, cands.length);
    for (let i = 0; i < limit; i++) {
      const r = analyzeSquare(bin, w, h, cands[i], dbg && i === 0 ? dbg : null);
      if (!r) continue;
      const sc = r.quality + (r.mask.size === 6 ? 400 : 0) + (r.mask.size === 5 ? 120 : 0) +
        (r.foldable ? 600 : 0) - i * 5;
      if (sc > bestScore) { bestScore = sc; best = r; }
    }
    if (best) { best.multi = cands.length > 1; return best; }
    return null;
  }

  /* 候选图形（按墨迹多少排序，过滤掉明显太小的） */
  function figureCandidates(bin, w, h) {
    const comps = darkComponents(bin, w, h).filter(c => c.area >= 4);
    let clusters;
    if (!comps.length || comps.length > 3000) {
      const bb = darkBBox(bin, w, h);
      clusters = bb ? [{ minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY, area: 1 }] : [];
    } else {
      clusters = clusterComponents(comps, 10).sort((a, b) => b.area - a.area);
    }
    return clusters.filter(c => (c.maxX - c.minX) >= 24 && (c.maxY - c.minY) >= 24).slice(0, 4);
  }

  /* 在指定包围盒内做正方体展开图识别 */
  function analyzeSquare(bin, w, h, bbox, dbg) {
    const multi = false;
    const bw = bbox.maxX - bbox.minX, bh = bbox.maxY - bbox.minY;
    if (bw < 24 || bh < 24) return null;

    if (dbg) dbg.bbox = { ...bbox }, dbg.multi = multi;
    /* 裁剪出目标图形：隔离其它图形，避免线条与格距互相干扰 */
    const cr = cropRegion(bin, w, h, bbox, 5);
    const cb = cr.bin, cw = cr.w, ch = cr.h, box = cr.box;

    /* ① 长直线 */
    const minLen = Math.max(10, Math.min(bw, bh) * 0.28);
    const vLines = clusterLines(scanLongRuns(cb, cw, ch, minLen, true));
    const hLines = clusterLines(scanLongRuns(cb, cw, ch, minLen, false));

    /* ② 格距候选：线间距投票 + 白色封闭区域 + 包围盒尺寸 */
    const sCands = new Set();
    for (const d of spacingCandidates(vLines.map(l => l.pos), 12, Math.max(bw, bh))) sCands.add(d);
    for (const d of spacingCandidates(hLines.map(l => l.pos), 12, Math.max(bw, bh))) sCands.add(d);
    for (let k = 1; k <= 6; k++) { sCands.add(Math.round(bw / k)); sCands.add(Math.round(bh / k)); }

    /* 外轮廓线：虚线/断线时封闭区域与长直线都不可用，靠最外侧的线条仍能估出格距 */
    const bd = boundaryLines(cb, cw, ch, box);
    if (bd.right - bd.left >= 20) {
      for (let k = 1; k <= 6; k++) sCands.add(Math.round((bd.right - bd.left) / k));
    }
    if (bd.bottom - bd.top >= 20) {
      for (let k = 1; k <= 6; k++) sCands.add(Math.round((bd.bottom - bd.top) / k));
    }

    const comps = whiteComponents(cb, cw, ch);
    const enclosed = comps.filter(c =>
      !c.touchBorder && c.area >= 30 &&
      (c.maxX - c.minX) >= 8 && (c.maxY - c.minY) >= 8 &&
      c.minX >= box.minX - 2 && c.maxX <= box.maxX + 2 &&
      c.minY >= box.minY - 2 && c.maxY <= box.maxY + 2);
    if (enclosed.length) {
      /* 按面积中位数筛选：格子内框面积彼此接近；外围边框造成的大空白、
       * 面内图案造成的小封闭区都会被排除 */
      const areas = enclosed.map(c => c.area).sort((a, b) => a - b);
      const medA = areas[areas.length >> 1];
      let regs = enclosed.filter(c => c.area >= 0.5 * medA && c.area <= 2.2 * medA);
      if (regs.length < 2) {
        const maxW = Math.max(...enclosed.map(c => c.maxX - c.minX));
        const maxH = Math.max(...enclosed.map(c => c.maxY - c.minY));
        regs = enclosed.filter(c => (c.maxX - c.minX) >= 0.7 * maxW && (c.maxY - c.minY) >= 0.7 * maxH);
      }
      const cells = regs.length ? regs : enclosed;
      const xs = [...new Set(cells.map(c => c.minX))].sort((a, b) => a - b);
      const ys = [...new Set(cells.map(c => c.minY))].sort((a, b) => a - b);
      const diffs = [];
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] >= 10) diffs.push(xs[i] - xs[i - 1]);
      for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] >= 10) diffs.push(ys[i] - ys[i - 1]);
      const ds = median(diffs.filter(d => d < 400));
      if (ds) {
        sCands.add(Math.round(ds));
        sCands.add(Math.round(ds + (median(cells.map(c => c.maxX - c.minX)) ? 4 : 4)));
      }
    }
    /* 格距细化：包围盒除法取整会带来 ±1~2px 误差，跨几格后会累积成明显偏移，
     * 必须把邻近值也纳入候选，让评分去挑正确的那个 */
    for (const s of [...sCands]) for (const d of [-2, -1, 1, 2]) sCands.add(s + d);
    const sList = [...sCands].filter(s => s >= 12 && s <= Math.max(bw, bh) + 4).sort((a, b) => b - a);

    /* ③ 粗评估：容差放宽到 2px，避免“格距对但相位差一点”被整组淘汰 */
    let best = null;
    for (const s of sList) {
      const vpos = vLines.length ? Math.min(...vLines.map(l => l.pos)) : box.minX;
      const hpos = hLines.length ? Math.min(...hLines.map(l => l.pos)) : box.minY;
      /* 原点对齐到包围盒，保证网格能覆盖整张展开图 */
      const x0 = vpos - Math.max(0, Math.floor((vpos - box.minX - 1) / s)) * s;
      const y0 = hpos - Math.max(0, Math.floor((hpos - box.minY - 1) / s)) * s;
      const cols = Math.min(12, Math.max(1, Math.ceil((box.maxX - x0) / s) + 1));
      const rows = Math.min(12, Math.max(1, Math.ceil((box.maxY - y0) / s) + 1));
      const scores = gridCellScores(cb, cw, ch, x0, y0, s, rows, cols, 2);
      const r = pickBestGrid(scores, rows, cols, { box, x0, y0, s });
      if (dbg) dbg.evals.push({ s, x0, y0, n: r ? r.n : 0, score: r ? Math.round(r.score * 10) / 10 : 0 });
      if (!r) continue;
      if (!best || r.score > best.score) {
        best = { score: r.score, n: r.n, s, x0, y0, rows, cols, scores, mask: r.mask };
      }
    }
    if (!best) return null;

    /* ④ 精调：容差收回 1px，在最优格距 ±1 与原点 ±4 的范围内找最贴合的一组
     *    （抵消格距估计误差在远端格子的累积偏移） */
    let tuned = null;
    for (const ds of [-1, 0, 1]) {
      const s = best.s + ds;
      if (s < 12) continue;
      for (let dx = -4; dx <= 4; dx += 2) {
        for (let dy = -4; dy <= 4; dy += 2) {
          const x0 = best.x0 + dx, y0 = best.y0 + dy;
          const cols = Math.min(12, Math.max(1, Math.ceil((box.maxX - x0) / s) + 1));
          const rows = Math.min(12, Math.max(1, Math.ceil((box.maxY - y0) / s) + 1));
          const scores = gridCellScores(cb, cw, ch, x0, y0, s, rows, cols, 1);
          const r = pickBestGrid(scores, rows, cols, { box, x0, y0, s });
          if (!r) continue;
          if (!tuned || r.score > tuned.score) {
            tuned = { score: r.score, n: r.n, s, x0, y0, rows, cols, scores, mask: r.mask };
          }
        }
      }
    }
    if (!tuned) tuned = best;

    if (dbg) {
      dbg.chosen = { s: tuned.s, x0: tuned.x0, y0: tuned.y0, rows: tuned.rows, cols: tuned.cols,
        box: { ...box }, vLines: vLines.map(l => l.pos), hLines: hLines.map(l => l.pos) };
      dbg.cells = [...tuned.scores.entries()]
        .map(([k, v]) => k + ':' + v.min.toFixed(2) + (tuned.mask.has(k) ? '*' : ''))
        .join(' ');
    }

    /* ⑤ 收集 extras：没入选但边线较完整、且与已选格相邻的格子（供自动纠错替换/补面） */
    const extras = [];
    {
      for (const [k, sc] of tuned.scores) {
        if (tuned.mask.has(k) || sc.min < 0.22) continue;
        const [r, c] = k.split(',').map(Number);
        const near = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(d => tuned.mask.has((r + d[0]) + ',' + (c + d[1])));
        if (near) extras.push({ key: k, score: sc.min });
      }
      extras.sort((a, b) => b.score - a.score);
    }

    /* 标出“线条不完整”的面，提示用户重点确认 */
    const weak = new Set();
    for (const k of tuned.mask.keys()) {
      const sc = tuned.scores.get(k);
      if (sc && sc.min < 0.5) weak.add(k);
    }

    /* 能真正折成正方体的网格优先（Fold 在同一页面里一定已加载；这里做软依赖） */
    let foldable = false;
    try {
      if (global.Fold && global.Fold.foldNet) {
        foldable = global.Fold.foldNet({
          type: 'square', origin: [tuned.x0 + cr.ox, tuned.y0 + cr.oy], s: tuned.s, mask: tuned.mask
        }, 1).valid;
      }
    } catch (e) { /* 忽略 */ }

    return {
      type: 'square', origin: [tuned.x0 + cr.ox, tuned.y0 + cr.oy], s: tuned.s,
      mask: tuned.mask, extras: extras.slice(0, 14), quality: tuned.score,
      weak, weakCount: weak.size, multi, foldable
    };
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
    const { w, h, bin, raw } = toBinary(imageData);
    const cands = figureCandidates(bin, w, h);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < Math.min(3, cands.length); i++) {
      const r = analyzeTriangle(bin, raw, w, h, cands[i]);
      if (!r) continue;
      const sc = (r.tris.size === 4 ? 400 : 0) + (r.tris.size === 3 ? 120 : 0) +
        (r.quality || 0) - i * 5;
      if (sc > bestScore) { bestScore = sc; best = r; }
    }
    if (best) best.multi = cands.length > 1;
    return best;
  }

  /* 在指定包围盒内做四面体展开图识别 */
  function analyzeTriangle(bin, raw, w, h, bbox) {
    const bw = bbox.maxX - bbox.minX, bh = bbox.maxY - bbox.minY;
    if (bw < 30 || bh < 25) return null;

    /* 同样裁剪隔离：避免同一张图里其它图形的线条干扰格点搜索 */
    const cr = cropRegion(bin, w, h, bbox, 5);
    const cb = cr.bin, cw = cr.w, ch = cr.h, box = cr.box;
    const craw = cropRegion(raw, w, h, bbox, 5).bin;

    const comps = whiteComponents(cb, cw, ch);
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
    for (let i = 0; i < craw.length; i++) darkCount += craw[i];  // 用未膨胀图，避免线宽被高估
    let whiteArea = 0;
    for (const c of enclosedAll) whiteArea += c.area;
    const figureArea = Math.max(1, whiteArea + darkCount);

    /* 评估某一组格点参数：返回命中三角形、面数、解释长度等 */
    const evalCfg = (O, u, v, s, theta) => {
      const r = tryTriangleLattice(cb, cw, ch, O, u, v, box, s);
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
              box.minX + (a / 10) * u[0] + (b / 10) * v[0] - s,
              box.minY + (a / 10) * u[1] + (b / 10) * v[1] - s
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
    return {
      type: 'tri', origin: [best.origin[0] + cr.ox, best.origin[1] + cr.oy],
      s: best.s, theta: best.theta, tris: best.tris,
      quality: Math.round(score(best) * 10) / 10, multi: false
    };
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

  /* ---------- 枚举一张图里的所有图形（选项 A/B/C/D 并排时逐个识别） ---------- */
  function detectAllFigures(imageData) {
    const { w, h, bin, raw } = toBinary(imageData);
    const cands = figureCandidates(bin, w, h);
    const figures = cands.map((c) => {
      let square = null, tri = null;
      try { square = analyzeSquare(bin, w, h, c, null); } catch (e) { /* 忽略 */ }
      try { tri = analyzeTriangle(bin, raw, w, h, c); } catch (e) { /* 忽略 */ }
      return { bbox: c, square, tri };
    });
    /* 按阅读顺序（先上后下、先左后右）编号，方便用户对应题里的选项 */
    figures.sort((a, b) => {
      const ay = a.bbox.minY, by = b.bbox.minY;
      if (Math.abs(ay - by) > Math.min(a.bbox.maxY - ay, b.bbox.maxY - by) * 0.5) return ay - by;
      return a.bbox.minX - b.bbox.minX;
    });
    return { w, h, figures };
  }

  /* 单个图形：在正方体 / 四面体两套结果里按可信度择一 */
  function bestNetOfFigure(f) {
    const sq = f.square, tr = f.tri;
    const scoreS = sq ? (sq.mask.size === 6 ? 5 : sq.mask.size === 5 ? 3 : sq.mask.size === 4 ? 2 : 1) : 0;
    const scoreT = tr ? (tr.tris.size === 4 ? 5 : tr.tris.size === 3 ? 3 : 2) : 0;
    if (scoreT > scoreS) return { net: tr, score: scoreT * 1000 + (tr.quality || 0) };
    if (scoreS > 0) return { net: sq, score: scoreS * 1000 + (sq.quality || 0) };
    return { net: null, score: -1 };
  }

  /* ---------- 自动：两套检测器都跑，按可信度打分择一 ---------- */
  function autoDetect(imageData) {
    const all = detectAllFigures(imageData);
    let best = null, bestScore = -Infinity;
    all.figures.forEach((f, i) => {
      const p = bestNetOfFigure(f);
      if (!p.net) return;
      const sc = p.score - i * 3;
      if (sc > bestScore) { bestScore = sc; best = p.net; }
    });
    return best;
  }

  global.Detect = {
    binarize, detectSquare, detectTriangle, autoDetect,
    detectAllFigures, bestNetOfFigure, orientationStats
  };
})(window);
