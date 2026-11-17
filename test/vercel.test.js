'use strict';

// Vercel용 API 처리기 테스트. Redis와 파일 저장소는 메모리로 흉내 낸 것을 씁니다.
// (실제 Vercel·Upstash·Blob에서만 확인할 수 있는 것은 README의 "배포 후 확인할 것" 참고)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { loadVercelConfig } = require('../src/vercel/config');
const { createHandler } = require('../src/vercel/handler');
const { createFakeKv } = require('./fake-kv');
const { createFakeBlob } = require('./fake-blob');

async function boot(t, overrides = {}, env = {}) {
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const kv = createFakeKv({ now });
  const blob = createFakeBlob({ now, baseUrl: 'https://blob.example' });
  const config = Object.assign(loadVercelConfig(Object.assign({ CRON_SECRET: 'cron-secret-value' }, env)), overrides);
  const handler = createHandler({ kv, blob, config, now });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, kv, blob, config, clock };
}

async function call(base, method, pathname, { token, json, headers, body } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  let payload = body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(base + pathname, { method, headers: h, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = null;
  }
  return { status: res.status, headers: res.headers, data, text };
}

async function makeRoom(base, name = '테스트 수업방', password) {
  const res = await call(base, 'POST', '/api/rooms', { json: { name, password } });
  assert.equal(res.status, 201);
  return res.data;
}

// 브라우저가 하는 세 단계: 허가증 받기 → 저장소에 직접 올리기 → 등록
async function uploadFile(ctx, room, name, data, token = room.token) {
  const ticket = await call(ctx.base, 'POST', `/api/rooms/${room.code}/upload`, { token, json: { name, size: data.length } });
  if (ticket.status !== 200) return ticket;
  const stored = ctx.blob.upload(ticket.data, data);
  assert.equal(stored.status, 200);
  return call(ctx.base, 'POST', `/api/rooms/${room.code}/files`, { token, json: { id: ticket.data.id } });
}

test('Vercel: 설정', async (t) => {
  const { base } = await boot(t, {}, { SITE_NAME: '우리반', TEACHER_PASSWORD: 'pw' });
  const res = await call(base, 'GET', '/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.data.siteName, '우리반');
  assert.equal(res.data.transport, 'poll');
  assert.equal(res.data.upload, 'blob');
  assert.equal(res.data.requirePassword, true);
  assert.equal(res.data.cleanup, true);
  assert.equal(res.data.pollMs, 3000);
  assert.deepEqual(res.data.lanUrls, []);
  assert.match(res.headers.get('cdn-cache-control'), /s-maxage=60/);
  assert.equal((await call(base, 'POST', '/api/config')).status, 405);
  assert.equal((await call(base, 'GET', '/api/nope')).status, 404);

  // 비밀번호와 정리 작업용 값을 등록하지 않은 배포는 설정에서 바로 드러난다
  const open = await boot(t, { teacherPassword: '', cronSecret: '' });
  const bare = (await call(open.base, 'GET', '/api/config')).data;
  assert.equal(bare.requirePassword, false);
  assert.equal(bare.cleanup, false);
});

test('Vercel: 빌드는 화면과 함께 배포 시각(version.json)을 만든다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { build } = require('../scripts/build-vercel');
  const before = Date.now();
  const out = build({ SITE_NAME: '우리 <반>', VERCEL_GIT_COMMIT_SHA: 'abc1234' + '0'.repeat(33) });
  const version = JSON.parse(fs.readFileSync(path.join(out, 'version.json'), 'utf8'));
  assert.equal(version.commit, 'abc1234');
  assert.ok(Date.parse(version.builtAt) >= before - 1000 && Date.parse(version.builtAt) <= Date.now() + 1000);
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /우리 &#60;반&#62;/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(build({}), 'version.json'), 'utf8')).commit, null);
});

test('Vercel: 수업방 만들기 → 공유 → 수정 → 삭제', async (t) => {
  const ctx = await boot(t);
  const { base } = ctx;
  const room = await makeRoom(base, '  3학년\n2반   정보 ');
  assert.match(room.code, /^\d{6}$/);
  assert.equal(room.name, '3학년 2반 정보');

  const guest = (await call(base, 'GET', `/api/rooms/${room.code}`)).data;
  assert.equal(guest.isHost, false);
  assert.equal(guest.usedBytes, undefined);
  assert.equal(guest.viewers, undefined);
  assert.match(guest.key, /^[a-f0-9]{16}$/);
  assert.ok(!JSON.stringify(guest).includes(room.token));

  const host = (await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data;
  assert.equal(host.isHost, true);
  assert.equal(host.usedBytes, 0);
  assert.equal(host.viewers, 0);

  const items = `/api/rooms/${room.code}/items`;
  for (const token of [null, 'wrong-token-wrong-token-wrong', room.token + 'x']) {
    assert.equal((await call(base, 'POST', items, { token, json: { text: 'x' } })).status, 403);
    assert.equal((await call(base, 'DELETE', items, { token })).status, 403);
    assert.equal((await call(base, 'PATCH', `/api/rooms/${room.code}`, { token, json: { name: 'x' } })).status, 403);
    assert.equal((await call(base, 'DELETE', `/api/rooms/${room.code}`, { token })).status, 403);
    assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/upload`, { token, json: { name: 'a', size: 1 } })).status, 403);
    assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/files`, { token, json: { id: 'a'.repeat(32) } })).status, 403);
  }

  const link = await call(base, 'POST', items, { token: room.token, json: { text: ' naver.com ' } });
  assert.equal(link.status, 201);
  assert.equal(link.data.item.url, 'https://naver.com/');
  assert.equal(link.data.v, 1);
  ctx.clock.now += 10;
  const text = await call(base, 'POST', items, { token: room.token, json: { text: '과제 안내\r\n내일까지' } });
  assert.equal(text.data.item.text, '과제 안내\n내일까지');
  ctx.clock.now += 10;
  const code = await call(base, 'POST', items, { token: room.token, json: { text: 'https://example.com', mono: true } });
  assert.equal(code.data.item.type, 'text');
  assert.equal((await call(base, 'POST', items, { token: room.token, json: { text: '  ' } })).data.error, 'empty');
  assert.equal((await call(base, 'POST', items, { token: room.token, body: '{bad', headers: { 'Content-Type': 'application/json' } })).status, 400);

  let snap = (await call(base, 'GET', `/api/rooms/${room.code}`)).data;
  assert.deepEqual(snap.items.map((i) => i.type), ['link', 'text', 'text']); // 올린 순서
  assert.equal(snap.v, 3);

  const renamed = await call(base, 'PATCH', `/api/rooms/${room.code}`, { token: room.token, json: { name: '정보 3-2' } });
  assert.deepEqual(renamed.data, { v: 4, name: '정보 3-2' });

  const removed = await call(base, 'DELETE', `${items}/${link.data.item.id}`, { token: room.token });
  assert.deepEqual(removed.data, { v: 5, removed: true });
  assert.equal((await call(base, 'DELETE', `${items}/${link.data.item.id}`, { token: room.token })).data.removed, false);

  const cleared = await call(base, 'DELETE', items, { token: room.token });
  assert.equal(cleared.data.removed, 2);
  snap = (await call(base, 'GET', `/api/rooms/${room.code}`)).data;
  assert.deepEqual(snap.items, []);
  assert.equal(snap.name, '정보 3-2');

  assert.equal((await call(base, 'DELETE', `/api/rooms/${room.code}`, { token: room.token })).status, 200);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`)).status, 404);
  assert.deepEqual(ctx.kv.keys().filter((k) => k.startsWith('r:')), []);
});

test('Vercel: 바뀐 것 확인(poll)은 열쇠가 있을 때만 CDN이 함께 캐시한다', async (t) => {
  const ctx = await boot(t);
  const { base } = ctx;
  const room = await makeRoom(base);
  const snap = (await call(base, 'GET', `/api/rooms/${room.code}`)).data;

  const before = ctx.kv.commandCount();
  const keyed = await call(base, 'GET', `/api/rooms/${room.code}/poll?k=${snap.key}`);
  assert.equal(ctx.kv.commandCount() - before, 1); // Redis 명령 하나
  assert.deepEqual(keyed.data, { v: 0, boot: snap.boot });
  assert.match(keyed.headers.get('vercel-cdn-cache-control'), /s-maxage=2/);
  assert.match(keyed.headers.get('cache-control'), /max-age=0/);

  const bare = await call(base, 'GET', `/api/rooms/${room.code}/poll`);
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get('vercel-cdn-cache-control'), null);
  assert.equal(bare.headers.get('cache-control'), 'no-store');

  await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: '새 글' } });
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}/poll?k=${snap.key}`)).data.v, 1);

  // 전체 상태: 학생이 "이 번호의 상태"를 물으면 캐시할 수 있고, 선생님 요청이나 번호가 다르면 캐시하지 않는다
  const shared = await call(base, 'GET', `/api/rooms/${room.code}?k=${snap.key}&v=1`);
  assert.match(shared.headers.get('vercel-cdn-cache-control'), /s-maxage=60/);
  assert.equal(shared.data.isHost, false);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}?k=${snap.key}&v=0`)).headers.get('cache-control'), 'no-store');
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}?k=${snap.key}&v=1`, { token: room.token })).headers.get('cache-control'), 'no-store');
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}?v=1`)).headers.get('cache-control'), 'no-store');
});

test('Vercel: rewrite가 넘겨 준 경로(__path)와 미리 읽힌 본문도 처리한다', async (t) => {
  const ctx = await boot(t);
  const room = await makeRoom(ctx.base);
  const viaRewrite = await call(ctx.base, 'GET', `/api/index?__path=rooms/${room.code}/poll`);
  assert.equal(viaRewrite.status, 200);
  assert.equal(viaRewrite.data.v, 0);
  // 원래 주소가 그대로 온 경우에는 그 주소가 우선이고, 방문자가 끼워 넣은 __path는 무시한다
  const other = await makeRoom(ctx.base);
  await call(ctx.base, 'POST', `/api/rooms/${other.code}/items`, { token: other.token, json: { text: '다른 방' } });
  const mixed = await call(ctx.base, 'GET', `/api/rooms/${room.code}/poll?__path=rooms/${other.code}/poll`);
  assert.equal(mixed.status, 200);
  assert.equal(mixed.data.v, 0);
  assert.equal((await call(ctx.base, 'GET', '/api/index')).status, 404);

  // req.body 가 이미 채워져 오는 경우 (Vercel의 Node 도우미)
  const handler = createHandler({ kv: ctx.kv, blob: ctx.blob, config: ctx.config, now: () => ctx.clock.now });
  const run = (body) =>
    new Promise((resolve) => {
      const req = { method: 'POST', url: `/api/rooms/${room.code}/items`, headers: { authorization: 'Bearer ' + room.token }, body };
      const res = {
        headersSent: false,
        setHeader() {},
        end(data) {
          resolve({ status: this.statusCode, data: JSON.parse(String(data)) });
        },
      };
      handler(req, res);
    });
  assert.equal((await run({ text: '객체로 온 본문' })).status, 201);
  assert.equal((await run('{"text":"문자열로 온 본문"}')).status, 201);
  assert.equal((await run(Buffer.from('{"text":"버퍼로 온 본문"}'))).status, 201);
  assert.equal((await run('not json')).status, 400);
  assert.equal((await run(['배열'])).status, 400);
});

test('Vercel: 파일 올리기(허가증 → 직접 업로드 → 등록)와 삭제', async (t) => {
  const ctx = await boot(t, { maxFileBytes: 1000, maxRoomBytes: 2500 });
  const { base, blob } = ctx;
  const room = await makeRoom(base);
  const data = Buffer.from('파일 내용입니다');

  const ticket = await call(base, 'POST', `/api/rooms/${room.code}/upload`, {
    token: room.token,
    json: { name: '수업 자료 (3주차).pdf'.normalize('NFD'), size: data.length },
  });
  assert.equal(ticket.status, 200);
  const pathname = new URL(ticket.data.uploadUrl).searchParams.get('pathname');
  assert.match(pathname, new RegExp(`^rooms/${room.code}-[0-9a-z]+/[a-f0-9]{32}/수업 자료 \\(3주차\\)\\.pdf$`));
  assert.match(ticket.data.headers.authorization, /^Bearer vercel_blob_client_/);
  assert.deepEqual(Object.keys(ticket.data).sort(), ['headers', 'id', 'uploadUrl']);

  // 아직 올리지 않았는데 등록하려 하면 거절
  const early = await call(base, 'POST', `/api/rooms/${room.code}/files`, { token: room.token, json: { id: ticket.data.id } });
  assert.equal(early.status, 409);
  assert.equal(early.data.error, 'upload_missing');

  // 허가증은 그 경로, 그 크기까지만
  assert.equal(blob.upload(ticket.data, data, pathname + 'x').status, 403);
  assert.equal(blob.upload(ticket.data, Buffer.alloc(data.length + 1)).status, 413);
  assert.equal(blob.upload(ticket.data, data).status, 200);

  const added = await call(base, 'POST', `/api/rooms/${room.code}/files`, { token: room.token, json: { id: ticket.data.id } });
  assert.equal(added.status, 201);
  const item = added.data.item;
  assert.equal(item.name, '수업 자료 (3주차).pdf');
  assert.equal(item.size, data.length);
  assert.equal(item.kind, 'pdf');
  assert.ok(item.url.startsWith('https://blob.example/_blob/rooms/') && item.url.endsWith('?download=1'));
  assert.equal(item.openUrl, item.url.replace('?download=1', ''));
  assert.equal(item.path, undefined); // 저장 경로는 내보내지 않는다

  // 같은 허가증으로 다시 등록할 수 없다
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/files`, { token: room.token, json: { id: ticket.data.id } })).status, 404);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data.usedBytes, data.length);

  // 웹 페이지로 실행될 수 있는 형식은 "바로 열기"를 주지 않는다
  for (const [name, canOpen] of [['page.html', false], ['pic.svg', false], ['notes.txt', true], ['photo.png', true], ['a.zip', false]]) {
    const up = await uploadFile(ctx, room, name, Buffer.from('x'));
    assert.equal(up.status, 201, name);
    assert.equal(Boolean(up.data.item.openUrl), canOpen, name);
    await call(base, 'DELETE', `/api/rooms/${room.code}/items/${up.data.item.id}`, { token: room.token });
  }

  // 지우면 저장소에서도 사라진다
  assert.deepEqual(blob.pathnames(), [pathname]);
  await call(base, 'DELETE', `/api/rooms/${room.code}/items/${item.id}`, { token: room.token });
  assert.deepEqual(blob.pathnames(), []);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data.usedBytes, 0);

  // 한도
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/upload`, { token: room.token, json: { name: 'big', size: 1001 } })).data.error, 'file_too_large');
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/upload`, { token: room.token, json: { name: 'zero', size: 0 } })).data.error, 'empty_file');
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/upload`, { token: room.token, json: { name: 'x', size: -5 } })).status, 400);
  assert.equal((await uploadFile(ctx, room, 'a.bin', Buffer.alloc(1000))).status, 201);
  assert.equal((await uploadFile(ctx, room, 'b.bin', Buffer.alloc(1000))).status, 201);
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/upload`, { token: room.token, json: { name: 'c', size: 600 } })).data.error, 'room_full');

  // 수업방을 지우면 파일도 모두 지워진다
  assert.equal(blob.pathnames().length, 2);
  await call(base, 'DELETE', `/api/rooms/${room.code}`, { token: room.token });
  assert.deepEqual(blob.pathnames(), []);
});

