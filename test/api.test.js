'use strict';

// 서버 동작 확인 테스트.  실행: npm test  (추가 설치 없이 Node.js 내장 테스트 도구 사용)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const util = require('../src/util');

// ---------------------------------------------------------------- 도우미

async function boot(t, overrides = {}, dataDir = null) {
  const dir = dataDir || (await fsp.mkdtemp(path.join(os.tmpdir(), 'class-share-test-')));
  const config = Object.assign(loadConfig({ DATA_DIR: dir }), overrides);
  const app = await createApp(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const ctx = { app, dir, config, base: `http://127.0.0.1:${app.port()}`, closed: false };
  ctx.close = async () => {
    if (ctx.closed) return;
    ctx.closed = true;
    await app.close();
  };
  t.after(async () => {
    await ctx.close();
    if (!dataDir) await fsp.rm(dir, { recursive: true, force: true });
  });
  return ctx;
}

async function call(base, method, pathname, { token, json, headers, body } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  let payload = body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(base + pathname, { method, headers: h, body: payload, redirect: 'manual' });
  const buffer = Buffer.from(await res.arrayBuffer());
  let data = null;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    data = null;
  }
  return { status: res.status, headers: res.headers, data, buffer, text: buffer.toString('utf8') };
}

async function makeRoom(base, name = '테스트 수업방', password) {
  const res = await call(base, 'POST', '/api/rooms', { json: { name, password } });
  assert.equal(res.status, 201);
  return res.data;
}

