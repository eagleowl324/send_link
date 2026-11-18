'use strict';

// 파일 저장소 연결(src/vercel/blob.js)과 Vercel 함수 진입점(api/index.js) 테스트.
// 실제 SDK(@vercel/blob)를 쓰되, 저장소 API는 흉내 낸 서버(test/fake-blob-api.js)로 돌립니다.
// (실제 Vercel Blob에서만 확인할 수 있는 것은 README의 "배포 후 확인할 것" 참고)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { startFakeBlobApi } = require('./fake-blob-api');
const { startFakeUpstash } = require('./fake-upstash');
const { oidcTokenOf, withRequest, currentOidcToken } = require('../src/vercel/oidc');
const { loadVercelConfig, storageVariableNames } = require('../src/vercel/config');

let sdkInstalled = true;
try {
  require.resolve('@vercel/blob');
} catch (err) {
  sdkInstalled = false;
}
const skip = !sdkInstalled && '@vercel/blob 미설치 (npm install 후 실행)';

const PATHNAME = 'rooms/123456-abc/' + 'f'.repeat(32) + '/한글 파일 (1).pdf';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function memoOf(map) {
  return {
    get: async (key) => (map.has(key) ? map.get(key) : null),
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}

// 브라우저가 하듯이, 받은 주소와 머리글로 파일을 올립니다.
function browserPut(url, headers, body) {
  return fetch(url, { method: 'PUT', headers, body });
}

test('Blob(BLOB_STORE_ID 방식): 서명된 주소로 브라우저가 직접 올리고, 서버는 신원 토큰으로 접속한다', { skip }, async (t) => {
  const { createBlobStore, BLOB_API_VERSION } = require('../src/vercel/blob');
  const api = await startFakeBlobApi({ storeId: 'TestStore123', oidcToken: 'oidc-abc' });
  t.after(() => api.close());
  const saved = new Map();
  const store = createBlobStore({ storeId: 'store_TestStore123', oidcToken: () => 'oidc-abc', memo: memoOf(saved) });

  const ticket = await store.uploadTicket({ pathname: PATHNAME, size: 5, validUntil: Date.now() + 60 * 60 * 1000 });

  // 처음 한 번은 저장소 종류를 알아내려고 작은 파일을 올렸다 지우고, 그 결과를 적어 둔다
  assert.deepEqual(api.kinds(), ['put-server', 'delete', 'signed-token']);
  assert.deepEqual(api.pathnames(), []);
  assert.equal(saved.get('blob-access:TestStore123'), 'public');
  // 서버가 보내는 요청은 모두 신원 토큰 + 저장소 번호(접두어 없이)로 접속한다
  for (const request of api.requests) {
    assert.equal(request.headers.authorization, 'Bearer oidc-abc');
    assert.equal(request.headers['x-vercel-blob-store-id'], 'TestStore123');
    assert.equal(request.headers['x-api-version'], BLOB_API_VERSION);
  }

  // 브라우저에 건네는 것: 비밀 값(Authorization) 없이, 조건이 서명된 주소
  assert.deepEqual(ticket.headers, {
    'x-api-version': BLOB_API_VERSION,
    'x-vercel-blob-access': 'public',
    'x-vercel-blob-store-id': 'TestStore123',
    'x-content-length': '5',
  });
  const url = new URL(ticket.url);
  assert.equal(url.origin + url.pathname, api.base + '/');
  assert.equal(url.searchParams.get('pathname'), PATHNAME);
  assert.equal(url.searchParams.get('vercel-blob-maximum-size-in-bytes'), '5');
  assert.equal(url.searchParams.get('vercel-blob-allow-overwrite'), 'false');
  assert.equal(url.searchParams.get('vercel-blob-add-random-suffix'), 'false');
  assert.ok(url.searchParams.get('vercel-blob-delegation'));
  assert.ok(url.searchParams.get('vercel-blob-signature'));

  // 허가된 것보다 큰 파일, 다른 경로, 조건을 고친 주소는 받아 주지 않는다
  assert.equal((await browserPut(ticket.url, ticket.headers, 'too long')).status, 400);
  const elsewhere = new URL(ticket.url);
  elsewhere.searchParams.set('pathname', 'rooms/elsewhere.txt');
  assert.equal((await browserPut(elsewhere, ticket.headers, 'hello')).status, 403);
  const bigger = new URL(ticket.url);
  bigger.searchParams.set('vercel-blob-maximum-size-in-bytes', '999');
  assert.equal((await browserPut(bigger, ticket.headers, 'too long')).status, 403);
  const overwrite = new URL(ticket.url);
  overwrite.searchParams.set('vercel-blob-allow-overwrite', 'true');
  assert.equal((await browserPut(overwrite, ticket.headers, 'hello')).status, 403);
  assert.deepEqual(api.pathnames(), []);

  // 맞게 올리면 들어가고, 같은 주소로 다시 올려 덮어쓸 수는 없다
  assert.equal((await browserPut(ticket.url, ticket.headers, 'hello')).status, 200);
  assert.equal((await browserPut(ticket.url, ticket.headers, 'HELLO')).status, 400);
  assert.equal(String(api.read(PATHNAME)), 'hello');

  const stored = await store.head(PATHNAME);
  assert.equal(stored.size, 5);
  assert.equal(stored.pathname, PATHNAME);
  assert.match(stored.url, /^https:\/\/teststore123\.public\.blob\.vercel-storage\.com\/rooms\//);
  assert.ok(Number.isFinite(stored.uploadedAt));
  assert.equal(await store.head('rooms/none.txt'), null);

  const folders = await store.list({ prefix: 'rooms/', mode: 'folded' });
  assert.deepEqual(folders.folders, ['rooms/123456-abc/']);
  const inside = await store.list({ prefix: 'rooms/123456-abc/' });
  assert.deepEqual(
    inside.blobs.map((b) => [b.pathname, b.size]),
    [[PATHNAME, 5]]
  );

  await store.del([PATHNAME]);
  assert.deepEqual(api.pathnames(), []);
  await store.del([]); // 지울 것이 없으면 저장소에 묻지 않는다

  // 새로 뜬 함수(새 저장소 객체)는 적어 둔 값을 쓰고, 다시 알아보지 않는다
  const before = api.requests.length;
  const again = createBlobStore({ storeId: 'store_TestStore123', oidcToken: () => 'oidc-abc', memo: memoOf(saved) });
  assert.equal(await again.access(), 'public');
  assert.equal(api.requests.length, before);
});

test('Blob: 비공개(Private) 저장소는 알아보고 알기 쉬운 오류로 답한다', { skip }, async (t) => {
  const { createBlobStore } = require('../src/vercel/blob');
  const api = await startFakeBlobApi({ storeId: 'PrivStore', access: 'private', oidcToken: 'oidc' });
  t.after(() => api.close());
  const store = createBlobStore({ storeId: 'store_PrivStore', oidcToken: () => 'oidc' });

  assert.equal(await store.access(), 'private');
  assert.deepEqual(api.kinds(), ['put-server', 'put-server', 'delete']); // 공개로 해 보고(거절), 비공개로 해 봄
  assert.deepEqual(api.pathnames(), []);
  await assert.rejects(
    store.uploadTicket({ pathname: PATHNAME, size: 5, validUntil: Date.now() + 60000 }),
    (err) => err.storageCode === 'storage_private'
  );
  assert.equal(api.requests.length, 3); // 한 번 알아낸 뒤에는 다시 묻지 않는다

  // 종류를 미리 정해 두면 알아보는 단계를 건너뛴다
  const fixed = createBlobStore({ storeId: 'store_PrivStore', oidcToken: () => 'oidc', access: 'private' });
  assert.equal(await fixed.access(), 'private');
  assert.equal(api.requests.length, 3);
});

test('Blob: 신원 토큰이 없거나 저장소가 거절하면 접속 문제로 알려 준다', { skip }, async (t) => {
  const { createBlobStore } = require('../src/vercel/blob');
  const api = await startFakeBlobApi({ storeId: 'S1', oidcToken: 'right-token' });
  t.after(() => api.close());
  const ticketOf = (store) => store.uploadTicket({ pathname: PATHNAME, size: 5, validUntil: Date.now() + 60000 });

  const none = createBlobStore({ storeId: 'store_S1', oidcToken: () => '' });
  await assert.rejects(ticketOf(none), (err) => err.storageCode === 'storage_auth' && /OIDC/.test(err.message));
  await assert.rejects(none.head(PATHNAME), (err) => err.storageCode === 'storage_auth');
  assert.equal(api.requests.length, 0); // 토큰이 없으면 저장소에 묻지도 않는다

  const wrong = createBlobStore({ storeId: 'store_S1', oidcToken: () => 'wrong-token' });
  await assert.rejects(ticketOf(wrong), (err) => err.storageCode === 'storage_auth' && /Access denied/.test(err.message));
  await assert.rejects(wrong.head(PATHNAME), (err) => err.storageCode === 'storage_auth');
  await assert.rejects(wrong.del([PATHNAME]), (err) => err.storageCode === 'storage_auth');
  await assert.rejects(wrong.list({ prefix: 'rooms/' }), (err) => err.storageCode === 'storage_auth');

  // 다른 저장소 번호로는 접속되지 않는다
  const other = createBlobStore({ storeId: 'store_Other', oidcToken: () => 'right-token' });
  await assert.rejects(other.head(PATHNAME), (err) => err.storageCode === 'storage_auth');

  assert.throws(() => createBlobStore({}), /BLOB_STORE_ID/);
});

test('Blob(예전 방식, 읽기/쓰기 토큰): 일회용 토큰으로 올린다', { skip }, async (t) => {
  const { createBlobStore, BLOB_API_URL } = require('../src/vercel/blob');
  const rwToken = 'vercel_blob_rw_OldStore9_' + 'x'.repeat(30);
  const api = await startFakeBlobApi({ storeId: 'OldStore9', rwToken });
  t.after(() => api.close());
  // 둘 다 있으면 읽기/쓰기 토큰을 쓴다 (신원 토큰은 쓰이지 않음)
  const store = createBlobStore({ token: rwToken, storeId: 'store_Unused', oidcToken: () => 'unused' });

  const ticket = await store.uploadTicket({ pathname: PATHNAME, size: 5, validUntil: Date.now() + 60 * 60 * 1000 });
  assert.deepEqual(api.kinds(), ['put-server', 'delete']);
  for (const request of api.requests) assert.equal(request.headers.authorization, `Bearer ${rwToken}`);
  assert.match(ticket.headers.authorization, /^Bearer vercel_blob_client_OldStore9_/);
  assert.equal(ticket.headers['x-vercel-blob-store-id'], 'OldStore9');
  assert.equal(ticket.headers['x-vercel-blob-access'], 'public');
  assert.equal(ticket.url, `${BLOB_API_URL}/?pathname=${encodeURIComponent(PATHNAME)}`);

  const target = ticket.url.replace(BLOB_API_URL, api.base);
  assert.equal((await browserPut(target, ticket.headers, 'too long')).status, 400);
  assert.equal((await browserPut(target, ticket.headers, 'hello')).status, 200);
  assert.equal((await store.head(PATHNAME)).size, 5);
  await store.del([PATHNAME]);
  assert.deepEqual(api.pathnames(), []);
});

test('신원 토큰은 요청 머리글 → Vercel의 요청 문맥 → 환경 변수 순으로 찾고, 요청끼리 섞이지 않는다', async () => {
  const symbol = Symbol.for('@vercel/request-context');
  const savedContext = globalThis[symbol];
  const savedEnv = process.env.VERCEL_OIDC_TOKEN;
  try {
    delete globalThis[symbol];
    delete process.env.VERCEL_OIDC_TOKEN;
    assert.equal(oidcTokenOf({ headers: {} }), '');
    assert.equal(oidcTokenOf(null), '');
    assert.equal(currentOidcToken(), '');

    process.env.VERCEL_OIDC_TOKEN = 'from-env';
    assert.equal(oidcTokenOf({ headers: {} }), 'from-env');
    globalThis[symbol] = { get: () => ({ headers: { 'x-vercel-oidc-token': 'from-context' } }) };
    assert.equal(oidcTokenOf({ headers: {} }), 'from-context');
    assert.equal(currentOidcToken(), 'from-context');
    assert.equal(oidcTokenOf({ headers: { 'x-vercel-oidc-token': 'from-header' } }), 'from-header');
    globalThis[symbol] = {
      get() {
        throw new Error('broken');
      },
    };
    assert.equal(oidcTokenOf({ headers: {} }), 'from-env');

    // 동시에 처리되는 요청마다 자기 토큰을 본다
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((name, index) =>
        withRequest({ headers: { 'x-vercel-oidc-token': `token-${name}` } }, async () => {
          await sleep((3 - index) * 5);
          return currentOidcToken();
        })
      )
    );
    assert.deepEqual(seen, ['token-a', 'token-b', 'token-c']);
  } finally {
    if (savedContext === undefined) delete globalThis[symbol];
    else globalThis[symbol] = savedContext;
    if (savedEnv === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = savedEnv;
  }
});

test('설정: Blob 연결 방식과 저장소 관련 환경 변수 이름', () => {
  const modern = loadVercelConfig({ BLOB_STORE_ID: 'store_abc', BLOB_WEBHOOK_PUBLIC_KEY: 'key' });
  assert.equal(modern.blobStoreId, 'store_abc');
  assert.equal(modern.blobToken, '');
  assert.equal(modern.blobAccess, '');
  assert.equal(modern.build, '');
  const legacy = loadVercelConfig({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y', BLOB_ACCESS: 'Private', VERCEL_GIT_COMMIT_SHA: '0f275701c2aa' + '0'.repeat(28) });
  assert.equal(legacy.blobToken, 'vercel_blob_rw_x_y');
  assert.equal(legacy.blobAccess, 'private');
  assert.equal(legacy.build, '0f27570');
  assert.equal(loadVercelConfig({ BLOB_ACCESS: 'whatever', VERCEL_GIT_COMMIT_SHA: 'not a sha' }).blobAccess, '');
  assert.equal(loadVercelConfig({ VERCEL_GIT_COMMIT_SHA: 'not a sha' }).build, '');

  // 이름만 내놓는다 (값은 내놓지 않음). 저장소와 무관한 것은 빼고, 가나다순
  const env = {
    KV_REST_API_URL: 'https://secret.example',
    KV_REST_API_TOKEN: 'secret-token',
    REDIS_URL: 'rediss://secret',
    BLOB_STORE_ID: 'store_secret',
    STORAGE_KV_REST_API_URL: 'x',
    TEACHER_PASSWORD: 'pw',
    TURSO_AUTH_TOKEN: 'secret',
    VERCEL_BLOB_RETRIES: '2',
    PATH: '/usr/bin',
    blob_lowercase: 'x',
  };
  const names = storageVariableNames(env);
  assert.deepEqual(names, ['BLOB_STORE_ID', 'KV_REST_API_TOKEN', 'KV_REST_API_URL', 'REDIS_URL', 'STORAGE_KV_REST_API_URL']);
  assert.ok(!JSON.stringify(names).includes('secret'));
});

// ---------------------------------------------------------------- 함수 진입점 (api/index.js) 전체 흐름

function freshEntry(env) {
  const names = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'BLOB_ACCESS', 'REDIS_URL', 'KV_URL', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_OIDC_TOKEN', 'TEACHER_PASSWORD', 'ADMIN_PASSWORD'];
  const saved = {};
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../api/index.js')];
  const fn = require('../api/index.js');
  return {
    fn,
    restore() {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      delete require.cache[require.resolve('../api/index.js')];
    },
  };
}

async function request(base, method, pathname, { token, json, headers } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json) });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  return { status: res.status, data };
}

test('함수 진입점(BLOB_STORE_ID 방식): 요청과 함께 온 신원 토큰으로 파일을 올리고 지운다', { skip }, async (t) => {
  const upstash = await startFakeUpstash();
  const api = await startFakeBlobApi({ storeId: 'E2EStore', oidcToken: 'oidc-from-vercel' });
  const entry = freshEntry({
    KV_REST_API_URL: upstash.base,
    KV_REST_API_TOKEN: 'redis-token',
    BLOB_STORE_ID: 'store_E2EStore',
    TEACHER_PASSWORD: 'room-pass',
    VERCEL_GIT_COMMIT_SHA: 'abc1234' + '0'.repeat(33),
  });
  const server = http.createServer(entry.fn);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    entry.restore();
    await api.close();
    await upstash.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const oidc = { 'x-vercel-oidc-token': 'oidc-from-vercel' };

  const config = await request(base, 'GET', '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.data.upload, 'blob');
  assert.equal(config.data.build, 'abc1234');

  assert.equal(config.data.requirePassword, true);

  const room = (await request(base, 'POST', '/api/rooms', { json: { name: '진입점 확인', password: 'room-pass' } })).data;
  assert.match(room.code, /^\d{6}$/);
  const upload = `/api/rooms/${room.code}/upload`;

  // 신원 토큰 없이 온 요청은 저장소에 접속할 수 없다 → 원인을 알 수 있는 오류
  const denied = await request(base, 'POST', upload, { token: room.token, json: { name: 'a.txt', size: 5 } });
  assert.equal(denied.status, 503);
  assert.equal(denied.data.error, 'storage_auth');
  assert.match(denied.data.detail, /OIDC/);
  assert.equal(api.requests.length, 0);

  // Vercel이 요청마다 넣어 주는 머리글이 있으면 그 토큰으로 접속한다
  const ticket = await request(base, 'POST', upload, { token: room.token, headers: oidc, json: { name: '활동지.txt', size: 5 } });
  assert.equal(ticket.status, 200);
  assert.equal(ticket.data.headers.authorization, undefined);
  assert.equal(ticket.data.headers['x-vercel-blob-store-id'], 'E2EStore');
  assert.deepEqual(api.kinds(), ['put-server', 'delete', 'signed-token']);
  // 저장소 종류는 Redis에 적어 둔다
  assert.equal(await upstash.kv.cmd('GET', 'cfg:blob-access:E2EStore'), 'public');

  assert.equal((await browserPut(ticket.data.uploadUrl, ticket.data.headers, 'hello')).status, 200);
  const added = await request(base, 'POST', `/api/rooms/${room.code}/files`, { token: room.token, headers: oidc, json: { id: ticket.data.id } });
  assert.equal(added.status, 201);
  assert.equal(added.data.item.name, '활동지.txt');
  assert.equal(added.data.item.size, 5);
  assert.match(added.data.item.url, /^https:\/\/e2estore\.public\.blob\.vercel-storage\.com\/rooms\/.*\?download=1$/);
  assert.equal(api.pathnames().length, 1);

  // 학생이 보는 목록에 올라와 있다
  const seen = await request(base, 'GET', `/api/rooms/${room.code}`);
  assert.equal(seen.data.items.length, 1);
  assert.equal(seen.data.items[0].name, '활동지.txt');

  // 수업방을 지우면 저장소의 파일도 지워진다
  assert.equal((await request(base, 'DELETE', `/api/rooms/${room.code}`, { token: room.token, headers: oidc })).status, 200);
  assert.deepEqual(api.pathnames(), []);
});

test('함수 진입점: 저장소가 연결되지 않았으면 무엇이 빠졌는지(이름만) 알려 준다', async () => {
  const ask = (fn) =>
    new Promise((resolve) => {
      const res = {
        setHeader() {},
        end(data) {
          resolve({ status: this.statusCode, data: JSON.parse(data), text: String(data) });
        },
      };
      fn({ method: 'GET', url: '/api/config', headers: {} }, res);
    });

  // 아무것도 전달되지 않은 배포 (저장소를 연결하기 전에 만든 배포)
  let entry = freshEntry({});
  let out = await ask(entry.fn);
  entry.restore();
  assert.equal(out.status, 503);
  assert.equal(out.data.error, 'not_configured');
  assert.match(out.data.message, /Redis/);
  assert.match(out.data.message, /Blob/);
  assert.deepEqual(out.data.seen, []);
  assert.match(out.data.hint, /하나도 전달되지 않았습니다/);

  // Redis만 연결된 배포
  entry = freshEntry({ KV_REST_API_URL: 'https://redis.example.invalid', KV_REST_API_TOKEN: 'super-secret-value', REDIS_URL: 'rediss://secret-too' });
  out = await ask(entry.fn);
  entry.restore();
  assert.equal(out.status, 503);
  assert.doesNotMatch(out.data.message, /Redis/);
  assert.match(out.data.message, /BLOB_STORE_ID/);
  assert.deepEqual(out.data.seen, ['KV_REST_API_TOKEN', 'KV_REST_API_URL', 'REDIS_URL']);
  assert.match(out.data.hint, /Storage/);
  assert.ok(!out.text.includes('secret')); // 값은 어디에도 나오지 않는다
});