test('Vercel: 허가증을 두 장 받아 한도를 넘기려 해도 등록 단계에서 막힌다', async (t) => {
  const ctx = await boot(t, { maxFileBytes: 1000, maxRoomBytes: 1500 });
  const room = await makeRoom(ctx.base);
  const ask = () => call(ctx.base, 'POST', `/api/rooms/${room.code}/upload`, { token: room.token, json: { name: 'f.bin', size: 1000 } });
  const [a, b] = [await ask(), await ask()]; // 둘 다 발급은 된다 (아직 아무것도 올라오지 않았으므로)
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  ctx.blob.upload(a.data, Buffer.alloc(1000));
  ctx.blob.upload(b.data, Buffer.alloc(1000));
  assert.equal((await call(ctx.base, 'POST', `/api/rooms/${room.code}/files`, { token: room.token, json: { id: a.data.id } })).status, 201);
  const second = await call(ctx.base, 'POST', `/api/rooms/${room.code}/files`, { token: room.token, json: { id: b.data.id } });
  assert.equal(second.status, 413);
  assert.equal(second.data.error, 'room_full');
  assert.deepEqual(ctx.blob.pathnames(), [new URL(a.data.uploadUrl).searchParams.get('pathname')]); // 거절된 파일은 저장소에서도 지운다
});

