// ──────────────────────────────────────────────────────────────
// inochi-loader.js — Inochi2D パペット (.inp) のロード
//
//   .inp には 2 形式が存在する:
//     1. 旧形式 (v0.6 まで): ZIP 圧縮、内包に puppet.json + PNG
//     2. 新形式 (v0.8 以降): TRNSRTS 独自バイナリ (公式 INP Specification 準拠)
//        "TRNSRTS\0" (8 bytes) + JSON 長 (BE uint32) + JSON
//        + "TEX_SECT" (8 bytes, \0 終端なし)
//        + Texture Count (BE uint32)
//        + [ Payload Length (BE uint32) + Encoding (1 byte: 0=PNG, 1=TGA, 2=BC7)
//            + payload (N bytes) ] × Texture Count
//
//   ファイル先頭マジックで形式を自動判別する。
// ──────────────────────────────────────────────────────────────
import { InochiRuntime } from 'app/vendor/inochi2d/inochi2d-runtime.js';
import { decodeTgaToBitmap } from 'app/core/tga-decoder.js';

// パイプライン版数 — ブラウザ console で「実際に走っているビルド」を判別する目印。
//   v2: Composite 内 zSort ソート
//   v3: (旧)
//   v4: 公式 Puppet.draw() セマンティクス準拠
//         - rootParts (全 Part + Composite) を累積 zSort 降順でスタブルソート
//         - マスク (stencil) 情報のパース
//         - Multiply / ClipToLower ブレンドモード (レンダラ側)
//   v5: premultiplied alpha + Composite FBO 合成 (公式 composite.d 準拠)
//         - TGA/PNG デコード時に premultiply (ミップの平均を正しくする)
//         - レンダラ側で Composite を FBO に描いて blend_mode/tint で合成
//   ※ http-server 等は Cache: 3600 を返すので、JS 差し替え後は強制リロード
//     (Ctrl+Shift+R) が必要。このログが出ない場合は古いキャッシュが走っている。
export const INOCHI_PIPELINE_VERSION = 5;

let _runtimePromise = null;

// シングルトン InochiRuntime を取得
export async function getRuntime() {
  if (!_runtimePromise) {
    _runtimePromise = InochiRuntime.create();
  }
  return _runtimePromise;
}

// ── 形式判定 ──
const MAGIC_TRNS = 'TRNSRTS\0';  // 新形式 (v0.8+)
const MAGIC_ZIP  = 'PK\x03\x04'; // 旧形式 (ZIP)

export function detectInpFormat(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // TRNSRTS\0 (8 bytes)
  let isTrns = true;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== MAGIC_TRNS.charCodeAt(i)) { isTrns = false; break; }
  }
  if (isTrns) return 'trns';
  // PK\x03\x04 (4 bytes)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'zip';
  }
  return 'unknown';
}

// ── .inp をロード → PuppetHandle を返す ──
//   WASM バックエンドがあればそちらへ ArrayBuffer ごと渡す。
//   無ければ純 JS でパースして JS フォールバック用 puppet を構築し、
//   PuppetHandle でラップしてから返す。
export async function loadInp(arrayBuffer) {
  const runtime = await getRuntime();
  // WASM バックエンドがある場合はそちらへ委譲
  //   ※ wasm 側が両形式をサポートしている前提。
  //   ※ ただし wasm はまだ未配置(JS フォールバック)なので、実際には
  //      ここから下の JS パスが走る。
  if (runtime.isAvailable) {
    try {
      const handle = await runtime.loadPuppet(arrayBuffer);
      if (handle) return handle;
    } catch (e) {
      console.warn('[Inochi2D] wasm loadPuppet failed, trying JS fallback:', e);
    }
  }
  // JS フォールバック: 形式判定して純 JS でパース →
  //   Runtime.loadPuppet 経由で PuppetHandle でラップしてもらう
  //   ※ runtime.loadPuppet は wasm 無し時に loadInp(この関数)を呼ぶので
  //     直接呼ぶと無限再帰になる。代わりに runtime 内のラップ処理を
  //     直接入手するため、手動で PuppetHandle 相当を構築する。
  const fmt = detectInpFormat(arrayBuffer);
  let puppet;
  if (fmt === 'trns') {
    puppet = await parseTrnsInp(arrayBuffer);
  } else if (fmt === 'zip') {
    puppet = await parseZipInp(arrayBuffer);
  } else {
    throw new Error(`Inochi2D .inp: unknown format (magic=${Array.from(new Uint8Array(arrayBuffer).slice(0, 8)).map(b => b.toString(16)).join(' ')})`);
  }
  // PuppetHandle でラップ (private だが同じモジュール内なので可)
  //   ※ runtime.js の PuppetHandle を直接 import すると循環参照になるので、
  //     runtime 経由でラップする。runtime._wrapAsHandle を呼ぶ。
  return runtime._wrapAsHandle(puppet);
}

