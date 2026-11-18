'use strict';

// Vercel용 관리자 API (/api/admin/*). 화면은 public/admin.html, 설정 저장은 src/vercel/settings.js
//
//   GET    /api/admin                상태 (누구나): 관리자가 정해졌는지, 지금 로그인돼 있는지
//   POST   /api/admin/setup          처음 설정: 관리자 비밀번호 만들기 (아직 관리자가 없을 때만)
//   POST   /api/admin/login          로그인
//   POST   /api/admin/logout         로그아웃
//   GET    /api/admin/overview       수업방 목록과 현재 설정
//   PUT    /api/admin/teacher        수업방 만들기 비밀번호 정하기 / 비밀번호 없이 허용
//   PUT    /api/admin/password       관리자 비밀번호 바꾸기
//   DELETE /api/admin/rooms/<코드>   수업방 삭제 (파일 포함)
//   DELETE /api/admin                화면에서 정한 설정을 지우고 처음 상태로
//
// 로그인하면 받는 토큰을 Authorization 머리글로 보내야 하며(쿠키를 쓰지 않음), 응답은 캐시되지 않습니다.

const { ADMIN_PASSWORD_MIN, TEACHER_PASSWORD_MIN, PASSWORD_MAX } = require('./settings');

const ATTEMPT_MAX = 10; // 비밀번호 오입력: 10분에 이만큼까지
const ATTEMPT_WINDOW_SEC = 10 * 60;
const LIST_MAX = 300;

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function createAdmin({ kv, rooms, settings, config, now, tools }) {
  const { HttpError, sendJson, readJson, clientKey, bearer, removeFiles } = tools;

  const strong = (value, min) => typeof value === 'string' && value.length >= min && value.length <= PASSWORD_MAX;

  async function requireSession(req, state) {
    const token = bearer(req);
    if (!(await settings.verifySession(token, state))) throw new HttpError(401, 'unauthorized');
    return token;
  }

  // 비밀번호를 확인하기 전에 부릅니다. 이미 너무 많이 틀렸으면 확인 자체를 하지 않습니다.
  async function attemptKey(req) {
    const key = clientKey(req);
    if ((await rooms.count('a', key)) >= ATTEMPT_MAX) {
      throw new HttpError(429, 'too_many_attempts', { retryAfter: ATTEMPT_WINDOW_SEC });
    }
    return key;
  }

  async function wrongPassword(key) {
    await rooms.hit('a', key, ATTEMPT_WINDOW_SEC);
    throw new HttpError(403, 'bad_password');
  }

  function describeTeacher(teacher) {
    return { mode: teacher.mode, source: teacher.source, at: teacher.at || null };
  }

  return async function admin(req, res, rest) {
    const method = req.method;
    const state = await settings.state();
    const claimed = state.admin.source !== null;

    if (rest === '') {
      if (method === 'GET') {
        const token = bearer(req);
        return sendJson(res, 200, {
          configured: claimed,
          // 이미 수업방 만들기 비밀번호가 있는 사이트에서는 그것을 아는 사람만 관리자가 될 수 있습니다.
          needsProof: !claimed && state.teacher.mode === 'password',
          setupRequired: state.setupRequired,
          signedIn: token ? await settings.verifySession(token, state) : false,
        });
      }
      if (method === 'DELETE') {
        const token = await requireSession(req, state);
        const key = await attemptKey(req);
        const body = await readJson(req, 4096);
        if (!(await settings.checkAdmin(body.password, state))) await wrongPassword(key);
        await settings.reset();
        await settings.closeSession(token);
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(405, 'method_not_allowed');
    }

    if (rest === 'setup') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      if (claimed) throw new HttpError(409, 'already_configured');
      const body = await readJson(req, 4096);
      if (!strong(body.password, ADMIN_PASSWORD_MIN)) throw new HttpError(400, 'weak_password');
      if (state.teacher.mode === 'password') {
        const key = await attemptKey(req);
        if (!(await settings.checkTeacher(body.proof, state))) await wrongPassword(key);
      }
      if (!(await settings.claimAdmin(body.password))) throw new HttpError(409, 'already_configured');
      return sendJson(res, 201, await settings.openSession(await settings.state()));
    }

    if (rest === 'login') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      if (!claimed) throw new HttpError(409, 'admin_not_set');
      const key = await attemptKey(req);
      const body = await readJson(req, 4096);
      if (!(await settings.checkAdmin(body.password, state))) await wrongPassword(key);
      return sendJson(res, 200, await settings.openSession(state));
    }

    if (rest === 'logout') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      await settings.closeSession(bearer(req));
      return sendJson(res, 200, { ok: true });
    }

    // ---- 여기부터는 로그인한 관리자만
    const token = await requireSession(req, state);

    if (rest === 'overview') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      const listed = await rooms.list(LIST_MAX);
      const cleanupAt = toInt(await kv.cmd('GET', 'cfg:cleanup-last'));
      return sendJson(res, 200, {
        rooms: listed.rooms.map((room) => ({
          code: room.code,
          name: room.name,
          createdAt: room.createdAt,
          // 마지막으로 쓴 때부터 보관 기간이 다시 시작되므로, 남은 기간에서 마지막 사용 시각을 알 수 있습니다.
          usedAt: room.expiresAt ? Math.max(room.createdAt, room.expiresAt - config.roomTtlMs) : room.createdAt,
          expiresAt: room.expiresAt || null,
          items: room.items,
          bytes: room.bytes,
          viewers: room.viewers,
        })),
        totalRooms: listed.total,
        teacher: describeTeacher(state.teacher),
        admin: { source: state.admin.source, at: state.admin.at || null },
        status: {
          build: config.build || null,
          cleanupAt: cleanupAt || null,
          maxFileBytes: config.maxFileBytes,
          maxRoomBytes: config.maxRoomBytes,
          roomTtlMs: config.roomTtlMs,
        },
      });
    }

    if (rest === 'teacher') {
      if (method !== 'PUT') throw new HttpError(405, 'method_not_allowed');
      const body = await readJson(req, 4096);
      if (body.mode === 'open') {
        return sendJson(res, 200, { teacher: describeTeacher(await settings.setTeacher('open')) });
      }
      if (body.mode !== 'password') throw new HttpError(400, 'bad_request');
      if (!strong(body.password, TEACHER_PASSWORD_MIN)) throw new HttpError(400, 'weak_password');
      return sendJson(res, 200, { teacher: describeTeacher(await settings.setTeacher('password', body.password)) });
    }

    if (rest === 'password') {
      if (method !== 'PUT') throw new HttpError(405, 'method_not_allowed');
      if (state.admin.source === 'env') throw new HttpError(409, 'fixed_by_env');
      const key = await attemptKey(req);
      const body = await readJson(req, 4096);
      if (!(await settings.checkAdmin(body.current, state))) await wrongPassword(key);
      if (!strong(body.next, ADMIN_PASSWORD_MIN)) throw new HttpError(400, 'weak_password');
      await settings.setAdminPassword(body.next);
      // 비밀번호가 바뀌면 이전 로그인은 모두 풀립니다. 지금 이 화면은 새 로그인으로 이어 줍니다.
      await settings.closeSession(token);
      return sendJson(res, 200, await settings.openSession(await settings.state()));
    }

    const roomMatch = /^rooms\/(\d{6})$/.exec(rest);
    if (roomMatch) {
      if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed');
      const room = await rooms.get(roomMatch[1]);
      if (!room) return sendJson(res, 200, { ok: true, removed: false });
      await removeFiles(await rooms.remove(roomMatch[1]));
      return sendJson(res, 200, { ok: true, removed: true });
    }

    throw new HttpError(404, 'not_found');
  };
}

module.exports = { createAdmin };
