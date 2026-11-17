'use strict';

// 테스트용: Vercel Blob의 관리 API(https://vercel.com/api/blob)를 흉내 내는 작은 HTTP 서버.
// 실제 SDK(@vercel/blob)가 이 서버와 이야기하게 해서(환경 변수 VERCEL_BLOB_API_URL),
// src/vercel/blob.js 가 SDK를 올바르게 부르는지, 브라우저에 건네는 올리기 주소가 실제로 통하는지 확인합니다.
// 서명 방식은 SDK 소스(signed-token.ts, presign-query-params.ts)에 적힌 대로 따랐습니다.

const http = require('node:http');
const crypto = require('node:crypto');

// 서명에 들어가는 주소 매개변수 (SDK의 PRESIGN_CANONICAL_QUERY_KEYS)
const CANONICAL_KEYS = [
  'vercel-blob-add-random-suffix',
  'vercel-blob-allow-overwrite',
  'vercel-blob-allowed-content-types',
  'vercel-blob-cache-control-max-age',
  'vercel-blob-callback-token-payload',
  'vercel-blob-callback-url',
  'vercel-blob-if-match',
  'vercel-blob-maximum-size-in-bytes',
  'vercel-blob-ttl-days',
  'vercel-blob-valid-until',
];

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// storeId:   저장소 번호 (store_ 접두어 없이)
// access:    이 저장소의 종류. 다른 종류로 올리면 거절합니다.
// oidcToken: 받아 줄 신원 토큰 (BLOB_STORE_ID 방식)
// rwToken:   받아 줄 읽기/쓰기 토큰 (예전 방식)
async function startFakeBlobApi({ storeId = 'TestStore123', access = 'public', oidcToken = '', rwToken = '', now = () => Date.now() } = {}) {
  const secret = crypto.randomBytes(16).toString('hex');
  const files = new Map(); // pathname -> { data, uploadedAt, contentType }
  const requests = []; // 받은 요청 기록 { method, path, headers, kind }

  const urlOf = (pathname) => `https://${storeId.toLowerCase()}.${access}.blob.vercel-storage.com/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  const pathnameOf = (urlOrPathname) => {
    if (!/^https?:\/\//.test(urlOrPathname)) return urlOrPathname;
    return new URL(urlOrPathname).pathname.slice(1).split('/').map(decodeURIComponent).join('/');
  };

  function fail(res, status, code, message) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message: message || code } }));
  }

  function ok(res, body) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  // 서버 쪽 접속(신원 토큰 또는 읽기/쓰기 토큰)인지
  function isServer(req) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!bearer) return false;
    if (rwToken && bearer === rwToken) return true;
    return Boolean(oidcToken) && bearer === oidcToken && req.headers['x-vercel-blob-store-id'] === storeId;
  }

  // 예전 방식의 일회용 토큰: 허용된 조건을 돌려주거나 null
  function clientTokenScope(req) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const m = /^vercel_blob_client_([^_]+)_(.+)$/.exec(bearer);
    if (!m || !rwToken || m[1] !== storeId) return null;
    const [signature, payload] = Buffer.from(m[2], 'base64').toString().split('.');
    if (!payload || signature !== crypto.createHmac('sha256', rwToken).update(payload).digest('hex')) return null;
    return JSON.parse(Buffer.from(payload, 'base64').toString());
  }

  // 서명된 올리기 주소: 허용된 조건을 돌려주거나 { error }
  function presignedScope(url, operation) {
    const delegation = url.searchParams.get('vercel-blob-delegation');
    const signature = url.searchParams.get('vercel-blob-signature');
    if (!delegation || !signature) return null;
    const dot = delegation.indexOf('.');
    const payloadPart = delegation.slice(0, dot);
    if (dot < 0 || delegation.slice(dot + 1) !== hmac(secret, payloadPart).toString('base64url')) return { error: 'bad delegation' };
    const scope = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    const pathname = url.searchParams.get('pathname') || '';
    const lines = [`operation=${operation}`, `pathname=${pathname}`];
    for (const key of CANONICAL_KEYS) {
      const value = url.searchParams.get(key);
      if (value) lines.push(`${key}=${value}`);
    }
    lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const signingKey = hmac(secret, delegation).toString('base64url');
    if (signature !== hmac(signingKey, lines.join('\n')).toString('base64url')) return { error: 'bad signature' };
    if (!scope.operations.includes(operation)) return { error: 'operation not allowed' };
    if (scope.pathname !== '*' && scope.pathname !== pathname) return { error: '"pathname" does not match the token payload' };
    const until = Number(url.searchParams.get('vercel-blob-valid-until') || scope.validUntil);
    if (until <= now() || scope.validUntil <= now()) return { error: 'Token expired' };
    const sizes = [scope.maximumSizeInBytes, url.searchParams.get('vercel-blob-maximum-size-in-bytes')].filter((v) => v !== undefined && v !== null);
    return {
      pathname,
      maximumSizeInBytes: sizes.length ? Math.min(...sizes.map(Number)) : undefined,
      allowOverwrite: url.searchParams.get('vercel-blob-allow-overwrite') === 'true',
      addRandomSuffix: url.searchParams.get('vercel-blob-add-random-suffix') === 'true',
    };
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL('http://localhost' + req.url);
    const record = { method: req.method, path: url.pathname, headers: req.headers, kind: '' };
    requests.push(record);
    try {
      // ---- 위임 토큰 발급
      if (req.method === 'POST' && url.pathname === '/signed-token') {
        record.kind = 'signed-token';
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (!isServer(req)) return fail(res, 403, 'forbidden');
        const payload = {
          storeId: `store_${storeId}`,
          ownerId: 'team_test',
          pathname: body.pathname || '*',
          operations: body.operations || ['get'],
          validUntil: body.validUntil || now() + 60 * 60 * 1000,
          iat: now(),
        };
        if (body.maximumSizeInBytes !== undefined) payload.maximumSizeInBytes = body.maximumSizeInBytes;
        if (payload.validUntil > now() + 60 * 60 * 1000 + 5000) return fail(res, 400, 'bad_request', 'validUntil is too far in the future');
        const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const delegationToken = `${payloadPart}.${hmac(secret, payloadPart).toString('base64url')}`;
        return ok(res, {
          delegationToken,
          clientSigningToken: hmac(secret, delegationToken).toString('base64url'),
          validUntil: payload.validUntil,
        });
      }

      // ---- 지우기
      if (req.method === 'POST' && url.pathname === '/delete') {
        record.kind = 'delete';
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (!isServer(req)) return fail(res, 403, 'forbidden');
        for (const target of body.urls || []) files.delete(pathnameOf(target));
        return ok(res, {});
      }

      // ---- 올리기
      if (req.method === 'PUT' && url.pathname === '/') {
        const data = await readBody(req);
        const pathname = url.searchParams.get('pathname') || '';
        let scope = null;
        if (isServer(req)) {
          record.kind = 'put-server';
          scope = { pathname, allowOverwrite: req.headers['x-allow-overwrite'] === '1' };
        } else if (url.searchParams.has('vercel-blob-delegation')) {
          record.kind = 'put-presigned';
          scope = presignedScope(url, 'put');
          if (scope && scope.error) return fail(res, 403, 'forbidden', scope.error);
          if (req.headers['x-vercel-blob-store-id'] !== storeId) return fail(res, 404, 'store_not_found');
        } else {
          record.kind = 'put-client-token';
          scope = clientTokenScope(req);
          if (scope && scope.validUntil <= now()) return fail(res, 403, 'forbidden', 'Token expired');
        }
        if (!scope) return fail(res, 403, 'forbidden');
        if (scope.pathname !== pathname) return fail(res, 403, 'forbidden', '"pathname" does not match the token payload');
        if (req.headers['x-vercel-blob-access'] !== access) {
          return fail(res, 400, 'bad_request', `Cannot use ${req.headers['x-vercel-blob-access']} access on a ${access} store`);
        }
        if (scope.maximumSizeInBytes !== undefined && data.length > scope.maximumSizeInBytes) {
          return fail(res, 400, 'bad_request', `the file length cannot be greater than ${scope.maximumSizeInBytes}`);
        }
        if (files.has(pathname) && !scope.allowOverwrite) return fail(res, 400, 'bad_request', 'This blob already exists');
        files.set(pathname, { data, uploadedAt: now(), contentType: req.headers['x-content-type'] || 'application/octet-stream' });
        return ok(res, {
          url: urlOf(pathname),
          downloadUrl: urlOf(pathname) + '?download=1',
          pathname,
          contentType: files.get(pathname).contentType,
          contentDisposition: 'inline',
          etag: '"' + crypto.createHash('md5').update(data).digest('hex') + '"',
        });
      }

      // ---- 파일 정보(url=…) 또는 목록
      if (req.method === 'GET' && url.pathname === '/') {
        if (!isServer(req)) return fail(res, 403, 'forbidden');
        if (url.searchParams.has('url')) {
          record.kind = 'head';
          const pathname = pathnameOf(url.searchParams.get('url'));
          const file = files.get(pathname);
          if (!file) return fail(res, 404, 'not_found');
          return ok(res, {
            url: urlOf(pathname),
            downloadUrl: urlOf(pathname) + '?download=1',
            pathname,
            size: file.data.length,
            contentType: file.contentType,
            contentDisposition: 'inline',
            cacheControl: 'public, max-age=2592000',
            uploadedAt: new Date(file.uploadedAt).toISOString(),
            etag: '"etag"',
          });
        }
        record.kind = 'list';
        const prefix = url.searchParams.get('prefix') || '';
        const names = Array.from(files.keys())
          .filter((name) => name.startsWith(prefix))
          .sort();
        const describe = (pathname) => ({
          url: urlOf(pathname),
          downloadUrl: urlOf(pathname) + '?download=1',
          pathname,
          size: files.get(pathname).data.length,
          uploadedAt: new Date(files.get(pathname).uploadedAt).toISOString(),
          etag: '"etag"',
        });
        if (url.searchParams.get('mode') === 'folded') {
          const folders = new Set();
          const blobs = [];
          for (const name of names) {
            const slash = name.indexOf('/', prefix.length);
            if (slash >= 0) folders.add(name.slice(0, slash + 1));
            else blobs.push(name);
          }
          return ok(res, { blobs: blobs.map(describe), folders: Array.from(folders), hasMore: false });
        }
        return ok(res, { blobs: names.map(describe), hasMore: false });
      }

      return fail(res, 404, 'not_found');
    } catch (err) {
      return fail(res, 500, 'unknown_error', String(err && err.message));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const savedUrl = process.env.VERCEL_BLOB_API_URL;
  process.env.VERCEL_BLOB_API_URL = base; // SDK가 읽는 값

  return {
    base,
    requests,
    kinds: () => requests.map((r) => r.kind),
    pathnames: () => Array.from(files.keys()).sort(),
    read: (pathname) => (files.has(pathname) ? files.get(pathname).data : null),
    async close() {
      if (savedUrl === undefined) delete process.env.VERCEL_BLOB_API_URL;
      else process.env.VERCEL_BLOB_API_URL = savedUrl;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakeBlobApi };
