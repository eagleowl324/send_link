'use strict';

// 관리자 기능(Vercel용) 테스트: 처음 설정, 로그인, 수업방 만들기 비밀번호, 수업방 목록·삭제, 처음 상태로 되돌리기.
// Redis와 파일 저장소는 메모리로 흉내 낸 것을 씁니다.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { loadVercelConfig } = require('../src/vercel/config');
const { createHandler } = require('../src/vercel/handler');
const { hashPassword, verifyPassword, SESSION_SEC } = require('../src/vercel/settings');
const { createFakeKv } = require('./fake-kv');
const { createFakeBlob } = require('./fake-blob');

const ADMIN_PW = '관리자 비밀번호 1234';
const ROOM_PW = '3-2반';

// 아무것도 정하지 않은 새 사이트
async function boot(t, env = {}, kvOptions = {}) {
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const kv = createFakeKv(Object.assign({ now }, kvOptions));
  const blob = createFakeBlob({ now, baseUrl: 'https://blob.example' });
  const config = loadVercelConfig(env);
  const handler = createHandler({ kv, blob, config, now });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, kv, blob, config, clock };
}

async function call(base, method, pathname, { token, json, headers } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = null;
  }
  return { status: res.status, headers: res.headers, data, text };
}

// 처음 설정을 마친 사이트: 관리자 로그인 토큰을 돌려준다
async function setUp(ctx, teacher = { mode: 'password', password: ROOM_PW }) {
  const made = await call(ctx.base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW } });
  assert.equal(made.status, 201);
  if (teacher) {
    assert.equal((await call(ctx.base, 'PUT', '/api/admin/teacher', { token: made.data.token, json: teacher })).status, 200);
  }
  return made.data.token;
}

async function makeRoom(ctx, name, password = ROOM_PW) {
  const res = await call(ctx.base, 'POST', '/api/rooms', { json: { name, password } });
  assert.equal(res.status, 201);
  return res.data;
}

async function uploadFile(ctx, room, name, data) {
  const ticket = await call(ctx.base, 'POST', `/api/rooms/${room.code}/upload`, { token: room.token, json: { name, size: data.length } });
  assert.equal(ticket.status, 200);
  assert.equal(ctx.blob.upload(ticket.data, data).status, 200);
  const added = await call(ctx.base, 'POST', `/api/rooms/${room.code}/files`, { token: room.token, json: { id: ticket.data.id } });
  assert.equal(added.status, 201);
  return added.data.item;
}

test('비밀번호 해시: 같은 글자를 다르게 조합해 넣어도 통과하고, 저장된 값에서 비밀번호를 알 수 없다', async () => {
  const stored = await hashPassword('가나다 café');
  assert.match(stored, /^s1\$[\w-]+\$[\w-]+$/);
  assert.ok(!stored.includes('café'));
  assert.equal(await verifyPassword('가나다 café', stored), true);
  assert.equal(await verifyPassword('가나다 café'.normalize('NFD'), stored), true); // 기기에 따라 풀어서 들어오는 경우
  assert.equal(await verifyPassword('가나다 cafe', stored), false);
  assert.equal(await verifyPassword('', stored), false);
  assert.notEqual(await hashPassword('가나다 café'), stored); // 매번 다른 소금
  for (const broken of ['', 'plain', 's1$$', 's1$abc$def', 's2$abc$def', null, undefined]) {
    assert.equal(await verifyPassword('x', broken), false);
  }
});

test('관리자: 새 사이트는 설정을 마치기 전까지 수업방을 만들 수 없다 → 처음 설정 → 비밀번호 정하기', async (t) => {
  const ctx = await boot(t);
  const { base, kv } = ctx;

  // 아무것도 정하지 않은 상태
  const config = await call(base, 'GET', '/api/config');
  assert.equal(config.data.admin, true);
  assert.equal(config.data.setupRequired, true);
  assert.equal(config.data.requirePassword, false);
  assert.equal(config.headers.get('cache-control'), 'no-store'); // 설정 전의 답은 캐시하지 않는다
  assert.equal(config.headers.get('cdn-cache-control'), null);
  const blocked = await call(base, 'POST', '/api/rooms', { json: { name: '아직' } });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.data.error, 'setup_required');
  assert.deepEqual((await call(base, 'GET', '/api/admin')).data, { configured: false, needsProof: false, setupRequired: true, signedIn: false });
  assert.equal((await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW } })).data.error, 'admin_not_set');

  // 관리자 비밀번호 만들기: 너무 짧으면 받지 않고, 동시에 여러 번 와도 한 번만 성공한다
  for (const password of ['', 'short', 1234567890, null, 'x'.repeat(201)]) {
    assert.equal((await call(base, 'POST', '/api/admin/setup', { json: { password } })).data.error, 'weak_password');
  }
  const race = await Promise.all([1, 2, 3, 4, 5].map((n) => call(base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW + n } })));
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  const winner = race.findIndex((r) => r.status === 201) + 1;
  const token = race[winner - 1].data.token;
  assert.ok(race[winner - 1].data.expiresAt > ctx.clock.now);
  assert.equal((await call(base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW } })).data.error, 'already_configured');

  // 관리자는 정해졌지만 수업방 만들기 비밀번호를 아직 고르지 않았다 → 여전히 만들 수 없다
  assert.deepEqual((await call(base, 'GET', '/api/admin', { token })).data, { configured: true, needsProof: false, setupRequired: true, signedIn: true });
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: '아직' } })).status, 503);
  const before = (await call(base, 'GET', '/api/admin/overview', { token })).data;
  assert.deepEqual(before.teacher, { mode: 'unset', source: null, at: null });
  assert.equal(before.admin.source, 'stored');
  assert.deepEqual(before.rooms, []);

  // 수업방 만들기 비밀번호 정하기
  for (const password of ['', 'abc', null]) {
    assert.equal((await call(base, 'PUT', '/api/admin/teacher', { token, json: { mode: 'password', password } })).data.error, 'weak_password');
  }
  assert.equal((await call(base, 'PUT', '/api/admin/teacher', { token, json: { mode: 'whatever' } })).status, 400);
  const set = await call(base, 'PUT', '/api/admin/teacher', { token, json: { mode: 'password', password: ROOM_PW } });
  assert.equal(set.status, 200);
  assert.equal(set.data.teacher.mode, 'password');
  assert.equal(set.data.teacher.source, 'stored');

  const ready = await call(base, 'GET', '/api/config');
  assert.equal(ready.data.setupRequired, false);
  assert.equal(ready.data.requirePassword, true);
  assert.match(ready.headers.get('cdn-cache-control'), /s-maxage=60/);
  for (const password of [undefined, '', 'wrong', ROOM_PW + ' ', ADMIN_PW + winner]) {
    assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password } })).data.error, 'bad_password');
  }
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: '3학년 2반', password: ROOM_PW } })).status, 201);

  // 비밀번호 없이 누구나 만들 수 있게 바꾸기
  assert.equal((await call(base, 'PUT', '/api/admin/teacher', { token, json: { mode: 'open' } })).data.teacher.mode, 'open');
  assert.equal((await call(base, 'GET', '/api/config')).data.requirePassword, false);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: '열린 방' } })).status, 201);

  // Redis에는 해시만 남는다
  const stored = JSON.stringify(await kv.cmd('MGET', 'cfg:admin', 'cfg:teacher'));
  assert.ok(!stored.includes(ADMIN_PW) && !stored.includes(ROOM_PW));
  assert.ok(!kv.keys().some((key) => key.includes(token)));
});

test('관리자: 로그인·로그아웃·만료·비밀번호 바꾸기', async (t) => {
  const ctx = await boot(t);
  const { base, clock } = ctx;
  const first = await setUp(ctx);

  // 로그인하지 않으면 아무것도 볼 수 없다
  for (const token of [undefined, 'x', 'wrong-token-wrong-token-wrong', first + 'x']) {
    assert.equal((await call(base, 'GET', '/api/admin/overview', { token })).status, 401);
    assert.equal((await call(base, 'PUT', '/api/admin/teacher', { token, json: { mode: 'open' } })).status, 401);
    assert.equal((await call(base, 'PUT', '/api/admin/password', { token, json: { current: ADMIN_PW, next: 'another-password' } })).status, 401);
    assert.equal((await call(base, 'DELETE', '/api/admin/rooms/123456', { token })).status, 401);
    assert.equal((await call(base, 'DELETE', '/api/admin', { token, json: { password: ADMIN_PW } })).status, 401);
    assert.equal((await call(base, 'GET', '/api/admin/nothing', { token })).status, 401);
  }
  assert.equal((await call(base, 'GET', '/api/admin/nothing', { token: first })).status, 404);
  assert.equal((await call(base, 'POST', '/api/admin/overview', { token: first })).status, 405);
  // 다른 사이트가 방문자의 브라우저를 시켜 보낸 요청은 받지 않는다
  const cross = await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.data.error, 'cross_site');
  // 관리자 응답은 캐시되지 않는다
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: first })).headers.get('cache-control'), 'no-store');

  const wrong = await call(base, 'POST', '/api/admin/login', { json: { password: ROOM_PW } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.error, 'bad_password');
  const login = await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW } });
  assert.equal(login.status, 200);
  const second = login.data.token;
  assert.notEqual(second, first);
  assert.equal(login.data.expiresAt, clock.now + SESSION_SEC * 1000);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: second })).status, 200);

  // 로그아웃하면 그 토큰만 풀린다
  assert.equal((await call(base, 'POST', '/api/admin/logout', { token: second })).status, 200);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: second })).status, 401);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: first })).status, 200);
  assert.equal((await call(base, 'POST', '/api/admin/logout')).status, 200);

  // 비밀번호 바꾸기: 지금 비밀번호를 알아야 하고, 바꾸면 이전 로그인은 모두 풀린다
  const other = (await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW } })).data.token;
  assert.equal((await call(base, 'PUT', '/api/admin/password', { token: first, json: { current: 'nope', next: 'brand-new-password' } })).data.error, 'bad_password');
  assert.equal((await call(base, 'PUT', '/api/admin/password', { token: first, json: { current: ADMIN_PW, next: 'short' } })).data.error, 'weak_password');
  const changed = await call(base, 'PUT', '/api/admin/password', { token: first, json: { current: ADMIN_PW, next: 'brand-new-password' } });
  assert.equal(changed.status, 200);
  const third = changed.data.token;
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: third })).status, 200);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: first })).status, 401);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: other })).status, 401);
  assert.equal((await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW } })).status, 403);
  assert.equal((await call(base, 'POST', '/api/admin/login', { json: { password: 'brand-new-password' } })).status, 200);

  // 12시간이 지나면 다시 로그인해야 한다
  clock.now += SESSION_SEC * 1000 + 1000;
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: third })).status, 401);
  assert.equal((await call(base, 'GET', '/api/admin', { token: third })).data.signedIn, false);
});

test('관리자: 비밀번호를 계속 틀리면 잠시 막힌다 (맞는 비밀번호도)', async (t) => {
  const ctx = await boot(t);
  const { base, clock } = ctx;
  await setUp(ctx);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await call(base, 'POST', '/api/admin/login', { json: { password: 'guess-' + i } })).status, 403);
  }
  const locked = await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW } });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('retry-after'), '600');
  // 수업방 만들기 쪽 제한과는 따로 센다
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: ROOM_PW } })).status, 201);
  clock.now += 10 * 60 * 1000 + 1000;
  assert.equal((await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW } })).status, 200);
});

