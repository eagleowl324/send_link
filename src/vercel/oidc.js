'use strict';

// Vercel이 함수에 건네주는 신원 토큰(OIDC). Blob 저장소를 BLOB_STORE_ID 방식으로 연결했을 때,
// 비밀 값 대신 이 토큰으로 "이 프로젝트의 함수"임을 증명하고 저장소에 접속합니다.
// 토큰은 요청마다 머리글(x-vercel-oidc-token)로 오므로, 처리 중인 요청의 것을 기억해 두었다가 꺼내 씁니다.

const { AsyncLocalStorage } = require('node:async_hooks');

const requestScope = new AsyncLocalStorage();

function oidcTokenOf(req) {
  const header = req && req.headers ? req.headers['x-vercel-oidc-token'] : '';
  if (typeof header === 'string' && header) return header;
  try {
    // Vercel의 공식 도구(@vercel/oidc)가 읽는 곳과 같은 곳입니다.
    const context = globalThis[Symbol.for('@vercel/request-context')];
    const headers = context && typeof context.get === 'function' ? (context.get() || {}).headers : null;
    if (headers && headers['x-vercel-oidc-token']) return String(headers['x-vercel-oidc-token']);
  } catch (err) {
    // 아래의 환경 변수로 넘어갑니다
  }
  return process.env.VERCEL_OIDC_TOKEN || '';
}

// work를 실행하는 동안 currentOidcToken()이 이 요청의 토큰을 돌려주게 합니다.
function withRequest(req, work) {
  return requestScope.run({ oidcToken: oidcTokenOf(req) }, work);
}

function currentOidcToken() {
  const scope = requestScope.getStore();
  return (scope && scope.oidcToken) || oidcTokenOf(null);
}

module.exports = { oidcTokenOf, withRequest, currentOidcToken };
