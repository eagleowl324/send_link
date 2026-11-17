'use strict';

// Vercel 서버리스 함수: /api/* 요청을 모두 이 함수가 받습니다 (vercel.json의 rewrites 참고).
// 필요한 것: Redis(Upstash) 연동과 Blob 저장소를 프로젝트에 연결해 둘 것. 자세한 순서는 README의 "Vercel에 올리기".

const { loadVercelConfig, storageVariableNames } = require('../src/vercel/config');
const { createKv } = require('../src/vercel/kv');
const { createBlobStore } = require('../src/vercel/blob');
const { withRequest, currentOidcToken } = require('../src/vercel/oidc');
const { createHandler } = require('../src/vercel/handler');

let handler = null;
let setupError = null;

function setup() {
  const config = loadVercelConfig(process.env);
  const missing = [];
  if (!config.redisUrl || !config.redisToken) missing.push('Redis (KV_REST_API_URL, KV_REST_API_TOKEN)');
  if (!config.blobStoreId && !config.blobToken) missing.push('Blob 저장소 (BLOB_STORE_ID 또는 BLOB_READ_WRITE_TOKEN)');
  if (missing.length) {
    const err = new Error('연결되지 않은 저장소: ' + missing.join(', '));
    // 원인을 밖에서도 알 수 있게, 이 배포가 받은 저장소 관련 환경 변수의 "이름"만 함께 알려 줍니다.
    err.seen = storageVariableNames(process.env);
    err.hint = err.seen.length
      ? 'Vercel 프로젝트의 Storage 탭에서 빠진 저장소를 이 프로젝트에 연결한 다음, 다시 배포(Redeploy)해 주세요.'
      : '이 배포에는 저장소 정보가 하나도 전달되지 않았습니다. 저장소를 연결하기 전에 만들어진 배포일 수 있으니, Vercel의 Deployments에서 다시 배포(Redeploy)해 주세요.';
    throw err;
  }
  const kv = createKv({ url: config.redisUrl, token: config.redisToken });
  const blob = createBlobStore({
    token: config.blobToken,
    storeId: config.blobStoreId,
    access: config.blobAccess,
    oidcToken: currentOidcToken,
    // 저장소 종류(공개/비공개)는 한 번 알아내면 Redis에 적어 두고 다시 묻지 않습니다.
    memo: {
      get: (key) => kv.cmd('GET', `cfg:${key}`),
      set: (key, value) => kv.cmd('SET', `cfg:${key}`, value),
    },
  });
  return createHandler({ config, kv, blob });
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
    res.end(
      JSON.stringify({
        error: 'not_configured',
        message: setupError.message,
        hint: setupError.hint || undefined,
        seen: setupError.seen || undefined,
      })
    );
    return;
  }
  // Blob 저장소 접속에 쓸 신원 토큰이 이 요청과 함께 왔으면, 처리하는 동안 꺼내 쓸 수 있게 해 둡니다.
  await withRequest(req, () => handler(req, res));
};