function upload(base, room, name, buffer, token = room.token) {
  return call(base, 'POST', `/api/rooms/${room.code}/files`, {
    token,
    headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
}

// 실시간 이벤트 스트림을 읽는 작은 클라이언트
async function openEvents(base, code, query = '') {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/rooms/${code}/events${query}`, { signal: controller.signal });
  const queue = [];
  const waiters = [];
  let ended = false;
  const push = (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  };

  if (res.status === 200) {
    (async () => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            let event = '';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (event) push({ event, data: JSON.parse(data) });
          }
        }
      } catch (err) {
        // 연결 종료
      }
      ended = true;
      push({ event: 'end', data: null });
    })();
  } else {
    await res.arrayBuffer();
    ended = true;
  }

  const next = (timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      if (ended) return resolve({ event: 'end', data: null });
      const timer = setTimeout(() => reject(new Error('이벤트를 기다리다 시간 초과')), timeoutMs);
      waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

  return {
    status: res.status,
    next,
    async nextOf(name, timeoutMs) {
      for (;;) {
        const message = await next(timeoutMs);
        if (message.event === name) return message;
        if (message.event === 'end') throw new Error(`${name} 이벤트 전에 연결이 끝남`);
      }
    },
    close: () => controller.abort(),
  };
}

function rawRequest(base, { method = 'GET', pathname = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + pathname);
    const req = http.request({ host: url.hostname, port: url.port, method, path: url.pathname + url.search, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------- 순수 함수

test('링크 판별: 주소 하나만 적었을 때만 링크로 본다', () => {
  assert.equal(util.detectLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(util.detectLink('  http://192.168.0.5:8080/x  '), 'http://192.168.0.5:8080/x');
  assert.equal(util.detectLink('naver.com'), 'https://naver.com/');
  assert.equal(util.detectLink('www.example.co.kr'), 'https://www.example.co.kr/');
  assert.equal(util.detectLink('forms.gle/AbC123'), 'https://forms.gle/AbC123');
  assert.equal(util.detectLink('bun.sh/install'), 'https://bun.sh/install'); // 경로가 있으면 링크
  assert.equal(util.detectLink('https://ko.wikipedia.org/wiki/한국'), 'https://ko.wikipedia.org/wiki/%ED%95%9C%EA%B5%AD');

  assert.equal(util.detectLink('main.py'), null); // 파일 이름
  assert.equal(util.detectLink('run.sh'), null);
  assert.equal(util.detectLink('README.md'), null);
  assert.equal(util.detectLink('v1.2'), null);
  assert.equal(util.detectLink('teacher@school.kr'), null);
  assert.equal(util.detectLink('naver.com 에 접속'), null); // 문장
  assert.equal(util.detectLink('javascript:alert(1)'), null);
  assert.equal(util.detectLink('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(util.detectLink('file:///etc/passwd'), null);
  assert.equal(util.detectLink(''), null);
});

test('파일 이름 정리', () => {
  const nfd = '한글 파일.hwp'.normalize('NFD');
  assert.notEqual(nfd, '한글 파일.hwp');
  assert.equal(util.sanitizeFileName(nfd), '한글 파일.hwp'); // macOS 자소 분리 → 합침
  assert.equal(util.sanitizeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(util.sanitizeFileName('C:\\Users\\me\\a.txt'), 'C__Users_me_a.txt');
  assert.equal(util.sanitizeFileName('a<b>:"c"|d?.txt'), 'a_b___c__d_.txt');
  assert.equal(util.sanitizeFileName('photo\u202Egnp.exe'), 'photognp.exe'); // 확장자 위장용 방향 제어 문자 제거
  assert.equal(util.sanitizeFileName('new\nline\u0000.txt'), 'newline.txt');
  assert.equal(util.sanitizeFileName('.gitignore'), '.gitignore');
  assert.equal(util.sanitizeFileName('..'), '');
  assert.equal(util.sanitizeFileName('   '), '');
  assert.equal(util.sanitizeFileName('trailing. . '), 'trailing');
  assert.equal(util.sanitizeFileName(123), '');

  const long = util.sanitizeFileName('가'.repeat(400) + '.pdf');
  assert.equal(Array.from(long).length, 150);
  assert.ok(long.endsWith('.pdf'));
});

test('다운로드 헤더와 범위 요청 해석', () => {
  assert.equal(
    util.contentDisposition('attachment', "3주차 활동지 (최종)'.hwp"),
    "attachment; filename=\"3__ ___ (__)'.hwp\"; filename*=UTF-8''3%EC%A3%BC%EC%B0%A8%20%ED%99%9C%EB%8F%99%EC%A7%80%20%28%EC%B5%9C%EC%A2%85%29%27.hwp"
  );
  assert.equal(util.contentDisposition('inline', 'a"b\\c.txt'), 'inline; filename="a_b_c.txt"; filename*=UTF-8\'\'a%22b%5Cc.txt');

  assert.deepEqual(util.parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(util.parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(util.parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(util.parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(util.parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(util.parseRange('bytes=5-2', 1000), 'invalid');
  assert.equal(util.parseRange('bytes=0-1,5-9', 1000), null); // 여러 범위는 무시하고 전체 전송
  assert.equal(util.parseRange(undefined, 1000), null);
});

test('공유 텍스트 정리: 들여쓰기와 줄바꿈은 유지', () => {
  assert.equal(util.cleanText('\r\n\r\n    if x:\r\n\tprint(x)\r\n\r\n'), '    if x:\n\tprint(x)');
  assert.equal(util.cleanText('a\u0000b\u0007c'), 'abc');
  assert.equal(util.cleanText(42), '');
  assert.equal(util.cleanLine('  여러   칸\n줄바꿈  ', 40), '여러 칸 줄바꿈');
  assert.equal(util.cleanLine('가'.repeat(100), 40), '가'.repeat(40));
});

// ---------------------------------------------------------------- 화면·정적 파일

test('화면과 보안 헤더', async (t) => {
  const { base } = await boot(t, { siteName: '<b>우리반</b> "공유"' });

  const home = await call(base, 'GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  // 사이트 이름은 HTML로 해석되지 않게 바꿔서 넣는다
  assert.ok(!home.text.includes('<b>우리반</b>'));
  assert.ok(home.text.includes('&#60;b&#62;우리반&#60;/b&#62; &#34;공유&#34;'));
  assert.ok(!home.text.includes('{{SITE_NAME}}'));

  // 수업방 화면은 코드가 실제로 있든 없든 똑같이 응답한다 (화면만으로는 코드 존재 여부를 알 수 없음)
  const room = await call(base, 'GET', '/123456');
  assert.equal(room.status, 200);
  assert.match(room.text, /id="feed"/);

  // 관리자 페이지는 Vercel용에만 있다. 여기서는 화면만 열리고(지원하지 않는다고 안내), 관리자 API는 없다
  const admin = await call(base, 'GET', '/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /id="setup-form"/);
  assert.ok(!admin.text.includes('{{SITE_NAME}}'));
  const adminApi = await call(base, 'GET', '/api/admin');
  assert.equal(adminApi.status, 404);
  assert.equal(adminApi.data.error, 'not_found');
  const config = (await call(base, 'GET', '/api/config')).data;
  assert.equal(config.admin, undefined);
  assert.equal(config.setupRequired, undefined);

  const css = await call(base, 'GET', '/assets/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const cached = await call(base, 'GET', '/assets/app.css', { headers: { 'If-None-Match': css.headers.get('etag') } });
  assert.equal(cached.status, 304);

  assert.equal((await call(base, 'GET', '/healthz')).text, 'ok');
  assert.equal((await call(base, 'GET', '/robots.txt')).status, 200);

  const redirected = await call(base, 'GET', '/483%20920');
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), '/483920');

  for (const bad of ['/nope', '/12345', '/1234567', '/index.html', '/room.html', '/admin.html', '/admin/', '/assets/', '/assets/../server.js',
    '/assets/%2e%2e/server.js', '/assets/..%2f..%2fserver.js', '/%2e%2e/package.json', '/src/app.js', '/.git/config']) {
    const res = await rawRequest(base, { pathname: bad });
    assert.equal(res.status, 404, bad);
    assert.ok(!res.text.includes('createApp'), bad);
  }
  assert.equal((await call(base, 'POST', '/')).status, 405);
});

test('ALLOW_FRAMING을 켜면 프레임 차단 헤더를 보내지 않는다', async (t) => {
  const { base } = await boot(t, { allowFraming: true });
  const home = await call(base, 'GET', '/');
  assert.equal(home.headers.get('x-frame-options'), null);
  assert.ok(!home.headers.get('content-security-policy').includes('frame-ancestors'));
});

// ---------------------------------------------------------------- 수업방

test('수업방 만들기 → 공유 → 수정 → 삭제', async (t) => {
  const { base } = await boot(t);
  const room = await makeRoom(base, '  3학년\n2반   정보 ');
  assert.match(room.code, /^\d{6}$/);
  assert.equal(room.name, '3학년 2반 정보');
  assert.ok(room.token.length >= 24);

  const guest = await call(base, 'GET', `/api/rooms/${room.code}`);
  assert.equal(guest.status, 200);
  assert.equal(guest.data.isHost, false);
  assert.equal(guest.data.usedBytes, undefined);
  assert.deepEqual(guest.data.items, []);
  assert.ok(!JSON.stringify(guest.data).includes(room.token));

  const host = await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token });
  assert.equal(host.data.isHost, true);
  assert.equal(host.data.usedBytes, 0);

  // 권한 없는 변경은 모두 거절
  const items = `/api/rooms/${room.code}/items`;
  for (const token of [null, 'wrong-token-wrong-token-wrong', room.token + 'x', room.token.slice(0, -1)]) {
    assert.equal((await call(base, 'POST', items, { token, json: { text: 'x' } })).status, 403);
    assert.equal((await call(base, 'DELETE', items, { token })).status, 403);
    assert.equal((await call(base, 'PATCH', `/api/rooms/${room.code}`, { token, json: { name: 'x' } })).status, 403);
    assert.equal((await call(base, 'DELETE', `/api/rooms/${room.code}`, { token })).status, 403);
    assert.equal((await upload(base, room, 'a.txt', Buffer.from('x'), token)).status, 403);
  }

  const link = await call(base, 'POST', items, { token: room.token, json: { text: ' naver.com ' } });
  assert.equal(link.status, 201);
  assert.equal(link.data.item.type, 'link');
  assert.equal(link.data.item.url, 'https://naver.com/');

  const text = await call(base, 'POST', items, { token: room.token, json: { text: '과제: main.py 를 고쳐 오세요\r\n내일까지' } });
  assert.equal(text.data.item.type, 'text');
  assert.equal(text.data.item.text, '과제: main.py 를 고쳐 오세요\n내일까지');
  assert.equal(text.data.item.mono, false);

  // "코드로 표시"를 켜면 주소 하나만 있어도 텍스트 그대로
  const code = await call(base, 'POST', items, { token: room.token, json: { text: 'https://example.com', mono: true } });
  assert.equal(code.data.item.type, 'text');
  assert.equal(code.data.item.mono, true);

  assert.equal((await call(base, 'POST', items, { token: room.token, json: { text: '   \n  ' } })).data.error, 'empty');
  assert.equal((await call(base, 'POST', items, { token: room.token, json: {} })).data.error, 'empty');
  assert.equal((await call(base, 'POST', items, { token: room.token, body: '{bad json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await call(base, 'POST', items, { token: room.token, json: ['x'] })).status, 400);

  let snap = (await call(base, 'GET', `/api/rooms/${room.code}`)).data;
  assert.deepEqual(snap.items.map((i) => i.type), ['link', 'text', 'text']);
  assert.equal(snap.v, 3);

  const renamed = await call(base, 'PATCH', `/api/rooms/${room.code}`, { token: room.token, json: { name: '정보 3-2' } });
  assert.equal(renamed.data.name, '정보 3-2');
  assert.equal((await call(base, 'PATCH', `/api/rooms/${room.code}`, { token: room.token, json: {} })).status, 400);

  const removed = await call(base, 'DELETE', `${items}/${link.data.item.id}`, { token: room.token });
  assert.equal(removed.data.removed, true);
  const again = await call(base, 'DELETE', `${items}/${link.data.item.id}`, { token: room.token });
  assert.equal(again.data.removed, false);

  const cleared = await call(base, 'DELETE', items, { token: room.token });
  assert.equal(cleared.data.removed, 2);
  snap = (await call(base, 'GET', `/api/rooms/${room.code}`)).data;
  assert.deepEqual(snap.items, []);
  assert.equal(snap.name, '정보 3-2');

  assert.equal((await call(base, 'DELETE', `/api/rooms/${room.code}`, { token: room.token })).status, 200);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`)).status, 404);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).status, 404);
});

