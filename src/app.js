'use strict';

// HTTP 서버: 화면(정적 파일), JSON API, 실시간 이벤트, 파일 올리기·내려받기

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { Store, publicItem } = require('./store');
const { Hub } = require('./hub');
const { RateLimiter } = require('./ratelimit');
const util = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// 저장소 오류 코드 → HTTP 상태
const STORE_STATUS = {
  too_many_items: 409,
  text_full: 413,
  file_too_large: 413,
  room_full: 413,
  server_full: 507,
  upload_busy: 429,
  too_many_rooms: 503,
  gone: 404,
};

const UPLOAD_MIN_BYTES_PER_SEC = 32 * 1024; // 이보다 느린 업로드는 끝까지 기다려 주지 않습니다
const PRESENCE_DEFAULT_SEC = 75;
const PRESENCE_MAX_SEC = 150;

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
    // true면 응답 뒤에도 연결을 유지하고 남은 요청 본문을 읽어서 버립니다.
    // (업로드 도중 거절할 때 브라우저가 오류 내용을 확실히 받도록 하기 위함)
    this.drain = false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function scanStatics(root) {
  const map = new Map();
  async function walk(dir, prefix) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, prefix + entry.name + '/');
      } else if (entry.isFile()) {
        const type = STATIC_TYPES[path.extname(entry.name).toLowerCase()];
        if (type) map.set(prefix + entry.name, { file: full, type });
      }
    }
  }
  await walk(root, '/');
  return map;
}

