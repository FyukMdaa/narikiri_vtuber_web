// ──────────────────────────────────────────────────────────────
// inochi-renderer.js — Inochi2D パペット用 WebGL2 レンダラ (v5)
//   公式 inochi2d (v0.8.x) の描画セマンティクスに準拠:
//
//   [v5] プレマルチプライド・アルファ (公式 part.frag と同じ規約)
//        - テクスチャはローダ側で premultiply 済み (TGA デコーダ / PNG)
//        - フラグメント: outColor = vec4(rgb * tint * a, a * opacity)
//        - Normal  = (ONE, ONE_MINUS_SRC_ALPHA)   ← 公式 inSetBlendModeLegacy
//          Multiply= (DST_COLOR, ONE_MINUS_SRC_ALPHA) ← ソフトマスク風の正しい乗算
//          Screen  = (ONE, ONE_MINUS_SRC_COLOR)
//          ClipToLower = (DST_ALPHA, ONE_MINUS_SRC_ALPHA)
//        - ミップマップ生成が数学的に正しくなり、パーツ境界の
//          暗いフリンジ (つなぎ目) が消える
//
//   [v5] Composite の FBO 合成 (公式 composite.d drawContents/drawSelf)
//        - subParts をオフスクリーン FBO に描いてから、
//          Composite 自身の blend_mode + tint + screenTint + opacity で
//          メインバッファへ一枚合成する
//        - これにより「Hair:: Shadows:: Composite (Multiply)」などが
//          公式どおりソフトな影になる (v4 では Normal のまま上塗り = 灰色の塊)
//
//   [v4 から継続] 描画順 = 公式 Puppet.draw() (rootParts 累積 zSort 降順)、
//        マスク = ステンシル (公式 inBeginMask / inBeginMaskContent)
//
//   座標系: Inochi2D は Y-down。u_proj 側で Y 反転して clip 空間へ。
// ──────────────────────────────────────────────────────────────

// パイプライン版数 (inochi-loader.js の INOCHI_PIPELINE_VERSION と一致させる)
//   v5: プレマルチプライド alpha + Composite FBO 合成
const RENDERER_PIPELINE_VERSION = 5;

const VERT_SRC = `#version 300 es
precision highp float;

in vec2 a_pos;       // puppet 座標系 (ピクセル)
in vec2 a_uv;        // 0..1

uniform mat3 u_proj;     // puppet → clip 空間 (bbox から計算)
uniform mat3 u_nodeXform; // per-node transform (worldMatrix)
uniform mat3 u_uvXform;  // テクスチャごとの UV 変換
out vec2 v_uv;

void main() {
  vec3 local = u_nodeXform * vec3(a_pos, 1.0);
  vec3 clip = u_proj * local;
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vec3 uv = u_uvXform * vec3(a_uv, 1.0);
  v_uv = uv.xy;
}
`;