test('바뀐 것이 있는지만 확인하는 가벼운 요청(poll)', async (t) => {
  const { base } = await boot(t);
  const room = await makeRoom(base, '이름에 "따옴표"와 \\ 역슬래시');
  const snap = (await call(base, 'GET', `/api/rooms/${room.code}`)).data;
  assert.equal(snap.name, '이름에 "따옴표"와 \\ 역슬래시');
  assert.match(snap.boot, /^[a-f0-9]{8}$/);
  assert.match(snap.key, /^[a-f0-9]{16}$/);
  assert.deepEqual(Object.keys(snap).sort(), ['boot', 'code', 'isHost', 'items', 'key', 'name', 'v', 'viewers']);

  const first = (await call(base, 'GET', `/api/rooms/${room.code}/poll?k=${snap.key}`)).data;
  assert.deepEqual(first, { v: snap.v, boot: snap.boot });
  await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: '새 글' } });
  const second = (await call(base, 'GET', `/api/rooms/${room.code}/poll`)).data;
  assert.deepEqual(second, { v: snap.v + 1, boot: snap.boot });
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/poll`)).status, 405);
});

test('실시간 이벤트', async (t) => {
  const { base } = await boot(t);
  const room = await makeRoom(base, '실시간');
  await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: '먼저 올린 글' } });

  const student = await openEvents(base, room.code, '?c=student-0001');
  assert.equal(student.status, 200);
  const hello = await student.nextOf('hello');
  assert.equal(hello.data.name, '실시간');
  assert.equal(hello.data.items.length, 1);
  assert.equal(hello.data.isHost, undefined);
  assert.equal(hello.data.viewers, 1);

  // 선생님 화면은 접속 학생 수에 넣지 않는다
  const host = await openEvents(base, room.code, '?role=host&c=teacher-0001');
  assert.equal((await host.nextOf('hello')).data.viewers, 1);

  const posted = await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: 'example.com' } });
  const add = await student.nextOf('add');
  assert.equal(add.data.v, 2);
  assert.deepEqual(add.data.item, posted.data.item);

  const up = await upload(base, room, '그림.png', Buffer.from('fake png'));
  const addFile = await student.nextOf('add');
  assert.equal(addFile.data.item.name, '그림.png');
  assert.equal(addFile.data.item.kind, 'image');
  assert.equal(addFile.data.v, 3);

  await call(base, 'DELETE', `/api/rooms/${room.code}/items/${up.data.item.id}`, { token: room.token });
  assert.deepEqual((await student.nextOf('remove')).data, { v: 4, id: up.data.item.id });

  await call(base, 'PATCH', `/api/rooms/${room.code}`, { token: room.token, json: { name: '바뀐 이름' } });
  assert.deepEqual((await student.nextOf('room')).data, { v: 5, name: '바뀐 이름' });

  await call(base, 'DELETE', `/api/rooms/${room.code}/items`, { token: room.token });
  assert.deepEqual((await student.nextOf('clear')).data, { v: 6 });

  // 학생이 들어오고 나가면 선생님에게 알려 준다
  const second = await openEvents(base, room.code, '?c=student-0002');
  await second.nextOf('hello');
  assert.equal((await host.nextOf('viewers')).data.n, 2);
  // 스트림만 닫힌 것은 "나감"이 아니다 (화면이 가려지면 스트림을 닫아 두기 때문). 나간다는 신호가 와야 빠진다.
  second.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`)).data.viewers, 2);
  await call(base, 'POST', `/api/rooms/${room.code}/here`, { json: { c: 'student-0002', t: 0 } });
  assert.equal((await host.nextOf('viewers')).data.n, 1);
  // 식별자 없이 붙은 연결(다른 프로그램 등)은 연결이 열려 있는 동안만 센다
  const anonymous = await openEvents(base, room.code);
  await anonymous.nextOf('hello');
  assert.equal((await host.nextOf('viewers')).data.n, 2);
  anonymous.close();
  assert.equal((await host.nextOf('viewers')).data.n, 1);

  await call(base, 'DELETE', `/api/rooms/${room.code}`, { token: room.token });
  await student.nextOf('closed');
  assert.equal((await student.next()).event, 'end');
  host.close();

  assert.equal((await openEvents(base, room.code)).status, 404);
});

// ---------------------------------------------------------------- 파일

