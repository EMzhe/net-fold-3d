/* 网格编辑器：在截图上叠加网格，点击格子/三角形进行增删，支持框选裁剪 */
(function (global) {
  'use strict';
  const { pointInTriangle } = global.MX;

  class NetEditor {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.net = null;
      this.img = null;          // 源截图 canvas
      this.view = { scale: 1, ox: 0, oy: 0 };
      this.onChange = null;     // 网格变化回调
      this.onCrop = null;       // 裁剪完成回调 (rect in image coords) | null
      this.cropMode = false;
      this.cropRect = null;     // {x,y,w,h} 图片坐标
      this._drag = null;
      this._bindEvents();
      this._render();
    }

    setImage(imgCanvas) {
      this.img = imgCanvas;
      this._fit();
      this._render();
    }

    setNet(net) {
      this.net = net;
      this._fit();
      this._render();
    }

    /* 裁剪模式切换 */
    setCropMode(on) {
      this.cropMode = on;
      this.cropRect = null;
      this.canvas.style.cursor = on ? 'crosshair' : 'pointer';
      this._render();
    }

    getCropRect() { return this.cropRect; }

    _fit() {
      const box = this._contentBox();
      const cw = this.canvas.clientWidth || 480;
      const ch = this.canvas.clientHeight || 340;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
        this.canvas.width = Math.round(cw * dpr);
        this.canvas.height = Math.round(ch * dpr);
      }
      if (!box) { this.view = { scale: 1, ox: 0, oy: 0 }; return; }
      const pad = 16;
      const scale = Math.min((cw - pad * 2) / box.w, (ch - pad * 2) / box.h, 3);
      this.view = {
        scale,
        ox: (cw - box.w * scale) / 2 - box.x * scale,
        oy: (ch - box.h * scale) / 2 - box.y * scale
      };
    }

    _contentBox() {
      if (!this.net) return this.img ? { x: 0, y: 0, w: this.img.width, h: this.img.height } : null;
      const n = this.net;
      if (n.type === 'square') {
        let minR = 99, maxR = -99, minC = 99, maxC = -99;
        for (const k of n.mask.keys()) {
          const [r, c] = k.split(',').map(Number);
          minR = Math.min(minR, r); maxR = Math.max(maxR, r);
          minC = Math.min(minC, c); maxC = Math.max(maxC, c);
        }
        if (maxR < 0) return this.img ? { x: 0, y: 0, w: this.img.width, h: this.img.height } : null;
        return {
          x: n.origin[0] + (minC - 1) * n.s, y: n.origin[1] + (minR - 1) * n.s,
          w: (maxC - minC + 3) * n.s, h: (maxR - minR + 3) * n.s
        };
      }
      const u = [n.s * Math.cos(n.theta), n.s * Math.sin(n.theta)];
      const v = [n.s * Math.cos(n.theta + Math.PI / 3), n.s * Math.sin(n.theta + Math.PI / 3)];
      let minI = 99, maxI = -99, minJ = 99, maxJ = -99;
      for (const k of n.tris.keys()) {
        const [i, j] = k.split(',').map(Number);
        minI = Math.min(minI, i); maxI = Math.max(maxI, i);
        minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j);
      }
      if (maxI < 0) return this.img ? { x: 0, y: 0, w: this.img.width, h: this.img.height } : null;
      const P = (i, j) => [n.origin[0] + i * u[0] + j * v[0], n.origin[1] + i * u[1] + j * v[1]];
      const pts = [P(minI - 1, minJ - 1), P(maxI + 2, minJ - 1), P(minI - 1, maxJ + 2), P(maxI + 2, maxJ + 2)];
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }

    toScreen(p) { return [p[0] * this.view.scale + this.view.ox, p[1] * this.view.scale + this.view.oy]; }
    toImage(x, y) { return [(x - this.view.ox) / this.view.scale, (y - this.view.oy) / this.view.scale]; }

    _render() {
      const ctx = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!this.img && !this.net) {
        ctx.fillStyle = '#98a3b3';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('上传截图后在此显示识别结果', cw / dpr / 2, ch / dpr / 2);
        return;
      }
      if (this.img) ctx.drawImage(this.img, this.view.ox, this.view.oy, this.img.width * this.view.scale, this.img.height * this.view.scale);

      if (this.net && !this.cropMode) this._renderNet(ctx);
      if (this.cropMode && this.cropRect) {
        const r = this.cropRect;
        const [sx, sy] = this.toScreen([r.x, r.y]);
        ctx.save();
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(sx, sy, r.w * this.view.scale, r.h * this.view.scale);
        ctx.restore();
      }
    }

    _renderNet(ctx) {
      const n = this.net;
      ctx.save();
      if (n.type === 'square') {
        /* 画格点参考线 */
        const { minR, maxR, minC, maxC } = this._maskRange();
        ctx.strokeStyle = 'rgba(60,90,160,0.18)';
        ctx.lineWidth = 1;
        for (let r = minR - 1; r <= maxR + 2; r++) {
          const y = n.origin[1] + r * n.s;
          const a = this.toScreen([n.origin[0] + (minC - 1) * n.s, y]);
          const b = this.toScreen([n.origin[0] + (maxC + 2) * n.s, y]);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
        for (let c = minC - 1; c <= maxC + 2; c++) {
          const x = n.origin[0] + c * n.s;
          const a = this.toScreen([x, n.origin[1] + (minR - 1) * n.s]);
          const b = this.toScreen([x, n.origin[1] + (maxR + 2) * n.s]);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
        /* 已选格子 */
        for (const k of n.mask.keys()) {
          const [r, c] = k.split(',').map(Number);
          const x = n.origin[0] + c * n.s, y = n.origin[1] + r * n.s;
          const a = this.toScreen([x, y]);
          const w = n.s * this.view.scale;
          ctx.fillStyle = 'rgba(47,109,246,0.20)';
          ctx.fillRect(a[0], a[1], w, w);
          ctx.strokeStyle = '#2f6df6';
          ctx.lineWidth = 2;
          ctx.strokeRect(a[0], a[1], w, w);
        }
      } else {
        const u = [n.s * Math.cos(n.theta), n.s * Math.sin(n.theta)];
        const v = [n.s * Math.cos(n.theta + Math.PI / 3), n.s * Math.sin(n.theta + Math.PI / 3)];
        const P = (i, j) => [n.origin[0] + i * u[0] + j * v[0], n.origin[1] + i * u[1] + j * v[1]];
        let minI = 99, maxI = -99, minJ = 99, maxJ = -99;
        for (const k of n.tris.keys()) {
          const [i, j] = k.split(',').map(Number);
          minI = Math.min(minI, i); maxI = Math.max(maxI, i);
          minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j);
        }
        /* 参考格线 */
        ctx.strokeStyle = 'rgba(60,90,160,0.18)';
        ctx.lineWidth = 1;
        for (let i = minI - 1; i <= maxI + 2; i++) {
          for (let j = minJ - 1; j <= maxJ + 2; j++) {
            for (const [a, b] of [[P(i, j), P(i + 1, j)], [P(i, j), P(i, j + 1)], [P(i + 1, j), P(i, j + 1)]]) {
              const sa = this.toScreen(a), sb = this.toScreen(b);
              ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
            }
          }
        }
        /* 已选三角形 */
        for (const k of n.tris.keys()) {
          const [i, j, up] = k.split(',').map(Number);
          const poly = up ? [P(i, j), P(i + 1, j), P(i, j + 1)] : [P(i + 1, j), P(i, j + 1), P(i + 1, j + 1)];
          ctx.beginPath();
          poly.forEach((p, idx) => {
            const s = this.toScreen(p);
            if (idx === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
          });
          ctx.closePath();
          ctx.fillStyle = 'rgba(47,109,246,0.20)';
          ctx.fill();
          ctx.strokeStyle = '#2f6df6';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    _maskRange() {
      const n = this.net;
      let minR = 99, maxR = -99, minC = 99, maxC = -99;
      for (const k of n.mask.keys()) {
        const [r, c] = k.split(',').map(Number);
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      }
      if (maxR < 0) { minR = 0; maxR = 2; minC = 0; maxC = 2; }
      return { minR, maxR, minC, maxC };
    }

    _bindEvents() {
      const cv = this.canvas;
      cv.style.cursor = 'pointer';
      cv.addEventListener('pointerdown', (ev) => {
        const rect = cv.getBoundingClientRect();
        const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
        if (this.cropMode) {
          this._drag = { x, y };
          this.cropRect = null;
          return;
        }
        this._toggleAt(x, y);
      });
      cv.addEventListener('pointermove', (ev) => {
        if (!this.cropMode || !this._drag) return;
        const rect = cv.getBoundingClientRect();
        const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
        const a = this.toImage(Math.min(this._drag.x, x), Math.min(this._drag.y, y));
        const b = this.toImage(Math.max(this._drag.x, x), Math.max(this._drag.y, y));
        this.cropRect = { x: a[0], y: a[1], w: b[0] - a[0], h: b[1] - a[1] };
        this._render();
      });
      window.addEventListener('pointerup', () => { this._drag = null; });
    }

    _toggleAt(sx, sy) {
      if (!this.net) return;
      const p = this.toImage(sx, sy);
      const n = this.net;
      if (n.type === 'square') {
        const c = Math.floor((p[0] - n.origin[0]) / n.s);
        const r = Math.floor((p[1] - n.origin[1]) / n.s);
        if (r < -1 || r > 14 || c < -1 || c > 14) return;
        const key = r + ',' + c;
        if (n.mask.has(key)) n.mask.delete(key); else n.mask.set(key, true);
      } else {
        const u = [n.s * Math.cos(n.theta), n.s * Math.sin(n.theta)];
        const v = [n.s * Math.cos(n.theta + Math.PI / 3), n.s * Math.sin(n.theta + Math.PI / 3)];
        const rel = [p[0] - n.origin[0], p[1] - n.origin[1]];
        const det = u[0] * v[1] - u[1] * v[0];
        if (Math.abs(det) < 1e-9) return;
        const fi = (rel[0] * v[1] - rel[1] * v[0]) / det;
        const fj = (u[0] * rel[1] - u[1] * rel[0]) / det;
        const i = Math.floor(fi), j = Math.floor(fj);
        const P = (ii, jj) => [n.origin[0] + ii * u[0] + jj * v[0], n.origin[1] + ii * u[1] + jj * v[1]];
        const cands = [
          [i, j, 1, [P(i, j), P(i + 1, j), P(i, j + 1)]],
          [i, j, 0, [P(i + 1, j), P(i, j + 1), P(i + 1, j + 1)]],
          [i - 1, j, 0, [P(i, j), P(i - 1, j + 1), P(i, j + 1)]],
          [i, j - 1, 0, [P(i + 1, j - 1), P(i, j), P(i + 1, j)]],
          [i, j - 1, 1, [P(i, j - 1), P(i + 1, j - 1), P(i, j)]],
          [i - 1, j, 1, [P(i - 1, j), P(i, j), P(i - 1, j + 1)]]
        ];
        for (const [ci, cj, up, poly] of cands) {
          if (pointInTriangle(p, poly[0], poly[1], poly[2])) {
            const key = ci + ',' + cj + ',' + up;
            if (n.tris.has(key)) n.tris.delete(key); else n.tris.set(key, true);
            break;
          }
        }
      }
      if (this.onChange) this.onChange();
      this._fit();
      this._render();
    }
  }

  global.NetEditor = NetEditor;
})(window);
