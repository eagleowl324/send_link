'use strict';

// 수업방별 실시간 연결(Server-Sent Events)과 접속자 수 집계

// 한 연결에 보내지 못하고 쌓아 둘 수 있는 최대 크기. 넘으면 끊고, 브라우저가 다시 연결해 전체 상태를 새로 받습니다.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const STREAM_TTL_MS = 75 * 1000; // 스트림을 연 뒤 생존 신호가 없으면 접속자에서 빠지는 시간
const MAX_PRESENCE_PER_ROOM = 1000;

class Hub {
  constructor({ maxPerRoom = 400, maxTotal = 3000 } = {}) {
    this.maxPerRoom = maxPerRoom;
    this.maxTotal = maxTotal;
    this.rooms = new Map(); // code -> Set<client>
    this.total = 0;
    // 접속자: 열려 있는 연결 수가 아니라 "최근에 소식이 있었던 브라우저"로 셉니다.
    // (연결을 닫지 못하고 사라진 기기, 실시간 연결 없이 주기적으로 확인만 하는 기기까지 맞게 세기 위함)
    this.presence = new Map(); // code -> Map<clientId, { expires, host, streams, sticky }>
    this.announced = new Map(); // code -> 마지막으로 알린 접속자 수
    this.anonymous = 0;
  }

  // ------------------------------------------------------------ 접속자

  // clientId가 ttlMs 동안 접속 중인 것으로 표시합니다.
  touch(code, clientId, isHost, ttlMs, now = Date.now()) {
    let map = this.presence.get(code);
    if (!map) {
      map = new Map();
      this.presence.set(code, map);
    }
    let entry = map.get(clientId);
    if (!entry) {
      if (map.size >= MAX_PRESENCE_PER_ROOM) return null;
      entry = { expires: 0, host: false, streams: 0, sticky: false };
      map.set(clientId, entry);
    }
    entry.host = Boolean(isHost);
    entry.expires = Math.max(entry.expires, now + ttlMs);
    this.announce(code, now);
    return entry;
  }

  // 화면을 닫으며 보낸 "나갑니다" 신호
  leave(code, clientId, now = Date.now()) {
    const map = this.presence.get(code);
    const entry = map && map.get(clientId);
    if (!entry) return;
    entry.expires = Math.min(entry.expires, now);
    this.announce(code, now);
  }

  // 선생님(진행자) 화면을 뺀 접속자 수
  viewers(code, now = Date.now()) {
    const map = this.presence.get(code);
    if (!map) return 0;
    let n = 0;
    for (const entry of map.values()) {
      if (!entry.host && (entry.expires > now || (entry.sticky && entry.streams > 0))) n += 1;
    }
    return n;
  }

  // 접속자 수가 바뀌었으면 그 방의 연결들에 알립니다.
  announce(code, now = Date.now()) {
    const n = this.viewers(code, now);
    if ((this.announced.get(code) || 0) === n) return;
    if (n) this.announced.set(code, n);
    else this.announced.delete(code);
    this.broadcast(code, 'viewers', { n });
  }

  // 1초마다 호출: 소식이 끊긴 접속자를 빼고, 달라진 수를 알립니다.
  sweepPresence(now = Date.now()) {
    for (const [code, map] of this.presence) {
      for (const [id, entry] of map) {
        if (entry.streams <= 0 && entry.expires <= now) map.delete(id);
      }
      if (map.size === 0) this.presence.delete(code);
      this.announce(code, now);
    }
  }

  // ------------------------------------------------------------ 연결

  canAccept(code) {
    const set = this.rooms.get(code);
    return this.total < this.maxTotal && (!set || set.size < this.maxPerRoom);
  }

  add(code, res, isHost, clientId) {
    let set = this.rooms.get(code);
    if (!set) {
      set = new Set();
      this.rooms.set(code, set);
    }
    const client = { res };
    set.add(client);
    this.total += 1;

    // 식별자 없이 붙은 연결(이전 버전 화면, 다른 프로그램)은 연결이 열려 있는 동안 접속 중으로 칩니다.
    const id = clientId || `anon-${(this.anonymous += 1)}`;
    const entry = this.touch(code, id, isHost, STREAM_TTL_MS);
    if (entry) {
      entry.streams += 1;
      if (!clientId) entry.sticky = true;
    }

    res.on('close', () => {
      if (!set.delete(client)) return;
      this.total -= 1;
      if (set.size === 0 && this.rooms.get(code) === set) this.rooms.delete(code);
      if (entry) {
        entry.streams -= 1;
        // 식별자가 있는 화면은 생존 신호와 "나갑니다" 신호로만 판단합니다. (화면이 가려져 스트림만 닫는 경우가 있으므로)
        // 식별자 없이 붙었던 연결은 연결이 곧 접속이므로, 끊기면 바로 나간 것으로 봅니다.
        if (entry.sticky && entry.streams <= 0) entry.expires = 0;
      }
    });
    return client;
  }

  // parts: Buffer 배열. 큰 조각(수업방 전체 상태)은 모든 연결이 같은 Buffer를 함께 쓰므로,
  // 받지 않고 버티는 연결이 많아도 메모리가 연결 수만큼 불어나지 않습니다.
  write(client, parts) {
    const res = client.res;
    if (res.destroyed || res.writableEnded) return;
    let size = 0;
    for (const part of parts) size += part.length;
    if (res.writableLength + size > MAX_BUFFERED_BYTES) {
      res.destroy();
      return;
    }
    for (const part of parts) res.write(part);
  }

  send(client, event, data) {
    this.write(client, [frame(event, data)]);
  }

  broadcast(code, event, data) {
    const set = this.rooms.get(code);
    if (!set) return;
    const parts = [frame(event, data)];
    for (const client of set) this.write(client, parts);
  }

  ping() {
    const parts = [frame('ping', {})];
    for (const set of this.rooms.values()) {
      for (const client of set) this.write(client, parts);
    }
  }

  closeRoom(code, event = 'closed') {
    this.presence.delete(code);
    this.announced.delete(code);
    const set = this.rooms.get(code);
    if (!set) return;
    const payload = frame(event, {});
    for (const client of Array.from(set)) {
      if (!client.res.destroyed && !client.res.writableEnded) client.res.end(payload);
    }
  }

  closeAll() {
    for (const set of Array.from(this.rooms.values())) {
      for (const client of Array.from(set)) {
        if (!client.res.destroyed) client.res.destroy();
      }
    }
    this.presence.clear();
    this.announced.clear();
  }
}

function frame(event, data) {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = { Hub };