// ── TRNSRTS 形式 (.inp v0.8+) のパース ──
//   構造 (公式仕様: INP Specification 準拠 — ヒューリスティック不要):
//     8 bytes   magic "TRNSRTS\0"
//     4 bytes   JSON length (BE uint32)
//     N bytes   JSON (puppet.json)
//     8 bytes   "TEX_SECT"      ← \0 終端なし・ちょうど 8 バイト
//     4 bytes   Texture Count (BE uint32)
//     [texture entries...]:
//       4 bytes  Payload Length (BE uint32)
//       1 byte   Encoding (0=PNG, 1=TGA, 2=BC7)
//       N bytes  payload
async function parseTrnsInp(arrayBuffer) {
  console.info(`[Inochi2D] loader pipeline v${INOCHI_PIPELINE_VERSION} (global zSort draw order + stencil masks + blend modes)`);
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  // 1. JSON 長
  const jsonLen = dv.getUint32(8, false /* big-endian */);
  if (12 + jsonLen > bytes.length) {
    throw new Error('Inochi2D TRNSRTS: declared JSON length exceeds file size');
  }

  // 2. JSON を UTF-8 デコード
  const jsonBytes = bytes.subarray(12, 12 + jsonLen);
  const jsonStr = new TextDecoder('utf-8').decode(jsonBytes);
  const puppetJson = JSON.parse(jsonStr);

  // 3. TEX_SECT マーカー (公式仕様: ちょうど 8 バイト、\0 終端なし)
  let pos = 12 + jsonLen;
  if (pos + 8 > bytes.length || String.fromCharCode(...bytes.subarray(pos, pos + 8)) !== 'TEX_SECT') {
    throw new Error('Inochi2D TRNSRTS: TEX_SECT marker not found');
  }
  pos += 8;

  // 4. テクスチャ数 (公式仕様: 単純な BE uint32。ヒューリスティック不要)
  const texCount = dv.getUint32(pos, false);
  pos += 4;

  // 5. 各テクスチャエントリを逐次読み (公式仕様どおり。総当たり検索不要)
  //   entry:
  //     4 bytes  Payload Length (BE uint32)
  //     1 byte   Encoding (0=PNG, 1=TGA, 2=BC7)
  //     N bytes  payload
  const TEX_ENC = { PNG: 0, TGA: 1, BC7: 2 };
  const texEntries = [];
  for (let t = 0; t < texCount; t++) {
    if (pos + 5 > bytes.length) {
      throw new Error(`Inochi2D TRNSRTS: texture entry ${t}: header truncated (pos=${pos}, fileSize=${bytes.length})`);
    }
    const payloadLen = dv.getUint32(pos, false);
    pos += 4;
    const encoding = bytes[pos];
    pos += 1;
    if (pos + payloadLen > bytes.length) {
      throw new Error(`Inochi2D TRNSRTS: texture entry ${t}: payload length ${payloadLen} exceeds file size (pos=${pos}, fileSize=${bytes.length})`);
    }
    const payload = bytes.subarray(pos, pos + payloadLen);
    pos += payloadLen;
    texEntries.push({ encoding, payload });
  }
  if (pos !== bytes.length) {
    console.warn(`[Inochi2D] TRNSRTS: ${bytes.length - pos} trailing bytes after texture section`);
  }

  // 6. ペイロードをデコード → ImageBitmap
  //   Encoding: 0=PNG (ブラウザ標準デコーダ), 1=TGA (自前デコーダ), 2=BC7 (JS フォールバック未対応)
  const textures = [];
  for (let i = 0; i < texEntries.length; i++) {
    const { encoding, payload } = texEntries[i];
    try {
      let width, height, bitmap;
      if (encoding === TEX_ENC.TGA) {
        ({ width, height, bitmap } = await decodeTgaToBitmap(payload));
      } else if (encoding === TEX_ENC.PNG) {
        // v5: premultiplied ImageBitmap としてデコード (ミップ平均を正しくする)
        //   対応しない環境は非 premultiply にフォールバック。
        try {
          bitmap = await createImageBitmap(new Blob([payload], { type: 'image/png' }), { premultiplyAlpha: 'premultiply' });
        } catch (_e) {
          bitmap = await createImageBitmap(new Blob([payload], { type: 'image/png' }));
        }
        width = bitmap.width;
        height = bitmap.height;
      } else if (encoding === TEX_ENC.BC7) {
        throw new Error('BC7 texture encoding is not supported by the JS fallback');
      } else {
        throw new Error(`unknown texture encoding ${encoding}`);
      }
      textures.push({
        name: String(i),    // インデックス参照なので番号を名前にする
        index: i,
        bitmap,
        width,
        height,
      });
      console.info(`[Inochi2D] texture ${i} decoded (${encoding === TEX_ENC.PNG ? 'PNG' : encoding === TEX_ENC.TGA ? 'TGA' : 'BC7'}): ${width}x${height}`);
    } catch (e) {
      console.error(`[Inochi2D] texture ${i} (encoding=${encoding}) decode failed:`, e);
      textures.push({ name: String(i), index: i, bitmap: null, width: 0, height: 0 });
    }
  }

  // 7. puppet.json を新しい構造でパース → 描画用ノードツリーを構築
  const flatNodes = flattenTrnsNodes(puppetJson.nodes, textures);

  // 7.5 各ノードの restTransform と deformOffsets を初期化
  //   (computeWorldTransforms が transform を読むので、先に初期化しておく)
  for (const n of flatNodes) {
    const t = n.restTransform;
    if (t) {
      // transform は毎フレーム rest から再計算される (bindings が additive で上書き)
      n.transform = {
        trans: [...t.trans],
        rot: [...t.rot],
        scale: [...t.scale],
      };
      // 頂点オフセット配列 (deform bindings が加算する)
      if (n.mesh && n.mesh.vertices) {
        n._deformOffsets = new Float32Array(n.mesh.vertices.length); // 0初期化
      }
    }
  }

  // 7.6 各ノードのワールド行列を計算 (親から子へ変換を累積)
  //   ※ これが無いと各 Part が自身のローカル原点にレンダリングされ、
  //      パーツがバラバラに飛び散ってしまう。
  //   ※ flatNodes は DFS 順 (親が先) なので、単純な for ループで伝播できる。
  const uuidIndex = buildNodeUuidIndex(flatNodes);
  computeWorldTransforms(flatNodes, uuidIndex);

  // 7.7 描画順リストを構築 (公式 Inochi2D の描画セマンティクス準拠)
  //   - 通常ノード: 自身 → 子の順 (ツリー順 / DFS 前順、ソートなし)
  //   - Composite : 配下の全 Part 子孫を収集し、累積 zSort 降順
  //     (大きい値 = 背面) でソートして一括描画
  //   参考: inochi2d v0.8.7 source/inochi2d/core/nodes/package.d (Node.draw / Part.draw),
  //         source/inochi2d/core/nodes/composite/package.d (selfSort / drawContents / scanPartsRecurse)
  const drawList = buildDrawList(flatNodes);

  // 8. バウンディングボックスを計算 (レンダラの u_proj 用)
  //   ※ ワールド空間の頂点座標を使って計算する (ローカル座標だと不正確)
  const bbox = computeBBox(flatNodes);

  // 10. パラメータ仕様 + binding 情報
  const params = (puppetJson.param || []).map(p => ({
    name: p.name,
    uuid: p.uuid,
    isVec2: !!p.is_vec2,
    min: p.is_vec2 ? p.min : (Array.isArray(p.min) ? p.min[0] : p.min),
    max: p.is_vec2 ? p.max : (Array.isArray(p.max) ? p.max[0] : p.max),
    defaults: p.defaults,
    axisPoints: p.axis_points,
    mergeMode: p.merge_mode,
    bindings: p.bindings || [],
  }));

  return {
    name: puppetJson.meta?.name || puppetJson.name || 'Inochi Puppet',
    meta: puppetJson.meta || {},
    physics: puppetJson.physics || {},
    params,
    nodes: flatNodes,
    textures,
    bbox,
    drawList,
    _values: {},
    _nodeIndexByUuid: uuidIndex,
  };
}

