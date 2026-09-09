// ──────────────────────────────────────────────────────────────
// inochi2d-runtime.js — Inochi2D の高レベル JS ラッパ
//   - 公式 WASM SDK（wasm-pack --target web ビルド）を優先使用
//   - バイナリが未配置 / export 不十分なら JS フォールバックへ退化
//   - フォールバックは phase 1（ロード+静止表示）のみをサポート
//   - WASM が在れば phase 2-4（物理/変形/パラメータ連動）も動作
//
//  外部に公開する単一のクラス: InochiRuntime
//   - await InochiRuntime.create() でインスタンス取得
//   - isAvailable: wasm バックエンドが使えるか
//   - loadPuppet(arraybuffer): .inp をパース → PuppetHandle を返す
//   - PuppetHandle.getParams() / setParam(name, value) / update(dt)
//   - PuppetHandle.getRenderData(): WebGL2 描画用データを返す
// ──────────────────────────────────────────────────────────────

// ── WASM グルーが export しているであろう関数名の候補 ──
//   wasm-pack 出力の命名規則に加え、手書き wasm-bindgen ラッパや
//   StarCried/inochi2d-web 形式までカバーする。
const WASM_FN_CANDIDATES = {
  loadPuppet:  ['load_puppet', 'loadPuppet', 'Inochi2D_load_puppet', 'puppet_from_buffer'],
  freePuppet:  ['free_puppet', 'freePuppet', 'Inochi2D_free_puppet', 'puppet_free'],
  getParams:   ['get_params', 'getParams', 'Inochi2D_get_params', 'puppet_params'],
  setParam:    ['set_param', 'setParam', 'Inochi2D_set_param', 'puppet_set_param'],
  update:      ['update', 'step', 'tick', 'puppet_update'],
  getNodes:    ['get_nodes', 'getNodes', 'puppet_nodes', 'nodes_get'],
  getTextures: ['get_textures', 'getTextures', 'puppet_textures', 'textures_get'],
};

// ── 候補名から最初に見つかった export を返す ──
function probeExport(exports, candidates) {
  for (const name of candidates) {
    if (typeof exports[name] === 'function') return exports[name];
  }
  return null;
}

// ── 公式 WASM SDK のロードを試みる ──
//   1. ./inochi2d_wasm.js (wasm-pack グルー) があれば dynamic import
//   2. 無ければ ./inochi2d_wasm_bg.wasm を直接 instantiateStreaming
//   3. どちらも失敗したら null を返す（呼び出し側で JS フォールバックへ）
async function tryLoadWasm() {
  const base = new URL('./', import.meta.url).href;

  // (1) wasm-pack 形式のグルースクリプトを試す
  try {
    const glueModule = await import(/* @vite-ignore */ './inochi2d_wasm.js');
    if (glueModule?.default && typeof glueModule.default === 'function') {
      // wasm-pack --target web の default は非同期 init を含む
      await glueModule.default(new URL('./inochi2d_wasm_bg.wasm', base));
    } else if (glueModule?.init && typeof glueModule.init === 'function') {
      await glueModule.init(new URL('./inochi2d_wasm_bg.wasm', base));
    }
    if (glueModule && typeof glueModule === 'object') {
      return glueModule;
    }
  } catch (e) {
    // グルーが無い場合は直接 instantiate へ
  }

  // (2) 直接 instantiateStreaming
  try {
    const resp = await fetch(new URL('./inochi2d_wasm_bg.wasm', base));
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    let instance;
    if (contentType.includes('application/wasm')) {
      instance = await WebAssembly.instantiateStreaming(resp);
    } else {
      const buf = await resp.arrayBuffer();
      instance = await WebAssembly.instantiate(buf);
    }
    return instance.instance?.exports || null;
  } catch (e) {
    return null;
  }
}

