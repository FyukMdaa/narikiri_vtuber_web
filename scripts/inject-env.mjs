#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// inject-env.mjs - .env を読み込んで web/js/env.js を生成する
//
//   Tauri のビルドツール無し構成では import.meta.env が使えないため、
//   プロジェクトルートの .env を読み込んで ESM モジュールとして
//   出力する。これによりフロントエンドは `import { env } from 'app/env.js'`
//   で環境変数にアクセスできる。
//
//   実行タイミング:
//     - npm run dev (scripts/dev-server.mjs が起動時に呼ぶ)
//     - npm run tauri:build (tauri.conf.json の beforeBuildCommand 経由)
// ──────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');
const OUT_PATH = resolve(ROOT, 'web', 'js', 'env.js');

// .env をパースして KEY=VALUE の Map を返す
function parseEnv(text) {
  const map = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 前後の引用符を外す
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    map[key] = value;
  }
  return map;
}

// 文字列を JSON 安全なリテラルへ変換
function asJsonString(value) {
  return JSON.stringify(String(value ?? ''));
}

function main() {
  let envMap = {};
  if (existsSync(ENV_PATH)) {
    const text = readFileSync(ENV_PATH, 'utf8');
    envMap = parseEnv(text);
  } else {
    console.warn('[inject-env] .env が見つかりません。デフォルト値で生成します。');
  }

  // デフォルト値（.env に無い項目のフォールバック）
  const resolved = {
    PHOTO_FRAME_TEXT: envMap.PHOTO_FRAME_TEXT ?? 'なりきりVTuber',
    PHOTO_FRAME_SUBTEXT: envMap.PHOTO_FRAME_SUBTEXT ?? 'Photo Mode',
    PHOTO_FRAME_COLOR: envMap.PHOTO_FRAME_COLOR ?? '#3b82f6',
    PHOTO_FILE_PREFIX: envMap.PHOTO_FILE_PREFIX ?? 'vtuber-photo',
  };

  const outDir = dirname(OUT_PATH);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const body = Object.entries(resolved)
    .map(([k, v]) => `  ${k}: ${asJsonString(v)},`)
    .join('\n');

  const src = `// ──────────────────────────────────────────────────────────────
// env.js - AUTO-GENERATED. 直接編集せずプロジェクトルートの .env を編集してください。
//   このファイルは scripts/inject-env.mjs によって .env から生成される。
// ──────────────────────────────────────────────────────────────
export const env = Object.freeze({
${body}
});

// 個別 import 用の named export
export const PHOTO_FRAME_TEXT = env.PHOTO_FRAME_TEXT;
export const PHOTO_FRAME_SUBTEXT = env.PHOTO_FRAME_SUBTEXT;
export const PHOTO_FRAME_COLOR = env.PHOTO_FRAME_COLOR;
export const PHOTO_FILE_PREFIX = env.PHOTO_FILE_PREFIX;
`;

  writeFileSync(OUT_PATH, src, 'utf8');
  console.log(`[inject-env] generated ${relative(ROOT, OUT_PATH)}`);
}

main();