// ── 描画順リストの構築 (公式 Puppet.draw() セマンティクス準拠 / v0.8.7) ──
//
//   公式の実装 (source/inochi2d/core/puppet.d):
//     scanPartsRecurse():
//       - Part        → rootParts へ追加し、さらにその子も走査 (Part のネストは全個別)
//       - Composite   → それ自体を 1 単位として rootParts へ追加
//                       (内部 Part は composite.subParts に吸収され、外側には現れない)
//       - その他 (Node/Deformer/SimplePhysics…) → 子のみ走査
//     draw():
//       rootParts を「累積 zSort 降順」でスタブルソート (大きい = 背面 = 先に描く) し、
//       順に drawOne() する。※ ツリー順はソートの同順タイブレークにしか使われない。
//       ※ v0.8.7 に zsort_enabled は存在せず、zsort は常に有効。
//
//   戻り値: 描画順に並べた配列 (レンダラは毎フレーム zSort バインディングの
//           オフセット込みで再ソートする)
//     { node, part: n, _zSortAcc }            ... 通常 Part
//     { node, composite: [node,...], _zSortAcc } ... Composite (subParts は降順プレソート済み)
function buildDrawList(flatNodes) {
  const childrenOf = new Map(); // parent uuid → [flat nodes] (DFS 順を維持)
  for (const n of flatNodes) {
    if (n.parent == null) continue;
    if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
    childrenOf.get(n.parent).push(n);
  }
  const roots = flatNodes.filter(n => n.parent == null);
  const childrenOfNode = (n) => childrenOf.get(n.uuid) || [];

  // 累積 zSort = 親の累積 + 自ノードの zsort
  //   (公式 Node.zSort(): zSortBase(親) + relZSort(自) + offsetSort と同じ。
  //    offsetSort は zSort バインディングの毎フレーム分で、レンダラ側で加算)
  for (const n of flatNodes) {
    if (n.parent != null) {
      const p = flatNodes.find(m => m.uuid === n.parent);
      n._zSortAcc = ((p && p._zSortAcc) || 0) + (typeof n.zSort === 'number' ? n.zSort : 0);
    } else {
      n._zSortAcc = (typeof n.zSort === 'number' ? n.zSort : 0);
    }
  }

  const drawList = [];

  // Composite の subParts 収集 (公式 Composite.scanPartsRecurse と同じ):
  //   Part は収集し、さらにその子も再帰する。それ以外 (Node/Deformer/
  //   ネストした Composite 等) は子だけ再帰。
  //   → ネスト Composite の Part は外側の Composite に吸収される。
  const collectParts = (n, list) => {
    if (n.type === 'Part' || n.mesh) list.push(n);
    for (const c of childrenOfNode(n)) collectParts(c, list);
  };

  // 公式 Puppet.scanPartsRecurse 相当の走査
  const walk = (n) => {
    if (n.type === 'Composite') {
      // Composite は 1 単位。配下はこの Composite が消費する (外側リストには出ない)
      const parts = [];
      collectParts(n, parts);
      // 公式 Composite.selfSort(): 累積 zSort 降順 (大きい = 背面) でソート
      parts.sort((a, b) => (b._zSortAcc - a._zSortAcc) || 0);
      if (parts.length) drawList.push({ node: n, composite: parts, _zSortAcc: n._zSortAcc });
      return; // Composite の子孫を外側の走査で再帰しない (公式 driversOnly 相当)
    }
    // Part は自身を rootParts 相当へ追加し、その後も子を走査する
    if (n.type === 'Part' || n.mesh) drawList.push({ node: n, part: n, _zSortAcc: n._zSortAcc });
    for (const c of childrenOfNode(n)) walk(c);
  };

  for (const r of roots) walk(r);

  // 公式 Puppet.selfSort(): rootParts 全体を累積 zSort 降順でスタブルソート
  //   (大きい = 背面 = 先に描く。同順は走査順 = ツリー順を維持)
  drawList.sort((a, b) => (b._zSortAcc - a._zSortAcc) || 0);
  return drawList;
}

