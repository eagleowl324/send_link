'use strict';

const path = require('node:path');

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

function num(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// PUBLIC_URL은 "https://share.example.com" 같은 최상위 주소만 지원합니다.
function normalizePublicUrl(value) {
  if (!value) return '';
  const raw = String(value).trim();
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch (err) {
    return '';
  }
}

function loadConfig(env = process.env) {
  return {
    port: Math.floor(num(env.PORT, 3000, 0, 65535)),
    host: env.HOST ? String(env.HOST) : undefined,
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    siteName: String(env.SITE_NAME || '수업공유').trim().slice(0, 30) || '수업공유',
    publicUrl: normalizePublicUrl(env.PUBLIC_URL),
    teacherPassword: env.TEACHER_PASSWORD ? String(env.TEACHER_PASSWORD) : '',

    maxFileBytes: Math.floor(num(env.MAX_FILE_MB, 100, 1, 10240) * MB),
    maxRoomBytes: Math.floor(num(env.MAX_ROOM_MB, 500, 1, 102400) * MB),
    maxTotalBytes: Math.floor(num(env.MAX_TOTAL_MB, 5000, 1, 1024000) * MB),
    maxTextBytes: 100 * 1024, // 글 하나의 최대 크기
    maxRoomTextBytes: 1024 * 1024, // 수업방 하나에 쌓을 수 있는 글 전체 크기
    maxItems: 300,
    maxRooms: Math.floor(num(env.MAX_ROOMS, 500, 1, 100000)),
    roomTtlMs: Math.floor(num(env.ROOM_TTL_DAYS, 30, 0.01, 3650) * DAY),

    // 리버스 프록시(Render, Fly.io, nginx 등) 뒤에서 실행할 때 프록시 단계 수.
    trustProxy: Math.floor(num(env.TRUST_PROXY, 0, 0, 10)),
    // 다른 사이트의 iframe 안에 넣어야 할 때만 1로 설정합니다.
    allowFraming: env.ALLOW_FRAMING === '1',
  };
}

module.exports = { loadConfig, MB, DAY };