test('Vercel: 글·항목 수 한도', async (t) => {
  const ctx = await boot(t, { maxItems: 3, maxRoomTextBytes: 1000, maxTextBytes: 600 });
  const room = await makeRoom(ctx.base);
  const post = (text) => call(ctx.base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text } });
  assert.equal((await post('가'.repeat(150))).status, 201);
  assert.equal((await post('가'.repeat(201))).data.error, 'text_too_long');
  assert.equal((await post('나'.repeat(150))).status, 201);
  assert.equal((await post('다'.repeat(40))).data.error, 'text_full');
  assert.equal((await post('짧은 글')).status, 201);
  assert.equal((await post('하나 더')).data.error, 'too_many_items');
  assert.equal((await call(ctx.base, 'POST', `/api/rooms/${room.code}/upload`, { token: room.token, json: { name: 'a', size: 10 } })).data.error, 'too_many_items');
});

test('Vercel: 접속자 수', async (t) => {
  const ctx = await boot(t);
  const room = await makeRoom(ctx.base);
  const key = (await call(ctx.base, 'GET', `/api/rooms/${room.code}`)).data.key;
  const here = (body, token) => call(ctx.base, 'POST', `/api/rooms/${room.code}/here?k=${key}`, { token, json: body });

  const student = await here({ c: 'student-aaa', t: 60 });
  assert.equal(student.status, 200);
  assert.deepEqual(Object.keys(student.data).sort(), ['boot', 'v']); // 학생에게는 수를 알려 주지 않는다 (명령 절약)
  await here({ c: 'student-aaa', t: 60 });
  await here({ c: 'student-bbb', t: 60 });
  assert.equal((await here({ c: 'teacher-zzz', t: 60 }, room.token)).data.viewers, 2);
  await here({ c: 'student-bbb', t: 0 }); // 나감
  assert.equal((await here({ c: 'teacher-zzz' }, room.token)).data.viewers, 1);
  // 화면을 닫으며 보내는 신호는 text/plain 으로 온다 (sendBeacon)
  const beacon = await call(ctx.base, 'POST', `/api/rooms/${room.code}/here?k=${key}`, { body: JSON.stringify({ c: 'student-aaa', t: 0 }), headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
  assert.equal(beacon.status, 200);
  assert.equal((await here({ c: 'teacher-zzz' }, room.token)).data.viewers, 0);

  await here({ c: 'student-ccc', t: 60 });
  ctx.clock.now += 61 * 1000; // 소식이 끊기면 빠진다
  assert.equal((await call(ctx.base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data.viewers, 0);
});

test('Vercel: 없는 코드 조회 제한과 열쇠 예외', async (t) => {
  const ctx = await boot(t);
  const { base } = ctx;
  const room = await makeRoom(base);
  const key = (await call(base, 'GET', `/api/rooms/${room.code}`)).data.key;
  const from = (ip) => ({ headers: { 'x-real-ip': ip } });

  for (let i = 0; i < 120; i += 1) assert.equal((await call(base, 'GET', '/api/rooms/000000', from('203.0.113.7'))).status, 404);
  assert.equal((await call(base, 'GET', '/api/rooms/000000', from('203.0.113.7'))).status, 429);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, from('203.0.113.7'))).status, 429); // 있는 코드인지도 알려 주지 않는다
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}/poll`, from('203.0.113.7'))).status, 429);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, from('203.0.113.8'))).status, 200); // 다른 방문자는 영향 없음

  // 이미 수업방을 연 브라우저와 선생님은 계속 쓸 수 있다
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}?k=${key}`, from('203.0.113.7'))).status, 200);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}/poll?k=${key}`, from('203.0.113.7'))).status, 200);
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/here?k=${key}`, Object.assign({ json: { c: 'student-0001' } }, from('203.0.113.7')))).status, 200);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, Object.assign({ token: room.token }, from('203.0.113.7')))).status, 200);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}?k=0000000000000000`, from('203.0.113.7'))).status, 429);

  ctx.clock.now += 5 * 60 * 1000 + 1000; // 시간이 지나면 풀린다
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, from('203.0.113.7'))).status, 200);

  // IPv6는 /64 단위
  for (let i = 0; i < 120; i += 1) await call(base, 'GET', '/api/rooms/000000', from(`2001:db8:1:1::${(i + 1).toString(16)}`));
  assert.equal((await call(base, 'GET', '/api/rooms/000000', from('2001:db8:1:1:ffff::9'))).status, 429);
  assert.equal((await call(base, 'GET', '/api/rooms/000000', from('2001:db8:1:2::1'))).status, 404);
});

test('Vercel: 만들기 제한·비밀번호·다른 사이트 요청', async (t) => {
  const ctx = await boot(t, { teacherPassword: '우리학교2026' });
  const { base } = ctx;
  for (const password of [undefined, '', 'wrong', ['우리학교2026']]) {
    const res = await call(base, 'POST', '/api/rooms', { json: { password } });
    assert.equal(res.status, 403);
    assert.equal(res.data.error, 'bad_password');
  }
  const ok = await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: '우리학교2026' } });
  assert.equal(ok.status, 201);
  for (let i = 0; i < 6; i += 1) await call(base, 'POST', '/api/rooms', { json: { password: 'guess' + i } });
  assert.equal((await call(base, 'POST', '/api/rooms', { json: { password: '우리학교2026' } })).status, 429); // 열 번 틀리면 잠시 막힘

  // 다른 방문자: 만들기 시도는 한 시간에 30번까지 (동시에 몰려도)
  const other = { 'x-real-ip': '198.51.100.9' };
  const burst = await Promise.all(
    Array.from({ length: 40 }, () => call(base, 'POST', '/api/rooms', { json: { password: '우리학교2026' }, headers: other }))
  );
  assert.equal(burst.filter((r) => r.status === 201).length, 30);
  assert.equal(burst.filter((r) => r.status === 429).length, 10);

  for (const site of ['cross-site', 'same-site']) {
    const res = await call(base, 'GET', `/api/rooms/${ok.data.code}`, { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(res.status, 403);
    assert.equal(res.data.error, 'cross_site');
  }
  assert.equal((await call(base, 'GET', `/api/rooms/${ok.data.code}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
});

