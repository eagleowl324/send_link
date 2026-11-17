'use strict';

// 수업방과 공유 항목의 저장소.
// 상태는 메모리에 두고, 수업방마다 JSON 파일 하나(data/rooms/<코드>.json)로 디스크에 남깁니다.
// 업로드한 파일은 data/files/<코드>/<항목 id> 에 원래 이름과 무관한 이름으로 저장합니다.

const fsp = require('node:fs/promises');
const path = require('node:path');
const util = require('./util');

const ROOM_NAME_MAX = 40;
const TOUCH_SAVE_INTERVAL = 6 * 60 * 60 * 1000;
const STALE_TMP_MS = 6 * 60 * 60 * 1000;
const MAX_UPLOADS_PER_ROOM = 3; // 한 수업방에서 동시에 받는 업로드 수
const UNUSED_ROOM_MIN_AGE = 60 * 60 * 1000;

function storeError(code) {
  const err = new Error(code);
  err.storeCode = code;
  return err;
}

// 브라우저로 내보내는 항목 모양
function publicItem(item, code) {
  if (item.type === 'link') {
    return { id: item.id, type: 'link', at: item.at, url: item.url };
  }
  if (item.type === 'file') {
    const info = util.fileInfo(item.name);
    const url = `/f/${code}/${item.id}/${encodeURIComponent(item.name)}`;
    return {
      id: item.id,
      type: 'file',
      at: item.at,
      name: item.name,
      size: item.size,
      kind: info.kind,
      ext: info.ext,
      url, // 내려받기
      openUrl: info.inline ? url + '?inline' : null, // 브라우저에서 바로 열기 (안전한 형식만)
    };
  }
  return { id: item.id, type: 'text', at: item.at, text: item.text, mono: Boolean(item.mono) };
}

// 글·링크가 수업방의 글 용량에서 차지하는 크기
function textSize(item) {
  if (item.type === 'text') return Buffer.byteLength(item.text);
  if (item.type === 'link') return Buffer.byteLength(item.url);
  return 0;
}

function newRoom(fields) {
  return Object.assign(
    {
      code: '',
      name: '',
      hostHash: '',
      readKey: '',
      createdAt: 0,
      activeAt: 0,
      version: 0,
      items: [],
      bytes: 0, // 올라와 있는 파일 크기 합
      textBytes: 0, // 글·링크 크기 합
      pendingBytes: 0, // 지금 받고 있는 업로드가 잡아 둔 크기
      uploads: 0, // 지금 받고 있는 업로드 수
      deleted: false,
      savedActiveAt: 0,
      _saving: null,
      _dirty: false,
      _itemsBuf: null,
    },
    fields
  );
}

function serialize(room) {
  return {
    code: room.code,
    name: room.name,
    hostHash: room.hostHash,
    readKey: room.readKey,
    createdAt: room.createdAt,
    activeAt: room.activeAt,
    version: room.version,
    items: room.items,
  };
}

function newReadKey() {
  return util.randomId().slice(0, 16);
}

// 디스크에서 읽은 값을 그대로 믿지 않고 형태를 확인합니다.
function revive(data, now) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.code !== 'string' || !/^\d{6}$/.test(data.code)) return null;
  if (typeof data.hostHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.hostHash)) return null;

  const createdAt = Number.isFinite(data.createdAt) ? data.createdAt : now;
  const activeAt = Number.isFinite(data.activeAt) ? data.activeAt : createdAt;
  const room = newRoom({
    code: data.code,
    name: util.cleanLine(data.name, ROOM_NAME_MAX),
    hostHash: data.hostHash,
    readKey: typeof data.readKey === 'string' && /^[a-f0-9]{16}$/.test(data.readKey) ? data.readKey : '',
    createdAt,
    activeAt,
    savedActiveAt: activeAt,
    version: Number.isSafeInteger(data.version) && data.version >= 0 ? data.version : 0,
  });

  const seen = new Set();
  for (const raw of Array.isArray(data.items) ? data.items : []) {
    if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{32}$/.test(raw.id) || seen.has(raw.id)) continue;
    const at = Number.isFinite(raw.at) ? raw.at : createdAt;
    let item;
    if (raw.type === 'text' && typeof raw.text === 'string') {
      item = { id: raw.id, type: 'text', at, text: util.stripLoneSurrogates(raw.text), mono: Boolean(raw.mono) };
    } else if (raw.type === 'link' && typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url)) {
      item = { id: raw.id, type: 'link', at, url: util.stripLoneSurrogates(raw.url) };
    } else if (raw.type === 'file' && typeof raw.name === 'string' && Number.isFinite(raw.size)) {
      item = { id: raw.id, type: 'file', at, name: util.sanitizeFileName(raw.name) || '파일', size: raw.size };
    } else {
      continue;
    }
    seen.add(raw.id);
    room.items.push(item);
    room.textBytes += textSize(item);
  }
  return room;
}