test('파일 올리기·내려받기', async (t) => {
  const { base, dir } = await boot(t);
  const room = await makeRoom(base);
  const content = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

  const up = await upload(base, room, '수업 자료 (3주차).pdf'.normalize('NFD'), content);
  assert.equal(up.status, 201);
  const item = up.data.item;
  assert.equal(item.name, '수업 자료 (3주차).pdf'); // 합쳐진 한글
  assert.equal(item.size, 5000);
  assert.equal(item.kind, 'pdf');
  assert.equal(item.url, `/f/${room.code}/${item.id}/${encodeURIComponent('수업 자료 (3주차).pdf')}`);
  assert.equal(item.openUrl, item.url + '?inline');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'files', room.code)), [item.id]); // 디스크에는 원래 이름을 쓰지 않는다
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);

  const fileUrl = `/f/${room.code}/${item.id}/${encodeURIComponent(item.name)}`;
  const down = await call(base, 'GET', fileUrl);
  assert.equal(down.status, 200);
  assert.ok(down.buffer.equals(content));
  assert.equal(down.headers.get('content-type'), 'application/octet-stream');
  assert.match(down.headers.get('content-disposition'), /^attachment; filename="[^"]+"; filename\*=UTF-8''%EC%88%98%EC%97%85/);
  assert.equal(down.headers.get('x-content-type-options'), 'nosniff');
  assert.match(down.headers.get('content-security-policy'), /sandbox/);
  assert.equal(down.headers.get('accept-ranges'), 'bytes');

  // 이름 부분은 있어도 없어도, 달라도 된다 (식별은 항목 id로)
  assert.equal((await call(base, 'GET', `/f/${room.code}/${item.id}`)).status, 200);
  assert.equal((await call(base, 'GET', `/f/${room.code}/${item.id}/other-name.bin`)).status, 200);

  const inline = await call(base, 'GET', fileUrl + '?inline');
  assert.equal(inline.headers.get('content-type'), 'application/pdf');
  assert.match(inline.headers.get('content-disposition'), /^inline;/);

  const range = await call(base, 'GET', fileUrl, { headers: { Range: 'bytes=100-199' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 100-199/5000');
  assert.ok(range.buffer.equals(content.subarray(100, 200)));
  const tail = await call(base, 'GET', fileUrl, { headers: { Range: 'bytes=-10' } });
  assert.ok(tail.buffer.equals(content.subarray(4990)));
  const badRange = await call(base, 'GET', fileUrl, { headers: { Range: 'bytes=9000-' } });
  assert.equal(badRange.status, 416);
  assert.equal(badRange.headers.get('content-range'), 'bytes */5000');

  const head = await call(base, 'HEAD', fileUrl);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '5000');
  assert.equal(head.buffer.length, 0);

  // 잘못된 주소
  assert.equal((await call(base, 'GET', `/f/${room.code}/${'0'.repeat(32)}/x`)).status, 404);
  assert.equal((await call(base, 'GET', `/f/000000/${item.id}/x`)).status, 404);
  assert.equal((await call(base, 'GET', `/f/${room.code}/..%2f..%2frooms%2f${room.code}.json`)).status, 404);
  assert.equal((await call(base, 'POST', fileUrl)).status, 405);

  // 삭제하면 디스크에서도 사라진다
  await call(base, 'DELETE', `/api/rooms/${room.code}/items/${item.id}`, { token: room.token });
  assert.equal((await call(base, 'GET', fileUrl)).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'files', room.code)), []);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data.usedBytes, 0);
});

test('스크립트를 담을 수 있는 파일은 브라우저에서 실행되지 않는다', async (t) => {
  const { base } = await boot(t);
  const room = await makeRoom(base);
  const evil = Buffer.from('<script>alert(document.domain)</script>');

  const cases = [
    ['page.html', 'text/plain'], // 소스 코드로만 보인다
    ['image.svg', 'application/octet-stream'], // 항상 다운로드
    ['doc.xhtml', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
    ['photo.png', 'image/png'], // 내용이 HTML이어도 이미지로만 해석 (nosniff)
  ];
  for (const [name, inlineType] of cases) {
    const up = await upload(base, room, name, evil);
    assert.equal(up.status, 201, name);
    const url = `/f/${room.code}/${up.data.item.id}/${name}`;

    const normal = await call(base, 'GET', url);
    assert.equal(normal.headers.get('content-type'), 'application/octet-stream', name);
    assert.match(normal.headers.get('content-disposition'), /^attachment;/, name);
    assert.equal(normal.headers.get('x-content-type-options'), 'nosniff', name);

    const inline = await call(base, 'GET', url + '?inline');
    assert.equal(inline.headers.get('content-type'), inlineType, name);
    assert.equal(inline.headers.get('x-content-type-options'), 'nosniff', name);
    assert.ok(!/html|svg|xml/.test(inline.headers.get('content-type')), name);
    if (inlineType === 'application/octet-stream') assert.match(inline.headers.get('content-disposition'), /^attachment;/, name);
    if (inlineType !== 'image/png') assert.match(inline.headers.get('content-security-policy'), /sandbox/, name);
  }
});

test('용량·개수 제한', async (t) => {
  const { base, dir } = await boot(t, { maxFileBytes: 1000, maxRoomBytes: 2500, maxTotalBytes: 4000, maxItems: 6, maxTextBytes: 200 });
  const room = await makeRoom(base);

  const tooBig = await upload(base, room, 'big.bin', Buffer.alloc(1001));
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.data.error, 'file_too_large');
  assert.equal((await upload(base, room, 'empty.bin', Buffer.alloc(0))).data.error, 'empty_file');

  assert.equal((await upload(base, room, 'a.bin', Buffer.alloc(1000))).status, 201);
  assert.equal((await upload(base, room, 'b.bin', Buffer.alloc(1000))).status, 201);
  const full = await upload(base, room, 'c.bin', Buffer.alloc(600));
  assert.equal(full.status, 413);
  assert.equal(full.data.error, 'room_full');
  assert.equal((await upload(base, room, 'c.bin', Buffer.alloc(500))).status, 201); // 딱 맞으면 가능

  // 서버 전체 한도
  const other = await makeRoom(base);
  assert.equal((await upload(base, other, 'd.bin', Buffer.alloc(1000))).status, 201);
  const serverFull = await upload(base, other, 'e.bin', Buffer.alloc(600));
  assert.equal(serverFull.status, 507);
  assert.equal(serverFull.data.error, 'server_full');

  // 거절된 업로드는 흔적을 남기지 않는다
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
  assert.equal(fs.readdirSync(path.join(dir, 'files', room.code)).length, 3);

  const items = `/api/rooms/${room.code}/items`;
  const long = await call(base, 'POST', items, { token: room.token, json: { text: '가'.repeat(67) } }); // 201바이트
  assert.equal(long.status, 413);
  assert.equal(long.data.error, 'text_too_long');
  assert.equal((await call(base, 'POST', items, { token: room.token, json: { text: 'x'.repeat(5000) } })).status, 413);

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call(base, 'POST', items, { token: room.token, json: { text: `글 ${i}` } })).status, 201);
  }
  const overText = await call(base, 'POST', items, { token: room.token, json: { text: '하나 더' } });
  assert.equal(overText.status, 409);
  assert.equal(overText.data.error, 'too_many_items');
  await call(base, 'DELETE', `${items}/${(await call(base, 'GET', `/api/rooms/${room.code}`)).data.items[0].id}`, { token: room.token });
  // 파일 하나를 지워 용량은 남지만 항목 수가 다시 가득 차면 거절
  assert.equal((await call(base, 'POST', items, { token: room.token, json: { text: '채움' } })).status, 201);
  assert.equal((await upload(base, room, 'f.bin', Buffer.alloc(10))).data.error, 'too_many_items');
});