// ── WASM バックエンドが必須関数を export しているか検査 ──
function validateWasmExports(exports) {
  if (!exports) return false;
  // loadPuppet + update + getNodes は必須
  const need = ['loadPuppet', 'update', 'getNodes'];
  for (const fn of need) {
    if (!probeExport(exports, WASM_FN_CANDIDATES[fn])) return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════
//  InochiRuntime — 全体のファサード
// ══════════════════════════════════════════════════════════════
export class InochiRuntime {
  constructor(wasmBackend) {
    this._wasm = wasmBackend;
    this.isAvailable = !!wasmBackend;
    this._puppets = new Map();
    this._nextId = 1;
  }

  // ファクトリ: WASM ロードを試み、失敗時は JS フォールバックで生成
  static async create() {
    const wasm = await tryLoadWasm();
    if (wasm && validateWasmExports(wasm)) {
      console.info('[Inochi2D] WASM backend detected — full features enabled.');
      return new InochiRuntime(wasm);
    }
    console.warn('[Inochi2D] WASM unavailable — falling back to JS bindings evaluator (basic transforms + deform).');
    return new InochiRuntime(null);
  }

  // .inp (ZIP 旧形式 または TRNSRTS 新形式) をロード → PuppetHandle を返す
  //   WASM バックエンドがある場合は wasm へ、無ければ JS フォールバック
  async loadPuppet(arrayBuffer) {
    const id = this._nextId++;
    let puppet;
    if (this._wasm) {
      try {
        puppet = await this._callWasm('loadPuppet', new Uint8Array(arrayBuffer));
      } catch (e1) {
        try {
          puppet = await this._callWasm('loadPuppet', arrayBuffer);
        } catch (e2) {
          console.warn('[Inochi2D] wasm loadPuppet failed:', e2);
          return null;
        }
      }
    } else {
      // JS フォールバック: inochi-loader.js の loadInp が両形式を自動判別
      //   (ZIP 形式と TRNSRTS 形式をマジックで判別)
      const { loadInp } = await import('app/core/inochi-loader.js');
      puppet = await loadInp(arrayBuffer);
    }
    if (!puppet) return null;

    const handle = new PuppetHandle(id, this, puppet);
    this._puppets.set(id, handle);
    return handle;
  }

  freePuppet(handle) {
    if (this._wasm) {
      this._callWasm('freePuppet', handle._raw);
    }
    this._puppets.delete(handle._id);
  }

  // 内部用: 純 JS パース済み puppet オブジェクトを PuppetHandle でラップ
  //   inochi-loader.js の JS フォールバックパスから呼ばれる。
  //   ※ PuppetHandle はこのモジュール内で定義された private クラスだが、
  //     同一モジュール内なので直接構築可能。
  _wrapAsHandle(puppet) {
    if (!puppet) return null;
    const id = this._nextId++;
    const handle = new PuppetHandle(id, this, puppet);
    this._puppets.set(id, handle);
    return handle;
  }

  // 内部用: wasm 候補名から関数を探して呼ぶ
  _callWasm(fnName, ...args) {
    const fn = probeExport(this._wasm, WASM_FN_CANDIDATES[fnName]);
    if (!fn) throw new Error(`Inochi2D wasm export "${fnName}" not found`);
    return fn(...args);
  }
}

// ══════════════════════════════════════════════════════════════
//  PuppetHandle — パペット 1 体分の API
// ══════════════════════════════════════════════════════════════
class PuppetHandle {
  constructor(id, runtime, raw) {
    this._id = id;
    this._runtime = runtime;
    this._raw = raw;          // wasm バックエンドでは wasm 側ハンドル、JS フォールバックでは純 JS オブジェクト
    this._params = null;      // パラメータ仕様のキャッシュ
    this._paramByName = null;
  }

  // パラメータ仕様一覧を取得
  getParams() {
    if (this._params) return this._params;
    let list;
    if (this._runtime._wasm) {
      list = this._runtime._callWasm('getParams', this._raw);
    } else {
      list = this._raw.params || [];
    }
    this._params = list;
    this._paramByName = new Map(list.map(p => [p.name, p]));
    return list;
  }

  // パラメータ名で値を設定
  //   v5: vec2 パラメータは [x, y] 配列を受け付ける
  //   (例: "Head:: Yaw-Pitch" へ [yaw, pitch]、"Mouth:: Shape" へ [smile, open])
  setParam(name, value) {
    if (this._runtime._wasm) {
      this._runtime._callWasm('setParam', this._raw, name, value);
    } else {
      // JS フォールバック: 内部ステートを更新
      const p = this._raw._values || (this._raw._values = {});
      p[name] = value;
    }
  }

  // 1フレーム更新
  //   WASM バックエンドがある場合は wasm へ委譲。
  //   JS フォールバックの場合は、各パラメータの bindings を評価して
  //   対象ノードの transform / deform へ反映する。
  update(dt) {
    if (this._runtime._wasm) {
      this._runtime._callWasm('update', this._raw, dt);
      return;
    }
    // ── JS フォールバック: bindings 評価 ──
    this._applyBindings();
  }

  // JS フォールバック用: 全パラメータの bindings を評価して
  // ノード transform と deform offsets へ累積適用
  _applyBindings() {
    const puppet = this._raw;
    if (!puppet || !puppet.nodes) return;
    const nodeIndex = puppet._nodeIndexByUuid;
    if (!nodeIndex) return;

    // 1. 全ノードの transform と _deformOffsets を restTransform へリセット
    //   ※ _zSortOffset (zSort バインディングの offsetSort 相当) も毎フレーム
    //     リセットする。公式は beginUpdate() で offsetSort = 0 に戻す。
    //   ※ これを忘れると zSort バインディングの値が毎フレーム累積し、
    //     描画順が時間経過で破壊される。
    for (const n of puppet.nodes) {
      n._zSortOffset = 0;          // restTransform の有無にかかわらず全ノードでリセット
      if (!n.restTransform) continue;
      n.transform.trans[0] = n.restTransform.trans[0] || 0;
      n.transform.trans[1] = n.restTransform.trans[1] || 0;
      n.transform.rot[0]   = n.restTransform.rot[0]   || 0;
      n.transform.rot[1]   = n.restTransform.rot[1]   || 0;
      n.transform.rot[2]   = n.restTransform.rot[2]   || 0;
      n.transform.scale[0]  = n.restTransform.scale[0] || 1;
      n.transform.scale[1]  = n.restTransform.scale[1] || 1;
      if (n._deformOffsets) n._deformOffsets.fill(0);
      n._zSortOffset = 0;
    }

    // 2. 各パラメータの bindings を評価
    //   v5: vec2 パラメータは値が [x, y] 配列で入り、各軸を独立に正規化する。
    //      スカラー値の場合は従来どおり両軸に同じ値を使う。
    const values = puppet._values || {};
    for (const param of puppet.params || []) {
      const raw = values[param.name];
      if (raw === undefined) continue;  // setParam された値のみ適用
      const vx = Array.isArray(raw) ? raw[0] : raw;
      const vy = Array.isArray(raw) ? (raw.length > 1 ? raw[1] : raw[0]) : raw;

      for (const binding of param.bindings || []) {
        const targetIdx = nodeIndex.get(binding.node);
        if (targetIdx === undefined) continue;
        const target = puppet.nodes[targetIdx];

        // パラメータ値を [0,1] の正規化空間へ (axis ごと)
        const minX = Array.isArray(param.min) ? param.min[0] : (param.min ?? 0);
        const maxX = Array.isArray(param.max) ? param.max[0] : (param.max ?? 1);
        const minY = Array.isArray(param.min) ? (param.min.length > 1 ? param.min[1] : param.min[0]) : (param.min ?? 0);
        const maxY = Array.isArray(param.max) ? (param.max.length > 1 ? param.max[1] : param.max[0]) : (param.max ?? 1);
        const nvX = (maxX === minX) ? 0 : (vx - minX) / (maxX - minX);
        const nvY = param.isVec2
          ? (maxY === minY ? 0 : (vy - minY) / (maxY - minY))
          : 0;

        // axis_points に沿って補間位置を計算
        const axisX = param.axisPoints?.[0] || [0, 1];
        const axisY = param.axisPoints?.[1] || [0];

        // bilinear 補間で binding 値を取得
        const result = evalBinding(binding, axisX, axisY, nvX, nvY);

        // 対象ノードの該当プロパティへ適用 (Additive mode を仮定)
        applyBindingToNode(target, binding.param_name, result);
      }
    }

    // 3. 各ノードのワールド行列を再計算
    //   ※ bindings が transform を更新したので、worldMatrix も更新する必要がある。
    //   ※ これをしないと親の変化が子に伝播せず、子が古い位置に留まる。
    _recomputeWorldMatrices(puppet);
  }

  // 描画用データ取得
  //   { nodes, textures, bbox }
  //   ※ JS フォールバック時は puppet 構築時に計算した bbox を添える。
  //   ※ WASM バックエンド時は wasm 側が bbox を計算して返すことを想定。
  getRenderData() {
    if (this._runtime._wasm) {
      return {
        nodes: this._runtime._callWasm('getNodes', this._raw),
        textures: this._runtime._callWasm('getTextures', this._raw),
        bbox: this._runtime._callWasm('getBBox', this._raw),
      };
    }
    return {
      nodes: this._raw.nodes || [],
      textures: this._raw.textures || [],
      bbox: this._raw.bbox || null,
      drawList: this._raw.drawList || null,   // 公式 draw セマンティクス準拠の描画順
    };
  }

  dispose() {
    this._runtime.freePuppet(this);
  }
}

// ══════════════════════════════════════════════════════════════
//  JS フォールバック: 純 JS で .inp をパース
//   - 物理演算やパラメータ駆動の変形は無し（phase 1 のみ）
//   - メッシュとテクスチャだけを取り出して静止描画可能にする
// ══════════════════════════════════════════════════════════════
async function jsFallbackLoadPuppet(arrayBuffer) {
  // ZIP 展開は core/inochi-loader.js の unzipInp に任せる。
  // ここでは「最低限の puppet 構造」を loader 側で既に構築済みであることを想定し、
  // loader が .fromArrayBuffer() を呼んだあとこの関数には来ないように作る。
  //
  // ただし wasm バックエンド無しで loadPuppet() が呼ばれた場合の
  // 一貫性を保つため、ここでは loader へ処理を移譲するブリッジを置く。
  const { parseInp } = await import('app/core/inochi-loader.js');
  return await parseInp(arrayBuffer);
}

// ── 各ノードのワールド行列を再計算 ──
//   puppet.nodes は DFS 順 (親が先)。親の worldMatrix を使って
//   子の worldMatrix = parent.worldMatrix * localMatrix を計算する。
//   puppet._nodeIndexByUuid で uuid → index を引く。
function _recomputeWorldMatrices(puppet) {
  const nodes = puppet.nodes;
  if (!nodes || !nodes.length) return;
  const uuidIndex = puppet._nodeIndexByUuid;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const local = _buildLocalMatrix(n.transform || n.restTransform);
    let parentMat = null;
    if (n.parent != null && uuidIndex) {
      const pIdx = uuidIndex.get(n.parent);
      if (pIdx != null && pIdx < i) {
        parentMat = nodes[pIdx].worldMatrix;
      }
    }
    n.worldMatrix = parentMat ? _mat3Mul(parentMat, local) : local;
  }
}

// 列優先 mat3 を transform から構築
function _buildLocalMatrix(t) {
  if (!t) return new Float32Array([1,0,0, 0,1,0, 0,0,1]);
  const tx = (t.trans && t.trans[0]) || 0;
  const ty = (t.trans && t.trans[1]) || 0;
  const rz = (t.rot   && t.rot[2])   || 0;
  const sx = (t.scale && t.scale[0]) || 1;
  const sy = (t.scale && t.scale[1]) || 1;
  const cos = Math.cos(rz);
  const sin = Math.sin(rz);
  return new Float32Array([
    sx * cos,  sx * sin,  0,
    -sy * sin, sy * cos,  0,
    tx,        ty,        1,
  ]);
}

// C = A * B (列優先 mat3)
function _mat3Mul(a, b) {
  const out = new Float32Array(9);
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += a[k * 3 + i] * b[j * 3 + k];
      }
      out[j * 3 + i] = sum;
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  bindings 評価ヘルパ (JS フォールバック用)
// ══════════════════════════════════════════════════════════════

// ── binding の values テーブルから補間値を取得 ──
//   axisX: X 軸のサンプル点列 (例: [0, 0.125, 0.25, ..., 1.0])
//   axisY: Y 軸のサンプル点列 (vec2 のみ。scalar は [0])
//   nvX, nvY: 現在の正規化入力 [0..1]
//
//   戻り値: スカラー値 (transform.t.x 等) または 頂点配列 (deform)
//   ※ vec2 と scalar の両方を同じ関数で処理するため、values 形状は
//     values[i][j] を持つ。i は axisX に沿ったインデックス、j は axisY。
//   ※ isSet は無視 (値が入っていればそのまま使う。一部未設定エントリは
//      補間で自然に処理される)
function evalBinding(binding, axisX, axisY, nvX, nvY) {
  const values = binding.values;
  if (!values || values.length === 0) return 0;

  // 入力を [0,1] の範囲にクランプ
  const cx = Math.max(0, Math.min(1, nvX));
  const cy = Math.max(0, Math.min(1, nvY));

  // X 軸の補間位置を特定
  const ix0 = findInterval(axisX, cx);
  const ix1 = Math.min(ix0 + 1, axisX.length - 1);
  const fx = axisX.length > 1
    ? (cx - axisX[ix0]) / (axisX[ix1] - axisX[ix0] || 1e-6)
    : 0;

  // Y 軸 (vec2 の場合のみ)
  const iy0 = findInterval(axisY, cy);
  const iy1 = Math.min(iy0 + 1, axisY.length - 1);
  const fy = axisY.length > 1
    ? (cy - axisY[iy0]) / (axisY[iy1] - axisY[iy0] || 1e-6)
    : 0;

  // 4隅のサンプリング (values 形状: values[ix][iy])
  //   ※ ix0/ix1 が values の範囲を超えないようクランプ
  const sx0 = ix0 < values.length ? values[ix0] : values[values.length - 1];
  const sx1 = ix1 < values.length ? values[ix1] : values[values.length - 1];
  if (!sx0 || !sx1) return 0;

  const v00 = iy0 < sx0.length ? sx0[iy0] : sx0[sx0.length - 1];
  const v01 = iy1 < sx0.length ? sx0[iy1] : sx0[sx0.length - 1];
  const v10 = iy0 < sx1.length ? sx1[iy0] : sx1[sx1.length - 1];
  const v11 = iy1 < sx1.length ? sx1[iy1] : sx1[sx1.length - 1];

  // 双線形補間 (要素がスカラーでも配列でも動く)
  return bilinear(v00, v01, v10, v11, fx, fy);
}

// axisPoints 配列で、入力 t がどの区間にあるか (左 index を返す)
function findInterval(arr, t) {
  if (arr.length === 0) return 0;
  if (t <= arr[0]) return 0;
  if (t >= arr[arr.length - 1]) return arr.length - 1;
  for (let i = 0; i < arr.length - 1; i++) {
    if (t >= arr[i] && t <= arr[i + 1]) return i;
  }
  return arr.length - 1;
}

// 双線形補間
//   v00, v01, v10, v11 は同じ shape (スカラー or 配列 or 配列の配列)
//   fx, fy は [0,1] の補間係数
function bilinear(v00, v01, v10, v11, fx, fy) {
  // スカラーの場合 (transform.t.x 等)
  if (typeof v00 === 'number') {
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
  }
  // 配列の場合 (deform: 各頂点 [dx, dy] の配列)
  if (Array.isArray(v00)) {
    const len = v00.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      const e00 = v00[i];
      const e01 = v01[i];
      const e10 = v10[i];
      const e11 = v11[i];
      // 各要素がさらに配列 ([dx, dy]) の場合
      if (Array.isArray(e00)) {
        const sub = new Array(e00.length);
        for (let j = 0; j < e00.length; j++) {
          const a = e00[j] + (e10[j] - e00[j]) * fx;
          const b = e01[j] + (e11[j] - e01[j]) * fx;
          sub[j] = a + (b - a) * fy;
        }
        out[i] = sub;
      } else {
        const a = e00 + (e10 - e00) * fx;
        const b = e01 + (e11 - e01) * fx;
        out[i] = a + (b - a) * fy;
      }
    }
    return out;
  }
  return v00;
}

