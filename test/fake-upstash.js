'use strict';

// 테스트용: 메모리 Redis(test/fake-kv.js)를 Upstash의 REST 방식(POST / , /pipeline, /multi-exec)으로 내놓는 작은 서버.
// 함수 진입점(api/index.js)처럼 실제 Redis 클라이언트(src/vercel/kv.js)를 거치는 흐름을 시험할 때 씁니다.

const http = require('node:http');
const { createFakeKv } = require('./fake-kv');

async function startFakeUpstash(options) {
  const kv = createFakeKv(options);
  const one = async (args) => {
    try {
      return { result: await kv.cmd(...args) };
    } catch (err) {
      return { error: err.message };
    }
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    let out;
    if (req.url === '/pipeline' || req.url === '/multi-exec') {
      out = [];
      for (const args of body) out.push(await one(args));
    } else {
      out = await one(body);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { kv, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { startFakeUpstash };