test('관리자: 수업방 목록(최근에 쓴 순서)과 삭제', async (t) => {
  const ctx = await boot(t, {}, { scanPage: 4 }); // Redis가 목록을 여러 번에 나눠 돌려주는 상황
  const { base, blob, clock, kv } = ctx;
  await setUp(ctx);
  const day = 24 * 60 * 60 * 1000;

  const old = await makeRoom(ctx, '오래된 방');
  await call(base, 'POST', `/api/rooms/${old.code}/items`, { token: old.token, json: { text: '글 하나' } });
  clock.now += 3 * day;
  const busy = await makeRoom(ctx, '  쓰는\n방 ');
  await call(base, 'POST', `/api/rooms/${busy.code}/items`, { token: busy.token, json: { text: 'naver.com' } });
  await uploadFile(ctx, busy, '활동지.pdf', Buffer.from('12345'));
  await uploadFile(ctx, busy, '사진.png', Buffer.from('1234567'));
  const key = (await call(base, 'GET', `/api/rooms/${busy.code}`)).data.key;
  for (const c of ['student-1', 'student-2', 'student-3']) {
    await call(base, 'POST', `/api/rooms/${busy.code}/here?k=${key}`, { json: { c, t: 120 } });
  }
  clock.now += 1000;
  const empty = await makeRoom(ctx, '');
  // 수업방이 아닌 키가 섞여 있어도 목록에 나오지 않는다
  await kv.cmd('SET', 'r:abcdef', 'not a room');
  await kv.cmd('HSET', 'r:999999', 'c', clock.now); // 만드는 도중인 방 (권한 정보 없음)

  // (처음 설정 때의 로그인은 며칠이 지나 풀렸으므로 다시 로그인)
  const token = (await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW } })).data.token;
  const view = (await call(base, 'GET', '/api/admin/overview', { token })).data;
  assert.equal(view.totalRooms, 3);
  assert.deepEqual(
    view.rooms.map((r) => [r.code, r.name, r.items, r.bytes, r.viewers]),
    [
      [empty.code, '', 0, 0, 0],
      [busy.code, '쓰는 방', 3, 12, 3],
      [old.code, '오래된 방', 1, 0, 0],
    ]
  );
  const [, busyRow, oldRow] = view.rooms;
  assert.equal(oldRow.createdAt, clock.now - 3 * day - 1000);
  assert.equal(oldRow.usedAt, oldRow.createdAt); // 만든 뒤 글을 올린 때가 마지막
  assert.equal(oldRow.expiresAt, oldRow.usedAt + ctx.config.roomTtlMs);
  assert.equal(busyRow.usedAt, clock.now - 1000);
  assert.ok(!JSON.stringify(view).includes(busy.token)); // 선생님 권한이나 열쇠는 내놓지 않는다
  assert.ok(!JSON.stringify(view).includes(key));
  assert.deepEqual(view.status, { build: null, cleanupAt: null, maxFileBytes: 50 * 1024 * 1024, maxRoomBytes: 200 * 1024 * 1024, roomTtlMs: 14 * day });

  // 삭제: 파일까지 지워지고, 학생 화면에서는 없는 방이 된다
  assert.equal(blob.pathnames().length, 2);
  assert.deepEqual((await call(base, 'DELETE', `/api/admin/rooms/${busy.code}`, { token })).data, { ok: true, removed: true });
  assert.deepEqual(blob.pathnames(), []);
  assert.equal((await call(base, 'GET', `/api/rooms/${busy.code}?k=${key}`)).status, 404);
  assert.equal((await call(base, 'GET', `/api/rooms/${busy.code}/poll?k=${key}`)).status, 404);
  assert.deepEqual((await call(base, 'DELETE', `/api/admin/rooms/${busy.code}`, { token })).data, { ok: true, removed: false });
  assert.equal((await call(base, 'DELETE', '/api/admin/rooms/12345', { token })).status, 404);
  assert.equal((await call(base, 'GET', `/api/admin/rooms/${old.code}`, { token })).status, 405);

  // 오래 쓰지 않아 사라진 방은 목록에서도 빠진다
  clock.now += 12 * day;
  const later = (await call(base, 'POST', '/api/admin/login', { json: { password: ADMIN_PW } })).data.token;
  const after = (await call(base, 'GET', '/api/admin/overview', { token: later })).data;
  assert.deepEqual(after.rooms.map((r) => r.code), [empty.code]);
  assert.equal(after.totalRooms, 1);

  // 정리 작업이 돌면 그 시각이 보인다
  assert.equal((await call(base, 'GET', '/api/cron/cleanup')).status, 200);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: later })).data.status.cleanupAt, clock.now);
});