async function createApp(config) {
  const store = new Store(config);
  await store.init();
  const hub = new Hub();
  const statics = await scanStatics(PUBLIC_DIR);

  const limiters = {
    lookup: new RateLimiter(120, 5 * 60 * 1000), // 없는 수업방 코드 조회 (IP당)
    create: new RateLimiter(30, 60 * 60 * 1000), // 수업방 만들기 시도 (IP당)
    password: new RateLimiter(10, 10 * 60 * 1000), // 생성 비밀번호 오입력 (IP당)
  };

  // 서버가 켜질 때마다 바뀌는 값. 브라우저가 "서버가 다시 시작됐다"는 것을 알아채는 데 씁니다.
  const bootId = util.randomId().slice(0, 8);
  let listeningPort = config.port;
  let warnedProxy = false;

  // ------------------------------------------------------------ 공통 응답

  const pageHeaders = (() => {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ];
    const headers = {
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-Robots-Tag': 'noindex, nofollow',
    };
    if (!config.allowFraming) {
      csp.push("frame-ancestors 'none'");
      headers['X-Frame-Options'] = 'DENY';
    }
    headers['Content-Security-Policy'] = csp.join('; ');
    return headers;
  })();

  const siteTag = util.sha256hex(config.siteName).slice(0, 8);
  const siteNameHtml = escapeHtml(config.siteName);
  const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  function sendJson(res, status, body, headers) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({ 'Content-Length': data.length }, JSON_HEADERS, headers));
    res.end(data);
  }

  function fail(req, res, err) {
    if (res.destroyed || (res.socket && res.socket.destroyed)) return; // 상대가 이미 끊음
    if (res.headersSent) {
      res.destroy();
      return;
    }
    let status = 500;
    let code = 'server_error';
    let extra = null;
    let drain = false;
    if (err instanceof HttpError) {
      ({ status, code, extra, drain } = err);
    } else if (err && err.storeCode && STORE_STATUS[err.storeCode]) {
      status = STORE_STATUS[err.storeCode];
      code = err.storeCode;
    } else if (err && err.code === 'ENOSPC') {
      status = 507;
      code = 'server_full';
    } else {
      console.error(`[error] ${req.method} ${req.url}:`, err);
    }
    const headers = {};
    if (!req.complete && !drain) headers.Connection = 'close';
    if (extra && extra.retryAfter) headers['Retry-After'] = String(extra.retryAfter);
    sendJson(res, status, Object.assign({ error: code }, extra), headers);
  }

  // ------------------------------------------------------------ 요청 정보

  // 접속 제한을 셀 때 쓰는 방문자 구분 키
  function clientKey(req) {
    let ip = util.normalizeIp(req.socket.remoteAddress);
    const forwarded = req.headers['x-forwarded-for'];
    if (config.trustProxy > 0 && forwarded) {
      const hops = String(forwarded)
        .split(',')
        .map((part) => util.normalizeIp(part.trim()))
        .filter(Boolean);
      if (hops.length) ip = hops[Math.max(0, hops.length - config.trustProxy)];
    } else if (forwarded && !warnedProxy) {
      warnedProxy = true;
      console.warn(
        '[안내] 프록시 뒤에서 실행 중인 것으로 보입니다. 접속 제한이 방문자별로 적용되도록 TRUST_PROXY=1 을 설정하세요.'
      );
    }
    return util.rateKey(ip);
  }

  // 다른 사이트의 페이지가 방문자의 브라우저를 시켜 보낸 요청인지. (요즘 브라우저는 모두 이 헤더를 보냅니다)
  // API는 이 사이트의 화면에서만 쓰므로, 그런 요청은 받지 않습니다. 접속 제한 횟수에도 넣지 않습니다.
  function isCrossSite(req) {
    const site = req.headers['sec-fetch-site'];
    return Boolean(site) && site !== 'same-origin' && site !== 'none';
  }

  function bearer(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return '';
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return m ? m[1] : '';
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        reject(new HttpError(413, 'too_large'));
        return;
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      const done = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.off('data', onData);
        if (err) reject(err);
        else resolve(value);
      };
      const onData = (chunk) => {
        size += chunk.length;
        if (size > limit) done(new HttpError(413, 'too_large'));
        else chunks.push(chunk);
      };
      const timer = setTimeout(() => done(new HttpError(408, 'timeout')), 20 * 1000);
      req.on('data', onData);
      req.on('end', () => done(null, Buffer.concat(chunks)));
      req.on('error', (err) => done(err));
      req.on('close', () => done(new HttpError(400, 'aborted')));
    });
  }

  async function readJson(req, limit) {
    const buffer = await readBody(req, limit);
    if (!buffer.length) return {};
    try {
      const value = JSON.parse(buffer.toString('utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch (err) {
      // 아래에서 처리
    }
    throw new HttpError(400, 'bad_request');
  }

  // ------------------------------------------------------------ 라우팅

  async function handle(req, res) {
    let url;
    try {
      url = new URL('http://localhost' + req.url);
    } catch (err) {
      throw new HttpError(400, 'bad_request');
    }
    const { pathname } = url;

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('ok');
      return;
    }
    if (pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (pathname.startsWith('/f/')) return handleFile(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    return handlePage(req, res, url);
  }

  async function handleApi(req, res, url) {
    if (isCrossSite(req)) throw new HttpError(403, 'cross_site');
    const { pathname } = url;
    if (pathname === '/api/config') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return sendJson(res, 200, publicConfig(req));
    }
    if (pathname === '/api/rooms') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      return createRoom(req, res);
    }
    const m = /^\/api\/rooms\/(\d{6})(?:\/(.*))?$/.exec(pathname);
    if (!m) throw new HttpError(404, 'not_found');
    return handleRoom(req, res, url, m[1], m[2] || '');
  }

  // ------------------------------------------------------------ 설정·수업방 만들기

  function publicConfig(req) {
    // 선생님 컴퓨터에서 localhost로 직접 열었을 때만, 학생에게 알려 줄 내부망 주소를 함께 보냅니다.
    // (프록시를 거쳐 온 요청에는 내부 주소를 알려 주지 않습니다)
    const headers = req.headers;
    const local =
      !config.publicUrl &&
      util.isLoopback(req.socket.remoteAddress) &&
      req.httpVersion !== '1.0' &&
      !headers['x-forwarded-for'] &&
      !headers['x-forwarded-host'] &&
      !headers['x-real-ip'] &&
      !headers.forwarded &&
      !headers.via &&
      /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(headers.host || '').toLowerCase());
    return {
      siteName: config.siteName,
      requirePassword: Boolean(config.teacherPassword),
      transport: 'sse', // 실시간 스트림 사용 (막히면 화면이 알아서 주기 확인으로 바꿉니다)
      upload: 'direct', // 파일을 이 서버로 바로 올림
      maxFileBytes: config.maxFileBytes,
      maxRoomBytes: config.maxRoomBytes,
      maxTextBytes: config.maxTextBytes,
      maxRoomTextBytes: config.maxRoomTextBytes,
      maxItems: config.maxItems,
      roomTtlMs: config.roomTtlMs,
      publicUrl: config.publicUrl || null,
      lanUrls: local ? util.lanAddresses().map((ip) => `http://${ip}:${listeningPort}`) : [],
    };
  }

  async function createRoom(req, res) {
    const key = clientKey(req);
    if (limiters.create.blocked(key)) {
      throw new HttpError(429, 'too_many_attempts', { retryAfter: limiters.create.retryAfter(key) });
    }
    // 본문을 기다리는 동안 다른 요청이 끼어들어 한도를 넘기지 못하도록, 시도 자체를 먼저 셉니다.
    limiters.create.hit(key);
    const body = await readJson(req, 8 * 1024);

    if (config.teacherPassword) {
      if (limiters.password.blocked(key)) {
        throw new HttpError(429, 'too_many_attempts', { retryAfter: limiters.password.retryAfter(key) });
      }
      const given = typeof body.password === 'string' ? body.password : '';
      if (!util.safeEqual(given, config.teacherPassword)) {
        limiters.password.hit(key);
        throw new HttpError(403, 'bad_password');
      }
    }

    if (store.rooms.size >= config.maxRooms) {
      // 가득 찼으면, 한 번도 쓰지 않고 방치된 빈 수업방 하나를 비워 자리를 만듭니다.
      const unused = store.pickUnused((code) => hub.rooms.has(code) || hub.viewers(code) > 0);
      if (!unused) throw new HttpError(503, 'too_many_rooms');
      hub.closeRoom(unused.code);
      store.deleteRoom(unused).catch((err) => console.error('[store]', err));
    }

    const { room, token } = store.createRoom(typeof body.name === 'string' ? body.name : '');
    sendJson(res, 201, { code: room.code, name: room.name, token });
  }

  // ------------------------------------------------------------ 수업방 API

  const SNAPSHOT_TAIL = Buffer.from('}');
  const HELLO_HEAD = Buffer.from('event: hello\ndata: ');
  const FRAME_END = Buffer.from('\n\n');

  // 수업방 전체 상태(JSON)의 앞부분. 항목 목록은 저장소가 만들어 둔 Buffer를 그대로 이어 붙입니다.
  function snapshotHead(room, isHost) {
    let head =
      `{"code":"${room.code}","name":${JSON.stringify(room.name)},"v":${room.version},"boot":"${bootId}"` +
      `,"key":"${room.readKey}","viewers":${hub.viewers(room.code)}`;
    if (isHost !== undefined) {
      head += `,"isHost":${isHost ? 'true' : 'false'}`;
      if (isHost) head += `,"usedBytes":${room.bytes}`;
    }
    return Buffer.from(head + ',"items":');
  }

  function sendSnapshot(res, room, isHost) {
    const head = snapshotHead(room, isHost);
    const items = store.itemsBuffer(room);
    res.writeHead(
      200,
      Object.assign({ 'Content-Length': head.length + items.length + SNAPSHOT_TAIL.length }, JSON_HEADERS)
    );
    res.write(head);
    res.write(items);
    res.end(SNAPSHOT_TAIL);
  }

  function presenceId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(value) ? value : '';
  }

  async function handleRoom(req, res, url, code, rest) {
    const key = clientKey(req);
    const room = store.getRoom(code);
    if (!room && store.failed.has(code)) throw new HttpError(503, 'unavailable');
    const isHost = room ? store.verifyHost(room, bearer(req)) : false;

    // 이미 이 수업방을 열어 본 브라우저는 그때 받은 열쇠(k)를 함께 보냅니다. 그런 요청과 선생님 요청은 접속 제한에서 뺍니다.
    // (같은 학교·교실은 인터넷 주소 하나를 함께 쓰는 일이 많아서, 누군가 제한에 걸려도 수업 중인 화면은 끊기지 않게)
    const known = isHost || (room !== null && util.safeEqual(url.searchParams.get('k') || '', room.readKey));
    if (!known) {
      // 코드를 마구 넣어 보며 수업방을 찾는 시도를 막습니다.
      if (limiters.lookup.blocked(key)) {
        throw new HttpError(429, 'too_many_attempts', { retryAfter: limiters.lookup.retryAfter(key) });
      }
      if (!room) {
        limiters.lookup.hit(key);
        throw new HttpError(404, 'not_found');
      }
    }

    const method = req.method;
    const requireHost = () => {
      if (!isHost) throw new HttpError(403, 'forbidden');
    };

    if (rest === '') {
      if (method === 'GET') {
        store.touch(room);
        return sendSnapshot(res, room, isHost);
      }
      if (method === 'PATCH') {
        requireHost();
        const body = await readJson(req, 8 * 1024);
        if (typeof body.name !== 'string') throw new HttpError(400, 'bad_request');
        store.renameRoom(room, body.name);
        hub.broadcast(code, 'room', { v: room.version, name: room.name });
        return sendJson(res, 200, { v: room.version, name: room.name });
      }
      if (method === 'DELETE') {
        requireHost();
        hub.closeRoom(code);
        await store.deleteRoom(room);
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(405, 'method_not_allowed');
    }

    // 바뀐 것이 있는지만 확인하는 가벼운 요청 (실시간 연결을 쓸 수 없는 환경에서 몇 초마다 호출)
    if (rest === 'poll') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return sendJson(res, 200, { v: room.version, boot: bootId });
    }

    // "아직 보고 있어요" 신호. 접속자 수 집계에 씁니다.
    if (rest === 'here') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      const body = await readJson(req, 1024);
      const id = presenceId(body.c);
      if (id) {
        const seconds = Number.isFinite(body.t) ? body.t : PRESENCE_DEFAULT_SEC;
        if (seconds <= 0) hub.leave(code, id);
        else hub.touch(code, id, isHost, Math.min(PRESENCE_MAX_SEC, Math.max(10, seconds)) * 1000);
      }
      return sendJson(res, 200, { v: room.version, boot: bootId, viewers: hub.viewers(code) });
    }

    if (rest === 'events') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return openEvents(req, res, url, room);
    }

    if (rest === 'items') {
      if (method === 'POST') {
        requireHost();
        const body = await readJson(req, config.maxTextBytes * 6 + 4096);
        const text = util.cleanText(body.text);
        if (!text.trim()) throw new HttpError(400, 'empty');
        if (Buffer.byteLength(text) > config.maxTextBytes) throw new HttpError(413, 'text_too_long');
        const item = store.addText(room, text, body.mono === true);
        const out = publicItem(item, code);
        hub.broadcast(code, 'add', { v: room.version, item: out });
        return sendJson(res, 201, { v: room.version, item: out });
      }
      if (method === 'DELETE') {
        requireHost();
        const removed = store.clearItems(room);
        if (removed) hub.broadcast(code, 'clear', { v: room.version });
        return sendJson(res, 200, { v: room.version, removed });
      }
      throw new HttpError(405, 'method_not_allowed');
    }

    if (rest === 'files') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      requireHost();
      return uploadFile(req, res, room);
    }

    const itemMatch = /^items\/([a-f0-9]{32})$/.exec(rest);
    if (itemMatch) {
      if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed');
      requireHost();
      const removed = store.removeItem(room, itemMatch[1]);
      if (removed) hub.broadcast(code, 'remove', { v: room.version, id: removed.id });
      return sendJson(res, 200, { v: room.version, removed: Boolean(removed) });
    }

    throw new HttpError(404, 'not_found');
  }

  function openEvents(req, res, url, room) {
    if (!hub.canAccept(room.code)) throw new HttpError(503, 'busy');
    store.touch(room);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // nginx 계열 프록시가 모아서 보내지 않도록
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    if (req.socket.setNoDelay) req.socket.setNoDelay(true);
    // 일부 프록시·보안 프로그램은 일정량이 쌓여야 전달을 시작하므로 앞에 빈 주석을 채워 보냅니다.
    res.write(`:${' '.repeat(2048)}\nretry: 2000\n\n`);
    const client = hub.add(
      room.code,
      res,
      url.searchParams.get('role') === 'host',
      presenceId(url.searchParams.get('c'))
    );
    hub.write(client, [HELLO_HEAD, snapshotHead(room), store.itemsBuffer(room), SNAPSHOT_TAIL, FRAME_END]);
  }

  async function uploadFile(req, res, room) {
    const lengthHeader = req.headers['content-length'];
    const size = Number(lengthHeader);
    if (lengthHeader === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw new HttpError(411, 'length_required');
    }

    const reject = (status, code) => {
      const err = new HttpError(status, code);
      err.drain = true;
      return err;
    };
    if (size === 0) throw reject(400, 'empty_file');

    let rawName = '';
    try {
      rawName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    } catch (err) {
      throw reject(400, 'bad_request');
    }
    const name = util.sanitizeFileName(rawName) || '파일';

    let reservation;
    try {
      reservation = store.reserveUpload(room, size);
    } catch (err) {
      if (err.storeCode && STORE_STATUS[err.storeCode]) throw reject(STORE_STATUS[err.storeCode], err.storeCode);
      throw err;
    }

    const id = util.randomId();
    const tmpPath = store.tmpPath(id);
    // 아주 조금씩 보내면서 자리를 계속 붙잡아 두지 못하도록, 크기에 비례한 전체 시간 제한을 둡니다.
    const deadline = setTimeout(
      () => req.destroy(new Error('upload timed out')),
      (120 + Math.ceil(size / UPLOAD_MIN_BYTES_PER_SEC)) * 1000
    );
    try {
      await pipeline(req, fs.createWriteStream(tmpPath, { flags: 'wx' }));
      const stat = await fsp.stat(tmpPath);
      if (stat.size !== size) throw new HttpError(400, 'bad_request');
      const item = await store.commitUpload(room, reservation, { id, name, tmpPath });
      const out = publicItem(item, room.code);
      hub.broadcast(room.code, 'add', { v: room.version, item: out });
      sendJson(res, 201, { v: room.version, item: out });
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    } finally {
      clearTimeout(deadline);
      reservation.release();
    }
  }

  // ------------------------------------------------------------ 파일 내려받기

  async function handleFile(req, res, url) {
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');

    const m = /^\/f\/(\d{6})\/([a-f0-9]{32})(?:\/[^/]*)?$/.exec(url.pathname);
    const room = m ? store.getRoom(m[1]) : null;
    const item = room ? room.items.find((it) => it.id === m[2] && it.type === 'file') : null;
    if (!item) throw new HttpError(404, 'not_found');

    const filePath = store.filePath(room, item.id);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (err) {
      throw new HttpError(404, 'not_found');
    }
    store.touch(room);

    // 기본은 항상 "다운로드". 안전한 형식에 한해 ?inline 으로 브라우저에서 바로 엽니다.
    const info = util.fileInfo(item.name);
    const inline = info.inline && url.searchParams.has('inline');
    const headers = {
      'Content-Type': inline ? info.mime : 'application/octet-stream',
      'Content-Disposition': util.contentDisposition(inline ? 'inline' : 'attachment', item.name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    };
    // 이미지·영상·PDF 뷰어는 그대로 두고, 그 밖의 응답은 어떤 경우에도 스크립트가 돌지 못하게 막습니다.
    const viewerKind = inline && info.kind !== 'text';
    if (!viewerKind) headers['Content-Security-Policy'] = "sandbox; default-src 'none'";

    if (stat.size === 0) {
      headers['Content-Length'] = 0;
      res.writeHead(200, headers);
      res.end();
      return;
    }

    let status = 200;
    let start = 0;
    let end = stat.size - 1;
    const range = util.parseRange(req.headers.range, stat.size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (range) {
      status = 206;
      ({ start, end } = range);
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (method === 'HEAD') {
      res.end();
      return;
    }
    try {
      await pipeline(fs.createReadStream(filePath, { start, end }), res);
    } catch (err) {
      if (!res.destroyed) res.destroy(); // 받는 쪽이 중간에 끊었거나 파일을 읽지 못함
    }
  }

  // ------------------------------------------------------------ 화면·정적 파일

  async function handlePage(req, res, url) {
    let { pathname } = url;
    if (pathname === '/') return sendStatic(req, res, statics.get('/index.html'), true);
    if (/^\/\d{6}$/.test(pathname)) return sendStatic(req, res, statics.get('/room.html'), true);
    // 관리자 페이지는 Vercel용에만 있습니다. 여기서는 화면이 "지원하지 않는다"고 안내합니다.
    if (pathname === '/admin') return sendStatic(req, res, statics.get('/admin.html'), true);
    if (pathname === '/favicon.ico') pathname = '/assets/favicon.svg';

    const entry = statics.get(pathname);
    if (entry && !pathname.endsWith('.html')) return sendStatic(req, res, entry, false);

    // "/483 920", "/483-920", "/483920/" 처럼 적어도 수업방으로 보냅니다.
    let decoded = '';
    try {
      decoded = decodeURIComponent(pathname.slice(1));
    } catch (err) {
      decoded = '';
    }
    const digits = decoded.replace(/[\s\-_./]/g, '');
    if (decoded.length <= 16 && /^\d{6}$/.test(digits)) {
      res.writeHead(302, { Location: '/' + digits, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    return sendStatic(req, res, statics.get('/404.html'), true, 404);
  }

  async function sendStatic(req, res, entry, isPage, status = 200) {
    if (!entry) throw new HttpError(404, 'not_found');
    const stat = await fsp.stat(entry.file);
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}${isPage ? '-' + siteTag : ''}"`;
    const headers = Object.assign(
      {
        'Content-Type': entry.type,
        'Cache-Control': 'no-cache',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      },
      isPage ? pageHeaders : null
    );
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let data = await fsp.readFile(entry.file);
    if (isPage) {
      // 바꿔 넣을 값을 함수로 넘겨야 이름에 든 "$" 가 특수 기호로 해석되지 않습니다.
      data = Buffer.from(data.toString('utf8').replace(/\{\{SITE_NAME\}\}/g, () => siteNameHtml));
    }
    headers['Content-Length'] = data.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  // ------------------------------------------------------------ 서버·주기 작업

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => fail(req, res, err));
  });
  server.requestTimeout = 0; // 큰 파일은 오래 걸릴 수 있습니다. 멈춘 연결은 아래 유휴 제한으로 정리합니다.
  server.headersTimeout = 70 * 1000;
  server.keepAliveTimeout = 65 * 1000;
  server.setTimeout(120 * 1000);
  server.maxConnections = 5000; // 연결이 비정상적으로 몰려도 프로세스가 버티도록
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') listeningPort = address.port;
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  async function sweep(now = Date.now()) {
    // 누군가 보고 있는 수업방은 사용 중으로 칩니다.
    for (const code of new Set([...hub.rooms.keys(), ...hub.presence.keys()])) {
      const room = store.getRoom(code);
      if (room && (hub.rooms.has(code) || hub.viewers(code, now) > 0)) store.touch(room, now);
    }
    const expired = await store.sweep(now);
    for (const code of expired) hub.closeRoom(code);
    for (const limiter of Object.values(limiters)) limiter.sweep(now);
    return expired;
  }

  const pingTimer = setInterval(() => hub.ping(), 25 * 1000);
  const presenceTimer = setInterval(() => hub.sweepPresence(), 1000);
  const sweepTimer = setInterval(() => {
    sweep().catch((err) => console.error('[sweep]', err));
  }, 5 * 60 * 1000);
  pingTimer.unref();
  presenceTimer.unref();
  sweepTimer.unref();

  async function close() {
    clearInterval(pingTimer);
    clearInterval(presenceTimer);
    clearInterval(sweepTimer);
    hub.closeAll();
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
    await store.flush();
  }

  return { server, store, hub, config, sweep, close, port: () => listeningPort };
}

module.exports = { createApp };