test('동시에 올려도 수업방 한도를 넘지 않는다', async (t) => {
  const { base } = await boot(t, { maxFileBytes: 1000, maxRoomBytes: 2000 });
  const room = await makeRoom(base);
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => upload(base, room, `f${i}.bin`, Buffer.alloc(900)))
  );
  const ok = results.filter((r) => r.status === 201).length;
  assert.equal(ok, 2);
  assert.ok(results.every((r) => r.status === 201 || r.data.error === 'room_full'));
  const snap = (await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data;
  assert.equal(snap.usedBytes, 1800);
  assert.equal(snap.items.length, 2);
});

// ---------------------------------------------------------------- 접근 제한

test('수업방 생성 비밀번호', async (t) => {
  const { base } = await boot(t, { teacherPassword: '우리학교2026' });
  assert.equal((await call(base, 'GET', '/api/config')).data.requirePassword, true);

  for (const password of [undefined, '', 'wrong', '우리학교2026 ', ['우리학교2026'], { a: 1 }]) {
    const res = await call(base, 'POST', '/api/rooms', { json: { name: 'x', password } });
    assert.equal(res.status, 403);
    assert.equal(res.data.error, 'bad_password');
  }
  const ok = await call(base, 'POST', '/api/rooms', { json: { name: 'x', password: '우리학교2026' } });
  assert.equal(ok.status, 201);

  // 계속 틀리면 잠시 막는다 (맞는 비밀번호도 그동안은 거절)
  for (let i = 0; i < 4; i += 1) await call(base, 'POST', '/api/rooms', { json: { password: 'guess' + i } });
  const locked = await call(base, 'POST', '/api/rooms', { json: { password: '우리학교2026' } });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  // 이미 만든 수업방은 계속 쓸 수 있다
  assert.equal((await call(base, 'GET', `/api/rooms/${ok.data.code}`, { token: ok.data.token })).status, 200);
});

test('없는 코드를 계속 넣어 보면 잠시 막힌다 (선생님은 예외)', async (t) => {
  const { base } = await boot(t);
  const room = await makeRoom(base);
  for (let i = 0; i < 120; i += 1) {
    const res = await call(base, 'GET', `/api/rooms/${String(100000 + i)}`);
    assert.equal(res.status, room.code === String(100000 + i) ? 200 : 404);
  }
  const blocked = await call(base, 'GET', '/api/rooms/999999');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error, 'too_many_attempts');
  // 막힌 동안에는 있는 코드인지도 알려 주지 않는다
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`)).status, 429);
  assert.equal((await openEvents(base, room.code)).status, 429);
  // 선생님 권한이 확인되면 그대로 쓸 수 있다
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).status, 200);
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: 'ok' } })).status, 201);
  // 화면과 파일 주소는 막지 않는다
  assert.equal((await call(base, 'GET', `/${room.code}`)).status, 200);
});

test('프록시 뒤에서는 TRUST_PROXY로 방문자를 구분한다', async (t) => {
  const { base } = await boot(t, { trustProxy: 1 });
  const from = (ip) => ({ headers: { 'X-Forwarded-For': `10.9.9.9, ${ip}` } }); // 맨 오른쪽이 프록시가 본 실제 주소
  for (let i = 0; i < 120; i += 1) await call(base, 'GET', '/api/rooms/000000', from('203.0.113.7'));
  assert.equal((await call(base, 'GET', '/api/rooms/000000', from('203.0.113.7'))).status, 429);
  assert.equal((await call(base, 'GET', '/api/rooms/000000', from('203.0.113.8'))).status, 404);
  // 방문자가 앞쪽에 가짜 주소를 끼워 넣어도 구분이 흐트러지지 않는다
  assert.equal((await call(base, 'GET', '/api/rooms/000000', { headers: { 'X-Forwarded-For': '1.2.3.4, 203.0.113.7' } })).status, 429);
});

test('수업방 개수 제한', async (t) => {
  const { base } = await boot(t, { maxRooms: 2 });
  await makeRoom(base);
  await makeRoom(base);
  const third = await call(base, 'POST', '/api/rooms', { json: {} });
  assert.equal(third.status, 503);
  assert.equal(third.data.error, 'too_many_rooms');
});

test('내부망 주소는 선생님 컴퓨터(localhost)에서 열었을 때만 알려 준다', async (t) => {
  const { base } = await boot(t);
  const port = new URL(base).port;
  const local = JSON.parse((await rawRequest(base, { pathname: '/api/config', headers: { Host: `localhost:${port}` } })).text);
  assert.ok(Array.isArray(local.lanUrls));
  for (const url of local.lanUrls) assert.match(url, new RegExp(`^http://\\d+\\.\\d+\\.\\d+\\.\\d+:${port}$`));

  const named = JSON.parse((await rawRequest(base, { pathname: '/api/config', headers: { Host: 'share.example.com' } })).text);
  assert.deepEqual(named.lanUrls, []);
  const proxied = JSON.parse(
    (await rawRequest(base, { pathname: '/api/config', headers: { Host: `localhost:${port}`, 'X-Forwarded-For': '203.0.113.9' } })).text
  );
  assert.deepEqual(proxied.lanUrls, []);

  const fixed = await boot(t, { publicUrl: 'https://share.example.com' });
  const config = (await call(fixed.base, 'GET', '/api/config')).data;
  assert.equal(config.publicUrl, 'https://share.example.com');
  assert.deepEqual(config.lanUrls, []);
});

// ---------------------------------------------------------------- 저장·정리

