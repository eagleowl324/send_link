'use strict';

// 파일 저장소(Vercel Blob) 연결. 공식 SDK(@vercel/blob)를 감싸서 이 서비스가 쓰는 동작만 내놓습니다.
//
// 저장소에 접속하는 방법은 두 가지이고, Vercel이 프로젝트에 넣어 준 환경 변수에 따라 정해집니다.
//   1) BLOB_STORE_ID (요즘 방식): 비밀 값 없이, Vercel이 요청마다 함수에 건네주는 신원 토큰(OIDC)으로 접속합니다.
//      브라우저에는 "이 경로에, 이 크기까지만" 올릴 수 있는 서명된 주소를 만들어 줍니다.
//   2) BLOB_READ_WRITE_TOKEN (예전 방식): 읽기/쓰기 토큰으로 접속하고, 브라우저에는 일회용 토큰을 만들어 줍니다.
//
// 파일은 "공개(public)" 저장소에 올라가며, 주소에 추측할 수 없는 값이 들어 있어 주소를 아는 사람만 받을 수 있습니다.

const crypto = require('node:crypto');

// 브라우저가 파일을 올릴 때 쓰는 저장소 API 주소와 버전. @vercel/blob SDK(2.9.0)가 쓰는 값과 같아야 합니다.
// (SDK를 올릴 때는 SDK 소스의 BLOB_API_VERSION 과 맞는지 확인하세요. test/vercel.test.js 가 검사합니다)
const BLOB_API_URL = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '13';

// 서명된 올리기 주소의 유효 시간 상한. (저장소 API의 기본값인 1시간보다 조금 짧게 잡습니다)
const SIGNED_URL_MAX_MS = 50 * 60 * 1000;

// 저장소 쪽 문제. storageCode 는 화면에 보여 줄 안내를 고르는 데 쓰고, message 는 원인 파악용입니다.
//   storage_auth    저장소가 이 프로젝트의 접속을 받아들이지 않음 (연결·권한 설정 문제)
//   storage_private 저장소가 비공개(Private)로 만들어져 있음
//   storage_error   그 밖의 실패 (일시적인 장애 등)
class StorageError extends Error {
  constructor(storageCode, message) {
    super(message);
    this.name = 'StorageError';
    this.storageCode = storageCode;
  }
}

function accessFromUrl(url) {
  const m = /\.(public|private)\.blob\.vercel-storage\.com$/i.exec(hostOf(url));
  return m ? m[1].toLowerCase() : '';
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch (err) {
    return '';
  }
}

