'use strict';

// Vercel용 API 처리기. 서버리스 함수 하나(api/index.js)가 /api/* 요청을 모두 받습니다.
//
// 자체 서버(src/app.js)와 같은 주소·응답 모양을 쓰되, 다음이 다릅니다.
//   - 상태 저장: 메모리·디스크 대신 Redis (src/vercel/rooms.js)
//   - 실시간 전달: 스트림 대신 "바뀐 것 있나요?" 확인(poll). 응답을 CDN이 몇 초 캐시하므로
//     학생이 많아도 함수는 수업방마다 몇 초에 한 번만 실행됩니다.
//   - 파일: 브라우저가 파일 저장소(Vercel Blob)로 직접 올리고, 이 함수는 허가증 발급과 등록만 합니다.
//     (함수가 받을 수 있는 요청 크기는 몇 MB뿐이라 파일을 거쳐 보낼 수 없습니다)

const util = require('../util');
const { createRooms } = require('./rooms');

const STORE_STATUS = {
  too_many_items: 409,
  text_full: 413,
  file_too_large: 413,
  room_full: 413,
  too_many_rooms: 503,
};

const LOOKUP_MAX = 120; // 없는 코드 조회: 5분에 이만큼까지
const LOOKUP_WINDOW_SEC = 5 * 60;
const CREATE_MAX = 30; // 수업방 만들기 시도: 1시간에
const CREATE_WINDOW_SEC = 60 * 60;
const PASSWORD_MAX = 10; // 비밀번호 오입력: 10분에
const PASSWORD_WINDOW_SEC = 10 * 60;

const PRESENCE_MAX_SEC = 300;
const UPLOAD_TICKET_SEC = 2 * 60 * 60;
// 브라우저에서 바로 열어도 되는 텍스트 형식에서 제외할 것 (파일 저장소 주소에서 웹 페이지로 실행될 수 있는 형식)
const NO_INLINE_EXT = new Set(['html', 'htm', 'xml']);

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