test('서버를 다시 켜도 수업방과 파일이 그대로다', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'class-share-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const first = await boot(t, {}, dir);
  const room = await makeRoom(first.base, '오래가는 방');
  await call(first.base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: '남아 있어야 하는 글' } });
  const up = await upload(first.base, room, '자료.zip', Buffer.from('zip-bytes'));
  const lost = await upload(first.base, room, '사라질.bin', Buffer.from('gone'));
  await first.close();

  // 저장 파일에는 권한 토큰 원문이 없어야 한다
  const saved = fs.readFileSync(path.join(dir, 'rooms', room.code + '.json'), 'utf8');
  assert.ok(!saved.includes(room.token));

  // 꺼져 있는 동안 생긴 흔적들: 사라진 파일, 주인 없는 파일, 끝나지 못한 업로드, 깨진 저장 파일
  fs.rmSync(path.join(dir, 'files', room.code, lost.data.item.id));
  fs.writeFileSync(path.join(dir, 'files', room.code, 'f'.repeat(32)), 'orphan');
  fs.mkdirSync(path.join(dir, 'files', '555555'));
  fs.writeFileSync(path.join(dir, 'files', '555555', 'a'.repeat(32)), 'orphan');
  fs.writeFileSync(path.join(dir, 'tmp', 'leftover'), 'partial');
  fs.writeFileSync(path.join(dir, 'rooms', '777777.json'), '{broken');
  fs.mkdirSync(path.join(dir, 'files', '777777'));
  fs.writeFileSync(path.join(dir, 'files', '777777', 'b'.repeat(32)), 'precious');
  fs.writeFileSync(path.join(dir, 'rooms', '888888.json'), JSON.stringify({ code: '999999', hostHash: 'x' }));

  const second = await boot(t, {}, dir);
  const snap = (await call(second.base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data;
  assert.equal(snap.isHost, true);
  assert.equal(snap.name, '오래가는 방');
  assert.deepEqual(snap.items.map((i) => i.type), ['text', 'file']);
  assert.equal(snap.usedBytes, 9);
  const down = await call(second.base, 'GET', `/f/${room.code}/${up.data.item.id}/x`);
  assert.equal(down.text, 'zip-bytes');

  assert.deepEqual(fs.readdirSync(path.join(dir, 'files', room.code)), [up.data.item.id]);
  assert.ok(!fs.existsSync(path.join(dir, 'files', '555555')));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
  // 저장 파일을 읽지 못한 수업방: 파일을 지우지 않고, "없는 방"이 아니라 "지금은 못 엶"으로 답한다
  const broken = await call(second.base, 'GET', '/api/rooms/777777');
  assert.equal(broken.status, 503);
  assert.equal(broken.data.error, 'unavailable');
  assert.equal(fs.readFileSync(path.join(dir, 'files', '777777', 'b'.repeat(32)), 'utf8'), 'precious');
  assert.equal(fs.readFileSync(path.join(dir, 'rooms', '777777.json'), 'utf8'), '{broken');
  assert.equal((await call(second.base, 'GET', '/api/rooms/888888')).status, 503);
  assert.equal((await call(second.base, 'GET', '/api/rooms/999999')).status, 404);
});

