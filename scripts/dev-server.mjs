#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// dev-server.mjs - 依存ゼロの静的ファイルサーバ
//   ビルドツールを使わないプロジェクト構成のため、開発時は
//   単純な静的サーバで index.html を配信する。
//   Tauri の devUrl (tauri.conf.json の build.devUrl) からもこれを使う。
//
//   起動時に scripts/inject-env.mjs を呼び出して web/js/env.js を
//   生成する（.env → env.js の注入）。これによりフロントエンドは
//   import.meta.env 相当の機能をビルドツール無しで利用できる。
// ──────────────────────────────────────────────────────────────
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');          // プロジェクトルート
const WEB_ROOT = path.resolve(ROOT, 'web');           // 静的配信ルート
const PORT = Number(process.env.PORT ?? 1420);
const HOST = process.env.HOST ?? '127.0.0.1';

// 起動時に .env → web/js/env.js を生成（失敗してもサーバ起動は継続）
try {
  const injectPath = path.resolve(__dirname, 'inject-env.mjs');
  const result = spawnSync(process.execPath, [injectPath], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.warn('[dev-server] inject-env が失敗しましたが続行します。');
  }
} catch (err) {
  console.warn('[dev-server] inject-env の起動に失敗:', err.message);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.vrm': 'application/octet-stream',
  '.inp': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(WEB_ROOT, urlPath === '/' ? 'index.html' : urlPath);

    // ディレクトリトラバーサル対策
    if (!filePath.startsWith(WEB_ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // 開発中はキャッシュさせない
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500);
    res.end('Internal Server Error: ' + err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dev server running at http://${HOST}:${PORT}`);
});
