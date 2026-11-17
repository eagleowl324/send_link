'use strict';

// Vercel 서버리스 함수: /api/* 요청을 모두 이 함수가 받습니다 (vercel.json의 rewrites 참고).
// 필요한 것: Redis(Upstash) 연동과 Blob 저장소를 프로젝트에 연결해 둘 것. 자세한 순서는 README의 "Vercel에 올리기".

const { loadVercelConfig } = require('../src/vercel/config');
const { createKv } = require('../src/vercel/kv');
const { createBlobStore } = require('../src/vercel/blob');
const { createHandler } = require('../src/vercel/handler');

let handler = null;
let setupError = null;

function setup() {
  const config = loadVercelConfig(process.env);
  const missing = [];
  if (!config.redisUrl || !config.redisToken) missing.push('Redis (KV_REST_API_URL, KV_REST_API_TOKEN)');
  if (!config.blobToken) missing.push('Blob 저장소 (BLOB_READ_WRITE_TOKEN)');
  if (missing.length) throw new Error('연결되지 않은 저장소: ' + missing.join(', '));
  return createHandler({
    config,
    kv: createKv({ url: config.redisUrl, token: config.redisToken }),
    blob: createBlobStore({ token: config.blobToken }),
  });
}

module.exports = async function vercelFunction(req, res) {
  if (!handler && !setupError) {
    try {
      handler = setup();
    } catch (err) {
      setupError = err;
      console.error('[설정 오류]', err.message);
    }
  }
  if (!handler) {
    // 저장소 연결이 끝나지 않은 상태. 화면이 안내 문구를 보여 줄 수 있게 구분되는 오류로 답합니다.
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'not_configured', message: setupError.message }));
    return;
  }
  await handler(req, res);
};