test('관리자: 수업방 목록을 읽지 못해도 관리 화면의 나머지는 쓸 수 있다', async (t) => {
  const ctx = await boot(t);
  const { base, kv } = ctx;
  const token = await setUp(ctx);
  await makeRoom(ctx, '보이지 않을 방');
  const original = kv.cmd;
  kv.cmd = async (...args) => {
    if (args[0] === 'SCAN') throw new Error('ERR scan is not available');
    return original(...args);
  };
  const view = await call(base, 'GET', '/api/admin/overview', { token });
  assert.equal(view.status, 200);
  assert.deepEqual(view.data.rooms, []);
  assert.match(view.data.roomsError, /scan is not available/);
  assert.equal(view.data.teacher.mode, 'password');
  assert.equal((await call(base, 'PUT', '/api/admin/teacher', { token, json: { mode: 'open' } })).status, 200);
  kv.cmd = original;
  const ok = (await call(base, 'GET', '/api/admin/overview', { token })).data;
  assert.equal(ok.roomsError, null);
  assert.equal(ok.rooms.length, 1);
});

test('관리자: 처음 상태로 되돌리기', async (t) => {
  const ctx = await boot(t);
  const { base } = ctx;
  const token = await setUp(ctx);
  const room = await makeRoom(ctx, '남는 방');

  assert.equal((await call(base, 'DELETE', '/api/admin', { token, json: { password: 'wrong' } })).data.error, 'bad_password');
  assert.equal((await call(base, 'DELETE', '/api/admin', { token, json: {} })).status, 403);
  assert.deepEqual((await call(base, 'DELETE', '/api/admin', { token, json: { password: ADMIN_PW } })).data, { ok: true });

  // 비밀번호 두 가지가 모두 지워지고, 로그인도 풀린다. 수업방은 그대로 남는다
  assert.deepEqual((await call(base, 'GET', '/api/admin', { token })).data, { configured: false, needsProof: false, setupRequired: true, signedIn: false });
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token })).status, 401);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: ROOM_PW } })).data.error, 'setup_required');
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data.isHost, true);

  // 다시 처음 설정을 할 수 있다
  const again = await call(base, 'POST', '/api/admin/setup', { json: { password: 'second-owner-password' } });
  assert.equal(again.status, 201);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: again.data.token })).data.rooms.length, 1);
});

test('관리자: 환경 변수의 관리자 비밀번호는 화면에서 바꿀 수 없고, 수업방 만들기 비밀번호는 화면에서 정한 것이 우선한다', async (t) => {
  const ctx = await boot(t, { ADMIN_PASSWORD: 'env-admin-password', TEACHER_PASSWORD: 'env-room' });
  const { base } = ctx;
  assert.deepEqual((await call(base, 'GET', '/api/admin')).data, { configured: true, needsProof: false, setupRequired: false, signedIn: false });
  assert.equal((await call(base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW } })).data.error, 'already_configured');
  assert.equal((await call(base, 'POST', '/api/admin/login', { json: { password: 'env-room' } })).status, 403);
  const token = (await call(base, 'POST', '/api/admin/login', { json: { password: 'env-admin-password' } })).data.token;
  const view = (await call(base, 'GET', '/api/admin/overview', { token })).data;
  assert.deepEqual(view.teacher, { mode: 'password', source: 'env', at: null });
  assert.deepEqual(view.admin, { source: 'env', at: null });
  assert.equal(
    (await call(base, 'PUT', '/api/admin/password', { token, json: { current: 'env-admin-password', next: 'another-password' } })).data.error,
    'fixed_by_env'
  );
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: 'env-room' } })).status, 201);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: 'env-admin-password' } })).status, 403);

  // 화면에서 새로 정하면 그 비밀번호를 쓰고, 환경 변수의 것은 더 이상 통하지 않는다
  const set = await call(base, 'PUT', '/api/admin/teacher', { token, json: { mode: 'password', password: ROOM_PW } });
  assert.deepEqual([set.data.teacher.mode, set.data.teacher.source], ['password', 'stored']);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: 'env-room' } })).status, 403);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: ROOM_PW } })).status, 201);
  // 비밀번호 없이 허용하는 것도 화면에서 정한 대로
  assert.equal((await call(base, 'PUT', '/api/admin/teacher', { token, json: { mode: 'open' } })).data.teacher.mode, 'open');
  assert.equal((await call(base, 'GET', '/api/config')).data.requirePassword, false);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x' } })).status, 201);

  // 처음 상태로 되돌리면 다시 환경 변수의 비밀번호를 쓴다 (관리자 비밀번호는 환경 변수 그대로)
  assert.equal((await call(base, 'DELETE', '/api/admin', { token, json: { password: 'env-admin-password' } })).status, 200);
  assert.equal((await call(base, 'GET', '/api/config')).data.requirePassword, true);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x' } })).status, 403);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: 'env-room' } })).status, 201);
  const back = (await call(base, 'POST', '/api/admin/login', { json: { password: 'env-admin-password' } })).data.token;
  assert.deepEqual((await call(base, 'GET', '/api/admin/overview', { token: back })).data.teacher, { mode: 'password', source: 'env', at: null });
});

