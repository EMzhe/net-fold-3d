/* 折叠引擎：把 2D 展开图（正方形网格 / 三角形网格）折叠为正方体或正四面体
 *
 * 原理：以某个面为基准，BFS 遍历相邻面；每跨过一条公共棱，
 * 就把新面绕该棱（在世界坐标中的位置）旋转 (180° - 二面角)，
 * 旋转方向取“折向父面内侧”。参数 t∈[0,1] 控制折叠进度，用于动画。
 */
(function (global) {
  'use strict';
  const { V, M, signedArea, centroid2 } = global.MX;

  const DIHEDRAL = {
    square: Math.PI / 2,          // 正方体二面角 90°
    tri: Math.acos(1 / 3)         // 正四面体二面角 ≈ 70.53°
  };

  const vkey = (p) => Math.round(p[0] * 4) + ',' + Math.round(p[1] * 4);
  const ekey = (a, b) => {
    const ka = vkey(a), kb = vkey(b);
    return ka < kb ? ka + '|' + kb : kb + '|' + ka;
  };

  /* 由 mask 生成 cells：[{key, poly:[[x,y],...]}]
   * 注意顶点绕向：图像坐标 y 向下，3D 世界 y 向上，两者互为镜像。
   * 折叠时会做一次 Y 镜像，所以这里要按「图像顺时针」排列，
   * 镜像后才是 3D 里的逆时针，法线才朝 +Z（朝向观察者 = 图案朝外）。 */
  function buildCells(net) {
    const cells = [];
    if (net.type === 'square') {
      const x0 = net.origin[0], y0 = net.origin[1], s = net.s;
      for (const key of net.mask.keys()) {
        const [r, c] = key.split(',').map(Number);
        let poly = [
          [x0 + c * s, y0 + r * s],
          [x0 + (c + 1) * s, y0 + r * s],
          [x0 + (c + 1) * s, y0 + (r + 1) * s],
          [x0 + c * s, y0 + (r + 1) * s]
        ];
        if (signedArea(poly) > 0) poly.reverse();
        cells.push({ key, poly });
      }
    } else {
      const ox = net.origin[0], oy = net.origin[1], s = net.s, th = net.theta;
      const u = [s * Math.cos(th), s * Math.sin(th)];
      const v = [s * Math.cos(th + Math.PI / 3), s * Math.sin(th + Math.PI / 3)];
      const P = (i, j) => [ox + i * u[0] + j * v[0], oy + i * u[1] + j * v[1]];
      for (const key of net.tris.keys()) {
        const [i, j, up] = key.split(',').map(Number);
        let poly = up
          ? [P(i, j), P(i + 1, j), P(i, j + 1)]
          : [P(i + 1, j), P(i, j + 1), P(i + 1, j + 1)];
        if (signedArea(poly) > 0) poly.reverse();
        cells.push({ key, poly });
      }
    }
    cells.sort((a, b) => (a.key < b.key ? -1 : 1));
    return cells;
  }

  /* 通过共享顶点找邻接关系：adj[i] = [{other, e1, e2}] */
  function buildAdjacency(cells) {
    const edgeMap = new Map(); // ekey -> [{idx, e1, e2}]
    cells.forEach((cell, idx) => {
      const n = cell.poly.length;
      for (let k = 0; k < n; k++) {
        const a = cell.poly[k], b = cell.poly[(k + 1) % n];
        const ek = ekey(a, b);
        if (!edgeMap.has(ek)) edgeMap.set(ek, []);
        edgeMap.get(ek).push({ idx, e1: a, e2: b });
      }
    });
    const adj = cells.map(() => []);
    for (const list of edgeMap.values()) {
      if (list.length !== 2) continue;
      const [A, B] = list;
      adj[A.idx].push({ other: B.idx, e1: A.e1, e2: A.e2 });
      adj[B.idx].push({ other: A.idx, e1: B.e1, e2: B.e2 });
    }
    return adj;
  }

  /* 折叠计算。t ∈ [0,1]。返回各面世界坐标下的顶点/法线/中心，以及校验结果 */
  function foldNet(net, t) {
    if (!net._cells) net._cells = buildCells(net);
    if (!net._adj) net._adj = buildAdjacency(net._cells);
    if (!net._signs) net._signs = new Map();

    const cells = net._cells;
    const adj = net._adj;
    const foldAng = Math.PI - DIHEDRAL[net.type];
    if (!cells.length) {
      return { faces: [], valid: false, message: '展开图为空，请先在网格中点选格子', opposite: [], meanCenter: [0, 0, 0], type: net.type };
    }

    /* 基准面：平移到原点并归一化为单位尺寸（poly 是像素坐标）。
     * 关键：图像 y 向下、3D 世界 y 向上，必须做一次 Y 镜像（scaling3 的 sy 取负），
     * 否则展开图在 3D 里是上下颠倒的——那是一次镜像，会改变手性，
     * 折出来的立方体图案排布与实际展开图正好相反。 */
    const bc = centroid2(cells[0].poly);
    const k = 1 / (net.s || 1);
    const baseM = M.multiply(
      M.translation(-k * bc[0], k * bc[1], 0),
      M.scaling3(k, -k, k)
    );

    const Mt = new Array(cells.length);  // 当前 t 下的变换
    const M1 = new Array(cells.length);  // t=1 时的变换
    Mt[0] = baseM; M1[0] = baseM;

    const visited = new Set([0]);
    const queue = [0];
    while (queue.length) {
      const p = queue.shift();
      for (const e of adj[p]) {
        const q = e.other;
        if (visited.has(q)) continue;
        visited.add(q);

        const ek = ekey(e.e1, e.e2);
        let sign = net._signs.get(ek);
        if (sign === undefined) {
          /* 用 t=1 判断折向：子面质点应转到父面法线的内侧 */
          const Mp1 = M1[p];
          const A1 = M.transformPoint(Mp1, [e.e1[0], e.e1[1], 0]);
          const B1 = M.transformPoint(Mp1, [e.e2[0], e.e2[1], 0]);
          const axis1 = V.normalize(V.sub(B1, A1));
          const np = M.transformDir(Mp1, [0, 0, 1]);
          const cq = centroid2(cells[q].poly);
          const Gflat = M.transformPoint(Mp1, [cq[0], cq[1], 0]);
          sign = 1;
          for (const s of [1, -1]) {
            const R = M.axisAngle(axis1, s * foldAng);
            const G1 = V.add(A1, M.transformDir(R, V.sub(Gflat, A1)));
            if (V.dot(V.sub(G1, A1), np) < 0) { sign = s; break; }
          }
          net._signs.set(ek, sign);
        }

        /* 当前 t：绕“父面当前棱”旋转 sign * foldAng * t */
        const Mpt = Mt[p];
        const At = M.transformPoint(Mpt, [e.e1[0], e.e1[1], 0]);
        const Bt = M.transformPoint(Mpt, [e.e2[0], e.e2[1], 0]);
        const axisT = V.normalize(V.sub(Bt, At));
        Mt[q] = M.multiply(M.rotationAboutLine(At, axisT, sign * foldAng * t), Mpt);

        /* t=1：同理（供后续面的折向判定） */
        const Mp1 = M1[p];
        const A1 = M.transformPoint(Mp1, [e.e1[0], e.e1[1], 0]);
        const B1 = M.transformPoint(Mp1, [e.e2[0], e.e2[1], 0]);
        const axis1 = V.normalize(V.sub(B1, A1));
        M1[q] = M.multiply(M.rotationAboutLine(A1, axis1, sign * foldAng), Mp1);

        queue.push(q);
      }
    }

    const faces = cells.map((cell, i) => {
      const m = Mt[i] || baseM;
      const verts3 = cell.poly.map(p => M.transformPoint(m, [p[0], p[1], 0]));
      const normal = V.normalize(M.transformDir(m, [0, 0, 1]));
      let cx = 0, cy = 0, cz = 0;
      for (const v of verts3) { cx += v[0]; cy += v[1]; cz += v[2]; }
      const n = verts3.length;
      const center = [cx / n, cy / n, cz / n];
      return { key: cell.key, poly2d: cell.poly, verts3, normal, center, idx: i };
    });

    /* 整体中心（用于居中显示） */
    let mx = 0, my = 0, mz = 0;
    for (const f of faces) { mx += f.center[0]; my += f.center[1]; mz += f.center[2]; }
    const fn = faces.length || 1;
    const meanCenter = [mx / fn, my / fn, mz / fn];

    const check = validate(net.type, faces, meanCenter);
    return { faces, meanCenter, type: net.type, ...check };
  }

  function validate(type, faces, meanCenter) {
    const EPS = 0.08;
    /* 重叠检测：两个面中心几乎重合 */
    for (let i = 0; i < faces.length; i++) {
      for (let j = i + 1; j < faces.length; j++) {
        if (V.len(V.sub(faces[i].center, faces[j].center)) < EPS) {
          return { valid: false, message: '✗ 折叠后面片发生重叠，不是有效的展开图', opposite: [], labels: [] };
        }
      }
    }
    if (type === 'square') {
      if (faces.length !== 6) {
        return { valid: false, message: `正方体展开图需要 6 个面（当前 ${faces.length} 个），请继续点选或删除格子`, opposite: [], labels: [] };
      }
      /* +Y 在世界里朝屏幕上方（图像已做 Y 镜像对齐），所以 +Y = 上 */
      const AXIS_LABEL = [
        ['x', 1, '右'], ['x', -1, '左'], ['y', 1, '上'], ['y', -1, '下'],
        ['z', 1, '前'], ['z', -1, '后']
      ];
      const labels = new Array(6).fill('');
      const used = new Set();
      for (const f of faces) {
        const off = V.sub(f.center, meanCenter);
        const abs = [Math.abs(off[0]), Math.abs(off[1]), Math.abs(off[2])];
        const axis = abs[0] > abs[1] && abs[0] > abs[2] ? 0 : (abs[1] > abs[2] ? 1 : 2);
        const sgn = off[axis] > 0 ? 1 : -1;
        if (abs[axis] < 0.5 - EPS || abs[(axis + 1) % 3] > EPS || abs[(axis + 2) % 3] > EPS) {
          return { valid: false, message: '✗ 折叠后构不成正方体（该展开图不是 11 种有效展开图之一）', opposite: [], labels: [] };
        }
        const tag = axis + '' + sgn;
        if (used.has(tag)) {
          return { valid: false, message: '✗ 折叠后发生重叠，不是有效的展开图', opposite: [], labels: [] };
        }
        used.add(tag);
        const found = AXIS_LABEL.find(a => a[0] === 'xyz'[axis] && a[1] === sgn);
        labels[f.idx] = found ? found[2] : '';
      }
      /* 对面配对 */
      const opposite = [];
      for (let i = 0; i < 6; i++) {
        for (let j = i + 1; j < 6; j++) {
          const a = V.sub(faces[i].center, meanCenter);
          const b = V.sub(faces[j].center, meanCenter);
          if (V.len(V.add(a, b)) < EPS) opposite.push([i, j]);
        }
      }
      return { valid: true, message: '✓ 有效正方体，三组对面已配对', opposite, labels };
    } else {
      if (faces.length !== 4) {
        return { valid: false, message: `正四面体展开图需要 4 个三角形（当前 ${faces.length} 个）`, opposite: [], labels: [] };
      }
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          const d = V.dot(faces[i].normal, faces[j].normal);
          if (d > -0.25) {
            return { valid: false, message: '✗ 折叠后构不成正四面体（该展开图无效）', opposite: [], labels: [] };
          }
        }
      }
      return { valid: true, message: '✓ 有效正四面体', opposite: [], labels: [] };
    }
  }

  /* 清缓存（网格编辑后调用） */
  function invalidate(net) {
    net._cells = null; net._adj = null; net._signs = null;
  }

  /* 智能纠错：识别出的面数不对 / 折不成正方体时，
   * 尝试「删掉 1 个多余面」或「补上 1~2 个疑似漏掉的面」，返回第一个能折成有效正方体的方案 */
  function autoRepair(net, extras) {
    if (!net || net.type !== 'square') return null;
    const base = [...net.mask.keys()];
    const make = (keys) => ({
      type: 'square', origin: net.origin.slice(), s: net.s, mask: new Map(keys.map(k => [k, true]))
    });
    const tryKeys = (keys) => {
      if (keys.length !== 6) return null;
      const cand = make(keys);
      const res = foldNet(cand, 1);
      return res.valid ? cand : null;
    };

    /* 面数过多：逐个删掉一个面试试 */
    if (base.length > 6) {
      for (const k of base) {
        const cand = tryKeys(base.filter(x => x !== k));
        if (cand) return { net: cand, action: 'remove', count: 1 };
      }
    }
    /* 面数不足：从“疑似漏掉的面”里补 */
    if (base.length < 6 && extras && extras.length) {
      for (const e of extras) {
        const cand = tryKeys(base.concat([e.key]));
        if (cand) return { net: cand, action: 'add', count: 1 };
      }
      const lim = Math.min(8, extras.length);
      for (let i = 0; i < lim; i++) {
        for (let j = i + 1; j < Math.min(10, extras.length); j++) {
          const cand = tryKeys(base.concat([extras[i].key, extras[j].key]));
          if (cand) return { net: cand, action: 'add', count: 2 };
        }
      }
    }
    /* 面数正好但形状不对（常见于整体错了一格）：尝试替换 1~2 个面 */
    if (base.length === 6 && extras && extras.length) {
      const ex = extras.slice(0, 12);
      for (const k of base) {
        for (const e of ex) {
          const cand = tryKeys(base.filter(x => x !== k).concat([e.key]));
          if (cand) return { net: cand, action: 'replace', count: 1 };
        }
      }
      for (let a = 0; a < base.length; a++) {
        for (let b = a + 1; b < base.length; b++) {
          const rest = base.filter((_, i) => i !== a && i !== b);
          for (let i = 0; i < ex.length; i++) {
            for (let j = i + 1; j < ex.length; j++) {
              const cand = tryKeys(rest.concat([ex[i].key, ex[j].key]));
              if (cand) return { net: cand, action: 'replace', count: 2 };
            }
          }
        }
      }
    }
    return null;
  }

  global.Fold = { foldNet, invalidate, autoRepair, DIHEDRAL };
})(window);
