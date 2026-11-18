'use strict';

// 관리자 설정 (Vercel용): 관리자 비밀번호, 수업방 만들기 비밀번호, 관리자 로그인 상태를 Redis에 둡니다.
// 화면(/admin)에서 정하므로, Vercel의 환경 변수를 건드리지 않고도 사이트를 잠글 수 있습니다.
//
//   cfg:admin      STRING  {"hash","gen","at"}                관리자 비밀번호
//   cfg:teacher    STRING  {"mode":"password","hash","at"}    수업방을 만들 때 물어볼 비밀번호
//                          {"mode":"open","at"}               비밀번호 없이 누구나 만들 수 있음
//   as:<토큰 해시>  STRING  로그인할 때의 gen (12시간 뒤 만료)
//
// 비밀번호는 scrypt 해시로만 저장합니다. gen 은 관리자 비밀번호를 정할 때마다 새로 만들어지는 값으로,
// 비밀번호가 바뀌면 이전에 로그인해 둔 화면이 모두 풀리게 합니다.
//
// 환경 변수 ADMIN_PASSWORD / TEACHER_PASSWORD 가 있으면 그것이 우선하고, 그 항목은 화면에서 바꿀 수 없습니다.

const crypto = require('node:crypto');
const util = require('../util');

const ADMIN_KEY = 'cfg:admin';
const TEACHER_KEY = 'cfg:teacher';
const SESSION_SEC = 12 * 60 * 60;
const ADMIN_PASSWORD_MIN = 8;
const TEACHER_PASSWORD_MIN = 4;
const PASSWORD_MAX = 200;

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 32;

// 같은 글자라도 기기에 따라 다르게 조합되어 들어올 수 있으므로(한글 등) 한 가지 형태로 맞춥니다.
function normalize(password) {
  return String(password).normalize('NFC');
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(normalize(password), salt, KEY_BYTES, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `s1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const salt = Buffer.from(parts[1], 'base64url');
  const expected = Buffer.from(parts[2], 'base64url');
  if (!salt.length || expected.length !== KEY_BYTES) return false;
  return crypto.timingSafeEqual(await scrypt(password, salt), expected);
}

function usable(password) {
  return typeof password === 'string' && password.length > 0 && password.length <= PASSWORD_MAX;
}

function parse(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

function createSettings({ kv, config, now = () => Date.now() }) {
  return {
    // 지금의 설정 상태.
    //   admin.source    'env' | 'stored' | null(아직 아무도 정하지 않음)
    //   teacher.mode    'password' | 'open' | 'unset'(아직 정하지 않음)
    //   setupRequired   설정이 끝나지 않아 수업방을 만들 수 없는 상태
    async state() {
      const [adminRaw, teacherRaw] = await kv.cmd('MGET', ADMIN_KEY, TEACHER_KEY);
      const storedAdmin = parse(adminRaw);
      const storedTeacher = parse(teacherRaw);

      let admin = { source: null, gen: '', at: 0, hash: '' };
      if (config.adminPassword) {
        admin = { source: 'env', gen: 'env-' + util.sha256hex('gen:' + config.adminPassword).slice(0, 16), at: 0, hash: '' };
      } else if (storedAdmin && typeof storedAdmin.hash === 'string' && storedAdmin.gen) {
        admin = { source: 'stored', gen: String(storedAdmin.gen), at: Number(storedAdmin.at) || 0, hash: storedAdmin.hash };
      }

      let teacher = { mode: 'unset', source: null, at: 0, hash: '' };
      if (config.teacherPassword) {
        teacher = { mode: 'password', source: 'env', at: 0, hash: '' };
      } else if (storedTeacher && storedTeacher.mode === 'open') {
        teacher = { mode: 'open', source: 'stored', at: Number(storedTeacher.at) || 0, hash: '' };
      } else if (storedTeacher && storedTeacher.mode === 'password' && typeof storedTeacher.hash === 'string') {
        teacher = { mode: 'password', source: 'stored', at: Number(storedTeacher.at) || 0, hash: storedTeacher.hash };
      }

      // 관리자가 없는데 누구나 만들 수 있는 상태로 두지 않습니다. (그 사이 아무나 관리자가 될 수 있으므로)
      const setupRequired = teacher.mode === 'unset' || (admin.source === null && teacher.mode === 'open');
      return { admin, teacher, setupRequired };
    },

    async checkTeacher(password, state) {
      if (state.teacher.mode !== 'password') return true;
      if (!usable(password)) return false;
      if (state.teacher.source === 'env') return util.safeEqual(normalize(password), normalize(config.teacherPassword));
      return verifyPassword(password, state.teacher.hash);
    },

    async checkAdmin(password, state) {
      if (!usable(password) || state.admin.source === null) return false;
      if (state.admin.source === 'env') return util.safeEqual(normalize(password), normalize(config.adminPassword));
      return verifyPassword(password, state.admin.hash);
    },

    // 처음 설정: 아직 관리자가 없을 때만 성공합니다. (동시에 여러 요청이 와도 하나만 성공)
    async claimAdmin(password) {
      const record = { hash: await hashPassword(password), gen: crypto.randomBytes(8).toString('hex'), at: now() };
      return (await kv.cmd('SET', ADMIN_KEY, JSON.stringify(record), 'NX')) === 'OK';
    },

    async setAdminPassword(password) {
      const record = { hash: await hashPassword(password), gen: crypto.randomBytes(8).toString('hex'), at: now() };
      await kv.cmd('SET', ADMIN_KEY, JSON.stringify(record));
    },

    // mode 'password'면 password를 수업방 만들기 비밀번호로, 'open'이면 비밀번호 없이 만들 수 있게 합니다.
    async setTeacher(mode, password) {
      const record = mode === 'open' ? { mode: 'open', at: now() } : { mode: 'password', hash: await hashPassword(password), at: now() };
      await kv.cmd('SET', TEACHER_KEY, JSON.stringify(record));
      return { mode: record.mode, source: 'stored', at: record.at };
    },

    async openSession(state) {
      const token = util.randomToken();
      await kv.cmd('SET', 'as:' + util.sha256hex(token), state.admin.gen, 'EX', SESSION_SEC);
      return { token, expiresAt: now() + SESSION_SEC * 1000 };
    },

    async verifySession(token, state) {
      if (typeof token !== 'string' || token.length < 16 || token.length > 200 || state.admin.source === null) return false;
      const gen = await kv.cmd('GET', 'as:' + util.sha256hex(token));
      return typeof gen === 'string' && gen !== '' && util.safeEqual(gen, state.admin.gen);
    },

    async closeSession(token) {
      if (typeof token === 'string' && token.length >= 16 && token.length <= 200) {
        await kv.cmd('DEL', 'as:' + util.sha256hex(token));
      }
    },

    // 화면에서 정한 것을 모두 지워 처음 설정 전 상태로 되돌립니다. (환경 변수로 정한 것은 그대로)
    async reset() {
      await kv.cmd('DEL', ADMIN_KEY, TEACHER_KEY);
    },
  };
}

module.exports = {
  createSettings,
  hashPassword,
  verifyPassword,
  ADMIN_PASSWORD_MIN,
  TEACHER_PASSWORD_MIN,
  PASSWORD_MAX,
  SESSION_SEC,
};