// ── 各ノードのワールド行列を計算 ──
//   各ノードの worldMatrix = parent.worldMatrix * localMatrix
//   flatNodes は DFS 順 (親が先) なので、前から順に処理すれば
//   親の worldMatrix は既に計算済み。
//
//   ※ Inochi2D の transform は:
//      trans: [x, y, z]  (z は z-order 用の深さ、変換には使わない)
//      rot:   [rx, ry, rz]  (radians, Z 軸周りが通常)
//      scale: [sx, sy]
//   ※ 行列は列優先 mat3 (GLSL 準拠):
//      | sx*cos  -sy*sin  tx |
//      | sx*sin   sy*cos  ty |
//      |   0       0       1  |
//
//   ※ この関数はロード時に1回呼ばれるほか、_applyBindings 後にも
//      毎フレーム呼ばれてワールド行列を更新する。
export function computeWorldTransforms(flatNodes, uuidIndex) {
  for (let i = 0; i < flatNodes.length; i++) {
    const n = flatNodes[i];
    const local = buildLocalMatrix(n.transform || n.restTransform);
    // 親を探す
    let parentMat = null;
    if (n.parent != null && uuidIndex) {
      const pIdx = uuidIndex.get(n.parent);
      if (pIdx != null && pIdx < i) {
        parentMat = flatNodes[pIdx].worldMatrix;
      }
    }
    if (parentMat) {
      n.worldMatrix = mat3Mul(parentMat, local);
    } else {
      // ルートノードまたは親が見つからない場合はローカル行列をそのまま使う
      n.worldMatrix = local;
    }
  }
}

