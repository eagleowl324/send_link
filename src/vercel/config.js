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
    // Vercel Blob 저장소를 프로젝트에 연결하면 생기는 값. 요즘은 저장소 번호(BLOB_STORE_ID)만 들어오고
    // (접속은 Vercel이 함수에 건네주는 신원 토큰으로 합니다), 예전에 만든 저장소는 읽기/쓰기 토큰이 들어옵니다.
    blobStoreId: pick(env, ['BLOB_STORE_ID']),
    blobToken: pick(env, ['BLOB_READ_WRITE_TOKEN']),
    // 저장소 종류를 미리 정해 두고 싶을 때만 씁니다. 비워 두면 저장소에 물어서 알아냅니다.
    blobAccess: ['public', 'private'].includes(String(env.BLOB_ACCESS || '').toLowerCase())
      ? String(env.BLOB_ACCESS).toLowerCase()
      : '',
    // 매일 도는 정리 작업을 Vercel만 부를 수 있게 하는 값
    cronSecret: pick(env, ['CRON_SECRET']),
    // 지금 올라가 있는 것이 저장소의 어느 시점 코드인지 (Vercel이 넣어 주는 값, 확인용)
    build: /^[0-9a-f]{7,40}$/.test(String(env.VERCEL_GIT_COMMIT_SHA || '')) ? String(env.VERCEL_GIT_COMMIT_SHA).slice(0, 7) : '',
  };
}

// 지금 이 배포가 받은 환경 변수 가운데 저장소와 관련된 것의 "이름"만 모읍니다. (값은 절대 내놓지 않습니다)
// 저장소 연결이 안 됐을 때, 무엇이 빠졌는지 밖에서도 알 수 있게 하려는 것입니다.
function storageVariableNames(env = process.env) {
  return Object.keys(env)
    .filter((name) => /^[A-Z][A-Z0-9_]{1,59}$/.test(name) && /(^|_)(KV|REDIS|UPSTASH|BLOB)(_|$)/.test(name))
    .filter((name) => !name.startsWith('VERCEL_')) // 저장소 연결이 아니라 동작 설정인 것들
    .sort()
    .slice(0, 20);
}

module.exports = { loadVercelConfig, storageVariableNames };
