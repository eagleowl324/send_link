'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------- 식별자·비교

function randomId() {
  return crypto.randomBytes(16).toString('hex');
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function randomCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// 길이와 무관하게 일정한 시간에 끝나는 문자열 비교
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------- 문자열 정리

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// 짝이 맞지 않는 서러게이트(깨진 이모지 조각). 남겨 두면 encodeURIComponent가 예외를 던집니다.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripLoneSurrogates(str) {
  return str.replace(LONE_SURROGATE, '');
}
// 파일 이름 확장자를 거꾸로 보이게 만드는 방향 제어 문자 (예: "exe.fdp")
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function truncate(str, maxChars) {
  const chars = Array.from(str);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : str;
}

// 수업방 이름처럼 한 줄짜리 값
function cleanLine(value, maxChars) {
  if (typeof value !== 'string') return '';
  const s = stripLoneSurrogates(value.slice(0, maxChars * 8))
    .normalize('NFC')
    .replace(CONTROL, ' ')
    .replace(BIDI, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(s, maxChars).trim();
}

// 공유 텍스트: 줄바꿈·들여쓰기는 그대로 두고 제어 문자만 제거
function cleanText(value) {
  if (typeof value !== 'string') return '';
  const s = stripLoneSurrogates(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trimEnd();
  const lines = s.split('\n');
  let first = 0;
  while (first < lines.length - 1 && lines[first].trim() === '') first += 1;
  return first ? lines.slice(first).join('\n') : s;
}

const MAX_FILE_NAME = 150;

function sanitizeFileName(value) {
  if (typeof value !== 'string') return '';
  let name = stripLoneSurrogates(value.slice(0, 1024))
    .normalize('NFC') // macOS가 보내는 자소 분리(NFD) 한글 이름을 합칩니다
    .replace(CONTROL, '')
    .replace(BIDI, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!name || /^\.+$/.test(name)) return '';
  if (Array.from(name).length > MAX_FILE_NAME) {
    const ext = path.posix.extname(name);
    const extLen = Array.from(ext).length;
    if (extLen > 0 && extLen <= 16) {
      name = truncate(name.slice(0, name.length - ext.length), MAX_FILE_NAME - extLen).replace(/[. ]+$/, '') + ext;
    } else {
      name = truncate(name, MAX_FILE_NAME).replace(/[. ]+$/, '');
    }
  }
  return name;
}

// ---------------------------------------------------------------- 파일 종류

const FILE_TYPES = new Map();

function defineTypes(kind, mime, exts) {
  for (const ext of exts) FILE_TYPES.set(ext, { kind, mime });
}

// 브라우저에서 바로 "열기"를 허용하는 형식만 등록합니다.
// (HTML·SVG처럼 스크립트를 담을 수 있는 형식은 항상 다운로드되거나 일반 텍스트로만 열립니다.)
defineTypes('image', 'image/png', ['png']);
defineTypes('image', 'image/jpeg', ['jpg', 'jpeg']);
defineTypes('image', 'image/gif', ['gif']);
defineTypes('image', 'image/webp', ['webp']);
defineTypes('image', 'image/avif', ['avif']);
defineTypes('image', 'image/bmp', ['bmp']);
defineTypes('pdf', 'application/pdf', ['pdf']);
defineTypes('video', 'video/mp4', ['mp4', 'm4v']);
defineTypes('video', 'video/webm', ['webm']);
defineTypes('video', 'video/quicktime', ['mov']);
defineTypes('audio', 'audio/mpeg', ['mp3']);
defineTypes('audio', 'audio/mp4', ['m4a']);
defineTypes('audio', 'audio/wav', ['wav']);
defineTypes('audio', 'audio/ogg', ['ogg']);
defineTypes('text', 'text/plain', [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'log',
  'py', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'java', 'kt', 'go', 'rs',
  'rb', 'php', 'pl', 'sh', 'bat', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'r', 'swift', 'lua',
  'ino', 'tex', 'srt', 'vtt',
]);

function fileInfo(name) {
  const ext = path.posix.extname(String(name)).slice(1).toLowerCase();
  const type = FILE_TYPES.get(ext);
  if (type) return { ext, kind: type.kind, mime: type.mime, inline: true };
  return { ext, kind: 'other', mime: 'application/octet-stream', inline: false };
}

// 한글 등 비ASCII 파일 이름을 위한 RFC 6266 / RFC 5987 헤더
function contentDisposition(type, name) {
  const fallback = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  let encoded;
  try {
    encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  } catch (err) {
    return `${type}; filename="${fallback}"`; // 인코딩할 수 없는 이름이면 ASCII 이름만
  }
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// "bytes=0-99" 형태의 단일 범위만 지원합니다. 그 밖의 형식은 무시(전체 전송)합니다.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!suffix) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

// ---------------------------------------------------------------- 링크 판별

// "naver.com"처럼 주소만 적어도 링크로 인정하는 최상위 도메인.
// 파일 확장자와 헷갈리는 것(py, sh, md …)은 일부러 넣지 않았습니다.
const BARE_TLDS = new Set(
  ('com net org kr io co me ly app dev edu ai gg tv us to do la gl gle be is so ' +
    'site page link info xyz jp uk cn de fr ca au').split(' ')
);

const BARE_DOMAIN =
  /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+)([a-z]{2,24})(:\d{1,5})?([/?#].*)?$/i;

// 입력 전체가 주소 하나일 때만 정규화된 URL을 돌려줍니다. 아니면 null.
function detectLink(text) {
  const t = String(text).trim();
  if (!t || t.length > 2048 || /\s/.test(t)) return null;

  let candidate = '';
  if (/^https?:\/\//i.test(t)) {
    candidate = t;
  } else if (/^www\.[^./]+\.[^./]/i.test(t)) {
    candidate = 'https://' + t;
  } else {
    const m = BARE_DOMAIN.exec(t);
    if (m) {
      const tld = m[2].toLowerCase();
      const hasPath = Boolean(m[4]) && m[4].length > 1;
      if (BARE_TLDS.has(tld) || hasPath) candidate = 'https://' + t;
    }
  }
  if (!candidate) return null;

  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------- 네트워크

function normalizeIp(ip) {
  const s = String(ip || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

function isLoopback(ip) {
  const s = normalizeIp(ip);
  return s === '::1' || s.startsWith('127.');
}

// IPv6 주소를 8개 묶음으로 펼칩니다. 형식이 아니면 null.
function expandIPv6(ip) {
  let s = String(ip).split('%')[0];
  if (!net.isIPv6(s)) return null;
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.', lastColon) >= 0) {
    // 끝에 IPv4가 붙은 표기 (예: 64:ff9b::192.0.2.1)
    const v4 = s.slice(lastColon + 1).split('.').map(Number);
    s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = head.concat(new Array(fill).fill('0'), tail);
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}

// 접속 제한을 셀 때 쓰는 키. IPv6는 한 사용자가 /64 대역 전체를 쓸 수 있으므로 앞 64비트로 묶습니다.
function rateKey(ip) {
  const s = normalizeIp(ip);
  if (s.indexOf(':') < 0) return s;
  const groups = expandIPv6(s);
  return groups ? groups.slice(0, 4).join(':') + '::/64' : s;
}

const VIRTUAL_IFACE = /vethernet|virtualbox|vmware|vmnet|docker|^br-|^veth|wsl|hyper-v|loopback|utun|tailscale|zerotier|^tun|^tap/i;

// 같은 네트워크의 학생 기기가 접속할 수 있는 이 컴퓨터의 IPv4 주소 (가능성 높은 순)
function lanAddresses() {
  const found = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = typeof net.family === 'string' ? net.family : 'IPv' + net.family;
      if (family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue;
      let rank = 3;
      if (net.address.startsWith('192.168.')) rank = 0;
      else if (net.address.startsWith('10.')) rank = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(net.address)) rank = 2;
      if (VIRTUAL_IFACE.test(name)) rank += 10;
      found.push({ address: net.address, rank });
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  return Array.from(new Set(found.map((f) => f.address)));
}

module.exports = {
  randomId,
  randomToken,
  randomCode,
  sha256hex,
  safeEqual,
  stripLoneSurrogates,
  cleanLine,
  cleanText,
  sanitizeFileName,
  fileInfo,
  contentDisposition,
  parseRange,
  detectLink,
  normalizeIp,
  rateKey,
  isLoopback,
  lanAddresses,
};