// ── 3x3 行列ヘルパ ──
//   すべて列優先 (column-major) で GLSL の mat3 と互換。
//   Float32Array(9) を使う。

const IDENTITY_MAT3 = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

function buildLocalMatrix(t) {
  if (!t) return new Float32Array(IDENTITY_MAT3);
  const tx = (t.trans && t.trans[0]) || 0;
  const ty = (t.trans && t.trans[1]) || 0;
  const rz = (t.rot   && t.rot[2])   || 0;
  const sx = (t.scale && t.scale[0]) || 1;
  const sy = (t.scale && t.scale[1]) || 1;
  const cos = Math.cos(rz);
  const sin = Math.sin(rz);
  // 列優先 mat3:
  //   col0 = [sx*cos, sx*sin, 0]
  //   col1 = [-sy*sin, sy*cos, 0]
  //   col2 = [tx, ty, 1]
  return new Float32Array([
    sx * cos,  sx * sin,  0,
    -sy * sin, sy * cos,  0,
    tx,        ty,        1,
  ]);
}

// C = A * B  (列優先 mat3)
function mat3Mul(a, b) {
  const out = new Float32Array(9);
  // a, b は列優先:
  //   a[col*3 + row]
  //   行列乗算: c[i][j] = sum_k a[i][k] * b[k][j]
  //   列優先ストレージでは: c[j*3+i] = sum_k a[k*3+i] * b[j*3+k]
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

// ── 全 Part ノードの頂点からバウンディングボックスを計算 ──
//   レンダラの u_proj (puppet 座標 → clip 空間) に使用
//   ※ ワールド行列を頂点に適用した後の座標で計算する
function computeBBox(flatNodes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of flatNodes) {
    if (!n.mesh || !n.mesh.vertices) continue;
    const v = n.mesh.vertices;
    const wm = n.worldMatrix;
    if (!wm) continue;
    // ワールド行列の構成要素を取り出す (列優先)
    const a = wm[0], b = wm[1];          // 列0 = [a, b, 0]
    const c = wm[3], d = wm[4];          // 列1 = [c, d, 0]
    const tx = wm[6], ty = wm[7];        // 列2 = [tx, ty, 1]
    for (let i = 0; i < v.length; i += 2) {
      const lx = v[i], ly = v[i + 1];
      // ワールド座標へ変換
      const wx = a * lx + c * ly + tx;
      const wy = b * lx + d * ly + ty;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  }
  if (!isFinite(minX)) return { minX: -1, maxX: 1, minY: -1, maxY: 1, width: 2, height: 2, cx: 0, cy: 0 };
  const width = (maxX - minX) || 1;
  const height = (maxY - minY) || 1;
  return {
    minX, maxX, minY, maxY,
    width, height,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

// ── TRNSRTS 形式のノードツリーを平坦化 ──
//   Inochi2D v0.8 のノードツリー:
//     - 'Node'        : 単なるグループ
//     - 'Part'        : 描画パート。mesh + textures + tint 等を持つ
//     - 'Composite'   : 複合パート (子ノードを統合)
//     - 'SimplePhysics': 物理設定 (描画なし)
function flattenTrnsNodes(node, textures, out = [], parent = null, depth = 0) {
  // puppet.json の nodes はルートノードの配列 (通常 1 要素)。
  // 配列が渡された場合はルート集合として各要素を処理する。
  if (Array.isArray(node)) {
    for (const root of node) flattenTrnsNodes(root, textures, out, parent, depth);
    return out;
  }
  if (!node || typeof node !== 'object') return out;

  // puppet.json の transform を rest として保存
  //   毎フレーム bindings が rest を上書きした現在値を transform へ書き込む
  const restT = node.transform
    ? {
        trans: [...(node.transform.trans || [0, 0, 0])],
        rot:   [...(node.transform.rot   || [0, 0, 0])],
        scale: [...(node.transform.scale || [1, 1])],
      }
    : { trans: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1] };

  // 全ノードを記録 (描画有無に関わらず、bindings から参照するため)
  //   ※ visible は公式 renderEnabled 相当: 親の enabled も継承する
  const flat = {
    uuid: node.uuid,
    name: node.name || String(node.uuid),
    type: node.type || 'Node',
    parent: parent?.uuid ?? null,
    visible: (parent?.visible !== false) && node.enabled !== false,
    zSort: node.zsort ?? 0,
    zSortEnabled: node.zsort_enabled ?? false,
    depth,
    restTransform: restT,         // bindings 適用前の基準姿勢
    transform: {
      trans: [...restT.trans],
      rot:   [...restT.rot],
      scale: [...restT.scale],
    },
    lockToRoot: node.lockToRoot,
  };

  // マスク情報 (公式 Drawable.masks: このノードを描く際のステンシルマスク源)
  //   puppet.json の形式: "masks": [ { "source": <uuid>, "mode": "Mask"|"DodgeMask" } ]
  //   Mask      = マスク源が不透明な場所でのみ描く (stencil EQUAL 1)
  //   DodgeMask = マスク源が不透明な場所では描かない (源が 0 を刻字)
  // v5: 自ノードが「マスク源」としてステンシルに刻字される際のアルファ閾値。
  //   公式 Part.maskAlphaThreshold (mask_threshold) に対応。Aka 系モデルは
  //   多くの Part で 0.5 を指定しており、これを無視すると顔のフェザーエッジ
  //   (半透明) まで刻字されて影がはみ出す (つなぎ目の原因)。
  if (Array.isArray(node.masks) && node.masks.length > 0) {
    flat.masks = node.masks
      .map(m => ({
        source: m.source ?? m.mask_src ?? m.maskSrcUUID ?? m.maskSrc?.uuid,
        dodge: (m.mode === 'DodgeMask'),
      }))
      .filter(m => m.source != null);
  }
  if (typeof node.mask_threshold === 'number') {
    flat.maskThreshold = Math.max(0, Math.min(1, node.mask_threshold));
  }

  // Part ノードは mesh + textures を持つ
  if (node.type === 'Part' || node.mesh) {
    const mesh = node.mesh || {};
    const texIndices = node.textures || [];
    // テクスチャインデックスから bitmap を解決
    //   4294967295 (0xFFFFFFFF) = -1 = no texture
    let primaryTex = null;
    for (const idx of texIndices) {
      if (idx === 4294967295 || idx === -1) continue;
      const tex = textures.find(t => t.index === idx);
      if (tex && tex.bitmap) { primaryTex = tex; break; }
    }

    flat.mesh = {
      vertices: new Float32Array(mesh.verts || []),
      uvs: new Float32Array(mesh.uvs || []),
      indices: new Uint16Array(mesh.indices || []),
      tex: primaryTex,
      texPath: primaryTex ? primaryTex.name : null,
      uvTransform: [1, 1, 0, 0],
      origin: mesh.origin || [0, 0],
    };
    flat.tint = node.tint || [1, 1, 1];
    flat.screenTint = node.screenTint || [0, 0, 0];
    flat.blendMode = node.blend_mode || 'Normal';
    flat.opacity = node.opacity ?? 1.0;
  }

  out.push(flat);

  // 子ノードを再帰処理
  for (let i = 0; i < (node.children || []).length; i++) {
    flattenTrnsNodes(node.children[i], textures, out, flat, depth + 1);
  }
  return out;
}

// ── uuid → ノードインデックスのマップ ──
function buildNodeUuidIndex(flatNodes) {
  const map = new Map();
  for (let i = 0; i < flatNodes.length; i++) {
    if (flatNodes[i].uuid != null) map.set(flatNodes[i].uuid, i);
  }
  return map;
}

// ══════════════════════════════════════════════════════════════
//  旧 ZIP 形式 (.inp v0.6 まで) のサポート — 以下は変更なし
// ══════════════════════════════════════════════════════════════
async function parseZipInp(arrayBuffer) {
  const entries = await unzipArrayBuffer(arrayBuffer);

  let puppetJsonName = null;
  for (const name of entries.keys()) {
    if (name.endsWith('puppet.json') && !name.startsWith('__MACOSX')) {
      puppetJsonName = name;
      break;
    }
  }
  if (!puppetJsonName) {
    console.error('[Inochi2D] entries:', [...entries.keys()]);
    throw new Error('Inochi2D .inp: puppet.json not found');
  }

  const puppetJson = JSON.parse(new TextDecoder('utf-8').decode(entries.get(puppetJsonName)));
  const basePath = puppetJsonName.replace(/puppet\.json$/, '');

  const textures = [];
  const texMap = new Map();
  for (const name of entries.keys()) {
    if (name.startsWith('__MACOSX')) continue;
    if (!name.toLowerCase().endsWith('.png')) continue;
    if (name === puppetJsonName) continue;
    const bytes = entries.get(name);
    try {
      const blob = new Blob([bytes], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      const tex = {
        name: name.replace(basePath, ''),
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
      };
      textures.push(tex);
      texMap.set(name.replace(basePath, ''), tex);
    } catch (e) {
      console.warn(`[Inochi2D] texture load failed: ${name}`, e);
    }
  }

  // 旧形式の puppet.json は v0.6 仕様 (flat nodes + mesh.vertices etc.)
  // そのまま旧パスで処理
  const flatNodes = [];
  flattenOldNodes(puppetJson.nodes || [], null, flatNodes, basePath, texMap);

  const params = (puppetJson.parameters || puppetJson.param || []).map(p => ({
    name: p.name || p.uuid || 'unnamed',
    uuid: p.uuid,
    min: Array.isArray(p.min) ? p.min[0] : (p.min ?? 0),
    max: Array.isArray(p.max) ? p.max[0] : (p.max ?? 1),
    default: Array.isArray(p.defaults) ? p.defaults[0] : (p.default ?? p.defaults ?? 0),
    axis: p.axis ?? 'x',
    isVector: !!p.is_vec2,
    mode: p.merge_mode || p.mode || 'additive',
  }));

  return {
    name: puppetJson.name || 'Inochi Puppet',
    params,
    nodes: flatNodes,
    textures,
    physics: puppetJson.physics || [],
    meta: puppetJson.meta || {},
    _values: {},
  };
}

// 旧形式の flatten (v0.6 用)
function flattenOldNodes(nodes, parent, out, basePath, texMap, depth = 0) {
  for (const node of nodes) {
    const flat = {
      uuid: node.uuid,
      name: node.name || node.uuid,
      type: node.type || 'deform',
      parent: parent?.uuid ?? null,
      visible: node.visible !== false,
      zSort: out.length,
      depth,
      transform: node.transform || null,
      mixins: node.mixins || [],
    };

    if (node.type === 'deform' || (!node.type && node.mesh)) {
      const mesh = node.mesh || {};
      flat.mesh = {
        vertices: new Float32Array(mesh.vertices || []),
        uvs: new Float32Array(mesh.uvs || mesh.uv || []),
        indices: new Uint16Array(mesh.indices || mesh.triangles || []),
        texPath: node.tex?.tex || node.texPath || null,
        uvTransform: node.tex?.uv || null,
      };
      if (flat.mesh.texPath) {
        const key = flat.mesh.texPath.replace(/^\.\//, '').replace(basePath, '');
        flat.mesh.tex = texMap.get(key) || texMap.get(flat.mesh.texPath) || null;
      }
    }

    out.push(flat);
    if (node.nodes?.length) flattenOldNodes(node.nodes, flat, out, basePath, texMap, depth + 1);
    if (node.children?.length) flattenOldNodes(node.children, flat, out, basePath, texMap, depth + 1);
  }
}

// ── 純 JS ZIP (STORE / DEFLATE) 展開 (旧形式用) ──
async function unzipArrayBuffer(buf) {
  const dv = new DataView(buf);
  const entries = new Map();

  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Inochi2D .inp (ZIP): EOCD not found (not a ZIP?)');
  const cdCount   = dv.getUint16(eocd + 10, true);
  let cdOffset    = dv.getUint32(eocd + 16, true);

  for (let i = 0; i < cdCount; i++) {
    if (dv.getUint32(cdOffset, true) !== 0x02014b50) throw new Error('Inochi2D .inp (ZIP): bad CD entry');
    const compMethod   = dv.getUint16(cdOffset + 10, true);
    const compSize     = dv.getUint32(cdOffset + 20, true);
    const uncompSize   = dv.getUint32(cdOffset + 24, true);
    const nameLen      = dv.getUint16(cdOffset + 28, true);
    const extraLen     = dv.getUint16(cdOffset + 30, true);
    const commentLen   = dv.getUint16(cdOffset + 32, true);
    const localOffset  = dv.getUint32(cdOffset + 42, true);
    const name = new TextDecoder('utf-8').decode(new Uint8Array(buf, cdOffset + 46, nameLen));

    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error('Inochi2D .inp (ZIP): bad local header');
    const lNameLen  = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compData  = new Uint8Array(buf, dataStart, compSize);

    let out;
    if (compMethod === 0) {
      out = compData;
    } else if (compMethod === 8) {
      out = await inflateRaw(compData, uncompSize);
    } else {
      console.warn(`[Inochi2D] .inp (ZIP): unsupported compression method ${compMethod} for ${name}`);
      cdOffset += 46 + nameLen + extraLen + commentLen;
      continue;
    }

    entries.set(name, out);
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

async function inflateRaw(compData, expectedSize) {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compData);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); total += value.length;
      }
      const out = new Uint8Array(total);
      let p = 0;
      for (const c of chunks) { out.set(c, p); p += c.length; }
      return out;
    } catch (e) {
      console.warn('[Inochi2D] DecompressionStream failed, fallback to pure JS inflate:', e);
    }
  }
  return pureJsInflate(compData, expectedSize);
}

// 純 JS inflate (DEFLATE) — 最小実装。詳細は前回実装を参照。
function pureJsInflate(comp, expectedSize) {
  // ※ 実装は長くなるので、DecompressionStream が使えない環境でのみ使用。
  //   ブラウザでは DecompressionStream が標準サポートなので、実際には
  //   このパスは走らない。コードを残しておくためスタブとして実装。
  throw new Error('Inochi2D pure-JS inflate: not available. DecompressionStream required.');
}

// ── ファイル/URL からのロード ──
export async function loadInpFromFile(file) {
  const buf = await file.arrayBuffer();
  return await loadInp(buf);
}

export async function loadInpFromUrl(url) {
  const resp = await fetch(url);
  const buf = await resp.arrayBuffer();
  return await loadInp(buf);
}

// ── parseInp は後方互換用 (旧API) ──
export async function parseInp(arrayBuffer) {
  return await loadInp(arrayBuffer);
}
