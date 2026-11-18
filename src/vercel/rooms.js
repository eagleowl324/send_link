'use strict';

// Vercel용 수업방 저장소: 상태를 Redis에 둡니다. (서버리스 함수는 메모리나 디스크에 상태를 남길 수 없습니다)
//
//   r:<코드>      HASH  n=이름 h=선생님 권한 해시 k=읽기 열쇠 c=만든 시각 v=변경 번호 b=파일 크기 합 t=글 크기 합
//   r:<코드>:i    HASH  항목 id → 항목(JSON)
//   r:<코드>:p    ZSET  접속 중인 화면 id → 만료 시각
//
// 세 키 모두 마지막으로 쓴 뒤 ROOM_TTL_DAYS가 지나면 Redis가 알아서 지웁니다.

const util = require('../util');
const { pairsToObject } = require('./kv');

const ROOM_NAME_MAX = 40;
const PRESENCE_KEY_TTL_SEC = 10 * 60;
const PRESENCE_MAX = 2000;

function storeError(code) {
  const err = new Error(code);
  err.storeCode = code;
  return err;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function textSize(item) {
  if (item.type === 'text') return Buffer.byteLength(item.text);
  if (item.type === 'link') return Buffer.byteLength(item.url);
  return 0;
}

function createRooms({ kv, config, now = () => Date.now() }) {
  const ttlSec = Math.max(60, Math.ceil(config.roomTtlMs / 1000));
  const roomKey = (code) => `r:${code}`;
  const itemsKey = (code) => `r:${code}:i`;
  const seenKey = (code) => `r:${code}:p`;
  const keepAlive = (code) => [
    ['EXPIRE', roomKey(code), ttlSec],
    ['EXPIRE', itemsKey(code), ttlSec],
  ];

  function parseRoom(code, fields) {
    if (!fields || !fields.h || !fields.k) return null; // 만드는 도중이거나 없는 방
    return {
      code,
      name: fields.n || '',
      hostHash: fields.h,
      readKey: fields.k,
      createdAt: toInt(fields.c),
      version: toInt(fields.v),
      bytes: toInt(fields.b),
      textBytes: toInt(fields.t),
    };
  }

  function parseItems(pairs) {
    const items = [];
    const map = pairsToObject(pairs);
    for (const id of Object.keys(map)) {
      try {
        const item = JSON.parse(map[id]);
        if (item && item.id === id) items.push(item);
      } catch (err) {
        // 읽을 수 없는 항목은 건너뜁니다
      }
    }
    items.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    return items;
  }

  return {
    async create(name) {
      const token = util.randomToken();
      const fields = {
        n: util.cleanLine(name, ROOM_NAME_MAX),
        h: util.sha256hex(token),
        k: util.randomId().slice(0, 16),
      };
      for (let tries = 0; tries < 20; tries += 1) {
        const code = util.randomCode();
        const created = now();
        // 같은 코드가 이미 있으면 0이 돌아옵니다. 만료 시간을 같이 걸어 두어, 도중에 멈춰도 흔적이 남지 않게 합니다.
        const [fresh] = await kv.pipeline([
          ['HSETNX', roomKey(code), 'c', created],
          ['EXPIRE', roomKey(code), ttlSec],
        ]);
        if (fresh !== 1) continue;
        await kv.multi([
          ['HSET', roomKey(code), 'n', fields.n, 'h', fields.h, 'k', fields.k, 'v', 0, 'b', 0, 't', 0],
          ['EXPIRE', roomKey(code), ttlSec],
        ]);
        return { code, token, room: parseRoom(code, Object.assign({ c: created, v: 0, b: 0, t: 0 }, fields)) };
      }
      throw storeError('too_many_rooms');
    },

    async get(code) {
      return parseRoom(code, pairsToObject(await kv.cmd('HGETALL', roomKey(code))));
    },

    // 수업방과 항목을 한 번에
    async load(code) {
      const [roomPairs, itemPairs] = await kv.pipeline([
        ['HGETALL', roomKey(code)],
        ['HGETALL', itemsKey(code)],
      ]);
      const room = parseRoom(code, pairsToObject(roomPairs));
      return room ? { room, items: parseItems(itemPairs) } : null;
    },

    // 변경 번호만 (주기 확인용. 명령 하나)
    async peek(code) {
      const [h, k, c, v] = await kv.cmd('HMGET', roomKey(code), 'h', 'k', 'c', 'v');
      return h && k ? { readKey: k, createdAt: toInt(c), version: toInt(v) } : null;
    },

    verifyHost(room, token) {
      if (typeof token !== 'string' || token.length < 16 || token.length > 200) return false;
      return util.safeEqual(util.sha256hex(token), room.hostHash);
    },

    async touch(code) {
      await kv.pipeline(keepAlive(code));
    },

    // 글·링크 추가. 새 변경 번호와 항목을 돌려줍니다.
    async addText(room, text, mono) {
      const count = toInt(await kv.cmd('HLEN', itemsKey(room.code)));
      if (count >= config.maxItems) throw storeError('too_many_items');
      const url = mono ? null : util.detectLink(text);
      const item = url
        ? { id: util.randomId(), type: 'link', at: now(), url }
        : { id: util.randomId(), type: 'text', at: now(), text, mono: Boolean(mono) };
      const size = textSize(item);
      if (room.textBytes + size > config.maxRoomTextBytes) throw storeError('text_full');
      const results = await kv.multi(
        [
          ['HSET', itemsKey(room.code), item.id, JSON.stringify(item)],
          ['HINCRBY', roomKey(room.code), 'v', 1],
          ['HINCRBY', roomKey(room.code), 't', size],
        ].concat(keepAlive(room.code))
      );
      return { item, version: toInt(results[1]) };
    },

    // 파일 항목 등록 (파일 자체는 이미 파일 저장소에 올라가 있음)
    async addFile(room, { id, name, size, url, path }) {
      const item = { id, type: 'file', at: now(), name, size, url, path };
      const results = await kv.multi(
        [
          ['HSETNX', itemsKey(room.code), item.id, JSON.stringify(item)],
          ['HINCRBY', roomKey(room.code), 'v', 1],
          ['HINCRBY', roomKey(room.code), 'b', size],
        ].concat(keepAlive(room.code))
      );
      return { item, version: toInt(results[1]), fresh: results[0] === 1 };
    },

    async itemCount(code) {
      return toInt(await kv.cmd('HLEN', itemsKey(code)));
    },

    // 항목 하나 지우기. 지운 항목(없었으면 null)과 새 변경 번호
    async removeItem(room, id) {
      const raw = await kv.cmd('HGET', itemsKey(room.code), id);
      if (!raw) return { item: null, version: room.version };
      let item = null;
      try {
        item = JSON.parse(raw);
      } catch (err) {
        item = { id, type: 'text', text: '' };
      }
      const results = await kv.multi(
        [
          ['HDEL', itemsKey(room.code), id],
          ['HINCRBY', roomKey(room.code), 'v', 1],
          ['HINCRBY', roomKey(room.code), item.type === 'file' ? 'b' : 't', -(item.type === 'file' ? toInt(item.size) : textSize(item))],
        ].concat(keepAlive(room.code))
      );
      if (results[0] !== 1) return { item: null, version: toInt(results[1]) }; // 그 사이 다른 요청이 지움
      return { item, version: toInt(results[1]) };
    },

    // 모두 지우기. 지운 항목 목록과 새 변경 번호
    async clear(room) {
      const items = parseItems(await kv.cmd('HGETALL', itemsKey(room.code)));
      if (!items.length) return { items, version: room.version };
      const results = await kv.multi([
        ['DEL', itemsKey(room.code)],
        ['HINCRBY', roomKey(room.code), 'v', 1],
        ['HSET', roomKey(room.code), 'b', 0, 't', 0],
        ['EXPIRE', roomKey(room.code), ttlSec],
      ]);
      return { items, version: toInt(results[1]) };
    },

    async rename(room, name) {
      const clean = util.cleanLine(name, ROOM_NAME_MAX);
      const results = await kv.multi(
        [
          ['HSET', roomKey(room.code), 'n', clean],
          ['HINCRBY', roomKey(room.code), 'v', 1],
        ].concat(keepAlive(room.code))
      );
      return { name: clean, version: toInt(results[1]) };
    },

    // 수업방 삭제. 지워야 할 파일이 든 항목 목록을 돌려줍니다.
    async remove(code) {
      const items = parseItems(await kv.cmd('HGETALL', itemsKey(code)));
      await kv.cmd('DEL', roomKey(code), itemsKey(code), seenKey(code));
      return items;
    },

    // 관리자용: 지금 있는 수업방 전체를 최근에 쓴 순서로. (limit개까지만 자세히 읽고, total은 전체 개수)
    async list(limit) {
      const codes = new Set();
      let cursor = '0';
      for (let round = 0; round < 200; round += 1) {
        const reply = await kv.cmd('SCAN', cursor, 'MATCH', 'r:??????', 'COUNT', 500);
        const keys = Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1] : [];
        for (const key of keys) {
          const m = /^r:(\d{6})$/.exec(String(key));
          if (m) codes.add(m[1]);
        }
        cursor = Array.isArray(reply) ? String(reply[0]) : '0';
        if (cursor === '0') break;
      }
      const all = Array.from(codes).sort();
      const picked = all.slice(0, limit);
      if (!picked.length) return { rooms: [], total: 0 };

      const at = now();
      const commands = [];
      for (const code of picked) {
        commands.push(['HMGET', roomKey(code), 'n', 'h', 'k', 'c', 'b']);
        commands.push(['TTL', roomKey(code)]);
        commands.push(['HLEN', itemsKey(code)]);
        commands.push(['ZCOUNT', seenKey(code), at + 1, '+inf']);
      }
      const results = await kv.pipeline(commands);
      const found = [];
      let missing = 0;
      picked.forEach((code, index) => {
        const [n, h, k, c, b] = results[index * 4] || [];
        if (!h || !k) {
          missing += 1; // 만드는 도중이거나 그 사이 사라진 방
          return;
        }
        const ttl = Number(results[index * 4 + 1]);
        found.push({
          code,
          name: n || '',
          createdAt: toInt(c),
          bytes: toInt(b),
          items: toInt(results[index * 4 + 2]),
          viewers: toInt(results[index * 4 + 3]),
          expiresAt: ttl > 0 ? at + ttl * 1000 : 0,
        });
      });
      found.sort((a, b) => b.expiresAt - a.expiresAt || b.createdAt - a.createdAt);
      return { rooms: found, total: all.length - missing };
    },

    // ------------------------------------------------------------ 접속자

    // 생존 신호. 선생님 화면은 세지 않습니다. wantCount면 지금 접속자 수를 함께 돌려줍니다.
    async here(code, clientId, isHost, seconds, wantCount) {
      const at = now();
      const commands = [];
      if (clientId && !isHost) {
        if (seconds <= 0) {
          commands.push(['ZREM', seenKey(code), clientId]);
        } else {
          commands.push(['ZADD', seenKey(code), at + seconds * 1000, clientId]);
          commands.push(['EXPIRE', seenKey(code), PRESENCE_KEY_TTL_SEC]);
        }
      }
      if (isHost) {
        // 선생님 신호 때 지난 기록을 치우고, 비정상적으로 많이 쌓였으면 최근 것만 남깁니다.
        commands.push(['ZREMRANGEBYSCORE', seenKey(code), '-inf', at]);
        commands.push(['ZREMRANGEBYRANK', seenKey(code), 0, -(PRESENCE_MAX + 1)]);
      }
      if (wantCount) commands.push(['ZCOUNT', seenKey(code), at + 1, '+inf']);
      if (!commands.length) return null;
      const results = await kv.pipeline(commands);
      return wantCount ? toInt(results[results.length - 1]) : null;
    },

    async viewers(code) {
      return toInt(await kv.cmd('ZCOUNT', seenKey(code), now() + 1, '+inf'));
    },

    // ------------------------------------------------------------ 접속 제한 (IP별 횟수)

    // 횟수를 하나 올리고 지금까지의 횟수를 돌려줍니다.
    async hit(kind, key, windowSec) {
      const name = `l:${kind}:${key}`;
      // 처음이면 만료 시간과 함께 만들고, 이어서 하나 올립니다. (만료 시간 없는 카운터가 남지 않도록 한 묶음으로)
      const results = await kv.multi([
        ['SET', name, 0, 'EX', windowSec, 'NX'],
        ['INCR', name],
      ]);
      return toInt(results[1]);
    },

    async count(kind, key) {
      return toInt(await kv.cmd('GET', `l:${kind}:${key}`));
    },
  };
}

module.exports = { createRooms, textSize, ROOM_NAME_MAX };