test('관리자: 이미 수업방 만들기 비밀번호가 있는 사이트에서는 그것을 아는 사람만 관리자가 될 수 있다', async (t) => {
  const ctx = await boot(t, { TEACHER_PASSWORD: 'env-room' });
  const { base } = ctx;
  // 전처럼 바로 쓸 수 있다 (환경 변수만으로 운영하던 사이트)
  assert.equal((await call(base, 'GET', '/api/config')).data.setupRequired, false);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: 'env-room' } })).status, 201);
  assert.deepEqual((await call(base, 'GET', '/api/admin')).data, { configured: false, needsProof: true, setupRequired: false, signedIn: false });

  assert.equal((await call(base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW } })).data.error, 'bad_password');
  assert.equal((await call(base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW, proof: 'guess' } })).data.error, 'bad_password');
  assert.equal((await call(base, 'GET', '/api/admin')).data.configured, false);
  const made = await call(base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW, proof: 'env-room' } });
  assert.equal(made.status, 201);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token: made.data.token })).status, 200);

  // 틀린 시도가 쌓이면 막힌다
  const other = await boot(t, { TEACHER_PASSWORD: 'env-room' });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await call(other.base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW, proof: 'guess-' + i } })).status, 403);
  }
  assert.equal((await call(other.base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW, proof: 'env-room' } })).status, 429);
});

test('관리자: 관리자가 없는데 누구나 만들 수 있는 상태로는 열리지 않는다', async (t) => {
  const ctx = await boot(t);
  const { base, kv } = ctx;
  // (누군가 Redis에서 관리자 기록만 지운 경우)
  await kv.cmd('SET', 'cfg:teacher', JSON.stringify({ mode: 'open', at: 1 }));
  assert.equal((await call(base, 'GET', '/api/config')).data.setupRequired, true);
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { name: 'x' } })).data.error, 'setup_required');
  const token = (await call(base, 'POST', '/api/admin/setup', { json: { password: ADMIN_PW } })).data.token;
  assert.equal((await call(base, 'GET', '/api/config')).data.setupRequired, false);
  assert.equal((await call(base, 'GET', '/api/admin/overview', { token })).data.teacher.mode, 'open');
  // 읽을 수 없는 기록은 없는 것으로 본다
  await kv.cmd('SET', 'cfg:teacher', 'not json');
  assert.equal((await call(base, 'GET', '/api/config')).data.setupRequired, true);
  await kv.cmd('SET', 'cfg:teacher', JSON.stringify({ mode: 'password' }));
  assert.equal((await call(base, 'GET', '/api/config')).data.setupRequired, true);
});
