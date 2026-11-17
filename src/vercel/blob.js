'use strict';

// 파일 저장소(Vercel Blob) 연결. 공식 SDK(@vercel/blob)를 감싸서 이 서비스가 쓰는 동작만 내놓습니다.
// 파일은 "공개(public)" 저장소에 올라가며, 주소에 추측할 수 없는 값이 들어 있어 주소를 아는 사람만 받을 수 있습니다.

// 브라우저가 파일을 올릴 때 쓰는 저장소 API 주소와 버전. @vercel/blob SDK(2.9.0)가 쓰는 값과 같아야 합니다.
// (SDK를 올릴 때는 SDK 소스의 BLOB_API_VERSION 과 맞는지 확인하세요. test/vercel.test.js 가 검사합니다)
const BLOB_API_URL = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '13';

function createBlobStore({ token }) {
  if (!token) throw new Error('파일 저장소 접속 정보(BLOB_READ_WRITE_TOKEN)가 없습니다.');
  // 이 패키지들은 Vercel에 올릴 때만 필요하므로 여기서 불러옵니다. (자체 서버로 실행할 때는 설치하지 않아도 됨)
  const sdk = require('@vercel/blob');
  const client = require('@vercel/blob/client');

  return {
    // 브라우저가 이 경로에, 이 크기까지만 직접 올릴 수 있는 일회용 허가증과, 그것으로 올리는 방법(주소·머리글).
    // 브라우저는 받은 주소로 파일을 PUT 하기만 하면 됩니다.
    async uploadTicket({ pathname, size, validUntil }) {
      const clientToken = await client.generateClientTokenFromReadWriteToken({
        token,
        pathname,
        maximumSizeInBytes: size,
        validUntil,
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      const storeId = clientToken.split('_')[3] || '';
      return {
        url: `${BLOB_API_URL}/?pathname=${encodeURIComponent(pathname)}`,
        headers: {
          authorization: `Bearer ${clientToken}`,
          'x-api-version': BLOB_API_VERSION,
          'x-vercel-blob-access': 'public',
          'x-vercel-blob-store-id': storeId,
          'x-content-length': String(size),
        },
      };
    },

    // 올라가 있는 파일 정보. 없으면 null
    async head(pathname) {
      try {
        const found = await sdk.head(pathname, { token });
        return {
          pathname: found.pathname,
          size: found.size,
          url: found.url,
          uploadedAt: new Date(found.uploadedAt).getTime(),
        };
      } catch (err) {
        if (err instanceof sdk.BlobNotFoundError) return null;
        throw err;
      }
    },

    async del(pathnames) {
      if (pathnames.length) await sdk.del(pathnames, { token });
    },

    async list({ prefix, mode, cursor }) {
      const page = await sdk.list({ prefix, mode, cursor, limit: 1000, token });
      return {
        blobs: (page.blobs || []).map((b) => ({
          pathname: b.pathname,
          size: b.size,
          uploadedAt: new Date(b.uploadedAt).getTime(),
        })),
        folders: page.folders || [],
        cursor: page.cursor,
        hasMore: Boolean(page.hasMore),
      };
    },
  };
}

module.exports = { createBlobStore, BLOB_API_URL, BLOB_API_VERSION };
