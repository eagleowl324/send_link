'use strict';

// Redis(Upstash) REST 클라이언트. 추가 패키지 없이 fetch만 씁니다.
//   kv.cmd('HGET', key, field)            → 결과 하나
//   kv.pipeline([['GET', a], ['GET', b]]) → 결과 배열 (한 번의 요청으로 여러 명령)
//   kv.multi([...])                       → 결과 배열 (모두 함께 적용되는 트랜잭션)
// 값은 모두 문자열(또는 정수)로 주고받습니다.

function createKv({ url, token, fetchImpl }) {
  if (!url || !token) throw new Error('Redis 접속 정보(KV_REST_API_URL / KV_REST_API_TOKEN)가 없습니다.');
  const base = String(url).replace(/\/+$/, '');
  const doFetch = fetchImpl || fetch;

  async function post(path, body) {
    const res = await doFetch(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok || data === null) {
      const detail = data && data.error ? `: ${data.error}` : '';
      throw new Error(`Redis 요청 실패 (HTTP ${res.status})${detail}`);
    }
    return data;
  }

  function unwrap(entry) {
    if (entry && entry.error) throw new Error(`Redis 오류: ${entry.error}`);
    return entry ? entry.result : null;
  }

  return {
    async cmd(...args) {
      return unwrap(await post('/', args));
    },
    async pipeline(commands) {
      if (!commands.length) return [];
      const data = await post('/pipeline', commands);
      return data.map(unwrap);
    },
    async multi(commands) {
      if (!commands.length) return [];
      const data = await post('/multi-exec', commands);
      return data.map(unwrap);
    },
  };
}

// HGETALL 결과([필드, 값, 필드, 값 …])를 객체로
function pairsToObject(list) {
  const out = {};
  if (Array.isArray(list)) {
    for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = list[i + 1];
  }
  return out;
}

module.exports = { createKv, pairsToObject };
