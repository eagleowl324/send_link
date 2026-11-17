'use strict';

// 테스트와 로컬 실행용: Redis 명령 가운데 이 서비스가 쓰는 것만 흉내 내는 메모리 저장소.
// src/vercel/kv.js 의 createKv 와 같은 모양(cmd / pipeline / multi)을 제공합니다.

function createFakeKv({ now = () => Date.now() } = {}) {
  const data = new Map(); // key -> { type: 'string'|'hash'|'zset', value, expires }
  let commands = 0;

  function live(key) {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expires !== null && entry.expires <= now()) {
      data.delete(key);
      return null;
    }
    return entry;
  }

  function ensure(key, type) {
    let entry = live(key);
    if (!entry) {
      entry = { type, value: type === 'string' ? '' : new Map(), expires: null };
      data.set(key, entry);
    } else if (entry.type !== type) {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    return entry;
  }

  function typed(key, type) {
    const entry = live(key);
    if (entry && entry.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return entry;
  }

  function int(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new Error('ERR value is not an integer or out of range');
    return n;
  }

  function bound(value) {
    if (value === '-inf') return -Infinity;
    if (value === '+inf' || value === 'inf') return Infinity;
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error('ERR min or max is not a float');
    return n;
  }

  function run(args) {
    commands += 1;
    const [name, key, ...rest] = args.map((a) => (typeof a === 'number' ? String(a) : a));
    switch (String(name).toUpperCase()) {
      case 'PING':
        return 'PONG';
      case 'GET': {
        const entry = typed(key, 'string');
        return entry ? entry.value : null;
      }
      case 'SET': {
        let ttl = null;
        let nx = false;
        for (let i = 1; i < rest.length; i += 1) {
          const flag = String(rest[i]).toUpperCase();
          if (flag === 'EX') ttl = int(rest[(i += 1)]) * 1000;
          else if (flag === 'PX') ttl = int(rest[(i += 1)]);
          else if (flag === 'NX') nx = true;
          else throw new Error('ERR syntax error');
        }
        if (nx && live(key)) return null;
        data.set(key, { type: 'string', value: String(rest[0]), expires: ttl === null ? null : now() + ttl });
        return 'OK';
      }
      case 'DEL': {
        let removed = 0;
        for (const k of [key, ...rest]) {
          if (live(k)) removed += 1;
          data.delete(k);
        }
        return removed;
      }
      case 'EXISTS':
        return [key, ...rest].filter((k) => live(k)).length;
      case 'EXPIRE': {
        const entry = live(key);
        if (!entry) return 0;
        entry.expires = now() + int(rest[0]) * 1000;
        return 1;
      }
      case 'TTL': {
        const entry = live(key);
        if (!entry) return -2;
        return entry.expires === null ? -1 : Math.ceil((entry.expires - now()) / 1000);
      }
      case 'INCR':
      case 'INCRBY': {
        const entry = ensure(key, 'string');
        const next = int(entry.value || '0') + (rest.length ? int(rest[0]) : 1);
        entry.value = String(next);
        return next;
      }
      case 'HSET': {
        if (rest.length === 0 || rest.length % 2) throw new Error("ERR wrong number of arguments for 'hset' command");
        const entry = ensure(key, 'hash');
        let added = 0;
        for (let i = 0; i < rest.length; i += 2) {
          if (!entry.value.has(rest[i])) added += 1;
          entry.value.set(rest[i], String(rest[i + 1]));
        }
        return added;
      }
      case 'HSETNX': {
        const entry = ensure(key, 'hash');
        if (entry.value.has(rest[0])) return 0;
        entry.value.set(rest[0], String(rest[1]));
        return 1;
      }
      case 'HGET': {
        const entry = typed(key, 'hash');
        return entry && entry.value.has(rest[0]) ? entry.value.get(rest[0]) : null;
      }
      case 'HMGET': {
        const entry = typed(key, 'hash');
        return rest.map((field) => (entry && entry.value.has(field) ? entry.value.get(field) : null));
      }
      case 'HGETALL': {
        const entry = typed(key, 'hash');
        const out = [];
        if (entry) for (const [field, value] of entry.value) out.push(field, value);
        return out;
      }
      case 'HDEL': {
        const entry = typed(key, 'hash');
        if (!entry) return 0;
        let removed = 0;
        for (const field of rest) if (entry.value.delete(field)) removed += 1;
        if (entry.value.size === 0) data.delete(key);
        return removed;
      }
      case 'HLEN': {
        const entry = typed(key, 'hash');
        return entry ? entry.value.size : 0;
      }
      case 'HINCRBY': {
        const entry = ensure(key, 'hash');
        const next = int(entry.value.get(rest[0]) || '0') + int(rest[1]);
        entry.value.set(rest[0], String(next));
        return next;
      }
      case 'ZADD': {
        if (rest.length === 0 || rest.length % 2) throw new Error('ERR syntax error');
        const entry = ensure(key, 'zset');
        let added = 0;
        for (let i = 0; i < rest.length; i += 2) {
          if (!entry.value.has(rest[i + 1])) added += 1;
          entry.value.set(rest[i + 1], Number(rest[i]));
        }
        return added;
      }
      case 'ZREM': {
        const entry = typed(key, 'zset');
        if (!entry) return 0;
        let removed = 0;
        for (const member of rest) if (entry.value.delete(member)) removed += 1;
        if (entry.value.size === 0) data.delete(key);
        return removed;
      }
      case 'ZCOUNT': {
        const entry = typed(key, 'zset');
        if (!entry) return 0;
        const min = bound(rest[0]);
        const max = bound(rest[1]);
        let count = 0;
        for (const score of entry.value.values()) if (score >= min && score <= max) count += 1;
        return count;
      }
      case 'ZCARD': {
        const entry = typed(key, 'zset');
        return entry ? entry.value.size : 0;
      }
      case 'ZREMRANGEBYRANK': {
        const entry = typed(key, 'zset');
        if (!entry) return 0;
        const sorted = Array.from(entry.value).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
        const size = sorted.length;
        let start = int(rest[0]);
        let stop = int(rest[1]);
        if (start < 0) start = Math.max(0, size + start);
        if (stop < 0) stop = size + stop;
        stop = Math.min(stop, size - 1);
        let removed = 0;
        for (let i = start; i <= stop; i += 1) {
          entry.value.delete(sorted[i][0]);
          removed += 1;
        }
        if (entry.value.size === 0) data.delete(key);
        return removed;
      }
      case 'ZREMRANGEBYSCORE': {
        const entry = typed(key, 'zset');
        if (!entry) return 0;
        const min = bound(rest[0]);
        const max = bound(rest[1]);
        let removed = 0;
        for (const [member, score] of Array.from(entry.value)) {
          if (score >= min && score <= max) {
            entry.value.delete(member);
            removed += 1;
          }
        }
        if (entry.value.size === 0) data.delete(key);
        return removed;
      }
      default:
        throw new Error(`ERR unknown command '${name}' (fake-kv)`);
    }
  }

  return {
    async cmd(...args) {
      return run(args);
    },
    async pipeline(list) {
      return list.map(run);
    },
    async multi(list) {
      return list.map(run);
    },
    // 테스트에서 들여다보기 위한 것
    keys: () => Array.from(data.keys()).filter((k) => live(k)),
    commandCount: () => commands,
  };
}

module.exports = { createFakeKv };