test('Vercel: 오래 쓰지 않은 수업방은 사라지고, 매일 도는 정리가 남은 파일을 지운다', async (t) => {
  const ctx = await boot(t);
  const { base, blob, clock, config } = ctx;
  const old = await makeRoom(base, '오래된 방');
  const oldFile = await uploadFile(ctx, old, 'old.pdf', Buffer.from('old'));
  assert.equal(oldFile.status, 201);

  clock.now += config.roomTtlMs - 60 * 60 * 1000; // 만료 한 시간 전
  const live = await makeRoom(base, '쓰는 방');
  const kept = await uploadFile(ctx, live, 'keep.pdf', Buffer.from('keep'));
  // 허가증만 받고 등록하지 않은 채 올라간 파일 (브라우저를 닫아 버린 경우)
  const stray = await call(base, 'POST', `/api/rooms/${live.code}/upload`, { token: live.token, json: { name: 'stray.bin', size: 5 } });
  blob.upload(stray.data, Buffer.from('stray'));
  assert.equal(blob.pathnames().length, 3);

  // 권한 없이는 실행할 수 없다
  assert.equal((await call(base, 'GET', '/api/cron/cleanup')).status, 401);
  assert.equal((await call(base, 'GET', '/api/cron/cleanup', { token: 'wrong' })).status, 401);

  // 아직 만료 전: 아무것도 지우지 않는다 (방금 올라온 미등록 파일도 두 시간은 기다려 준다)
  const first = await call(base, 'GET', '/api/cron/cleanup', { token: 'cron-secret-value' });
  assert.deepEqual(first.data, { ok: true, folders: 2, removedFolders: 0, removedFiles: 0 });

  clock.now += 3 * 60 * 60 * 1000; // 오래된 방은 만료, 미등록 파일은 두 시간 경과
  assert.equal((await call(base, 'GET', `/api/rooms/${old.code}`)).status, 404);
  const second = await call(base, 'GET', '/api/cron/cleanup', { token: 'cron-secret-value' });
  assert.deepEqual(second.data, { ok: true, folders: 2, removedFolders: 1, removedFiles: 2 });
  assert.equal(blob.pathnames().length, 1);
  assert.ok(blob.pathnames()[0].endsWith('/keep.pdf'));
  assert.equal((await call(base, 'GET', `/api/rooms/${live.code}`)).data.items.length, 1);
  assert.equal(kept.status, 201);
});

