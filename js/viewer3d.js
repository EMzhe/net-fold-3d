/* 3D 查看器：three.js 渲染折叠过程，面片直接使用截图 UV 贴图，
 * 支持拖拽旋转、滚轮缩放、自动旋转、折叠进度动画与视角预设。 */
(function (global) {
  'use strict';
  const THREE = global.THREE;

  const PALETTE = [0x2f6df6, 0xe8590c, 0x0ca678, 0xd6336c, 0x7048e8, 0xf59f00];

  class Viewer3D {
    constructor(canvas) {
      this.canvas = canvas;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.outputEncoding = THREE.sRGBEncoding;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0xf0f3f8);
      this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

      this.group = new THREE.Group();
      this.scene.add(this.group);

      const amb = new THREE.AmbientLight(0xffffff, 0.88);
      const dir1 = new THREE.DirectionalLight(0xffffff, 0.45);
      dir1.position.set(2.5, 3, 4);
      const dir2 = new THREE.DirectionalLight(0xffffff, 0.22);
      dir2.position.set(-3, -1.5, -2.5);
      this.scene.add(amb, dir1, dir2);

      this.orbit = { theta: 0.65, phi: 1.05, radius: 4.2 };
      this.autoRotate = false;
      this.net = null;
      this.t = 1;
      this.texture = null;
      this.imgSize = null;
      this.faceObjs = [];   // [{mesh, edge}]
      this._clock = null;
      this.onFoldResult = null;

      this._bindEvents();
      this._resize();
      this._loop();
      if (window.ResizeObserver) {
        new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
      }
      window.addEventListener('resize', () => this._resize());
    }

    setImage(imgCanvas) {
      if (this.texture) this.texture.dispose();
      const tex = new THREE.CanvasTexture(imgCanvas);
      tex.flipY = false;
      tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 4;
      this.texture = tex;
      this.imgSize = [imgCanvas.width, imgCanvas.height];
      if (this.net) this.setNet(this.net);
    }

    clearImage() {
      if (this.texture) { this.texture.dispose(); this.texture = null; }
      this.imgSize = null;
      if (this.net) this.setNet(this.net);
    }

    setNet(net) {
      this._clearGroup();
      this.net = net;
      if (!net) return;
      const { foldNet } = global.Fold;
      const res0 = foldNet(net, 1);
      if (this.texture) {
        this._sharedMat = new THREE.MeshLambertMaterial({ map: this.texture, side: THREE.DoubleSide });
      }
      const sharedMat = this._sharedMat || null;

      this.faceObjs = res0.faces.map((f, i) => {
        const n = f.verts3.length;
        const positions = new Float32Array((n === 4 ? 6 : 3) * 3);
        const normals = new Float32Array((n === 4 ? 6 : 3) * 3);
        const uvs = new Float32Array((n === 4 ? 6 : 3) * 2);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        const mat = sharedMat || new THREE.MeshLambertMaterial({
          color: PALETTE[i % PALETTE.length], side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData.idx = i;

        /* 边线 */
        const ep = new Float32Array(n * 3);
        const egeo = new THREE.BufferGeometry();
        egeo.setAttribute('position', new THREE.BufferAttribute(ep, 3));
        const edge = new THREE.LineLoop(egeo, new THREE.LineBasicMaterial({ color: 0x303846 }));

        this.group.add(mesh, edge);
        return { mesh, edge };
      });

      this.setT(this.t);
    }

    setT(t) {
      this.t = t;
      if (!this.net || !this.faceObjs.length) { this.renderer.render(this.scene, this.camera); return; }
      const { foldNet } = global.Fold;
      const res = foldNet(this.net, t);
      const [iw, ih] = this.imgSize || [1, 1];
      const mc = res.meanCenter;

      res.faces.forEach((f, i) => {
        const obj = this.faceObjs[i];
        if (!obj) return;
        const vs = f.verts3.map(v => [v[0] - mc[0], v[1] - mc[1], v[2] - mc[2]]);
        const nrm = f.normal;
        const order = vs.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
        const pos = obj.mesh.geometry.attributes.position.array;
        const nor = obj.mesh.geometry.attributes.normal.array;
        const uv = obj.mesh.geometry.attributes.uv.array;
        order.forEach((vi, k) => {
          const p = vs[vi];
          pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
          nor[k * 3] = nrm[0]; nor[k * 3 + 1] = nrm[1]; nor[k * 3 + 2] = nrm[2];
          if (this.texture) {
            uv[k * 2] = f.poly2d[vi][0] / iw;
            uv[k * 2 + 1] = f.poly2d[vi][1] / ih;
          }
        });
        obj.mesh.geometry.attributes.position.needsUpdate = true;
        obj.mesh.geometry.attributes.normal.needsUpdate = true;
        obj.mesh.geometry.attributes.uv.needsUpdate = true;
        obj.mesh.geometry.computeBoundingSphere();

        const ep = obj.edge.geometry.attributes.position.array;
        const off = 0.004;
        vs.forEach((p, k) => {
          ep[k * 3] = p[0] + nrm[0] * off;
          ep[k * 3 + 1] = p[1] + nrm[1] * off;
          ep[k * 3 + 2] = p[2] + nrm[2] * off;
        });
        obj.edge.geometry.attributes.position.needsUpdate = true;
        obj.edge.geometry.computeBoundingSphere();
      });

      if (this.onFoldResult) this.onFoldResult(res);
      this.renderer.render(this.scene, this.camera);
    }

    setView(theta, phi) {
      this.orbit.theta = theta;
      this.orbit.phi = phi;
      this._updateCamera();
      this.renderer.render(this.scene, this.camera);
    }

    resetView() { this.setView(0.65, 1.05); }

    _clearGroup() {
      while (this.group.children.length) {
        const c = this.group.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material && c.material !== this._sharedMat) c.material.dispose();
      }
      this.faceObjs = [];
      if (this._sharedMat) { this._sharedMat.dispose(); this._sharedMat = null; }
    }

    _updateCamera() {
      const { theta, phi, radius } = this.orbit;
      this.camera.position.set(
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.cos(theta)
      );
      this.camera.lookAt(0, 0, 0);
    }

    _bindEvents() {
      const cv = this.canvas;
      let dragging = false, lx = 0, ly = 0;
      cv.style.touchAction = 'none';
      cv.addEventListener('pointerdown', (e) => {
        dragging = true; lx = e.clientX; ly = e.clientY;
        cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        this.orbit.theta -= (e.clientX - lx) * 0.008;
        this.orbit.phi -= (e.clientY - ly) * 0.008;
        this.orbit.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.orbit.phi));
        lx = e.clientX; ly = e.clientY;
        this._updateCamera();
      });
      cv.addEventListener('pointerup', () => { dragging = false; });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.orbit.radius *= Math.exp(e.deltaY * 0.0012);
        this.orbit.radius = Math.max(1.8, Math.min(12, this.orbit.radius));
        this._updateCamera();
      }, { passive: false });
    }

    _resize() {
      const parent = this.canvas.parentElement;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this._updateCamera();
    }

    _loop() {
      requestAnimationFrame(() => this._loop());
      if (this.autoRotate) {
        this.orbit.theta += 0.006;
        this._updateCamera();
      }
      this.renderer.render(this.scene, this.camera);
    }
  }

  global.Viewer3D = Viewer3D;
})(window);
