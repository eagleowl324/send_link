'use strict';

// 테스트와 로컬 실행용: Vercel Blob을 흉내 내는 메모리 파일 저장소.
// src/vercel/blob.js 의 createBlobStore 와 같은 모양에 더해, 브라우저의 직접 업로드를 받는 HTTP 처리기를 제공합니다.

const crypto = require('node:crypto');
const util = require('../src/util');

function createFakeBlob({ baseUrl = '', now = () => Date.now() } = {}) {
  const files = new Map(); // pathname -> { data, uploadedAt, contentType }
  const tickets = new Map(); // clientToken -> { pathname, maxBytes, validUntil }
  let operations = 0;

  const urlOf = (pathname) => `${baseUrl}/_blob/${pathname.split('/').map(encodeURIComponent).join('/')}`;

  // 허가증을 확인하고 파일을 받습니다. 실패하면 { status, error }
  function accept(token, pathname, data) {
    const ticket = tickets.get(token);
    if (!ticket) return { status: 403, error: 'forbidden' };
    if (ticket.validUntil <= now()) return { status: 403, error: 'expired' };
    if (ticket.pathname !== pathname) return { status: 403, error: 'pathname_mismatch' };
    if (data.length > ticket.maxBytes) return { status: 413, error: 'too_large' };
    if (files.has(pathname)) return { status: 409, error: 'exists' };
    files.set(pathname, { data, uploadedAt: now(), contentType: util.fileInfo(pathname).mime });
    return {
      status: 200,
      body: {
        url: urlOf(pathname),
        downloadUrl: urlOf(pathname) + '?download=1',
        pathname,
        contentType: util.fileInfo(pathname).mime,
        contentDisposition: 'inline',
        etag: '"' + crypto.createHash('md5').update(data).digest('hex') + '"',
      },
    };
  }

  return {
    // 브라우저가 직접 올릴 주소와 머리글 (baseUrl이 비어 있으면 같은 사이트의 경로)
    async uploadTicket({ pathname, size, validUntil }) {
      operations += 1;
      const token = 'vercel_blob_client_fakestore_' + crypto.randomBytes(12).toString('hex');
      tickets.set(token, { pathname, maxBytes: size, validUntil });
      return {
        url: `${baseUrl}/_blobapi/?pathname=${encodeURIComponent(pathname)}`,
        headers: { authorization: `Bearer ${token}`, 'x-content-length': String(size) },
      };
    },

    async head(pathname) {
      operations += 1;
      const file = files.get(pathname);
      return file ? { pathname, size: file.data.length, url: urlOf(pathname), uploadedAt: file.uploadedAt } : null;
    },

    async del(pathnames) {
      operations += 1;
      for (const pathname of pathnames) files.delete(pathname);
    },

    async list({ prefix = '', mode } = {}) {
      operations += 1;
      const names = Array.from(files.keys()).filter((name) => name.startsWith(prefix)).sort();
      if (mode === 'folded') {
        const folders = new Set();
        const blobs = [];
        for (const name of names) {
          const rest = name.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash >= 0) folders.add(prefix + rest.slice(0, slash + 1));
          else blobs.push(name);
        }
        return { blobs: blobs.map(describe), folders: Array.from(folders), hasMore: false };
      }
      return { blobs: names.map(describe), folders: [], hasMore: false };
    },

    // ---- 테스트용
    // 받은 허가증(ticket)으로 올리기. pathname을 따로 주면 그 경로로 올리려 시도합니다.
    upload(ticket, data, pathname) {
      const token = String(ticket.headers.authorization).replace(/^Bearer\s+/i, '');
      const target = pathname || new URL(ticket.uploadUrl || ticket.url, 'http://localhost').searchParams.get('pathname');
      return accept(token, target, Buffer.from(data));
    },
    read: (pathname) => (files.has(pathname) ? files.get(pathname).data : null),
    pathnames: () => Array.from(files.keys()).sort(),
    operations: () => operations,
    setUploadedAt(pathname, at) {
      if (files.has(pathname)) files.get(pathname).uploadedAt = at;
    },

    // ---- 브라우저 직접 업로드(PUT /_blobapi/?pathname=…)와 파일 내려받기(GET /_blob/…)를 처리합니다.
    // 처리했으면 true
    async handle(req, res) {
      const url = new URL('http://localhost' + req.url);
      if (url.pathname === '/_blobapi/' || url.pathname === '/_blobapi') {
        if (req.method !== 'PUT') {
          res.writeHead(405).end();
          return true;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const result = accept(token, url.searchParams.get('pathname') || '', Buffer.concat(chunks));
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body || { error: { code: result.error, message: result.error } }));
        return true;
      }
      if (url.pathname.startsWith('/_blob/')) {
        let pathname = '';
        try {
          pathname = url.pathname.slice('/_blob/'.length).split('/').map(decodeURIComponent).join('/');
        } catch (err) {
          pathname = '';
        }
        const file = files.get(pathname);
        if (!file) {
          res.writeHead(404).end('not found');
          return true;
        }
        const name = pathname.slice(pathname.lastIndexOf('/') + 1);
        const download = url.searchParams.has('download');
        res.writeHead(200, {
          'Content-Type': download ? 'application/octet-stream' : file.contentType,
          'Content-Length': file.data.length,
          'Content-Disposition': util.contentDisposition(download ? 'attachment' : 'inline', name),
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : file.data);
        return true;
      }
      return false;
    },
  };

  function describe(pathname) {
    const file = files.get(pathname);
    return { pathname, size: file.data.length, uploadedAt: file.uploadedAt };
  }
}

module.exports = { createFakeBlob };
