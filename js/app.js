/* 主应用：上传截图 → 识别 → 编辑网格 → 3D 折叠展示 → 对面/有效性分析 */
(function (global) {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const state = {
    srcCanvas: null,   // 当前工作图（可能裁剪过）
    net: null,
    mode: 'auto',      // auto | square | tri
    animId: null,
    figures: [],       // 截图里识别出的所有图形（一图多形时可切换）
    figIndex: 0        // 当前分析的图形序号
  };

  let viewer = null, editor = null;

  /* ---------------- 图片载入 ---------------- */
  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const url = URL.createObjectURL(file);
    loadURL(url, () => URL.revokeObjectURL(url));
  }

  function loadURL(url, done) {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      if (done) done();
      setSource(cv);
    };
    img.onerror = () => { if (done) done(); showMsg('图片加载失败，请换一张试试', true); };
    img.src = url;
  }

  function setSource(cv) {
    state.srcCanvas = cv;
    state.figPicked = false;
    state.figIndex = 0;
    editor.setImage(cv);
    viewer.setImage(cv);
    $('cropMode').checked = false;
    editor.setCropMode(false);
    $('cropApply').style.display = 'none';
    runDetection();
  }

  /* ---------------- 识别 ---------------- */
  function runDetection() {
    if (!state.srcCanvas) return;
    const cv = state.srcCanvas;
    const data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    const D = global.Detect;
    let figures = [];
    try {
      figures = D.detectAllFigures(data).figures.filter(f => f.square || f.tri);
    } catch (err) { console.error(err); }
    state.figures = figures;

    /* 默认选可信度最高的那个；用户手动切过之后就沿用他选的序号 */
    let idx = state.figIndex < figures.length ? state.figIndex : 0;
    if (!state.figPicked) {
      let bi = 0, bs = -Infinity;
      figures.forEach((f, i) => {
        const p = D.bestNetOfFigure(f);
        if (p.score > bs) { bs = p.score; bi = i; }
      });
      idx = bi;
    }
    buildFigPicker(figures, idx);
    applyFigure(idx);
  }

  /* 一图多形（如选项 A/B/C/D 并排）时给出切换按钮 */
  function buildFigPicker(figures, active) {
    const box = $('figPicker');
    box.innerHTML = '';
    if (!figures || figures.length < 2) { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    const title = document.createElement('span');
    title.className = 'fp-title';
    title.textContent = `图里检测到 ${figures.length} 个图形，选择要分析的：`;
    box.appendChild(title);
    figures.forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'fp-btn' + (i === active ? ' on' : '');
      const n = (state.mode === 'tri' ? f.tri : state.mode === 'square' ? f.square : D_pick(f)) || null;
      const ok = n && (n.type === 'square'
        ? global.Fold.foldNet(n, 1).valid
        : global.Fold.foldNet(n, 1).valid);
      b.innerHTML = `第 ${i + 1} 个` + (ok ? '' : '<span class="bad">待修正</span>');
      b.addEventListener('click', () => {
        state.figPicked = true;
        buildFigPicker(figures, i);
        applyFigure(i);
      });
      box.appendChild(b);
    });
  }

  function D_pick(f) { return global.Detect.bestNetOfFigure(f).net; }

  function applyFigure(idx) {
    state.figIndex = idx;
    const f = state.figures[idx];
    let net = null;
    if (f) {
      if (state.mode === 'square') net = f.square;
      else if (state.mode === 'tri') net = f.tri;
      else net = global.Detect.bestNetOfFigure(f).net;
    }
    editor.setHighlight(f ? f.bbox : null);
    applyFigureNet(net);
  }

  function applyFigureNet(net) {
    const cv = state.srcCanvas;
    if (net) {
      /* 智能纠错：面数不对或折不成正方体时，自动尝试补/删/替换一个面 */
      let fixNote = '';
      if (net.type === 'square') {
        const repair = global.Fold.autoRepair(net, net.extras);
        if (repair) {
          net = repair.net;
          fixNote = repair.action === 'add'
            ? `（自动补上 ${repair.count} 个漏识别的面）`
            : repair.action === 'remove'
              ? `（自动去掉 ${repair.count} 个误识别的面）`
              : `（自动修正 ${repair.count} 个面的位置）`;
        }
      }
      applyNet(net);
      const weak = net.weakCount || 0;
      const which = state.figures.length > 1 ? `（图里第 ${state.figIndex + 1} 个，共 ${state.figures.length} 个）` : '';
      showMsg((net.type === 'square'
        ? `识别到正方体展开图（${net.mask.size} 个面）${which}${fixNote}`
        : `识别到四面体展开图（${net.tris.size} 个三角形）${which}${fixNote}`) +
        (weak ? `；有 ${weak} 个面线条不完整，已在图上标黄，可点击确认` : '；可点击格子微调'), !!weak);
    } else {
      /* 识别失败：给一个默认网格供手动编辑 */
      const W = cv.width, H = cv.height;
      const s = Math.max(40, Math.min(W, H) / 4.2);
      const x0 = (W - 4 * s) / 2, y0 = (H - 3 * s) / 2;
      const mask = new Map([['0,1', 1], ['1,0', 1], ['1,1', 1], ['1,2', 1], ['2,1', 1], ['3,1', 1]].map(([k]) => [k, true]));
      applyNet({ type: 'square', origin: [x0, y0], s, mask });
      showMsg('未能自动识别出展开图，已载入默认十字网格——请直接在图上点击勾出展开图形状（深色格子会被折叠）', true);
    }
  }

  function applyNet(net) {
    state.net = net;
    editor.setNet(net);
    viewer.setNet(net);
    viewer.setT(1);
    $('foldSlider').value = 100;
    updateInfo();
  }

  function rebuild() {
    global.Fold.invalidate(state.net);
    viewer.setNet(state.net);
    updateInfo();
  }

  /* ---------------- 结果面板 ---------------- */
  function updateInfo() {
    const box = $('infoPanel');
    const list = $('faceList');
    const msgEl = $('validMsg');
    list.innerHTML = '';
    if (!state.net) { msgEl.textContent = ''; box.style.display = 'none'; return; }
    const res = global.Fold.foldNet(state.net, 1);
    msgEl.textContent = res.message || '';
    msgEl.className = 'valid-msg ' + (res.valid ? 'ok' : 'bad');
    box.style.display = 'block';

    res.faces.forEach((f, i) => {
      const item = document.createElement('div');
      item.className = 'face-item';
      const thumb = makeThumb(f.poly2d, i);
      const label = document.createElement('div');
      label.className = 'face-label';
      label.innerHTML = `面 <b>${i + 1}</b>` + (res.labels && res.labels[i] ? `<span class="dir">${res.labels[i]}</span>` : '');
      item.appendChild(thumb);
      item.appendChild(label);
      list.appendChild(item);
    });

    const oppBox = $('oppositeBox');
    oppBox.innerHTML = '';
    if (res.opposite && res.opposite.length) {
      const h = document.createElement('div');
      h.className = 'opp-title';
      h.textContent = '对面关系（折叠后互相正对的两面）';
      oppBox.appendChild(h);
      res.opposite.forEach(([a, b]) => {
        const row = document.createElement('div');
        row.className = 'opp-row';
        row.appendChild(makeThumb(res.faces[a].poly2d, a, true));
        const mid = document.createElement('span');
        mid.textContent = '↔';
        row.appendChild(mid);
        row.appendChild(makeThumb(res.faces[b].poly2d, b, true));
        const txt = document.createElement('span');
        txt.className = 'opp-txt';
        txt.textContent = `面${a + 1} 对 面${b + 1}`;
        row.appendChild(txt);
        oppBox.appendChild(row);
      });
    }
  }

  function makeThumb(poly, idx, small) {
    const size = small ? 36 : 46;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    cv.className = 'thumb' + (small ? ' sm' : '');
    const ctx = cv.getContext('2d');
    if (state.srcCanvas) {
      const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const w = Math.max(1, Math.max(...xs) - minX), h = Math.max(1, Math.max(...ys) - minY);
      const sc = (size - 6) / Math.max(w, h);
      ctx.save();
      ctx.translate((size - w * sc) / 2 - minX * sc, (size - h * sc) / 2 - minY * sc);
      ctx.scale(sc, sc);
      ctx.beginPath();
      poly.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(state.srcCanvas, 0, 0);
      ctx.restore();
    } else {
      const colors = ['#2f6df6', '#e8590c', '#0ca678', '#d6336c', '#7048e8', '#f59f00'];
      ctx.fillStyle = colors[idx % 6];
      ctx.fillRect(0, 0, size, size);
    }
    ctx.strokeStyle = '#2f6df6';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-block;position:relative';
    wrap.appendChild(cv);
    return wrap;
  }

  function showMsg(text, warn) {
    const el = $('detectMsg');
    el.textContent = text;
    el.className = 'detect-msg' + (warn ? ' warn' : '');
  }

  /* ---------------- 折叠动画 ---------------- */
  function setT(t) {
    if (state.animId) { cancelAnimationFrame(state.animId); state.animId = null; }
    viewer.setT(t);
    $('foldSlider').value = Math.round(t * 100);
  }

  function playFold() {
    if (state.animId) cancelAnimationFrame(state.animId);
    const dur = 1400;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      viewer.setT(e);
      $('foldSlider').value = Math.round(e * 100);
      if (p < 1) state.animId = requestAnimationFrame(step);
      else state.animId = null;
    };
    state.animId = requestAnimationFrame(step);
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    viewer = new Viewer3D($('view3d'));
    editor = new NetEditor($('netCanvas'));
    editor.onChange = () => rebuild();

    $('fileInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
    $('dropZone').addEventListener('dragover', (e) => { e.preventDefault(); $('dropZone').classList.add('over'); });
    $('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('over'));
    $('dropZone').addEventListener('drop', (e) => {
      e.preventDefault();
      $('dropZone').classList.remove('over');
      loadFile(e.dataTransfer.files[0]);
    });
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) { loadFile(it.getAsFile()); break; }
      }
    });

    $('modeSel').addEventListener('change', (e) => { state.mode = e.target.value; runDetection(); });
    $('redetect').addEventListener('click', runDetection);

    $('foldSlider').addEventListener('input', (e) => {
      if (state.animId) { cancelAnimationFrame(state.animId); state.animId = null; }
      viewer.setT(e.target.value / 100);
    });
    $('playBtn').addEventListener('click', playFold);
    $('autoRotate').addEventListener('change', (e) => { viewer.autoRotate = e.target.checked; });
    $('resetView').addEventListener('click', () => viewer.resetView());
    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [t, p] = btn.getAttribute('data-view').split(',').map(Number);
        viewer.setView(t, p);
      });
    });

    /* 裁剪 */
    $('cropMode').addEventListener('change', (e) => {
      editor.setCropMode(e.target.checked);
      $('cropApply').style.display = 'none';
    });
    $('cropApply').addEventListener('click', () => {
      const r = editor.getCropRect();
      if (!r || r.w < 10 || r.h < 10) return;
      const pad = 8;
      const cv = document.createElement('canvas');
      cv.width = Math.round(r.w + pad * 2);
      cv.height = Math.round(r.h + pad * 2);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(state.srcCanvas, r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 0, 0, cv.width, cv.height);
      setSource(cv);
    });
    /* 裁剪框选结束时显示应用按钮 */
    const origRender = editor._render.bind(editor);
    editor._render = () => {
      origRender();
      const r = editor.getCropRect();
      $('cropApply').style.display = (editor.cropMode && r && r.w > 10 && r.h > 10) ? 'inline-block' : 'none';
    };

    /* 测试接口 */
    global.__app = { loadURL, runDetection, state, get viewer() { return viewer; }, get editor() { return editor; } };
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