test('오래 쓰지 않은 수업방은 자동으로 지워진다', async (t) => {
  const { base, app, dir, config } = await boot(t);
  const idle = await makeRoom(base, '안 쓰는 방');
  const watched = await makeRoom(base, '보고 있는 방');
  await upload(base, idle, 'a.bin', Buffer.from('data'));
  const viewer = await openEvents(base, watched.code);
  await viewer.nextOf('hello');
  const idleViewer = await openEvents(base, idle.code);
  await idleViewer.nextOf('hello');
  idleViewer.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(await app.sweep(Date.now() + config.roomTtlMs - 60000), []); // 아직 기한 전

  const later = Date.now() + config.roomTtlMs + 60000;
  assert.deepEqual(await app.sweep(later), [idle.code]); // 누군가 보고 있는 방은 남는다
  assert.equal((await call(base, 'GET', `/api/rooms/${idle.code}`)).status, 404);
  assert.equal((await call(base, 'GET', `/api/rooms/${watched.code}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'rooms', idle.code + '.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'files', idle.code)));
  viewer.close();
});

// ---------------------------------------------------------------- 중간에 끊기는 연결

async function waitFor(condition, timeoutMs = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('조건을 기다리다 시간 초과');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('올리다가 끊긴 파일은 흔적 없이 버린다', async (t) => {
  const { base, dir } = await boot(t);
  const room = await makeRoom(base);
  const url = new URL(base);

  await new Promise((resolve) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method: 'POST',
      path: `/api/rooms/${room.code}/files`,
      headers: { Authorization: 'Bearer ' + room.token, 'X-File-Name': 'half.bin', 'Content-Length': 200000 },
    });
    req.on('error', () => {});
    req.on('close', resolve);
    req.write(Buffer.alloc(60000), () => setTimeout(() => req.destroy(), 80)); // 일부만 보내고 연결을 끊는다
  });

  await waitFor(() => fs.readdirSync(path.join(dir, 'tmp')).length === 0);
  const snap = (await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data;
  assert.deepEqual(snap.items, []);
  assert.equal(snap.usedBytes, 0);
  assert.equal((await upload(base, room, 'ok.bin', Buffer.from('fine'))).status, 201); // 서버는 계속 정상
});

test('내려받다가 끊거나, 받는 중에 지워도 서버는 멀쩡하다', async (t) => {
  const { base, dir } = await boot(t);
  const room = await makeRoom(base);
  const content = Buffer.alloc(8 * 1024 * 1024, 3);
  const up = await upload(base, room, 'big.bin', content);
  assert.equal(up.status, 201);
  const url = new URL(base);
  const filePath = `/f/${room.code}/${up.data.item.id}/big.bin`;

  // 조금 받다가 끊기
  await new Promise((resolve) => {
    const req = http.get({ host: url.hostname, port: url.port, path: filePath }, (res) => {
      res.once('data', () => {
        req.destroy();
      });
    });
    req.on('error', () => {});
    req.on('close', resolve);
  });

  // 받는 도중에 선생님이 항목을 지움
  const slow = new Promise((resolve) => {
    const req = http.get({ host: url.hostname, port: url.port, path: filePath }, (res) => {
      res.pause(); // 받는 쪽이 멈춰 있는 상태
      setTimeout(() => {
        res.resume();
        res.on('data', () => {});
        res.on('end', resolve);
        res.on('error', resolve);
        res.on('close', resolve);
      }, 150);
    });
    req.on('error', resolve);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const removed = await call(base, 'DELETE', `/api/rooms/${room.code}/items/${up.data.item.id}`, { token: room.token });
  assert.equal(removed.data.removed, true);
  await slow;

  assert.equal((await call(base, 'GET', filePath)).status, 404);
  await waitFor(() => fs.readdirSync(path.join(dir, 'files', room.code)).length === 0);
  assert.equal((await call(base, 'GET', '/healthz')).text, 'ok');
  assert.equal((await upload(base, room, 'again.bin', Buffer.from('fine'))).status, 201);
});

test('본문 길이를 밝히지 않은 업로드는 받지 않는다', async (t) => {
  const { base, dir } = await boot(t);
  const room = await makeRoom(base);
  const url = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'POST',
        path: `/api/rooms/${room.code}/files`,
        headers: { Authorization: 'Bearer ' + room.token, 'X-File-Name': 'chunked.bin', 'Transfer-Encoding': 'chunked' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.end(Buffer.alloc(1000));
  });
  assert.equal(status, 411);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
});

// ---------------------------------------------------------------- 보안 검토에서 나온 문제들이 막혔는지

// 헤더만 먼저 보내고 본문은 나중에 보내는 요청 (본문을 기다리는 사이의 경쟁을 재현)
function slowJsonPost(base, pathname, body, delayMs, headers = {}) {
  return new Promise((resolve) => {
    const url = new URL(base + pathname);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'POST',
        path: url.pathname,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', () => resolve(0));
    req.flushHeaders();
    setTimeout(() => req.end(payload), delayMs);
  });
}

// 일부만 보내고 붙잡고 있는 업로드
function heldUpload(base, room, declared, sent) {
  const url = new URL(base);
  const req = http.request({
    host: url.hostname,
    port: url.port,
    method: 'POST',
    path: `/api/rooms/${room.code}/files`,
    headers: { Authorization: 'Bearer ' + room.token, 'X-File-Name': 'held.bin', 'Content-Length': declared },
  });
  req.on('error', () => {});
  const done = new Promise((resolve) => req.on('close', resolve));
  const started = new Promise((resolve) => req.write(Buffer.alloc(sent), resolve));
  return { started, abort: () => (req.destroy(), done) };
}

test('글도 수업방 한도 안에서만 쌓인다', async (t) => {
  const { base } = await boot(t, { maxRoomTextBytes: 1000, maxTextBytes: 600 });
  const room = await makeRoom(base);
  const items = `/api/rooms/${room.code}/items`;
  const post = (text) => call(base, 'POST', items, { token: room.token, json: { text } });

  const first = await post('가'.repeat(150)); // 450바이트
  assert.equal(first.status, 201);
  assert.equal((await post('나'.repeat(150))).status, 201);
  const third = await post('다'.repeat(40)); // 120바이트 → 합계 1020
  assert.equal(third.status, 413);
  assert.equal(third.data.error, 'text_full');
  assert.equal((await post('https://example.com/' + 'a'.repeat(90))).data.error, 'text_full'); // 링크도 포함
  assert.equal((await post('짧은 글')).status, 201);

  // 지우면 다시 쓸 수 있다
  await call(base, 'DELETE', `${items}/${first.data.item.id}`, { token: room.token });
  assert.equal((await post('다'.repeat(40))).status, 201);
  await call(base, 'DELETE', items, { token: room.token });
  assert.equal((await post('가'.repeat(190))).status, 201);
});

test('수업방 만들기 제한은 동시에 몰려도 넘지 못한다', async (t) => {
  const { base } = await boot(t);
  const statuses = await Promise.all(Array.from({ length: 80 }, () => slowJsonPost(base, '/api/rooms', { name: 'x' }, 250)));
  assert.equal(statuses.filter((s) => s === 201).length, 30);
  assert.equal(statuses.filter((s) => s === 429).length, 50);
});

test('받고 있는 업로드도 한도에 포함된다', async (t) => {
  const { base, dir } = await boot(t, { maxFileBytes: 1000, maxRoomBytes: 2000 });
  const room = await makeRoom(base);

  // 1000바이트짜리 두 개를 999바이트만 보낸 채 붙잡아 둔다
  const held = [heldUpload(base, room, 1000, 999), heldUpload(base, room, 1000, 999)];
  await Promise.all(held.map((h) => h.started));
  await waitFor(() => fs.readdirSync(path.join(dir, 'tmp')).length === 2);

  const blocked = await upload(base, room, 'c.bin', Buffer.alloc(500));
  assert.equal(blocked.status, 413);
  assert.equal(blocked.data.error, 'room_full');

  await Promise.all(held.map((h) => h.abort()));
  await waitFor(() => fs.readdirSync(path.join(dir, 'tmp')).length === 0);
  assert.equal((await upload(base, room, 'c.bin', Buffer.alloc(500))).status, 201); // 자리가 풀리면 다시 가능
  const snap = (await call(base, 'GET', `/api/rooms/${room.code}`, { token: room.token })).data;
  assert.equal(snap.usedBytes, 500);
});

test('한 수업방에서 동시에 받는 업로드 수 제한', async (t) => {
  const { base, dir, app } = await boot(t);
  const room = await makeRoom(base);
  const held = [1, 2, 3].map(() => heldUpload(base, room, 5000, 100));
  await Promise.all(held.map((h) => h.started));
  await waitFor(() => fs.readdirSync(path.join(dir, 'tmp')).length === 3);

  const busy = await upload(base, room, 'd.bin', Buffer.alloc(10));
  assert.equal(busy.status, 429);
  assert.equal(busy.data.error, 'upload_busy');

  // 받는 도중에 수업방을 지워도 깨끗이 정리된다
  assert.equal((await call(base, 'DELETE', `/api/rooms/${room.code}`, { token: room.token })).status, 200);
  await Promise.all(held.map((h) => h.abort()));
  await waitFor(() => fs.readdirSync(path.join(dir, 'tmp')).length === 0);
  assert.equal(app.store.pendingBytes, 0);
  assert.equal(app.store.totalBytes, 0);
});

test('IPv6는 /64 대역 단위로 접속 제한을 센다', async (t) => {
  const { base } = await boot(t, { trustProxy: 1 });
  const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
  for (let i = 0; i < 120; i += 1) {
    await call(base, 'GET', '/api/rooms/000000', from(`2001:db8:1:1::${(i + 1).toString(16)}`)); // 주소를 바꿔 가며 시도
  }
  assert.equal((await call(base, 'GET', '/api/rooms/000000', from('2001:db8:1:1:ffff::9'))).status, 429);
  assert.equal((await call(base, 'GET', '/api/rooms/000000', from('2001:db8:1:2::1'))).status, 404); // 다른 대역
});

test('다른 사이트가 시킨 요청은 받지 않고, 접속 제한 횟수에도 넣지 않는다', async (t) => {
  const { base } = await boot(t);
  const room = await makeRoom(base);
  for (const site of ['cross-site', 'same-site']) {
    const res = await call(base, 'GET', '/api/rooms/000000', { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(res.status, 403);
    assert.equal(res.data.error, 'cross_site');
  }
  for (let i = 0; i < 150; i += 1) await call(base, 'GET', '/api/rooms/000000', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal((await call(base, 'GET', '/api/rooms/000000')).status, 404); // 막히지 않았다
  assert.equal((await call(base, 'POST', '/api/rooms', { json: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);

  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`, { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
  // 화면과 파일 주소는 다른 사이트의 링크로도 열 수 있어야 한다
  assert.equal((await call(base, 'GET', `/${room.code}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
});

test('이미 수업방을 연 브라우저는 접속 제한에 걸려도 계속 쓸 수 있다', async (t) => {
  const { base } = await boot(t);
  const room = await makeRoom(base);
  const key = (await call(base, 'GET', `/api/rooms/${room.code}`)).data.key;
  for (let i = 0; i < 120; i += 1) await call(base, 'GET', '/api/rooms/000000');
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`)).status, 429);

  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}?k=${key}`)).status, 200);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}/poll?k=${key}`)).status, 200);
  assert.equal((await call(base, 'POST', `/api/rooms/${room.code}/here?k=${key}`, { json: { c: 'student-0001' } })).status, 200);
  const stream = await openEvents(base, room.code, `?k=${key}&c=student-0001`);
  assert.equal(stream.status, 200);
  stream.close();

  // 열쇠가 틀리면 예외가 아니다 (다른 수업방의 열쇠도 마찬가지)
  const other = await makeRoom(base);
  const otherKey = (await call(base, 'GET', `/api/rooms/${other.code}`, { token: other.token })).data.key;
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}?k=${otherKey}`)).status, 429);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}/poll?k=0000000000000000`)).status, 429);
  assert.equal((await call(base, 'GET', '/api/rooms/000000?k=' + key)).status, 429);
});

