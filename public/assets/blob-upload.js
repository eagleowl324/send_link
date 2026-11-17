/* 수업공유 — 파일 저장소로 브라우저에서 직접 올리기 (Vercel에 올렸을 때 쓰입니다) */
(function () {
  'use strict';

  var A = window.App;

  // entry: { name, size, file }   hooks: { progress(0~1), done(item), fail(message), cancelled() }
  // ctx:   { roomUrl, token, config }
  // 취소할 때 부를 함수를 돌려줍니다.
  //
  // 순서: 1) 서버에서 허가증(올릴 주소와 머리글) 받기 → 2) 저장소로 직접 PUT → 3) 서버에 등록 요청
  // 2단계는 진행률을 알 수 있고 어떤 네트워크(HTTP/1.1 포함)에서도 동작하는 XMLHttpRequest를 씁니다.
  A.uploadToBlob = function (entry, hooks, ctx) {
    var cancelled = false;
    var xhr = null;

    function describe(err) {
      if (err && err.status) {
        if (err.code === 'file_too_large') {
          return '파일이 너무 큽니다. (하나에 최대 ' + A.formatBytes(ctx.config.maxFileBytes) + ')';
        }
        return A.errorText(err);
      }
      if (err && err.code === 'timeout') return A.errorText(err);
      if (err && err.storageStatus) return '파일 저장소가 받지 않았습니다. (오류 ' + err.storageStatus + ') 잠시 뒤 다시 시도해 주세요.';
      return '파일 저장소에 올리지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.';
    }

    function putFile(ticket) {
      return new Promise(function (resolve, reject) {
        xhr = new XMLHttpRequest();
        xhr.open('PUT', ticket.uploadUrl, true);
        Object.keys(ticket.headers || {}).forEach(function (name) {
          xhr.setRequestHeader(name, ticket.headers[name]);
        });
        xhr.upload.onprogress = function (event) {
          // 등록 단계가 남아 있으므로 99%까지만 표시합니다.
          if (event.lengthComputable && event.total) hooks.progress(Math.min(0.99, event.loaded / event.total));
        };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            var err = new Error('storage');
            err.storageStatus = xhr.status;
            reject(err);
          }
        };
        xhr.onerror = function () {
          reject(new Error('network'));
        };
        xhr.onabort = function () {
          reject(new Error('aborted'));
        };
        xhr.send(entry.file);
      });
    }

    A.api('POST', ctx.roomUrl + '/upload', { name: entry.name, size: entry.size }, ctx.token)
      .then(function (ticket) {
        if (cancelled) return null;
        return putFile(ticket).then(function () {
          if (cancelled) return null;
          return A.api('POST', ctx.roomUrl + '/files', { id: ticket.id }, ctx.token, 30000);
        });
      })
      .then(
        function (result) {
          if (cancelled || !result) hooks.cancelled();
          else hooks.done(result.item);
        },
        function (err) {
          if (cancelled) hooks.cancelled();
          else hooks.fail(describe(err));
        }
      );

    return function () {
      cancelled = true;
      if (xhr) xhr.abort();
    };
  };
})();