// ---------------------------------------------------------------- 실제 SDK와의 연결 (패키지가 설치돼 있을 때만)

let sdkInstalled = true;
try {
  require.resolve('@vercel/blob');
} catch (err) {
  sdkInstalled = false;
}

test('Vercel: 실제 SDK로 만든 업로드 허가증', { skip: !sdkInstalled && '@vercel/blob 미설치 (npm install 후 실행)' }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createBlobStore, BLOB_API_URL, BLOB_API_VERSION } = require('../src/vercel/blob');
  const { getPayloadFromClientToken } = require('@vercel/blob/client');

  // (저장소 종류를 미리 정해 두면 저장소에 물어보지 않으므로, 네트워크 없이 확인할 수 있다)
  const store = createBlobStore({ token: 'vercel_blob_rw_TestStore123_' + 'x'.repeat(30), access: 'public' });
  const pathname = 'rooms/123456-abc/' + 'f'.repeat(32) + '/한글 파일 (1).pdf';
  const validUntil = Date.now() + 60 * 60 * 1000;
  const ticket = await store.uploadTicket({ pathname, size: 12345, validUntil });

  assert.equal(ticket.url, `${BLOB_API_URL}/?pathname=${encodeURIComponent(pathname)}`);
  assert.equal(new URL(ticket.url).searchParams.get('pathname'), pathname);
  assert.equal(ticket.headers['x-vercel-blob-store-id'], 'TestStore123');
  assert.equal(ticket.headers['x-vercel-blob-access'], 'public');
  assert.equal(ticket.headers['x-content-length'], '12345');
  const clientToken = ticket.headers.authorization.replace(/^Bearer /, '');
  assert.match(clientToken, /^vercel_blob_client_TestStore123_/);
  // 허가증은 이 경로, 이 크기, 이 시간까지만 유효하다
  assert.deepEqual(getPayloadFromClientToken(clientToken), {
    pathname,
    maximumSizeInBytes: 12345,
    validUntil,
    addRandomSuffix: false,
    allowOverwrite: false,
  });

  // 브라우저가 쓰는 저장소 API 주소·버전이 설치된 SDK와 같은지 (SDK를 올릴 때 어긋나면 여기서 알 수 있다)
  const dist = path.dirname(require.resolve('@vercel/blob'));
  const source = fs
    .readdirSync(dist)
    .filter((name) => /^chunk-.*\.cjs$/.test(name))
    .map((name) => fs.readFileSync(path.join(dist, name), 'utf8'))
    .join('\n');
  assert.equal((/BLOB_API_VERSION = (\d+)/.exec(source) || [])[1], BLOB_API_VERSION);
  assert.equal((/defaultVercelBlobApiUrl = "([^"]+)"/.exec(source) || [])[1], BLOB_API_URL);
});

