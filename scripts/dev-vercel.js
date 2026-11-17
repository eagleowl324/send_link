#!/usr/bin/env node
'use strict';

// Vercel에 올리기 전에, Vercel용 구성(api/ 함수 + 정적 화면)을 내 컴퓨터에서 미리 써 보는 서버입니다.
// Redis와 파일 저장소를 메모리로 흉내 내므로 끄면 내용이 모두 사라집니다. 실제 수업용이 아닙니다.
//
//   node scripts/dev-vercel.js          → http://localhost:3001
//   PORT=4000 TEACHER_PASSWORD=pw node scripts/dev-vercel.js
//
// vercel.json 의 rewrites·headers 를 그대로 읽어 적용합니다.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadVercelConfig } = require('../src/vercel/config');
const { createHandler } = require('../src/vercel/handler');
const { createFakeKv } = require('../test/fake-kv');
const { createFakeBlob } = require('../test/fake-blob');
const { build } = require('./build-vercel');

const ROOT = path.join(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function createDevServer(env = process.env) {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const dist = build(env);
  const kv = createFakeKv();
  const blob = createFakeBlob({ baseUrl: '' });
  const config = loadVercelConfig(Object.assign({ CRON_SECRET: 'dev-cron-secret' }, env));
  const handler = createHandler({ kv, blob, config });

  // vercel.json 의 "/(.*)" 머리글을 모든 응답에 붙입니다.
  const globalHeaders = {};
  for (const rule of settings.headers || []) {
    if (rule.source === '/(.*)') for (const h of rule.headers) globalHeaders[h.key] = h.value;
  }

  function sendFile(res, file, status) {
    fs.readFile(file, (err, data) => {
      if (err) {
        sendFile(res, path.join(dist, '404.html'), 404);
        return;
      }
      res.writeHead(status, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    for (const name of Object.keys(globalHeaders)) res.setHeader(name, globalHeaders[name]);
    try {
      if (await blob.handle(req, res)) return; // 흉내 낸 파일 저장소
      const url = new URL('http://localhost' + req.url);
      const { pathname } = url;

      if (pathname.startsWith('/api/')) {
        // rewrites: "/api/:path*" → "/api/index?__path=:path*"
        if (pathname !== '/api/index') {
          url.searchParams.set('__path', pathname.slice('/api/'.length));
          req.url = '/api/index?' + url.searchParams.toString();
        }
        await handler(req, res);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      if (/^\/\d{6}$/.test(pathname)) return sendFile(res, path.join(dist, 'room.html'), 200); // rewrites
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = path.join(dist, relative);
      if (!file.startsWith(dist + path.sep) || pathname.includes('..')) return sendFile(res, path.join(dist, '404.html'), 404);
      return sendFile(res, file, 200);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  return { server, kv, blob, config };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3001;
  const { server } = createDevServer();
  server.listen(port, () => {
    console.log(`\n  Vercel용 구성 미리 보기: http://localhost:${port}`);
    console.log('  (Redis와 파일 저장소는 메모리로 흉내 낸 것입니다. 끄면 내용이 사라집니다)\n');
  });
}

module.exports = { createDevServer };
