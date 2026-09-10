// ──────────────────────────────────────────────────────────────
// inochi2d-wasm.js — Inochi2D 公式 WASM SDK の薄いローダ
//   - runtime.js から呼ばれることを想定
//   - このファイル自身はプロジェクト側の薄いローダ
//   - 隣接する `inochi2d_wasm_bg.wasm` を直接ロードして instantiate する
//
//   このファイル自体は wasm のバイナリを同梱せず、隣の
//   `inochi2d_wasm_bg.wasm` を fetch して instantiate するだけ。
//
//   ※ Inochi2D 公式 wasm-pack ビルドは「インポート必須の wasm」を出力する
//      (wbindgen placeholder / env など)。そのまま `WebAssembly.instantiate(buf)`
//      を呼ぶと "second argument must be an object" で失敗する。
//      公式の glue コード (`inochi2d_wasm_bg.js` — wasm-pack --target web 出力)
//      が隣にあればそちらを優先使用し、無ければ薄いローダで空 import を
//      渡して instantiation を試みる (実機能は使えないが JS フォールバックへ
//      退化するため UX 上の問題は無い)。
// ──────────────────────────────────────────────────────────────

let _exports = null;
let _initPromise = null;

// ── WASM が要求するインポートをスタブ化 ──
//   実機能は無いが、instantiate が TypeError で止まらないようにする。
function buildStubImports(wasmModule) {
  const imports = {};
  try {
    const reqs = WebAssembly.Module.imports(wasmModule);
    for (const r of reqs) {
      if (!imports[r.module]) imports[r.module] = {};
      if (r.kind === 'function') {
        imports[r.module][r.name] = function () { return 0; };
      } else if (r.kind === 'memory') {
        imports[r.module][r.name] = new WebAssembly.Memory({ initial: 16, maximum: 256 });
      } else if (r.kind === 'table') {
        imports[r.module][r.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
      } else if (r.kind === 'global') {
        imports[r.module][r.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
      }
    }
  } catch (_e) {
    // Module.imports が失敗したら空 import で試みる
  }
  return imports;
}

// wasm バイナリを fetch して instantiate する
async function ensureInit() {
  if (_exports) return _exports;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const base = new URL('./', import.meta.url).href;

    // (1) 公式 wasm-pack glue が隣にあればそちらを優先使用
    //   inochi2d_wasm_bg.js (wasm-pack --target web 出力) は WASM が要求する
    //   すべてのインポートを正しく実装してある。
    try {
      const glueUrl = new URL('./inochi2d_wasm_bg.js', base);
      const probe = await fetch(glueUrl, { method: 'HEAD' }).catch(() => null);
      if (probe && probe.ok) {
        const glue = await import(/* @vite-ignore */ glueUrl.href);
        if (glue?.default && typeof glue.default === 'function') {
          await glue.default(new URL('./inochi2d_wasm_bg.wasm', base));
        } else if (glue?.init && typeof glue.init === 'function') {
          await glue.init(new URL('./inochi2d_wasm_bg.wasm', base));
        }
        console.info('[Inochi2D] wasm-pack glue detected — using official bindings.');
        _exports = glue;
        return _exports;
      }
    } catch (_e) {
      // glue が無い場合は直接 instantiate へ
    }

    // (2) 直接 instantiateStreaming / instantiate
    //   WASM がインポートを要求する場合は空スタブ import を渡す。
    //   ※ 実機能は使えないが、JS フォールバックへ退化するので問題無し。
    try {
      const url = new URL('./inochi2d_wasm_bg.wasm', base);
      const resp = await fetch(url);
      if (!resp.ok) {
        // 404 等 — WASM バイナリ未配置。JS フォールバックへ。
        console.info('[Inochi2D] wasm binary not found at', url.href, '— using JS fallback.');
        return null;
      }
      const ct = resp.headers.get('content-type') || '';
      let result;
      if (ct.includes('application/wasm')) {
        try {
          result = await WebAssembly.instantiateStreaming(resp);
        } catch (_streamErr) {
          const buf2 = await resp.arrayBuffer();
          const mod = await WebAssembly.compile(buf2);
          const imports = buildStubImports(mod);
          const instance = await WebAssembly.instantiate(mod, imports);
          result = { instance };
        }
      } else {
        const buf = await resp.arrayBuffer();
        const mod = await WebAssembly.compile(buf);
        const imports = buildStubImports(mod);
        result = await WebAssembly.instantiate(mod, imports);
      }
      _exports = result.instance?.exports || null;
      if (_exports) {
        console.info('[Inochi2D] wasm instantiated (thin loader). 実機能を使うには wasm-pack glue (inochi2d_wasm_bg.js) を同梱してください。');
      }
      return _exports;
    } catch (e) {
      console.warn('[Inochi2D] wasm instantiation failed:', e.message || e);
      console.warn('[Inochi2D] wasm-pack glue (inochi2d_wasm_bg.js) を web/js/vendor/inochi2d/ に配置するとフル機能が有効化されます。');
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