test('Vercel: 함수 진입점이 SDK와 함께 올라온다', { skip: !sdkInstalled && '@vercel/blob 미설치' }, async () => {
  const saved = {};
  const env = {
    KV_REST_API_URL: 'https://example.invalid',
    KV_REST_API_TOKEN: 't',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_Store_' + 'y'.repeat(20),
    BLOB_STORE_ID: '',
  };
  for (const name of Object.keys(env)) {
    saved[name] = process.env[name];
    process.env[name] = env[name];
  }
  delete require.cache[require.resolve('../api/index.js')];
  const fn = require('../api/index.js');
  // 설정 조회는 저장소에 접속하지 않으므로, 여기까지 오면 조립이 된 것이다
  const out = await new Promise((resolve) => {
    const res = {
      headersSent: false,
      setHeader() {},
      end(data) {
        resolve({ status: this.statusCode, data: JSON.parse(String(data)) });
      },
    };
    fn({ method: 'GET', url: '/api/index?__path=config', headers: {} }, res);
  });
  for (const name of Object.keys(saved)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  delete require.cache[require.resolve('../api/index.js')];
  assert.equal(out.status, 200);
  assert.equal(out.data.transport, 'poll');
  assert.equal(out.data.maxFileBytes, 50 * 1024 * 1024);
});