// 公式 part.frag 相当: tint/opacity を適用し **premultiplied** で出力
const FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_tex;
uniform float u_alpha;     // opacity (offsetOpacity * opacity)
uniform float u_alphaCut;  // 破棄閾値 (通常 0.004 / マスク刻字時は mask_threshold)
uniform vec3 u_tint;       // multColor

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec4 c = texture(u_tex, v_uv);
  float a = c.a * u_alpha;
  if (a < u_alphaCut) discard;
  // テクスチャは既に premultiplied (ローダで変換済み)。
  //   opacity (u_alpha) は premult rgb と alpha の両方に掛かる。
  outColor = vec4(c.rgb * u_tint * u_alpha, a);
}
`;

const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

// ══════════════════════════════════════════════════════════════
//  InochiRenderer
// ══════════════════════════════════════════════════════════════
export class InochiRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      antialias: true,
      premultipliedAlpha: true,   // v5: バッファ内容 = premultiplied → 正しいページ合成
      alpha: true,
      depth: false,
      stencil: true,              // マスク (公式 Drawable.masks) に必須
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('Inochi2D: WebGL2 not supported');
    console.info(`[Inochi2D] renderer pipeline v${RENDERER_PIPELINE_VERSION} (premultiplied alpha + Composite FBO + per-frame zSort + stencil masks)`);

    this._program = buildProgram(this.gl, VERT_SRC, FRAG_SRC);
    this._loc = {
      a_pos:      this.gl.getAttribLocation(this._program, 'a_pos'),
      a_uv:       this.gl.getAttribLocation(this._program, 'a_uv'),
      u_proj:     this.gl.getUniformLocation(this._program, 'u_proj'),
      u_nodeXform:this.gl.getUniformLocation(this._program, 'u_nodeXform'),
      u_uvXform:  this.gl.getUniformLocation(this._program, 'u_uvXform'),
      u_tex:      this.gl.getUniformLocation(this._program, 'u_tex'),
      u_alpha:    this.gl.getUniformLocation(this._program, 'u_alpha'),
      u_alphaCut: this.gl.getUniformLocation(this._program, 'u_alphaCut'),
      u_tint:     this.gl.getUniformLocation(this._program, 'u_tint'),
    };

    this._vao = this.gl.createVertexArray();
    this._vboPos = this.gl.createBuffer();
    this._vboUv = this.gl.createBuffer();
    this._ibo = this.gl.createBuffer();

    // Composite 合成用フルスクリーンクアッド (clip 空間 -1..1, uv 0..1)
    this._quadVao = this.gl.createVertexArray();
    this._quadVbo = this.gl.createBuffer();
    {
      const gl = this.gl;
      // x,y, u,v の交互配列。左下原点: (-1,-1)uv(0,0) → (1,1)uv(1,1)
      const quad = new Float32Array([
        -1, -1, 0, 0,
         1, -1, 1, 0,
         1,  1, 1, 1,
        -1,  1, 0, 1,
      ]);
      gl.bindVertexArray(this._quadVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVbo);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this._loc.a_pos);
      gl.vertexAttribPointer(this._loc.a_pos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(this._loc.a_uv);
      gl.vertexAttribPointer(this._loc.a_uv, 2, gl.FLOAT, false, 16, 8);
      this._quadIbo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._quadIbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
    }

    this._textures = new Map();   // texPath -> WebGLTexture
    this._puppet = null;
    this._projMat = new Float32Array(9); // puppet → clip 行列
    this._nodeXformMat = new Float32Array(9); // per-node T*R*S
    this._nodeByUuid = new Map();        // uuid -> flat node (マスク源解決用)
    this._compositeMembers = new Map();  // Composite uuid -> subParts[]

    // Composite 用オフスクリーン FBO
    this._compFbo = null;
    this._compTex = null;
    this._compRbo = null;
    this._compW = 0;
    this._compH = 0;

    this.brightness = 1.0;

    this._resize();
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.disable(this.gl.DEPTH_TEST);
    this.gl.enable(this.gl.BLEND);
    // v5: 常時 premultiplied 規約 (公式 inBeginScene と同じ)
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cssW = this.canvas.clientWidth;
    let cssH = this.canvas.clientHeight;
    if (cssW === 0 || cssH === 0) {
      const parent = this.canvas.parentElement;
      if (parent) {
        const r = parent.getBoundingClientRect();
        cssW = r.width || cssW;
        cssH = r.height || cssH;
      }
    }
    if (cssW === 0 || cssH === 0) {
      const r = this.canvas.getBoundingClientRect();
      cssW = r.width || cssW;
      cssH = r.height || cssH;
    }
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // パペットをレンダラへ紐付け。テクスチャをアップロード + u_proj 計算。
  attachPuppet(puppetHandle) {
    this._puppet = puppetHandle;
    this._textures.clear();
    this._resize();

    const data = puppetHandle.getRenderData();
    const gl = this.gl;
    for (const tex of (data.textures || [])) {
      if (!tex.bitmap) continue;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      // v5: ローダが premultiply 済みのデータを渡すので、ここでは変換しない
      //   (ImageBitmap の場合は UNPACK_* は仕様上無視される)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex.bitmap);
      // 公式と同じくミップマップは使わない (LINEAR のみ)。
      //   ミップを生成すると縮小時にアトラスの隣接テクスチャが混入し、
      //   輪郭に色飞び (スぺックル) が出る。premultiplied 化の恩恵は
      //   ブレンドの数学的正しさ (Multiply/ソフトエッジ) で得られる。
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._textures.set(tex.name, t);
    }
    this._renderData = data;
    this._rebuildNodeIndex(data);
    this._updateProjMatrix();
  }

  // u_proj を計算 (puppet → clip 空間, Y 反転 + アスペクト維持 fit)
  _updateProjMatrix() {
    const bbox = this._renderData?.bbox;
    if (!bbox) {
      this._projMat.set(IDENTITY3);
      return;
    }
    const cw = this.canvas.width || 1;
    const ch = this.canvas.height || 1;
    const canvasAspect = cw / ch;
    const bboxAspect = bbox.width / bbox.height;

    let scaleX, scaleY;
    if (bboxAspect > canvasAspect) {
      scaleX = 2 / bbox.width;
      scaleY = scaleX;
    } else {
      scaleY = 2 / bbox.height;
      scaleX = scaleY;
    }
    const tx = -bbox.cx * scaleX;
    const ty = bbox.cy * scaleY; // Y 反転 (puppet Y-down → clip Y-up)

    // 列優先 mat3:
    //   | sx  0   tx |
    //   | 0  -sy  ty |
    //   | 0   0   1 |
    this._projMat.set([
      scaleX,  0,       0,
      0,      -scaleY, 0,
      tx,     ty,       1,
    ]);
  }

  refreshRenderData() {
    if (!this._puppet) return;
    this._renderData = this._puppet.getRenderData();
    this._rebuildNodeIndex(this._renderData);
  }

  _rebuildNodeIndex(data) {
    this._nodeByUuid = new Map();
    for (const n of (data?.nodes || [])) {
      if (n.uuid != null) this._nodeByUuid.set(n.uuid, n);
    }
    this._compositeMembers = new Map();
    for (const item of (data?.drawList || [])) {
      if (item.composite && item.node) {
        this._compositeMembers.set(item.node.uuid, item.composite);
      }
    }
  }

  // ── Composite 用 FBO (公式 inBeginComposite/inEndComposite) ──
  _ensureCompositeFbo(w, h) {
    const gl = this.gl;
    if (this._compFbo && this._compW === w && this._compH === h) return;
    this._destroyCompositeFbo();
    this._compTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._compTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._compRbo = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this._compRbo);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    this._compFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._compFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._compTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this._compRbo);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._compW = w;
    this._compH = h;
  }

  _destroyCompositeFbo() {
    const gl = this.gl;
    if (this._compFbo) gl.deleteFramebuffer(this._compFbo);
    if (this._compTex) gl.deleteTexture(this._compTex);
    if (this._compRbo) gl.deleteRenderbuffer(this._compRbo);
    this._compFbo = null;
    this._compTex = null;
    this._compRbo = null;
    this._compW = 0;
    this._compH = 0;
  }

  // 1フレーム描画
  render() {
    this._resize();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    if (!this._puppet || !this._renderData) return;

    this._updateProjMatrix();

    gl.useProgram(this._program);
    gl.uniform1i(this._loc.u_tex, 0);
    gl.uniform1f(this._loc.u_alphaCut, 0.004);
    gl.activeTexture(gl.TEXTURE0);

    // ── ブレンドモード (公式 common.d inSetBlendModeLegacy / premultiplied 入力) ──
    const BLEND_MODES = {
      Normal:         ['ONE',        'ONE_MINUS_SRC_ALPHA'],
      Multiply:       ['DST_COLOR',  'ONE_MINUS_SRC_ALPHA'],
      Screen:         ['ONE',        'ONE_MINUS_SRC_COLOR'],
      ClipToLower:    ['DST_ALPHA',  'ONE_MINUS_SRC_ALPHA'],
      SliceFromLower: ['ZERO',       'ONE_MINUS_SRC_ALPHA'],
      DestinationIn:  ['ZERO',       'SRC_ALPHA'],
    };
    const setBlendMode = (mode) => {
      const bf = BLEND_MODES[mode] || BLEND_MODES.Normal;
      // 公式どおり alpha チャンネルにも同じ係数を適用 (glBlendFunc)
      gl.blendFunc(gl[bf[0]], gl[bf[1]]);
    };

    // 幾何描画本体。opts.forMask = ステンシル刻字のみ (公式 drawOneDirect 相当)
    const drawPart = (node, opts = {}) => {
      const forMask = !!opts.forMask;
      if (!forMask && !node.visible) return;
      const mesh = node.mesh;
      if (!mesh || !mesh.vertices || mesh.vertices.length === 0) return;
      if (!mesh.indices || mesh.indices.length === 0) return;

      let glTex = null;
      if (mesh.texPath && this._textures.has(mesh.texPath)) {
        glTex = this._textures.get(mesh.texPath);
      } else if (mesh.tex?.name && this._textures.has(mesh.tex.name)) {
        glTex = this._textures.get(mesh.tex.name);
      }
      if (!glTex) return;

      // ── マスク (公式 Drawable.masks → ステンシル) ──
      let masking = false;
      if (!forMask && Array.isArray(node.masks) && node.masks.length > 0) {
        masking = true;
        const anyNonDodge = node.masks.some(m => !m.dodge);
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xff);
        gl.clearStencil(anyNonDodge ? 0 : 1);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        for (const m of node.masks) {
          const src = this._nodeByUuid.get(m.source);
          if (src) this._renderMaskSource(src, m.dodge, drawPart);
        }
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.EQUAL, 1, 0xff);
        gl.stencilMask(0x00);
      }

      try {
        const verts = mesh.vertices;
        const deform = node._deformOffsets;
        const n = verts.length / 2;
        const posArr = new Float32Array(verts.length);
        for (let i = 0; i < n; i++) {
          let x = verts[i * 2];
          let y = verts[i * 2 + 1];
          if (deform && deform.length >= verts.length) {
            x += deform[i * 2];
            y += deform[i * 2 + 1];
          }
          posArr[i * 2] = x;
          posArr[i * 2 + 1] = y;
        }
        const uvs = mesh.uvs;
        const uvArr = (uvs && uvs.length > 0) ? uvs : defaultUVs(n);

        gl.bindVertexArray(this._vao);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
        gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this._loc.a_pos);
        gl.vertexAttribPointer(this._loc.a_pos, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this._vboUv);
        gl.bufferData(gl.ARRAY_BUFFER, uvArr, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this._loc.a_uv);
        gl.vertexAttribPointer(this._loc.a_uv, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indices), gl.DYNAMIC_DRAW);

        const uvXform = mesh.uvTransform || [1, 1, 0, 0];
        const u_uvXform = new Float32Array([
          uvXform[0] || 1, 0, 0,
          0, uvXform[1] || 1, 0,
          uvXform[2] || 0, uvXform[3] || 0, 1,
        ]);
        gl.uniformMatrix3fv(this._loc.u_uvXform, false, u_uvXform);

        if (node.worldMatrix) {
          this._nodeXformMat.set(node.worldMatrix);
        } else {
          buildNodeXform(node, this._nodeXformMat);
        }
        gl.uniformMatrix3fv(this._loc.u_nodeXform, false, this._nodeXformMat);
        gl.uniformMatrix3fv(this._loc.u_proj, false, this._projMat);

        const tint = node.tint || [1, 1, 1];
        const gt = opts.groupTint || null;
        const opacity = (node.opacity != null ? node.opacity : 1.0)
          * (opts.groupOpacity != null ? opts.groupOpacity : 1.0);
        const b = this.brightness;
        gl.uniform3f(this._loc.u_tint,
          tint[0] * (gt ? gt[0] : 1) * b,
          tint[1] * (gt ? gt[1] : 1) * b,
          tint[2] * (gt ? gt[2] : 1) * b);
        gl.uniform1f(this._loc.u_alpha, opacity);
        // マスク刻字時は mask_threshold (公式 maskAlphaThreshold) を適用。
        //   これによりマスク源の半透明フェザーエッジがステンシルに混入しない。
        gl.uniform1f(this._loc.u_alphaCut,
          forMask ? Math.min(1, Math.max(node.maskThreshold ?? 0, 0.004)) : 0.004);

        setBlendMode(forMask ? 'Normal' : (node.blendMode || 'Normal'));

        gl.bindTexture(gl.TEXTURE_2D, glTex);
        gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
      } finally {
        if (masking) {
          gl.stencilMask(0xff);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff);
          gl.disable(gl.STENCIL_TEST);
        }
      }
    };

    // ── 描画順 (公式 Puppet.draw(): 累積 zSort 降順スタブルソート) ──
    const zTotal = (n) => (n._zSortAcc || 0) + (n._zSortOffset || 0);
    const drawList = this._renderData.drawList;
    if (Array.isArray(drawList) && drawList.length > 0) {
      const list = drawList.slice().sort((a, b) => zTotal(b.node) - zTotal(a.node));
      for (const item of list) {
        if (item.part) {
          drawPart(item.part);
        } else if (item.composite) {
          // ── 公式 Composite.drawOne(): FBO へ描いてから blend_mode で合成 ──
          if (window.__INOCHI_DISABLE_COMPOSITE_FBO__) {
            // DEBUG: v4 互換 (直接描画)
            const parts = item.composite.slice().sort((a, b) => zTotal(b) - zTotal(a));
            const groupOpacity = (item.node && item.node.opacity != null) ? item.node.opacity : 1;
            const groupTint = (item.node && item.node.tint) || [1, 1, 1];
            for (const p of parts) drawPart(p, { groupOpacity, groupTint });
          } else {
            this._drawComposite(item, setBlendMode, drawPart);
          }
        }
      }
    } else {
      const nodes = this._renderData.nodes || [];
      for (const node of nodes) drawPart(node);
    }
    gl.bindVertexArray(null);
    setBlendMode('Normal');
  }

  // 公式 Composite.drawOne() 相当:
  //   selfSort → drawContents (FBO へ subParts を描画) → drawSelf (FBO を合成)
  _drawComposite(item, setBlendMode, drawPart) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    this._ensureCompositeFbo(w, h);

    // inBeginComposite: FBO へ切替 + クリア (premultiplied 蓄積)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._compFbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const parts = item.composite.slice().sort((a, b) => {
      const za = (a._zSortAcc || 0) + (a._zSortOffset || 0);
      const zb = (b._zSortAcc || 0) + (b._zSortOffset || 0);
      return zb - za;
    });
    for (const p of parts) drawPart(p);

    // inEndComposite + drawSelf: FBO テクスチャを composite の属性でメインへ合成
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.STENCIL_TEST);

    const cNode = item.node;
    const tint = (cNode && cNode.tint) || [1, 1, 1];
    const opacity = (cNode && cNode.opacity != null) ? cNode.opacity : 1;
    const b = this.brightness;

    gl.useProgram(this._program);
    gl.uniformMatrix3fv(this._loc.u_proj, false, IDENTITY3);
    gl.uniformMatrix3fv(this._loc.u_nodeXform, false, IDENTITY3);
    gl.uniformMatrix3fv(this._loc.u_uvXform, false, IDENTITY3);
    gl.uniform3f(this._loc.u_tint, tint[0] * b, tint[1] * b, tint[2] * b);
    gl.uniform1f(this._loc.u_alpha, opacity);
    // screenTint は Aka 系モデルでは未使用 ([0,0,0])。将来的にここへ加算合成を実装。
    setBlendMode((cNode && cNode.blendMode) || 'Normal');
    gl.bindVertexArray(this._quadVao);
    gl.bindTexture(gl.TEXTURE_2D, this._compTex);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  // マスク源をステンシルバッファへ刻字 (公式 Part.renderMask / Composite.renderMask 相当)
  _renderMaskSource(srcNode, dodge, drawGeometry) {
    const gl = this.gl;
    gl.colorMask(false, false, false, false);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, dodge ? 0 : 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    const members = (srcNode.type === 'Composite')
      ? (this._compositeMembers.get(srcNode.uuid) || [])
      : [srcNode];
    for (const m of members) drawGeometry(m, { forMask: true });
    gl.colorMask(true, true, true, true);
  }

  // パペットの破棄
  detachPuppet() {
    for (const t of this._textures.values()) {
      this.gl.deleteTexture(t);
    }
    this._textures.clear();
    this._puppet = null;
    this._renderData = null;
    this._nodeByUuid = new Map();
    this._compositeMembers = new Map();
    this._destroyCompositeFbo();
  }

  destroy() {
    this.detachPuppet();
    this.gl.deleteBuffer(this._vboPos);
    this.gl.deleteBuffer(this._vboUv);
    this.gl.deleteBuffer(this._ibo);
    this.gl.deleteBuffer(this._quadVbo);
    this.gl.deleteBuffer(this._quadIbo);
    this.gl.deleteVertexArray(this._vao);
    this.gl.deleteVertexArray(this._quadVao);
    this.gl.deleteProgram(this._program);
  }
}

// ══════════════════════════════════════════════════════════════
//  ヘルパ
// ══════════════════════════════════════════════════════════════
function buildProgram(gl, vsSrc, fsSrc) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Inochi2D shader compile: ' + log);
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('Inochi2D program link: ' + log);
  }
  return prog;
}

// ── ノード transform (T * R * S) を 3x3 行列へ構築 (worldMatrix 未計算時のフォールバック) ──
function buildNodeXform(node, out) {
  const t = node.transform || node.restTransform;
  if (!t) {
    out.set(IDENTITY3);
    return;
  }
  const tx = (t.trans && t.trans[0]) || 0;
  const ty = (t.trans && t.trans[1]) || 0;
  const rz = (t.rot   && t.rot[2])   || 0;
  const sx = (t.scale && t.scale[0]) || 1;
  const sy = (t.scale && t.scale[1]) || 1;
  const cos = Math.cos(rz);
  const sin = Math.sin(rz);
  out[0] = sx * cos;  out[3] = -sy * sin;  out[6] = tx;
  out[1] = sx * sin;  out[4] =  sy * cos;  out[7] = ty;
  out[2] = 0;         out[5] = 0;          out[8] = 1;
}

function defaultUVs(n) {
  const uvs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { uvs[i*2] = 0; uvs[i*2+1] = 0; }
  return uvs;
}

// ── メッシュ正規化ヘルパ (旧 ZIP 形式 v0.6 用、互換性の為残す) ──
export function normalizeMeshes(puppet) {
  if (!puppet || !puppet.nodes) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of puppet.nodes) {
    if (!node.mesh) continue;
    const v = node.mesh.vertices;
    for (let i = 0; i < v.length; i += 2) {
      const x = v[i], y = v[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return;
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const aspect = w / h;
  let sx, sy;
  if (aspect > 1) { sx = 2 / w; sy = (2 / w); }
  else { sy = 2 / h; sx = 2 / h; }
  for (const node of puppet.nodes) {
    if (!node.mesh) continue;
    const v = node.mesh.vertices;
    for (let i = 0; i < v.length; i += 2) {
      v[i]     = (v[i]     - cx) * sx;
      v[i + 1] = (v[i + 1] - cy) * sy;
    }
  }
}
