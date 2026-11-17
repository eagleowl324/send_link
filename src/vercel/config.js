'use strict';

// Vercel에 올렸을 때의 설정 (프로젝트의 환경 변수에서 읽음)

const { loadConfig } = require('../config');

function pick(env, names) {
  for (const name of names) {
    if (env[name]) return String(env[name]);
  }
  return '';
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Vercel의 무료 파일 저장 한도가 넉넉하지 않으므로, 따로 지정하지 않으면 자체 서버보다 작은 값을 씁니다.
const VERCEL_DEFAULTS = { MAX_FILE_MB: '50', MAX_ROOM_MB: '200', ROOM_TTL_DAYS: '14' };

function loadVercelConfig(env = process.env) {
  const base = loadConfig(Object.assign({}, VERCEL_DEFAULTS, env));
  return {
    siteName: base.siteName,
    publicUrl: base.publicUrl,
    teacherPassword: base.teacherPassword,
    maxFileBytes: base.maxFileBytes,
    maxRoomBytes: base.maxRoomBytes,
    maxTextBytes: base.maxTextBytes,
    maxRoomTextBytes: base.maxRoomTextBytes,
    maxItems: base.maxItems,
    roomTtlMs: base.roomTtlMs,

    // 학생 화면이 "바뀐 것 있나요?"를 묻는 간격과, 그 답을 CDN이 보관하는 시간.
    // 둘을 합친 것이 공유한 내용이 학생에게 보이기까지 걸리는 최대 시간입니다.
    pollMs: Math.round(num(env.POLL_SECONDS, 3, 2, 30) * 1000),
    pollCacheSec: Math.round(num(env.POLL_CACHE_SECONDS, 2, 1, 30)),
    // 접속자 수 집계를 위한 생존 신호 간격
    presenceMs: Math.round(num(env.PRESENCE_SECONDS, 120, 30, 240) * 1000),

    // Redis (Vercel Marketplace의 Upstash 연동이 넣어 주는 이름, 또는 Upstash의 기본 이름)
    redisUrl: pick(env, ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']),
    redisToken: pick(env, ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']),
    // Vercel Blob 저장소를 프로젝트에 연결하면 생기는 값
    blobToken: pick(env, ['BLOB_READ_WRITE_TOKEN']),
    // 매일 도는 정리 작업을 Vercel만 부를 수 있게 하는 값
    cronSecret: pick(env, ['CRON_SECRET']),
  };
}

module.exports = { loadVercelConfig };
