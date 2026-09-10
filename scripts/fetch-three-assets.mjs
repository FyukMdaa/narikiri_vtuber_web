#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// fetch-three-assets.mjs
//   three.js / @pixiv/three-vrm を自己ホストするために、
//   node_modules から web/js/vendor/ へ ESM バンドルをコピーする。
//
//   従来 web/index.html の importmap は https://esm.sh/... を参照して
//   おり、実行時に外部CDNへ依存していた。これを廃止し、
//   MediaPipe と同様に同一オリジンから配信する自己ホスト構成にする。
//
//   three.module.js / three-vrm.module.js はそれぞれ単一ファイルに
//   バンドル済みの ESM（three-vrm 側は "three" を bare specifier で
//   import するのみ）なので、追加のビルド処理なしにそのまま配信できる。
//   GLTFLoader.js は three/examples/jsm 側の相対 import
//   （BufferGeometryUtils.js）のみに依存するため、2ファイルをセットで
//   コピーする。
//
//   このスクリプトは「開発者のマシンで一度だけ」実行する想定。
//   実行後、アプリはビルド・実行時ともに esm.sh 等の外部CDNへ
//   一切アクセスしない。
// ──────────────────────────────────────────────────────────────
import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const THREE_PKG = path.join(ROOT, 'node_modules', 'three');
const VRM_PKG = path.join(ROOT, 'node_modules', '@pixiv', 'three-vrm');

const THREE_VENDOR = path.join(ROOT, 'web', 'js', 'vendor', 'three');
const VRM_VENDOR = path.join(ROOT, 'web', 'js', 'vendor', 'three-vrm');

async function copyIfExists(src, dest) {
  if (!existsSync(src)) {
    console.warn(`[warn] not found (skip): ${path.relative(ROOT, src)}`);
    return;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log(`[vendor] ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dest)}`);
}

async function vendorThree() {
  if (!existsSync(THREE_PKG)) {
    console.log('[info] three が node_modules に見つからないため、three のベンダー化をスキップします');
    console.log('       (`npm install` 後に再実行してください)');
    return;
  }
  await copyIfExists(
    path.join(THREE_PKG, 'build', 'three.module.js'),
    path.join(THREE_VENDOR, 'build', 'three.module.js'),
  );
  await copyIfExists(
    path.join(THREE_PKG, 'examples', 'jsm', 'loaders', 'GLTFLoader.js'),
    path.join(THREE_VENDOR, 'examples', 'jsm', 'loaders', 'GLTFLoader.js'),
  );
  await copyIfExists(
    path.join(THREE_PKG, 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'),
    path.join(THREE_VENDOR, 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'),
  );
  await copyIfExists(
    path.join(THREE_PKG, 'LICENSE'),
    path.join(THREE_VENDOR, 'LICENSE'),
  );
}

async function vendorThreeVrm() {
  if (!existsSync(VRM_PKG)) {
    console.log('[info] @pixiv/three-vrm が node_modules に見つからないため、ベンダー化をスキップします');
    console.log('       (`npm install` 後に再実行してください)');
    return;
  }
  await copyIfExists(
    path.join(VRM_PKG, 'lib', 'three-vrm.module.js'),
    path.join(VRM_VENDOR, 'three-vrm.module.js'),
  );
  await copyIfExists(
    path.join(VRM_PKG, 'LICENSE'),
    path.join(VRM_VENDOR, 'LICENSE'),
  );
}

async function main() {
  console.log('=== three.js / @pixiv/three-vrm 自己ホスト設定 ===');
  await vendorThree();
  await vendorThreeVrm();
  console.log('\n完了しました。web/js/vendor/three, web/js/vendor/three-vrm 配下が');
  console.log('自己ホストされ、web/index.html の importmap もローカルパスを参照します。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