test('접속자 수는 생존 신호(here)로 센다', async (t) => {
  const { base, app } = await boot(t);
  const room = await makeRoom(base);
  const here = (body, token) => call(base, 'POST', `/api/rooms/${room.code}/here`, { token, json: body });

  assert.equal((await here({ c: 'student-aaa' })).data.viewers, 1);
  assert.equal((await here({ c: 'student-aaa' })).data.viewers, 1); // 같은 브라우저는 한 번만
  assert.equal((await here({ c: 'student-bbb' })).data.viewers, 2);
  assert.equal((await here({ c: 'teacher-zzz' }, room.token)).data.viewers, 2); // 선생님은 세지 않는다
  assert.equal((await here({ c: 'bad id!' })).data.viewers, 2);
  assert.equal((await here({})).data.viewers, 2);
  const beat = await here({ c: 'student-bbb', t: 0 }); // "나갑니다"
  assert.equal(beat.data.viewers, 1);
  assert.deepEqual(Object.keys(beat.data).sort(), ['boot', 'v', 'viewers']);

  // 실시간 연결로 보는 학생에게도 바뀐 수가 전달된다
  const host = await openEvents(base, room.code, '?role=host&c=teacher-zzz');
  assert.equal((await host.nextOf('hello')).data.viewers, 1);
  await here({ c: 'student-ccc' });
  assert.equal((await host.nextOf('viewers')).data.n, 2);

  // 소식이 끊기면 빠진다
  app.hub.sweepPresence(Date.now() + 76 * 1000);
  assert.equal((await host.nextOf('viewers')).data.n, 0);
  host.close();
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`)).data.viewers, 0);
});

test('깨진 글자가 든 파일 이름도 문제를 일으키지 않는다', async (t) => {
  const { base } = await boot(t);
  const room = await makeRoom(base);
  // 1024번째 글자에서 이모지가 반으로 잘리도록 만든 이름
  const up = await upload(base, room, 'a'.repeat(1019) + '.abc' + '😀', Buffer.from('data'));
  assert.equal(up.status, 201);
  const name = up.data.item.name;
  assert.ok(name.endsWith('.abc'));
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.equal((await call(base, 'GET', up.data.item.url)).status, 200);
  assert.equal((await call(base, 'GET', `/api/rooms/${room.code}`)).status, 200);

  // 글에 든 깨진 글자도 걸러진다
  const text = await call(base, 'POST', `/api/rooms/${room.code}/items`, {
    token: room.token,
    body: '{"text":"앞\\ud83d뒤"}',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(text.data.item.text, '앞뒤');
});

test('서비스 이름에 $ 가 있어도 화면이 깨지지 않는다', async (t) => {
  const { base } = await boot(t, { siteName: "Kim's $& room $` $1 $$" });
  const home = await call(base, 'GET', '/');
  assert.equal(home.text.match(/<!doctype html>/g).length, 1);
  assert.ok(!home.text.includes('{{SITE_NAME}}'));
  assert.ok(home.text.includes('Kim&#39;s $&#38; room $` $1 $$'));
});

test('가득 차면 한 번도 쓰지 않은 오래된 빈 수업방부터 비운다', async (t) => {
  const { base, app } = await boot(t, { maxRooms: 2 });
  const unused = await makeRoom(base, '안 쓴 방');
  const used = await makeRoom(base, '쓴 방');
  await call(base, 'POST', `/api/rooms/${used.code}/items`, { token: used.token, json: { text: '내용' } });
  assert.equal((await call(base, 'POST', '/api/rooms', { json: {} })).status, 503); // 방금 만든 방은 비우지 않는다

  const hoursAgo = Date.now() - 3 * 60 * 60 * 1000;
  app.store.getRoom(unused.code).createdAt = hoursAgo;
  app.store.getRoom(used.code).createdAt = hoursAgo;
  const fresh = await call(base, 'POST', '/api/rooms', { json: { name: '새 방' } });
  assert.equal(fresh.status, 201);
  assert.equal((await call(base, 'GET', `/api/rooms/${unused.code}`)).status, 404);
  assert.equal((await call(base, 'GET', `/api/rooms/${used.code}`)).status, 200); // 내용이 있는 방은 남는다
  assert.equal((await call(base, 'POST', '/api/rooms', { json: {} })).status, 503);
});

test('많은 연결이 전체 상태를 받다 멈춰도 메모리가 연결 수만큼 늘지 않는다', async (t) => {
  const { base, app } = await boot(t);
  const room = await makeRoom(base);
  for (let i = 0; i < 9; i += 1) {
    const res = await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: 'x'.repeat(100000) } });
    assert.equal(res.status, 201);
  }
  // 같은 상태에서는 항목 목록을 한 번만 만들어 모든 응답이 함께 쓴다
  const live = app.store.getRoom(room.code);
  assert.equal(app.store.itemsBuffer(live), app.store.itemsBuffer(live));
  const before = app.store.itemsBuffer(live);
  await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: '작은 글' } });
  assert.notEqual(app.store.itemsBuffer(live), before);
  const tenth = await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: 'x'.repeat(100000) } });
  assert.equal(tenth.status, 201);
  const eleventh = await call(base, 'POST', `/api/rooms/${room.code}/items`, { token: room.token, json: { text: 'x'.repeat(100000) } });
  assert.equal(eleventh.data.error, 'text_full'); // 글 전체 한도(1MB)

  const snap = await call(base, 'GET', `/api/rooms/${room.code}`);
  assert.equal(snap.data.items.length, 11);
  assert.ok(snap.buffer.length < 1.1 * 1024 * 1024);
});
