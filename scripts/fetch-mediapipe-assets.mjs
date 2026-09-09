#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// fetch-mediapipe-assets.mjs
//   MediaPipe を自己ホストするために必要なファイルをローカルへ取得する。
//
//   1) モデル本体 (.task) を Google の公開バケットから
//      assets/mediapipe/models/ にダウンロードする
//   2) （任意）@mediapipe/tasks-vision の WASM / ESM バンドルを
//      node_modules から js/vendor/mediapipe/ へコピーし直す
//      （ライブラリのバージョンを更新したときに使う）
//
//   このスクリプトは「開発者のマシンで一度だけ」実行する想定。
//   実行後、アプリ自体はネットワーク上のCDN(jsdelivr / storage.googleapis.com)
//   に一切アクセスせず、同一オリジン（自己ホスト）のファイルのみで動作する。
// ──────────────────────────────────────────────────────────────
import { mkdir, copyFile, stat } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MODELS_DIR = path.join(ROOT, 'assets', 'mediapipe', 'models');
const VENDOR_DIR = path.join(ROOT, 'js', 'vendor', 'mediapipe');

// バージョンを上げたい場合はここを変更し、package.json の devDependency も揃える。
const MODEL_URLS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

async function downloadFile(url, destPath) {
  if (existsSync(destPath)) {
    console.log(`[skip] already exists: ${path.relative(ROOT, destPath)}`);
    return;
  }
  console.log(`[fetch] ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  await mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(res.body, createWriteStream(destPath));
  console.log(`[done] ${path.relative(ROOT, destPath)}`);
}

async function refreshVendorBundle() {
  const pkgDir = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision');
  if (!existsSync(pkgDir)) {
    console.log('[info] @mediapipe/tasks-vision が node_modules に見つからないため、');
    console.log('       vendor バンドルの更新はスキップします（`npm install` 後に再実行してください）。');
    return;
  }
  await mkdir(path.join(VENDOR_DIR, 'wasm'), { recursive: true });
  const files = [
    ['vision_bundle.mjs', VENDOR_DIR],
    ['vision_bundle.mjs.map', VENDOR_DIR],
    ['wasm/vision_wasm_internal.js', path.join(VENDOR_DIR, 'wasm')],
    ['wasm/vision_wasm_internal.wasm', path.join(VENDOR_DIR, 'wasm')],
    ['wasm/vision_wasm_nosimd_internal.js', path.join(VENDOR_DIR, 'wasm')],
    ['wasm/vision_wasm_nosimd_internal.wasm', path.join(VENDOR_DIR, 'wasm')],
  ];
  for (const [rel, destDir] of files) {
    const src = path.join(pkgDir, rel);
    const dest = path.join(destDir, path.basename(rel));
    if (!existsSync(src)) {
      console.warn(`[warn] missing in package: ${rel}`);
      continue;
    }
    await copyFile(src, dest);
    console.log(`[vendor] ${rel} -> ${path.relative(ROOT, dest)}`);
  }
}

async function main() {
  console.log('=== MediaPipe assets self-host setup ===');
  await mkdir(MODELS_DIR, { recursive: true });

  for (const [filename, url] of Object.entries(MODEL_URLS)) {
    await downloadFile(url, path.join(MODELS_DIR, filename));
  }

  await refreshVendorBundle();

  console.log('\n完了しました。以下が自己ホストされています:');
  console.log(`  - WASM/ESM バンドル: ${path.relative(ROOT, VENDOR_DIR)}`);
  console.log(`  - モデルファイル:     ${path.relative(ROOT, MODELS_DIR)}`);
  console.log('\nアプリはこれ以降、外部CDNへ一切アクセスしません。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
