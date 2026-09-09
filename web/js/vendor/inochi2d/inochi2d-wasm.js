// ──────────────────────────────────────────────────────────────
// inochi2d-wasm.js — Inochi2D 公式 WASM SDK の薄いローダ
//   - runtime.js から呼ばれることを想定
//   - このファイル自身はプロジェクト側の薄いローダ
//   - 隣接する `inochi2d_wasm_bg.wasm` を直接ロードする
//
//   このファイル自体は wasm のバイナリを同梱せず、隣の
//   `inochi2d_wasm_bg.wasm` を fetch して instantiate するだけ。
// ──────────────────────────────────────────────────────────────

let _exports = null;
let _initPromise = null;

// wasm バイナリを fetch して instantiate する
async function ensureInit() {
  if (_exports) return _exports;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const base = new URL('./', import.meta.url).href;

    // このプロジェクトではこのファイル自身が薄いローダであり、
    // 同名の wasm-pack glue を再 import しない。再帰的な404を防ぐ。

    // (2) 直接 instantiateStreaming / instantiate
    try {
      const url = new URL('./inochi2d_wasm_bg.wasm', base);
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn('[Inochi2D] wasm not found at', url.href);
        return null;
      }
      const ct = resp.headers.get('content-type') || '';
      let result;
      if (ct.includes('application/wasm')) {
        result = await WebAssembly.instantiateStreaming(resp);
      } else {
        const buf = await resp.arrayBuffer();
        result = await WebAssembly.instantiate(buf);
      }
      _exports = result.instance?.exports || null;
      return _exports;
    } catch (e) {
      console.warn('[Inochi2D] wasm instantiation failed:', e);
      return null;
    }
  })();

  return _initPromise;
}

// 同期的に現在の exports を返す（未 init なら null）
export function getExportsSync() {
  return _exports;
}

// 非同期で init してから exports を返す
export async function getExports() {
  return await ensureInit();
}

// デフォルトエクスポート: getExports を呼ぶ関数
export default getExports;