// ── binding 評価結果をノードへ適用 ──
//   paramName: "transform.t.x" / "transform.r.x" / "transform.s.x" / "deform" / "zSort"
//   value: スカラー (transform系) または 頂点配列 (deform)
function applyBindingToNode(node, paramName, value) {
  switch (paramName) {
    case 'transform.t.x':
      node.transform.trans[0] += Number(value) || 0;
      break;
    case 'transform.t.y':
      node.transform.trans[1] += Number(value) || 0;
      break;
    case 'transform.r.x':
      node.transform.rot[0] += Number(value) || 0;
      break;
    case 'transform.r.y':
      node.transform.rot[1] += Number(value) || 0;
      break;
    case 'transform.r.z':
      node.transform.rot[2] += Number(value) || 0;
      break;
    case 'transform.s.x':
      node.transform.scale[0] += (Number(value) - 1) || 0; // additive (1 = neutral)
      break;
    case 'transform.s.y':
      node.transform.scale[1] += (Number(value) - 1) || 0;
      break;
    case 'zSort':
      // zSort は描画順に影響。現状は格納のみ (将来ソートに使用)
      node._zSortOffset = (node._zSortOffset || 0) + (Number(value) || 0);
      break;
    case 'deform':
      // 頂点オフセット配列を _deformOffsets へ加算
      //   value は [[dx, dy], [dx, dy], ...] の形を想定
      if (!node._deformOffsets || !Array.isArray(value)) break;
      const verts = node.mesh?.vertices;
      if (!verts) break;
      const vCount = verts.length / 2;
      const len = Math.min(value.length, vCount);
      for (let i = 0; i < len; i++) {
        const off = value[i];
        if (Array.isArray(off) && off.length >= 2) {
          node._deformOffsets[i * 2]     += Number(off[0]) || 0;
          node._deformOffsets[i * 2 + 1] += Number(off[1]) || 0;
        }
      }
      break;
    default:
      // 未知の param_name は無視
      break;
  }
}