function createHandler({ kv, blob, config, now = () => Date.now() }) {
  const rooms = createRooms({ kv, config, now });

  // ------------------------------------------------------------ 응답

  const NO_STORE = { 'Cache-Control': 'no-store' };

  // CDN만 seconds초 동안 보관하고 브라우저는 매번 다시 묻게 합니다.
  function cdnCache(seconds) {
    return {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'CDN-Cache-Control': `public, s-maxage=${seconds}`,
      'Vercel-CDN-Cache-Control': `public, s-maxage=${seconds}`,
    };
  }

  function sendJson(res, status, body, headers) {
    const data = Buffer.from(JSON.stringify(body));
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', data.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const extra = headers || NO_STORE;
    for (const name of Object.keys(extra)) res.setHeader(name, extra[name]);
    res.end(data);
  }

  function fail(req, res, err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    let status = 500;
    let code = 'server_error';
    let extra = null;
    if (err instanceof HttpError) {
      ({ status, code, extra } = err);
    } else if (err && err.storeCode && STORE_STATUS[err.storeCode]) {
      status = STORE_STATUS[err.storeCode];
      code = err.storeCode;
    } else if (err && err.storageCode) {
      // 파일 저장소(Blob) 쪽 문제. 파일을 다루는 요청은 선생님만 보낼 수 있으므로, 원인을 함께 알려 줍니다.
      status = err.storageCode === 'storage_error' ? 502 : 503;
      code = err.storageCode;
      extra = { detail: String(err.message || '').slice(0, 300) };
      console.error(`[storage] ${req.method} ${req.url}: ${code}: ${err.message}`);
    } else {
      console.error(`[error] ${req.method} ${req.url}:`, err);
    }
    const headers = Object.assign({}, NO_STORE);
    if (extra && extra.retryAfter) headers['Retry-After'] = String(extra.retryAfter);
    sendJson(res, status, Object.assign({ error: code }, extra), headers);
  }

  // ------------------------------------------------------------ 요청

  function parseUrl(req) {
    let url;
    try {
      url = new URL('http://localhost' + req.url);
    } catch (err) {
      throw new HttpError(400, 'bad_request');
    }
    // vercel.json의 rewrite는 모든 /api/* 요청을 /api/index 로 보내면서 원래 경로를 __path에 담아 줍니다.
    // 플랫폼이 원래 주소를 그대로 넘겨 주는 경우에는 그 주소를 쓰고, __path는 /api/index 로 들어왔을 때만 믿습니다.
    const forwarded = url.searchParams.get('__path');
    url.searchParams.delete('__path');
    if (forwarded !== null && (url.pathname === '/api/index' || url.pathname === '/api')) {
      url.pathname = '/api/' + forwarded.replace(/^\/+/, '');
    }
    return url;
  }

  // Vercel은 방문자의 실제 주소를 이 헤더들에 넣어 주며, 방문자가 보낸 값은 덮어씁니다.
  function clientKey(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    const ip = String(req.headers['x-real-ip'] || forwarded || (req.socket && req.socket.remoteAddress) || 'unknown');
    return util.rateKey(ip);
  }

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

  function parseJsonObject(text) {
    if (!text) return {};
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch (err) {
      // 아래에서 처리
    }
    throw new HttpError(400, 'bad_request');
  }

  async function readJson(req, limit) {
    // Vercel의 Node 함수는 본문을 미리 읽어 req.body에 넣어 주기도 합니다.
    let preset;
    try {
      preset = req.body;
    } catch (err) {
      throw new HttpError(400, 'bad_request');
    }
    // (Content-Type 없이 온 요청은 빈 문자열이 들어 있으므로, 그때는 아래에서 본문을 직접 읽습니다)
    if (preset !== undefined && preset !== null && preset !== '') {
      if (Buffer.isBuffer(preset)) return parseJsonObject(preset.toString('utf8'));
      if (typeof preset === 'string') return parseJsonObject(preset);
      if (typeof preset === 'object' && !Array.isArray(preset)) return preset;
      throw new HttpError(400, 'bad_request');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'too_large');
      chunks.push(chunk);
    }
    return parseJsonObject(Buffer.concat(chunks).toString('utf8'));
  }

  // ------------------------------------------------------------ 표시용 변환

  // 같은 코드로 수업방이 새로 만들어졌는지 브라우저가 알아챌 수 있게 하는 값
  function bootOf(createdAt) {
    return createdAt.toString(36);
  }

  // 수업방의 파일이 저장되는 폴더. 만든 시각을 넣어, 나중에 같은 코드가 다시 쓰여도 섞이지 않게 합니다.
  function folderOf(code, createdAt) {
    return `rooms/${code}-${bootOf(createdAt)}`;
  }

  function publicItem(item) {
    if (item.type === 'link') return { id: item.id, type: 'link', at: item.at, url: item.url };
    if (item.type === 'file') {
      const info = util.fileInfo(item.name);
      const canOpen = info.inline && !NO_INLINE_EXT.has(info.ext);
      return {
        id: item.id,
        type: 'file',
        at: item.at,
        name: item.name,
        size: item.size,
        kind: info.kind,
        ext: info.ext,
        url: item.url + (item.url.includes('?') ? '&' : '?') + 'download=1',
        openUrl: canOpen ? item.url : null,
      };
    }
    return { id: item.id, type: 'text', at: item.at, text: item.text, mono: Boolean(item.mono) };
  }

  function publicConfig() {
    return {
      siteName: config.siteName,
      requirePassword: Boolean(config.teacherPassword),
      transport: 'poll',
      upload: 'blob',
      pollMs: config.pollMs,
      presenceMs: config.presenceMs,
      maxFileBytes: config.maxFileBytes,
      maxRoomBytes: config.maxRoomBytes,
      maxTextBytes: config.maxTextBytes,
      maxRoomTextBytes: config.maxRoomTextBytes,
      maxItems: config.maxItems,
      roomTtlMs: config.roomTtlMs,
      publicUrl: config.publicUrl || null,
      lanUrls: [],
      build: config.build || null,
      // 만료된 수업방의 파일을 지우는 매일 정리 작업이 켜져 있는지 (CRON_SECRET 을 등록해야 켜집니다)
      cleanup: Boolean(config.cronSecret),
    };
  }

  // ------------------------------------------------------------ 접속 제한

  // 열쇠 없이 들어온 수업방 조회. 없는 코드를 계속 넣어 보는 시도를 막습니다.
  async function guardLookup(req, exists) {
    const key = clientKey(req);
    const misses = await rooms.count('m', key);
    if (misses >= LOOKUP_MAX) throw new HttpError(429, 'too_many_attempts', { retryAfter: LOOKUP_WINDOW_SEC });
    if (!exists) {
      await rooms.hit('m', key, LOOKUP_WINDOW_SEC);
      throw new HttpError(404, 'not_found');
    }
  }

  // ------------------------------------------------------------ 라우팅

  async function route(req, res) {
    const url = parseUrl(req);
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) throw new HttpError(404, 'not_found');

    if (pathname === '/api/cron/cleanup') return cleanup(req, res);
    // API는 이 사이트의 화면에서만 씁니다. 다른 사이트가 방문자의 브라우저를 시켜 보낸 요청은 받지 않습니다.
    if (isCrossSite(req)) throw new HttpError(403, 'cross_site');

    if (pathname === '/api/config') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return sendJson(res, 200, publicConfig(), cdnCache(60));
    }
    if (pathname === '/api/rooms') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      return createRoom(req, res);
    }
    const m = /^\/api\/rooms\/(\d{6})(?:\/(.*))?$/.exec(pathname);
    if (!m) throw new HttpError(404, 'not_found');
    return handleRoom(req, res, url, m[1], m[2] || '');
  }

  async function createRoom(req, res) {
    const key = clientKey(req);
    // 시도 자체를 먼저 세어, 동시에 몰려도 한도를 넘지 못하게 합니다.
    const attempts = await rooms.hit('c', key, CREATE_WINDOW_SEC);
    if (attempts > CREATE_MAX) throw new HttpError(429, 'too_many_attempts', { retryAfter: CREATE_WINDOW_SEC });
    const body = await readJson(req, 8 * 1024);

    if (config.teacherPassword) {
      if ((await rooms.count('p', key)) >= PASSWORD_MAX) {
        throw new HttpError(429, 'too_many_attempts', { retryAfter: PASSWORD_WINDOW_SEC });
      }
      const given = typeof body.password === 'string' ? body.password : '';
      if (!util.safeEqual(given, config.teacherPassword)) {
        await rooms.hit('p', key, PASSWORD_WINDOW_SEC);
        throw new HttpError(403, 'bad_password');
      }
    }
    const { code, token, room } = await rooms.create(typeof body.name === 'string' ? body.name : '');
    sendJson(res, 201, { code, name: room.name, token });
  }

  async function handleRoom(req, res, url, code, rest) {
    const method = req.method;
    const givenKey = url.searchParams.get('k') || '';

    // 가장 자주 불리는 요청. Redis 명령 하나로 끝냅니다.
    if (rest === 'poll') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      const info = await rooms.peek(code);
      const knownPoll = Boolean(info) && util.safeEqual(givenKey, info.readKey);
      if (!knownPoll) await guardLookup(req, Boolean(info));
      // 열쇠가 든 주소는 그 수업방 학생들이 똑같이 쓰므로 CDN이 함께 캐시할 수 있습니다.
      return sendJson(
        res,
        200,
        { v: info.version, boot: bootOf(info.createdAt) },
        knownPoll ? cdnCache(config.pollCacheSec) : NO_STORE
      );
    }

    if (rest === '' && method === 'GET') return snapshot(req, res, url, code, givenKey);

    const room = await rooms.get(code);
    const isHost = room ? rooms.verifyHost(room, bearer(req)) : false;
    const known = isHost || (room !== null && util.safeEqual(givenKey, room.readKey));
    if (!known) await guardLookup(req, room !== null);
    const requireHost = () => {
      if (!isHost) throw new HttpError(403, 'forbidden');
    };
    const boot = bootOf(room.createdAt);

    if (rest === '') {
      if (method === 'PATCH') {
        requireHost();
        const body = await readJson(req, 8 * 1024);
        if (typeof body.name !== 'string') throw new HttpError(400, 'bad_request');
        const renamed = await rooms.rename(room, body.name);
        return sendJson(res, 200, { v: renamed.version, name: renamed.name });
      }
      if (method === 'DELETE') {
        requireHost();
        const items = await rooms.remove(code);
        await removeFiles(items);
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(405, 'method_not_allowed');
    }

    if (rest === 'here') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      const body = await readJson(req, 1024);
      const id = typeof body.c === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(body.c) ? body.c : '';
      const seconds = Number.isFinite(body.t) ? Math.min(PRESENCE_MAX_SEC, Math.max(0, body.t)) : 75;
      const viewers = await rooms.here(code, id, isHost, seconds, isHost);
      const out = { v: room.version, boot };
      if (isHost) out.viewers = viewers; // 접속자 수는 선생님 화면에만 필요합니다
      return sendJson(res, 200, out);
    }

    if (rest === 'items') {
      if (method === 'POST') {
        requireHost();
        const body = await readJson(req, config.maxTextBytes * 6 + 4096);
        const text = util.cleanText(body.text);
        if (!text.trim()) throw new HttpError(400, 'empty');
        if (Buffer.byteLength(text) > config.maxTextBytes) throw new HttpError(413, 'text_too_long');
        const added = await rooms.addText(room, text, body.mono === true);
        return sendJson(res, 201, { v: added.version, item: publicItem(added.item) });
      }
      if (method === 'DELETE') {
        requireHost();
        const cleared = await rooms.clear(room);
        await removeFiles(cleared.items);
        return sendJson(res, 200, { v: cleared.version, removed: cleared.items.length });
      }
      throw new HttpError(405, 'method_not_allowed');
    }

    // 파일 올리기 1단계: 허가증 발급. 브라우저는 이것으로 파일 저장소에 직접 올립니다.
    if (rest === 'upload') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      requireHost();
      const body = await readJson(req, 8 * 1024);
      const size = Number(body.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'bad_request');
      if (size === 0) throw new HttpError(400, 'empty_file');
      if (size > config.maxFileBytes) throw new HttpError(413, 'file_too_large');
      if (room.bytes + size > config.maxRoomBytes) throw new HttpError(413, 'room_full');
      if ((await rooms.itemCount(code)) >= config.maxItems) throw new HttpError(409, 'too_many_items');

      const name = util.sanitizeFileName(typeof body.name === 'string' ? body.name : '') || '파일';
      const id = util.randomId();
      const pathname = `${folderOf(code, room.createdAt)}/${id}/${name}`;
      const ticket = await blob.uploadTicket({ pathname, size, validUntil: now() + 60 * 60 * 1000 });
      await kv.cmd('SET', `u:${code}:${id}`, JSON.stringify({ name, size, pathname }), 'EX', UPLOAD_TICKET_SEC);
      // 브라우저는 uploadUrl로 파일을 PUT(머리글 포함)한 뒤, id를 가지고 등록을 요청합니다.
      return sendJson(res, 200, { id, uploadUrl: ticket.url, headers: ticket.headers });
    }

    // 파일 올리기 2단계: 다 올린 파일을 수업방 항목으로 등록
    if (rest === 'files') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      requireHost();
      const body = await readJson(req, 1024);
      const id = typeof body.id === 'string' && /^[a-f0-9]{32}$/.test(body.id) ? body.id : '';
      if (!id) throw new HttpError(400, 'bad_request');
      const ticketKey = `u:${code}:${id}`;
      const raw = await kv.cmd('GET', ticketKey);
      if (!raw) throw new HttpError(404, 'upload_not_found');
      const ticket = JSON.parse(raw);

      // 브라우저가 알려 준 값이 아니라 저장소에 실제로 올라간 것을 확인합니다.
      const stored = await blob.head(ticket.pathname);
      if (!stored) throw new HttpError(409, 'upload_missing');
      const fresh = await rooms.get(code);
      if (!fresh) {
        await blob.del([ticket.pathname]);
        throw new HttpError(404, 'not_found');
      }
      if (stored.size > config.maxFileBytes || fresh.bytes + stored.size > config.maxRoomBytes) {
        await blob.del([ticket.pathname]);
        await kv.cmd('DEL', ticketKey);
        throw new HttpError(413, stored.size > config.maxFileBytes ? 'file_too_large' : 'room_full');
      }
      const added = await rooms.addFile(fresh, {
        id,
        name: ticket.name,
        size: stored.size,
        url: stored.url,
        path: ticket.pathname,
      });
      await kv.cmd('DEL', ticketKey);
      return sendJson(res, 201, { v: added.version, item: publicItem(added.item) });
    }

    const itemMatch = /^items\/([a-f0-9]{32})$/.exec(rest);
    if (itemMatch) {
      if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed');
      requireHost();
      const removed = await rooms.removeItem(room, itemMatch[1]);
      if (removed.item) await removeFiles([removed.item]);
      return sendJson(res, 200, { v: removed.version, removed: Boolean(removed.item) });
    }

    throw new HttpError(404, 'not_found');
  }

  // 수업방 전체 상태
  async function snapshot(req, res, url, code, givenKey) {
    const loaded = await rooms.load(code);
    const room = loaded ? loaded.room : null;
    const token = bearer(req);
    const isHost = room ? rooms.verifyHost(room, token) : false;
    const known = isHost || (room !== null && util.safeEqual(givenKey, room.readKey));
    if (!known) await guardLookup(req, room !== null);

    const body = {
      code,
      name: room.name,
      v: room.version,
      boot: bootOf(room.createdAt),
      key: room.readKey,
      isHost,
      items: loaded.items.map(publicItem),
    };
    if (isHost) {
      body.usedBytes = room.bytes;
      body.viewers = await rooms.viewers(code);
      await rooms.touch(code); // 선생님이 연 수업방은 쓰고 있는 것으로 봅니다
    }
    // 학생들이 "이 번호의 상태를 주세요"라고 같은 주소로 물으면, 한 번 만든 답을 CDN이 나눠 줍니다.
    const shareable =
      !token && known && url.searchParams.get('v') === String(room.version) && !req.headers.authorization;
    sendJson(res, 200, body, shareable ? cdnCache(60) : NO_STORE);
  }

  async function removeFiles(items) {
    const paths = items.filter((item) => item.type === 'file' && item.path).map((item) => item.path);
    if (!paths.length) return;
    try {
      await blob.del(paths);
    } catch (err) {
      // 수업방 쪽은 이미 정리됐습니다. 남은 파일은 매일 도는 정리 작업이 지웁니다.
      console.error('[blob] 파일을 지우지 못했습니다:', err && err.message);
    }
  }

  // ------------------------------------------------------------ 정리 (하루 한 번, Vercel Cron)

  // 수업방이 만료되면 Redis의 기록은 저절로 사라지지만 파일은 남습니다. 주인 없는 파일을 찾아 지웁니다.
  async function cleanup(req, res) {
    if (!config.cronSecret || !util.safeEqual(bearer(req), config.cronSecret)) throw new HttpError(401, 'unauthorized');
    const startedAt = now();
    const budgetMs = 20 * 1000;
    let folders = 0;
    let removedFolders = 0;
    let removedFiles = 0;
    let cursor;

    do {
      const page = await blob.list({ prefix: 'rooms/', mode: 'folded', cursor });
      for (const folder of page.folders || []) {
        if (now() - startedAt > budgetMs) break;
        folders += 1;
        const m = /^rooms\/(\d{6})-([0-9a-z]+)\/$/.exec(folder);
        const info = m ? await rooms.peek(m[1]) : null;
        const alive = Boolean(info) && bootOf(info.createdAt) === m[2];

        let referenced = null;
        if (alive) {
          const loaded = await rooms.load(m[1]);
          referenced = new Set((loaded ? loaded.items : []).filter((i) => i.type === 'file').map((i) => i.path));
        }
        // 살아 있는 수업방이면 등록되지 않은 채 두 시간 넘게 남은 파일만, 아니면 폴더 전체를 지웁니다.
        const doomed = [];
        let inner;
        do {
          const files = await blob.list({ prefix: folder, cursor: inner });
          for (const file of files.blobs || []) {
            const stale = now() - file.uploadedAt > UPLOAD_TICKET_SEC * 1000;
            if (!alive || (!referenced.has(file.pathname) && stale)) doomed.push(file.pathname);
          }
          inner = files.hasMore ? files.cursor : undefined;
        } while (inner);
        if (doomed.length) {
          await blob.del(doomed);
          removedFiles += doomed.length;
        }
        if (!alive) removedFolders += 1;
      }
      cursor = page.hasMore && now() - startedAt <= budgetMs ? page.cursor : undefined;
    } while (cursor);

    sendJson(res, 200, { ok: true, folders, removedFolders, removedFiles });
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      fail(req, res, err);
    }
  };
}

module.exports = { createHandler };