class Store {
  constructor(config) {
    this.config = config;
    this.rooms = new Map();
    this.roomsDir = path.join(config.dataDir, 'rooms');
    this.filesDir = path.join(config.dataDir, 'files');
    this.tmpDir = path.join(config.dataDir, 'tmp');
    this.totalBytes = 0;
    this.pendingBytes = 0;
    // 저장 파일은 있는데 읽지 못한 수업방 코드. 파일을 지우거나 같은 코드를 새로 내주지 않습니다.
    this.failed = new Set();
    this.deleting = new Set(); // 지우는 중인 수업방 코드 (같은 코드 재사용 방지)
    this.pendingDeletes = new Set(); // 지우지 못해 나중에 다시 시도할 경로
  }

  // ------------------------------------------------------------ 시작

  async init() {
    await fsp.mkdir(this.roomsDir, { recursive: true });
    await fsp.mkdir(this.filesDir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });

    // 지난 실행에서 끝나지 못한 업로드 조각 정리
    for (const name of await fsp.readdir(this.tmpDir)) {
      await fsp.rm(path.join(this.tmpDir, name), { recursive: true, force: true }).catch(() => {});
    }

    const now = Date.now();
    const needsSave = [];
    for (const name of await fsp.readdir(this.roomsDir)) {
      const file = path.join(this.roomsDir, name);
      if (name.endsWith('.tmp')) {
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      const match = /^(\d{6})\.json$/.exec(name);
      if (!match) continue;
      let room = null;
      try {
        room = revive(JSON.parse(await fsp.readFile(file, 'utf8')), now);
        if (room && room.code !== match[1]) room = null;
      } catch (err) {
        room = null;
      }
      if (!room) {
        // 일시적인 읽기 오류나 기록 도중 꺼진 경우일 수 있으므로, 이 수업방의 파일은 건드리지 않고 그대로 둡니다.
        this.failed.add(match[1]);
        console.error(`[store] ${name}: 읽지 못했습니다. 이 수업방은 불러오지 않고, 저장된 파일은 그대로 둡니다.`);
        continue;
      }
      if (!room.readKey) {
        room.readKey = newReadKey();
        needsSave.push(room);
      }
      this.rooms.set(room.code, room);
    }

    // 항목과 실제 파일 맞추기
    for (const room of this.rooms.values()) {
      const kept = [];
      for (const item of room.items) {
        if (item.type === 'file') {
          try {
            const stat = await fsp.stat(this.filePath(room, item.id));
            if (!stat.isFile()) throw new Error('not a file');
            item.size = stat.size;
            room.bytes += stat.size;
          } catch (err) {
            continue; // 파일이 사라진 항목은 버립니다
          }
        }
        kept.push(item);
      }
      if (kept.length !== room.items.length) {
        room.items = kept;
        room.version += 1;
        needsSave.push(room);
      }
      this.totalBytes += room.bytes;
    }
    for (const room of new Set(needsSave)) this.save(room);

    // 어느 항목에도 속하지 않는 파일 정리
    for (const dirName of await fsp.readdir(this.filesDir)) {
      if (this.failed.has(dirName)) continue;
      const dir = path.join(this.filesDir, dirName);
      const room = this.rooms.get(dirName);
      if (!room) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const ids = new Set(room.items.filter((i) => i.type === 'file').map((i) => i.id));
      for (const fileName of await fsp.readdir(dir).catch(() => [])) {
        if (!ids.has(fileName)) {
          await fsp.rm(path.join(dir, fileName), { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  }

  // ------------------------------------------------------------ 경로

  roomFile(code) {
    return path.join(this.roomsDir, code + '.json');
  }

  filePath(room, itemId) {
    return path.join(this.filesDir, room.code, itemId);
  }

  tmpPath(id) {
    return path.join(this.tmpDir, id);
  }

  // ------------------------------------------------------------ 수업방

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  createRoom(name, now = Date.now()) {
    let code = '';
    for (let tries = 0; tries < 2000; tries += 1) {
      const candidate = util.randomCode();
      if (!this.rooms.has(candidate) && !this.deleting.has(candidate) && !this.failed.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw storeError('too_many_rooms');

    const token = util.randomToken();
    const room = newRoom({
      code,
      name: util.cleanLine(name, ROOM_NAME_MAX),
      hostHash: util.sha256hex(token),
      readKey: newReadKey(),
      createdAt: now,
      activeAt: now,
      savedActiveAt: now,
    });
    this.rooms.set(code, room);
    this.save(room);
    return { room, token };
  }

  // 자리가 모자랄 때 비워도 되는 수업방: 한 번도 쓰지 않았고(공유·이름 변경 없음) 만든 지 한 시간이 넘은 것 중 가장 오래 방치된 것
  pickUnused(isBusy, now = Date.now()) {
    let pick = null;
    for (const room of this.rooms.values()) {
      if (room.version !== 0 || room.items.length || room.uploads) continue;
      if (now - room.createdAt < UNUSED_ROOM_MIN_AGE) continue;
      if (isBusy && isBusy(room.code)) continue;
      if (!pick || room.activeAt < pick.activeAt) pick = room;
    }
    return pick;
  }

  verifyHost(room, token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 200) return false;
    return util.safeEqual(util.sha256hex(token), room.hostHash);
  }

  renameRoom(room, name, now = Date.now()) {
    room.name = util.cleanLine(name, ROOM_NAME_MAX);
    this._changed(room, now);
  }

  // 사용 흔적만 남깁니다. 디스크에는 가끔씩만 씁니다.
  touch(room, now = Date.now()) {
    if (room.deleted) return;
    room.activeAt = now;
    if (now - room.savedActiveAt > TOUCH_SAVE_INTERVAL) this.save(room);
  }

  async deleteRoom(room) {
    if (room.deleted) return;
    room.deleted = true;
    this.rooms.delete(room.code);
    this.deleting.add(room.code);
    this.totalBytes -= room.bytes;
    room.bytes = 0;
    room.textBytes = 0;
    room.items = [];
    room._itemsBuf = null;
    try {
      if (room._saving) await room._saving.catch(() => {});
      await this._remove(this.roomFile(room.code));
      await this._remove(path.join(this.filesDir, room.code));
    } finally {
      this.deleting.delete(room.code);
    }
  }

  // ------------------------------------------------------------ 항목

  // 수업방의 항목 전체를 JSON으로 만든 것. 바뀔 때까지 같은 Buffer를 돌려주어 요청마다 다시 만들지 않습니다.
  itemsBuffer(room) {
    if (!room._itemsBuf) {
      room._itemsBuf = Buffer.from(JSON.stringify(room.items.map((item) => publicItem(item, room.code))));
    }
    return room._itemsBuf;
  }

  addText(room, text, mono, now = Date.now()) {
    if (room.items.length + room.uploads >= this.config.maxItems) throw storeError('too_many_items');
    const url = mono ? null : util.detectLink(text);
    const item = url
      ? { id: util.randomId(), type: 'link', at: now, url }
      : { id: util.randomId(), type: 'text', at: now, text, mono: Boolean(mono) };
    const size = textSize(item);
    // 글은 파일 용량과 따로 한도를 둡니다. (수업방 전체 상태가 한없이 커지지 않도록)
    if (room.textBytes + size > this.config.maxRoomTextBytes) throw storeError('text_full');
    room.items.push(item);
    room.textBytes += size;
    this._changed(room, now);
    return item;
  }

  // 업로드를 받기 시작할 때 자리를 잡아 둡니다. 받는 중인 파일도 한도에 포함되어야
  // 여러 업로드를 동시에 걸어 한도를 넘기거나 임시 폴더를 채우는 일을 막을 수 있습니다.
  // 돌려받은 release()는 성공·실패와 관계없이 반드시 한 번 호출해야 합니다(여러 번 불러도 안전).
  reserveUpload(room, size) {
    if (room.deleted) throw storeError('gone');
    if (room.items.length + room.uploads >= this.config.maxItems) throw storeError('too_many_items');
    if (size > this.config.maxFileBytes) throw storeError('file_too_large');
    if (room.bytes + room.pendingBytes + size > this.config.maxRoomBytes) throw storeError('room_full');
    if (this.totalBytes + this.pendingBytes + size > this.config.maxTotalBytes) throw storeError('server_full');
    if (room.uploads >= MAX_UPLOADS_PER_ROOM) throw storeError('upload_busy');

    room.uploads += 1;
    room.pendingBytes += size;
    this.pendingBytes += size;
    let released = false;
    return {
      size,
      release: () => {
        if (released) return;
        released = true;
        room.uploads -= 1;
        room.pendingBytes -= size;
        this.pendingBytes -= size;
      },
    };
  }

  // tmpPath에 다 받아 둔 파일을 수업방 항목으로 등록합니다.
  // 실패하면 예외를 던지며, tmpPath 정리와 reservation.release()는 호출한 쪽 몫입니다.
  async commitUpload(room, reservation, { id, name, tmpPath }, now = Date.now()) {
    if (room.deleted) throw storeError('gone');
    const size = reservation.size;
    const finalPath = this.filePath(room, id);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await renameWithRetry(tmpPath, finalPath);
    if (room.deleted) {
      // 받는 사이에 수업방이 지워졌습니다.
      await this._remove(finalPath);
      await fsp.rmdir(path.dirname(finalPath)).catch(() => {});
      throw storeError('gone');
    }

    // 잡아 둔 자리를 실제 사용량으로 바꿉니다.
    reservation.release();
    room.bytes += size;
    this.totalBytes += size;
    const item = { id, type: 'file', at: now, name, size };
    room.items.push(item);
    this._changed(room, now);
    return item;
  }

  removeItem(room, id, now = Date.now()) {
    const index = room.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [item] = room.items.splice(index, 1);
    this._release(room, item);
    this._changed(room, now);
    return item;
  }

  clearItems(room, now = Date.now()) {
    const items = room.items;
    if (!items.length) return 0;
    room.items = [];
    for (const item of items) this._release(room, item);
    this._changed(room, now);
    return items.length;
  }

  _release(room, item) {
    room.textBytes -= textSize(item);
    if (item.type !== 'file') return;
    room.bytes -= item.size;
    this.totalBytes -= item.size;
    this._remove(this.filePath(room, item.id));
  }

  _changed(room, now) {
    room.version += 1;
    room.activeAt = now;
    room._itemsBuf = null;
    this.save(room);
  }

  // ------------------------------------------------------------ 정리

  // 오래 쓰지 않은 수업방을 지우고, 지워진 코드 목록을 돌려줍니다.
  async sweep(now = Date.now()) {
    const expired = [];
    for (const room of Array.from(this.rooms.values())) {
      if (now - room.activeAt > this.config.roomTtlMs) {
        expired.push(room.code);
        await this.deleteRoom(room);
      }
    }

    for (const target of Array.from(this.pendingDeletes)) {
      try {
        await fsp.rm(target, { recursive: true, force: true });
        this.pendingDeletes.delete(target);
      } catch (err) {
        // 다음 정리 때 다시 시도
      }
    }

    // 정리되지 못하고 남은 오래된 업로드 조각
    for (const name of await fsp.readdir(this.tmpDir).catch(() => [])) {
      const file = path.join(this.tmpDir, name);
      try {
        const stat = await fsp.stat(file);
        if (now - stat.mtimeMs > STALE_TMP_MS) await fsp.rm(file, { recursive: true, force: true });
      } catch (err) {
        // 이미 없어졌거나 사용 중
      }
    }
    return expired;
  }

  // Windows에서는 누군가 내려받는 중인 파일을 바로 지울 수 없어서, 실패하면 나중에 다시 시도합니다.
  async _remove(target) {
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      this.pendingDeletes.add(target);
    }
  }

  // ------------------------------------------------------------ 디스크 기록

  // 같은 수업방의 기록은 한 번에 하나씩만 진행하고, 진행 중에 바뀐 내용은 이어서 다시 씁니다.
  save(room) {
    if (room.deleted) return Promise.resolve();
    room._dirty = true;
    if (!room._saving) {
      room._saving = this._writeLoop(room).finally(() => {
        room._saving = null;
      });
    }
    return room._saving;
  }

  async _writeLoop(room) {
    const file = this.roomFile(room.code);
    const tmp = `${file}.${process.pid}.tmp`;
    while (room._dirty && !room.deleted) {
      room._dirty = false;
      const savedActiveAt = room.activeAt;
      try {
        // 임시 파일에 쓰고 디스크까지 내려보낸 뒤 이름을 바꿉니다. 기록 도중 전원이 나가도 이전 파일이 온전히 남습니다.
        const handle = await fsp.open(tmp, 'w');
        try {
          await handle.writeFile(JSON.stringify(serialize(room)));
          await handle.sync().catch(() => {}); // 일부 파일 시스템은 지원하지 않습니다
        } finally {
          await handle.close();
        }
        await renameWithRetry(tmp, file);
        room.savedActiveAt = savedActiveAt;
      } catch (err) {
        console.error(`[store] 수업방 ${room.code} 저장 실패: ${err.message}`);
        await fsp.rm(tmp, { force: true }).catch(() => {});
        return;
      }
    }
  }

  async flush() {
    const pending = [];
    for (const room of this.rooms.values()) if (room._saving) pending.push(room._saving);
    await Promise.all(pending.map((p) => p.catch(() => {})));
  }
}

// Windows에서는 백신 등이 파일을 잠깐 잡고 있으면 rename이 실패할 수 있습니다.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const retryable = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!retryable || attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
    }
  }
}

module.exports = { Store, publicItem, ROOM_NAME_MAX };
