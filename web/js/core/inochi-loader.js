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
export const INOCHI_PIPELINE_VERSION = 6;

// 悪意のある/破損した .inp がブラウザをメモリ枯渇させないための上限。
const LIMITS = Object.freeze({
  fileBytes: 100 * 1024 * 1024,
  jsonBytes: 16 * 1024 * 1024,
  textures: 256,
  textureBytes: 64 * 1024 * 1024,
  texturePixels: 32 * 1024 * 1024,
  maxTextureDimension: 8192,
  zipEntries: 256,
  zipUncompressedBytes: 128 * 1024 * 1024,
  zipEntryUncompressedBytes: 64 * 1024 * 1024,
  nodes: 10000,
  params: 2000,
  maxNodeDepth: 256,
  meshVertices: 2_000_000,
});

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
  if (!(arrayBuffer instanceof ArrayBuffer)) throw new Error('Inochi2D .inp: invalid ArrayBuffer');
  if (arrayBuffer.byteLength > LIMITS.fileBytes) {
    throw new Error(`Inochi2D .inp: file is too large (max ${LIMITS.fileBytes / 1024 / 1024} MiB)`);
  }
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
  if (bytes.length < 12) throw new Error('Inochi2D TRNSRTS: truncated header');
  const jsonLen = dv.getUint32(8, false /* big-endian */);
  if (jsonLen > LIMITS.jsonBytes) throw new Error(`Inochi2D TRNSRTS: JSON section too large (max ${LIMITS.jsonBytes / 1024 / 1024} MiB)`);
  if (12 + jsonLen > bytes.length) {
    throw new Error('Inochi2D TRNSRTS: declared JSON length exceeds file size');
  }

  // 2. JSON を UTF-8 デコード
  const jsonBytes = bytes.subarray(12, 12 + jsonLen);
  const jsonStr = new TextDecoder('utf-8').decode(jsonBytes);
  const puppetJson = JSON.parse(jsonStr);

  // v6.2: 実際の JSON 構造をダンプ (問題診断用)
  //   ※ puppetJson 全体は大きいので、トップレベル keys + nodes の型と最初のエントリだけ出す
  {
    const topKeys = Object.keys(puppetJson);
    const nodesType = Array.isArray(puppetJson.nodes) ? 'array' : (puppetJson.nodes && typeof puppetJson.nodes === 'object' ? 'object' : typeof puppetJson.nodes);
    console.info(`[Inochi2D] TRNSRTS JSON top-level keys: ${topKeys.join(', ')}`);
    console.info(`[Inochi2D] TRNSRTS JSON nodes type: ${nodesType}`);
    if (Array.isArray(puppetJson.nodes)) {
      console.info(`[Inochi2D] TRNSRTS JSON nodes.length: ${puppetJson.nodes.length}`);
      if (puppetJson.nodes.length > 0) {
        const n0 = puppetJson.nodes[0];
        console.info(`[Inochi2D] TRNSRTS JSON nodes[0] keys: ${n0 && typeof n0 === 'object' ? Object.keys(n0).join(',') : typeof n0}`);
        if (n0 && typeof n0 === 'object' && n0.children) {
          console.info(`[Inochi2D] TRNSRTS JSON nodes[0].children[0..2]: ${JSON.stringify(n0.children.slice(0, 3))} (len=${n0.children.length})`);
        }
      }
    } else if (puppetJson.nodes && typeof puppetJson.nodes === 'object') {
      const nodeKeys = Object.keys(puppetJson.nodes);
      console.info(`[Inochi2D] TRNSRTS JSON nodes dict size: ${nodeKeys.length}`);
      console.info(`[Inochi2D] TRNSRTS JSON nodes dict first 5 keys: ${nodeKeys.slice(0, 5).join(', ')}`);
      const firstKey = nodeKeys[0];
      if (firstKey != null) {
        const n0 = puppetJson.nodes[firstKey];
        const n0Type = Array.isArray(n0) ? 'array' : typeof n0;
        console.info(`[Inochi2D] TRNSRTS JSON nodes['${firstKey}'] type: ${n0Type}`);
        if (n0 && typeof n0 === 'object' && !Array.isArray(n0)) {
          console.info(`[Inochi2D] TRNSRTS JSON nodes['${firstKey}'] keys: ${Object.keys(n0).join(',')}`);
          if (n0.children) console.info(`[Inochi2D] TRNSRTS JSON nodes['${firstKey}'].children[0..4]: ${JSON.stringify(n0.children.slice ? n0.children.slice(0, 5) : n0.children)}`);
          if (n0.mesh) console.info(`[Inochi2D] TRNSRTS JSON nodes['${firstKey}'].mesh keys: ${Object.keys(n0.mesh).join(',')}`);
          if (n0.textures) console.info(`[Inochi2D] TRNSRTS JSON nodes['${firstKey}'].textures: ${JSON.stringify(n0.textures)}`);
        } else if (Array.isArray(n0)) {
          console.info(`[Inochi2D] TRNSRTS JSON nodes['${firstKey}'] array length: ${n0.length}`);
          if (n0.length > 0) console.info(`[Inochi2D] TRNSRTS JSON nodes['${firstKey}'][0] type: ${typeof n0[0]}, keys: ${n0[0] && typeof n0[0] === 'object' ? Object.keys(n0[0]).join(',') : '?'}`);
        }
      }
    }
    console.info(`[Inochi2D] TRNSRTS JSON root_node: ${puppetJson.root_node}, root_nodes: ${JSON.stringify(puppetJson.root_nodes)}`);
  }

  // 3. TEX_SECT マーカー (公式仕様: ちょうど 8 バイト、\0 終端なし)
  let pos = 12 + jsonLen;
  if (pos + 8 > bytes.length || String.fromCharCode(...bytes.subarray(pos, pos + 8)) !== 'TEX_SECT') {
    throw new Error('Inochi2D TRNSRTS: TEX_SECT marker not found');
  }
  pos += 8;

  // 4. テクスチャ数 (公式仕様: 単純な BE uint32。ヒューリスティック不要)
  if (pos + 4 > bytes.length) throw new Error('Inochi2D TRNSRTS: texture count truncated');
  const texCount = dv.getUint32(pos, false);
  pos += 4;
  if (texCount > LIMITS.textures) throw new Error(`Inochi2D TRNSRTS: too many textures (${texCount}, max ${LIMITS.textures})`);

  // 5. 各テクスチャエントリを逐次読み (公式仕様どおり。総当たり検索不要)
  //   entry:
  //     4 bytes  Payload Length (BE uint32)
  //     1 byte   Encoding (0=PNG, 1=TGA, 2=BC7)
  //     N bytes  payload
  const TEX_ENC = { PNG: 0, TGA: 1, BC7: 2 };
  const texEntries = [];
  let totalTextureBytes = 0;
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
    totalTextureBytes += payloadLen;
    if (payloadLen > LIMITS.textureBytes || totalTextureBytes > LIMITS.textureBytes) {
      throw new Error(`Inochi2D TRNSRTS: texture payload exceeds safety limit (max ${LIMITS.textureBytes / 1024 / 1024} MiB total)`);
    }
    const payload = bytes.subarray(pos, pos + payloadLen);
    pos += payloadLen;
    texEntries.push({ encoding, payload });
  }
  if (pos !== bytes.length) {
    // 新形式 (.inp v0.8+) では TEX_SECT の後に物理演算・エクスポート設定等の
    // 追加セクションが付くことがある。JS フォールバックでは本文 (JSON) と
    // テクスチャだけ使うので、これら未パースの後続バイトは警告だけ出して無視。
    console.debug(`[Inochi2D] TRNSRTS: ${bytes.length - pos} trailing bytes after texture section (likely physics/extra section — ignored by JS fallback)`);
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
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
          width <= 0 || height <= 0 || width > LIMITS.maxTextureDimension ||
          height > LIMITS.maxTextureDimension || width * height > LIMITS.texturePixels) {
        bitmap?.close?.();
        throw new Error(`texture dimensions exceed safety limit: ${width}x${height}`);
      }
      // テクスチャの UUID / path は puppetJson 側で参照される場合があるので、
      // 後でパースした JSON から補完する。ここでは index だけ入れておく。
      textures.push({
        name: String(i),    // インデックス参照なので番号を名前にする
        index: i,
        uuid: null,          // puppetJson 解析後に補完 (textures 配列が UUID を持つ場合)
        path: null,          // 同上
        bitmap,
        width,
        height,
      });
      console.info(`[Inochi2D] texture ${i} decoded (${encoding === TEX_ENC.PNG ? 'PNG' : encoding === TEX_ENC.TGA ? 'TGA' : 'BC7'}): ${width}x${height}`);
    } catch (e) {
      console.error(`[Inochi2D] texture ${i} (encoding=${encoding}) decode failed:`, e);
      textures.push({ name: String(i), index: i, uuid: null, path: null, bitmap: null, width: 0, height: 0 });
    }
  }

  // 7. puppet.json を新しい構造でパース → 描画用ノードツリーを構築
  //   Inochi2D v0.8+ の .inp JSON には 2 つの直列化スタイルがある:
  //     (A) 旧: nodes が「ノードオブジェクトの配列」で各ノードの children も
  //            ノードオブジェクト (再帰的に埋め込み)
  //     (B) 新: nodes が「UUID をキーにしたノード辞書」。各ノードの children は
  //            「子ノードとして扱うフィールド名のリスト」(D 言語 @serdeChildren
  //            アノテーション由来。例: ['zsort', 'lockToRoot']) であり、
  //            実際の親子関係は `parent` フィールドで表現される。
  //            ルートは root_node (単一 UUID) または root_nodes (UUID 配列)。
  //            parameters も param ではなく parameters (複数形) の可能性あり。
  //   どちらでも同じ形に正規化してから下流の flattenTrnsNodes に渡す。
  const normalized = normalizeTrnsPuppetJson(puppetJson);
  if (!Array.isArray(normalized.nodes)) {
    throw new Error('Inochi2D TRNSRTS: nodes must be an array or a UUID-keyed object (got ' +
      Object.prototype.toString.call(puppetJson.nodes) + ')');
  }
  if (normalized.nodes.length > LIMITS.nodes) throw new Error(`Inochi2D TRNSRTS: too many root nodes (max ${LIMITS.nodes})`);
  // parameters は配列 OR UUID-keyed 辞書を許容
  let paramList = normalized.param || normalized.parameters || [];
  if (!Array.isArray(paramList)) {
    if (paramList && typeof paramList === 'object') paramList = Object.values(paramList);
    else paramList = [];
  }
  if (paramList.length > LIMITS.params) throw new Error(`Inochi2D TRNSRTS: too many parameters (max ${LIMITS.params})`);

  // 7.1 テクスチャ UUID / path を補完
  //   puppetJson.textures が配列 (JSON で各テクスチャに UUID/path が振られている
  //   場合) であれば、バイナリからデコード済みの textures にマージする。
  //   ※ JSON 側の textures エントリ数がバイナリのテクスチャ数と一致することを
  //      検証し、不一致なら警告して続行 (インデックス参照は壊れない)。
  const texMeta = Array.isArray(puppetJson.textures) ? puppetJson.textures
    : (puppetJson.textures && typeof puppetJson.textures === 'object' ? Object.values(puppetJson.textures) : null);
  if (Array.isArray(texMeta) && texMeta.length > 0) {
    for (let i = 0; i < Math.min(texMeta.length, textures.length); i++) {
      const m = texMeta[i];
      if (!m || typeof m !== 'object') continue;
      if (m.uuid) textures[i].uuid = String(m.uuid);
      if (m.path || m.name) {
        textures[i].path = String(m.path || m.name);
        // path が分かれば name も上書き (デバッグ視認性向上)
        if (!textures[i].name || textures[i].name === String(i)) {
          textures[i].name = String(m.path || m.name);
        }
      }
    }
    if (texMeta.length !== textures.length) {
      console.warn(`[Inochi2D] TRNSRTS: puppetJson.textures count (${texMeta.length}) ≠ decoded textures count (${textures.length}) — index-based refs may be off`);
    }
  }

  const flatNodes = flattenTrnsNodes(normalized.nodes, textures);
  if (flatNodes.length > LIMITS.nodes) throw new Error(`Inochi2D TRNSRTS: too many nodes (max ${LIMITS.nodes})`);

  // v6.1: 誰も表示されないケースの原因究明用に、構造を軽量ログ出力
  //   ※ puppetJson 全体は大きすぎるので、キー一覧 + 各ノードの型/キーだけ出す
  const drawableCount = flatNodes.filter(n => n.mesh && n.mesh.tex).length;
  const partCount = flatNodes.filter(n => n.type === 'Part').length;
  console.info(`[Inochi2D] TRNSRTS structure: nodes=${flatNodes.length} partType=${partCount} drawable=${drawableCount}`);
  if (drawableCount === 0) {
    // 描画対象が無い → ノード構造をダンプして原因特定に使う
    console.warn('[Inochi2D] TRNSRTS: 0 drawable nodes — dumping first 3 nodes for diagnosis:');
    for (const n of flatNodes.slice(0, 3)) {
      console.warn('  node', n.uuid, 'type=', n.type, 'keys=', Object.keys(n).join(','), 'mesh=', n.mesh ? Object.keys(n.mesh).join(',') : 'null', 'tex=', n.mesh?.tex ? 'yes' : 'no');
    }
    // flatten 前の正規化済みノードもダンプ
    console.warn('[Inochi2D] TRNSRTS: normalized roots dump (first 3):');
    for (const r of normalized.nodes.slice(0, 3)) {
      console.warn('  raw', r.uuid, 'type=', r.type, 'keys=', Object.keys(r).join(','));
      if (r.mesh) console.warn('    mesh keys=', Object.keys(r.mesh).join(','));
      if (r.deform) console.warn('    deform keys=', Object.keys(r.deform).join(','));
      if (r.drawable) console.warn('    drawable keys=', Object.keys(r.drawable).join(','));
    }
    // v6.3: ルートの子ノード（第1階層）もダンプ。Part 構造を把握するため。
    if (Array.isArray(normalized.nodes) && normalized.nodes.length > 0) {
      const root = normalized.nodes[0];
      if (Array.isArray(root.children) && root.children.length > 0) {
        console.warn(`[Inochi2D] TRNSRTS: root has ${root.children.length} children. First 3 children:`);
        for (const c of root.children.slice(0, 3)) {
          if (!c || typeof c !== 'object') {
            console.warn('  child (non-object):', typeof c, c);
            continue;
          }
          console.warn('  child', c.uuid, 'type=', c.type, 'name=', c.name, 'keys=', Object.keys(c).join(','));
          if (c.mesh) console.warn('    mesh keys=', Object.keys(c.mesh).join(','), 'verts?', !!(c.mesh.verts || c.mesh.vertices), 'len=', (c.mesh.verts || c.mesh.vertices || []).length);
          if (c.deform) console.warn('    deform keys=', Object.keys(c.deform).join(','));
          if (c.drawable) console.warn('    drawable keys=', Object.keys(c.drawable).join(','));
          if (c.textures) console.warn('    textures=', JSON.stringify(c.textures).slice(0, 200));
          if (Array.isArray(c.children) && c.children.length > 0) {
            console.warn(`    has ${c.children.length} grandchildren. First grandchild:`);
            const gc = c.children[0];
            if (gc && typeof gc === 'object') {
              console.warn('    grandchild', gc.uuid, 'type=', gc.type, 'name=', gc.name, 'keys=', Object.keys(gc).join(','));
              if (gc.mesh) console.warn('      grandchild.mesh keys=', Object.keys(gc.mesh).join(','), 'verts?', !!(gc.mesh.verts || gc.mesh.vertices), 'len=', (gc.mesh.verts || gc.mesh.vertices || []).length);
              if (gc.textures) console.warn('      grandchild.textures=', JSON.stringify(gc.textures).slice(0, 200));
            }
          }
        }
      } else {
        console.warn('[Inochi2D] TRNSRTS: root has no children (or empty array)');
      }
    }
  }

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
  //   上で正規化済みの paramList (配列形式) を使う。puppetJson.param /
  //   puppetJson.parameters が両方 undefined なら空配列。
  const params = paramList.map(p => ({
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

// ── puppet.json を flattenTrnsNodes が食える形に正規化 ──
//   Inochi2D v0.8+ の .inp JSON には 3 つの直列化スタイルが存在する:
//     (A) 旧: nodes = [node, ...], 各 node.children = [node, ...] (埋め込み)
//     (B) 新: nodes = {単一のルートノード}, node.children = [子node, ...] (埋め込み)
//            ※ nodes は「ルートノードそのもの」であって dict ではない!
//            ※ uuid は D 言語の ulong で数値型。
//     (C) UUID-keyed dict: nodes = {uuid: nodeObj, ...}, parent フィールドで参照
//            ※ これは一部のエクスポータのみ。公式 Inochi Studio は (B) を出力。
//   どちらも (A) と同じ形 (nodes が配列) に変換してから下流に渡す。
function normalizeTrnsPuppetJson(puppetJson) {
  if (!puppetJson || typeof puppetJson !== 'object') {
    return { ...puppetJson, nodes: [] };
  }

  const nodesField = puppetJson.nodes;

  // (A) 旧形式: nodes が配列
  if (Array.isArray(nodesField)) {
    // children が UUID 文字列になっているかチェック (混合形式も許容)
    const needsResolve = nodesField.some(n =>
      Array.isArray(n?.children) && n.children.length > 0 &&
      typeof n.children[0] === 'string'
    );
    if (!needsResolve) {
      // 純粋な旧形式 — そのまま返す
      return puppetJson;
    }
    // nodes は配列だが children が UUID 文字列 → dict を構築して parent ベースで解決
    const nodeDict = {};
    for (const n of nodesField) {
      if (n && n.uuid != null) nodeDict[n.uuid] = n;
    }
    const resolved = resolveTrnsNodesFromDict(puppetJson, nodeDict);
    return { ...puppetJson, nodes: resolved };
  }

  // (B)(C) nodes がオブジェクト
  if (nodesField && typeof nodesField === 'object') {
    // (B) 単一ルートノード形式かどうかを判定
    //   ルートノードは type (string) と children (array) を持つ
    //   ※ dict の場合は keys が UUID (数値 or 文字列) で、値が node オブジェクト
    //   ※ 最初の値の type が string なら (B)、そうでなければ (C)
    if (typeof nodesField.type === 'string' && Array.isArray(nodesField.children)) {
      // (B) 単一ルートノード → 配列で包むだけ
      return { ...puppetJson, nodes: [nodesField] };
    }
    // (C) UUID-keyed dict
    const resolved = resolveTrnsNodesFromDict(puppetJson, nodesField);
    return { ...puppetJson, nodes: resolved };
  }

  // 未知の形式 — そのまま返し、呼び出し側のバリデーションに委ねる
  return puppetJson;
}

// UUID-keyed 辞書からノードツリーを再構築する。
//   新形式 (B) では `children` は UUID 配列ではなく「子ノードとして扱う
//   フィールド名のリスト」(@serdeChildren アノテーション由来) なので、
//   実際の親子関係は `parent` フィールドから再構築する。
//
//   戻り値: [nodeObj, ...] (各 nodeObj.children はノードオブジェクト配列)
function resolveTrnsNodesFromDict(puppetJson, nodeDict) {
  const allUuids = Object.keys(nodeDict);

  // 1. parent フィールドから親子マップを構築
  //   ※ 新形式では各ノードが `parent` フィールド (UUID or null) を持つ。
  //   ※ parent が無い (旧形式) 場合は children フィールドの UUID 配列を使う。
  //   ※ 両方持つ場合は parent を優先。
  const childrenOf = new Map();          // parent uuid → [child uuid]
  const childrenOfChildrenField = new Map(); // children フィールド経由の参照
  const parentedUuids = new Set();
  let parentFieldAvailable = false;

  for (const uuid of allUuids) {
    const node = nodeDict[uuid];
    const parent = node?.parent;
    if (parent != null) {
      parentFieldAvailable = true;
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(uuid);
      parentedUuids.add(uuid);
    }
    // children フィールドの文字列を収集 (旧形式互換用)
    const ch = node?.children;
    if (Array.isArray(ch)) {
      for (const c of ch) {
        if (typeof c === 'string' && nodeDict[c]) {
          if (!childrenOfChildrenField.has(uuid)) childrenOfChildrenField.set(uuid, []);
          childrenOfChildrenField.get(uuid).push(c);
        }
      }
    }
  }

  // parent フィールドが一つも無い → children フィールドから親子マップを構築
  if (!parentFieldAvailable && childrenOfChildrenField.size > 0) {
    childrenOf.clear();
    for (const [p, cs] of childrenOfChildrenField.entries()) {
      childrenOf.set(p, cs);
    }
  }

  // 2. ルート UUID 一覧を決定
  let rootUuids = [];
  if (typeof puppetJson.root_node === 'string') {
    rootUuids = [puppetJson.root_node];
  } else if (Array.isArray(puppetJson.root_nodes)) {
    rootUuids = puppetJson.root_nodes.filter(u => typeof u === 'string');
  } else if (typeof puppetJson.rootNode === 'string') {
    rootUuids = [puppetJson.rootNode];
  } else if (Array.isArray(puppetJson.rootNodes)) {
    rootUuids = puppetJson.rootNodes.filter(u => typeof u === 'string');
  } else {
    // ルート指定が無い場合
    if (parentFieldAvailable) {
      // parent フィールドがある → parent が無いノードをルートとする
      rootUuids = allUuids.filter(u => !parentedUuids.has(u));
    } else {
      // parent フィールドが無い → children フィールドの子として現れない UUID をルートとする
      const childSet = new Set();
      for (const uuids of childrenOfChildrenField.values()) {
        for (const u of uuids) childSet.add(u);
      }
      rootUuids = allUuids.filter(u => !childSet.has(u));
    }

    if (rootUuids.length === 0 && allUuids.length > 0) {
      // 全ノードが parent を持つ (循環等) — 最初の UUID をルートにする
      rootUuids = [allUuids[0]];
    }
  }

  // 3. parent から子ツリーを再構築 (path セットで循環検出)
  const buildNode = (uuid, path) => {
    if (path.has(uuid)) {
      console.warn(`[Inochi2D] TRNSRTS: cycle detected at node ${uuid} — skipping subtree`);
      return null;
    }
    const node = nodeDict[uuid];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      // ノードが null か非オブジェクト (配列含む) の場合はスキップ
      if (node != null) {
        console.warn(`[Inochi2D] TRNSRTS: node ${uuid} is not an object (got ${Array.isArray(node) ? 'array' : typeof node}) — skipping`);
      } else {
        console.warn(`[Inochi2D] TRNSRTS: node ${uuid} referenced but not found in nodes dict — skipping`);
      }
      return null;
    }
    const nextPath = new Set(path);
    nextPath.add(uuid);

    // shallow clone して children を解決済みノード配列で上書き
    //   ※ 新形式では uuid が dict のキーで、ノードエントリに uuid フィールドが
    //      無い可能性がある。dict キーから uuid を注入する。
    const clone = { ...node };
    if (clone.uuid == null) clone.uuid = uuid;
    const childUuids = childrenOf.get(uuid) || [];
    clone.children = childUuids
      .map(c => buildNode(c, nextPath))
      .filter(c => c != null);
    return clone;
  };

  const roots = rootUuids
    .map(uuid => buildNode(uuid, new Set()))
    .filter(n => n != null);

  if (roots.length === 0) {
    console.warn('[Inochi2D] TRNSRTS: no root nodes resolved — puppet will render nothing');
  }
  return roots;
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
  //   新形式 (v0.8+) では mesh が node.deform.mesh や node.drawable.mesh に
  //   ネストしている可能性がある。複数候補を順に探す。
  //   ※ node.type === 'Part' のノードでも、何も描画しない純粋な Part (例: 親
  //      Composite の zSort 制御用の empty Part) は mesh を持たない。
  //   ※ 'Node' / 'Composite' / 'SimplePhysics' / 'Deformer' / 'Physics' 等
  //      Part 以外の型でも mesh を持つものがあれば描画対象に含める。
  const meshRaw = node.mesh || node.deform?.mesh || node.drawable?.mesh || null;
  const texIndices = node.textures || node.tex || node.drawable?.textures || node.deform?.textures || [];

  // Part 型 または mesh もしくは textures を持つノードを描画対象とする
  if (node.type === 'Part' || meshRaw || (Array.isArray(texIndices) && texIndices.length > 0)) {
    const mesh = meshRaw || {};
    // テクスチャインデックスから bitmap を解決
    //   4294967295 (0xFFFFFFFF) = -1 = no texture
    //   ※ 新形式では textures が数値配列ではなくオブジェクト配列 (テクスチャ
    //      UUID や path を含む) の可能性もある。数値でも文字列でも解決できる
    //      ように両対応する。
    let primaryTex = null;
    for (const idx of texIndices) {
      if (idx === 4294967295 || idx === -1) continue;
      let tex = null;
      if (typeof idx === 'number') {
        tex = textures.find(t => t.index === idx);
      } else if (typeof idx === 'string') {
        // UUID または path で解決
        tex = textures.find(t => t.uuid === idx || t.name === idx || t.path === idx);
      } else if (idx && typeof idx === 'object') {
        // { uuid, path, ... } 形式
        const uuid = idx.uuid;
        const path = idx.path || idx.tex;
        tex = textures.find(t => t.uuid === uuid || t.name === path || t.path === path);
      }
      if (tex && tex.bitmap) { primaryTex = tex; break; }
    }

    // 頂点配列 (verts) は mesh.verts または mesh.vertices のどちらか
    const vertsSrc = mesh.verts || mesh.vertices || [];
    const uvsSrc = mesh.uvs || mesh.uv || mesh.texcoords || [];
    const indicesSrc = mesh.indices || mesh.triangles || [];

    flat.mesh = {
      vertices: new Float32Array(vertsSrc),
      uvs: new Float32Array(uvsSrc),
      indices: new Uint16Array(indicesSrc),
      tex: primaryTex,
      texPath: primaryTex ? primaryTex.name : null,
      uvTransform: [1, 1, 0, 0],
      origin: mesh.origin || [0, 0],
    };
    flat.tint = node.tint || [1, 1, 1];
    flat.screenTint = node.screenTint || [0, 0, 0];
    flat.blendMode = node.blend_mode || node.blendMode || 'Normal';
    flat.opacity = node.opacity ?? 1.0;
    if (typeof node.mask_threshold === 'number') {
      flat.maskThreshold = Math.max(0, Math.min(1, node.mask_threshold));
    }
    if (Array.isArray(node.masks)) {
      flat.masks = node.masks
        .map(m => ({
          source: m.source ?? m.mask_src ?? m.maskSrcUUID ?? m.maskSrc?.uuid,
          dodge: (m.mode === 'DodgeMask'),
        }))
        .filter(m => m.source != null);
    }
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
      if (bitmap.width > LIMITS.maxTextureDimension || bitmap.height > LIMITS.maxTextureDimension ||
          bitmap.width * bitmap.height > LIMITS.texturePixels) {
        bitmap.close?.();
        throw new Error(`texture dimensions exceed safety limit: ${bitmap.width}x${bitmap.height}`);
      }
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
  if (depth > LIMITS.maxNodeDepth) throw new Error(`Inochi2D ZIP: node tree exceeds max depth ${LIMITS.maxNodeDepth}`);
  for (const node of nodes) {
    if (out.length >= LIMITS.nodes) throw new Error(`Inochi2D ZIP: node count exceeds max ${LIMITS.nodes}`);
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
      if ((mesh.vertices?.length || 0) > LIMITS.meshVertices * 2) throw new Error(`Inochi2D ZIP: mesh is too large (max ${LIMITS.meshVertices} vertices)`);
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
  if (cdCount > LIMITS.zipEntries) throw new Error(`Inochi2D .inp (ZIP): too many entries (${cdCount}, max ${LIMITS.zipEntries})`);
  let cdOffset    = dv.getUint32(eocd + 16, true);

  let totalUncompressed = 0;
  for (let i = 0; i < cdCount; i++) {
    if (dv.getUint32(cdOffset, true) !== 0x02014b50) throw new Error('Inochi2D .inp (ZIP): bad CD entry');
    const compMethod   = dv.getUint16(cdOffset + 10, true);
    const compSize     = dv.getUint32(cdOffset + 20, true);
    const uncompSize   = dv.getUint32(cdOffset + 24, true);
    if (uncompSize > LIMITS.zipEntryUncompressedBytes ||
        totalUncompressed + uncompSize > LIMITS.zipUncompressedBytes) {
      throw new Error(`Inochi2D .inp (ZIP): uncompressed data exceeds safety limit at ${nameLen ? 'entry' : 'entry'}`);
    }
    totalUncompressed += uncompSize;
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

    if (compMethod === 8 && uncompSize > 1024 && compSize > 0 && uncompSize / compSize > 200) {
      throw new Error(`Inochi2D .inp (ZIP): suspicious compression ratio for entry ${name}`);
    }

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