// token:     BLOB_READ_WRITE_TOKEN (있으면 이것을 씁니다)
// storeId:   BLOB_STORE_ID
// oidcToken: 지금 처리 중인 요청의 신원 토큰을 돌려주는 함수 (storeId 방식에서 필요)
// access:    'public' | 'private' 를 미리 알고 있으면 지정. 비워 두면 처음 한 번 저장소에 물어서 알아냅니다.
// memo:      알아낸 값을 기억해 둘 곳 { get(key), set(key, value) } (없어도 됨)
// sdk, client: 테스트에서 바꿔 끼우기 위한 것
function createBlobStore({ token = '', storeId = '', oidcToken = null, access = '', memo = null, sdk, client } = {}) {
  if (!token && !storeId) {
    throw new Error('파일 저장소 접속 정보(BLOB_STORE_ID 또는 BLOB_READ_WRITE_TOKEN)가 없습니다.');
  }
  // 이 패키지들은 Vercel에 올릴 때만 필요하므로 여기서 불러옵니다. (자체 서버로 실행할 때는 설치하지 않아도 됨)
  const blobSdk = sdk || require('@vercel/blob');
  const getClient = () => client || require('@vercel/blob/client');

  // SDK는 저장소가 응답하지 않으면 기본 10번까지 다시 시도하는데, 함수 실행 시간(30초) 안에 끝나도록 줄입니다.
  if (!process.env.VERCEL_BLOB_RETRIES) process.env.VERCEL_BLOB_RETRIES = '2';

  const bareStoreId = token ? String(token.split('_')[3] || '') : String(storeId).replace(/^store_/, '');
  let accessType = access === 'public' || access === 'private' ? access : '';
  let detecting = null;

  // SDK 호출에 넘길 접속 정보
  function credentials() {
    if (token) return { token };
    const oidc = String((typeof oidcToken === 'function' ? oidcToken() : oidcToken) || '').trim();
    if (!oidc) {
      throw new StorageError(
        'storage_auth',
        'Vercel이 이 함수에 신원 토큰(OIDC)을 건네주지 않았습니다. 프로젝트 설정의 OIDC(Secure Backend Access)가 켜져 있어야 합니다.'
      );
    }
    return { oidcToken: oidc, storeId };
  }

  function wrap(err) {
    if (err instanceof StorageError) return err;
    const message = String((err && err.message) || err).slice(0, 300);
    const denied =
      (blobSdk.BlobAccessError && err instanceof blobSdk.BlobAccessError) ||
      /OIDC|No blob credentials|oidcToken/i.test(message);
    return new StorageError(denied ? 'storage_auth' : 'storage_error', message);
  }

  async function call(work) {
    try {
      return await work(credentials());
    } catch (err) {
      throw wrap(err);
    }
  }

  // 저장소가 공개용인지 비공개용인지. 저장소를 만들 때 정해지고 바뀌지 않으므로 한 번만 알아냅니다.
  async function resolveAccess() {
    if (accessType) return accessType;
    if (!detecting) {
      detecting = detectAccess().finally(() => {
        detecting = null;
      });
    }
    return detecting;
  }

  async function detectAccess() {
    const key = `blob-access:${bareStoreId}`;
    if (memo) {
      const saved = await Promise.resolve(memo.get(key)).catch(() => null);
      if (saved === 'public' || saved === 'private') {
        accessType = saved;
        return saved;
      }
    }
    const found = await probeAccess();
    accessType = found;
    if (memo) await Promise.resolve(memo.set(key, found)).catch(() => {});
    return found;
  }

  // 아주 작은 파일을 올려 보고(곧바로 지웁니다) 어느 쪽으로 받아 주는지 봅니다.
  async function probeAccess() {
    const pathname = `probe/${crypto.randomBytes(8).toString('hex')}.txt`;
    let firstError = null;
    for (const candidate of ['public', 'private']) {
      try {
        const cred = credentials();
        const put = await blobSdk.put(
          pathname,
          'ok',
          Object.assign({ access: candidate, addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain' }, cred)
        );
        await Promise.resolve(blobSdk.del(put.pathname || pathname, cred)).catch(() => {});
        return accessFromUrl(put.url) || candidate;
      } catch (err) {
        if (!firstError) firstError = err;
        if (err instanceof StorageError) break; // 접속 정보가 없으면 다른 방식으로 해 봐도 같습니다
      }
    }
    throw wrap(firstError);
  }

  return {
    // 브라우저가 이 경로에, 이 크기까지만 직접 올릴 수 있는 일회용 허가와, 그것으로 올리는 방법(주소·머리글).
    // 브라우저는 받은 주소로 파일을 PUT 하기만 하면 됩니다.
    async uploadTicket({ pathname, size, validUntil }) {
      const kind = await resolveAccess();
      if (kind !== 'public') {
        throw new StorageError(
          'storage_private',
          '연결된 Blob 저장소가 비공개(Private)용입니다. 공개(Public) 저장소를 만들어 연결해 주세요.'
        );
      }
      return call(async (cred) => {
        const headers = {
          'x-api-version': BLOB_API_VERSION,
          'x-vercel-blob-access': kind,
          'x-vercel-blob-store-id': bareStoreId,
          'x-content-length': String(size),
        };
        if (cred.token) {
          const clientToken = await getClient().generateClientTokenFromReadWriteToken({
            token: cred.token,
            pathname,
            maximumSizeInBytes: size,
            validUntil,
            addRandomSuffix: false,
            allowOverwrite: false,
          });
          headers.authorization = `Bearer ${clientToken}`;
          return { url: `${BLOB_API_URL}/?pathname=${encodeURIComponent(pathname)}`, headers };
        }
        // 저장소가 서명해 준 위임 토큰으로, 조건(경로·크기·덮어쓰기 금지)이 박힌 올리기 주소를 만듭니다.
        // 위임 토큰 자체는 경로를 가리지 않게('*') 받고, 경로는 주소의 서명으로 묶습니다. 서명에 쓰는 열쇠는
        // 서버 밖으로 나가지 않으므로 브라우저가 다른 경로의 주소를 만들 수는 없습니다.
        // (토큰에 경로를 넣으면 SDK 2.9.0이 한글 같은 비ASCII 경로를 잘못 읽어 "경로가 다르다"며 거절합니다)
        const signed = await blobSdk.issueSignedToken(
          Object.assign(
            {
              pathname: '*',
              operations: ['put'],
              maximumSizeInBytes: size,
              validUntil: Math.floor(Math.min(validUntil, Date.now() + SIGNED_URL_MAX_MS)),
            },
            cred
          )
        );
        const { presignedUrl } = await blobSdk.presignUrl(signed, {
          operation: 'put',
          pathname,
          access: kind,
          maximumSizeInBytes: size,
          addRandomSuffix: false,
          allowOverwrite: false,
        });
        // 저장소 번호는 SDK가 하듯 위임 토큰에 적힌 것을 씁니다. (읽지 못하면 환경 변수의 것을 그대로 둡니다)
        try {
          headers['x-vercel-blob-store-id'] = blobSdk.parseStoreIdFromDelegationToken(signed.delegationToken) || bareStoreId;
        } catch (err) {
          headers['x-vercel-blob-store-id'] = bareStoreId;
        }
        return { url: presignedUrl, headers };
      });
    },

    // 올라가 있는 파일 정보. 없으면 null
    async head(pathname) {
      return call(async (cred) => {
        try {
          const found = await blobSdk.head(pathname, cred);
          return {
            pathname: found.pathname,
            size: found.size,
            url: found.url,
            uploadedAt: new Date(found.uploadedAt).getTime(),
          };
        } catch (err) {
          if (blobSdk.BlobNotFoundError && err instanceof blobSdk.BlobNotFoundError) return null;
          throw err;
        }
      });
    },

    async del(pathnames) {
      if (!pathnames.length) return;
      await call((cred) => blobSdk.del(pathnames, cred));
    },

    async list({ prefix, mode, cursor }) {
      return call(async (cred) => {
        const page = await blobSdk.list(Object.assign({ prefix, mode, cursor, limit: 1000 }, cred));
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
      });
    },

    // 저장소 종류 ('public' | 'private'). 필요하면 저장소에 물어봅니다.
    access: resolveAccess,
  };
}

module.exports = { createBlobStore, StorageError, BLOB_API_URL, BLOB_API_VERSION };
