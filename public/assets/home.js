/* 수업공유 — 처음 화면: 코드로 들어가기, 수업방 만들기 */
(function () {
  'use strict';

  var A = window.App;
  var $ = A.$;

  function showError(node, message) {
    node.textContent = message || '';
    node.hidden = !message;
  }

  // ------------------------------------------------------------ 학생: 코드로 들어가기

  var codeInput = $('join-code');
  var joinError = $('join-error');
  var joining = false;

  function digitsOf(value) {
    return String(value).replace(/\D/g, '').slice(0, 6);
  }

  function join() {
    var code = digitsOf(codeInput.value);
    if (code.length !== 6) {
      showError(joinError, '숫자 6자리를 입력해 주세요.');
      codeInput.focus();
      return;
    }
    if (joining) return;
    joining = true;
    showError(joinError, '');
    A.api('GET', '/api/rooms/' + code).then(
      function () {
        location.href = '/' + code;
      },
      function (err) {
        joining = false;
        showError(joinError, err.status === 404 ? '없는 코드입니다. 숫자를 다시 확인해 주세요.' : A.errorText(err));
        codeInput.focus();
        codeInput.select();
      }
    );
  }

  codeInput.addEventListener('input', function () {
    var digits = digitsOf(codeInput.value);
    var formatted = digits.length > 3 ? digits.slice(0, 3) + ' ' + digits.slice(3) : digits;
    if (codeInput.value !== formatted) codeInput.value = formatted;
    showError(joinError, '');
    if (digits.length === 6) join();
  });

  $('join-form').addEventListener('submit', function (event) {
    event.preventDefault();
    join();
  });

  // 뒤로 가기로 돌아왔을 때 다시 입력할 수 있게
  window.addEventListener('pageshow', function () {
    joining = false;
    creating = false;
    $('create-button').disabled = false;
  });

  // ------------------------------------------------------------ 선생님: 수업방 만들기

  var createError = $('create-error');
  var creating = false;

  $('create-form').addEventListener('submit', function (event) {
    event.preventDefault();
    if (creating) return;
    var passwordField = $('password-field');
    var password = $('room-password').value;
    if (!passwordField.hidden && !password) {
      showError(createError, '수업방 생성 비밀번호를 입력해 주세요.');
      $('room-password').focus();
      return;
    }
    creating = true;
    $('create-button').disabled = true;
    showError(createError, '');
    A.api('POST', '/api/rooms', { name: $('room-name').value, password: password }).then(
      function (room) {
        A.rooms.save(room.code, room.token, room.name);
        // 저장소를 쓸 수 없는 브라우저에서도 권한이 이어지도록 주소 뒤(#)에 실어 보냅니다. 서버로는 전송되지 않습니다.
        location.href = '/' + room.code + '#host=' + encodeURIComponent(room.token);
      },
      function (err) {
        creating = false;
        $('create-button').disabled = false;
        showError(createError, A.errorText(err));
      }
    );
  });

  // ------------------------------------------------------------ 이 기기에서 만든 수업방

  function renderMyRooms() {
    var rooms = A.rooms.all();
    var list = $('my-room-list');
    list.textContent = '';
    rooms.forEach(function (room) {
      list.appendChild(
        A.el('li', null, [
          A.el('a', { href: '/' + room.code }, [
            A.el('span', { class: 'room-list__name', text: room.name || '이름 없는 수업방' }),
            A.el('span', { class: 'room-list__code', text: A.formatCode(room.code) })
          ])
        ])
      );
    });
    $('my-rooms').hidden = rooms.length === 0;
  }

  renderMyRooms();

  // 이미 지워졌거나 권한이 사라진 수업방은 목록에서 뺍니다.
  A.rooms.all().forEach(function (room) {
    A.api('GET', '/api/rooms/' + room.code, null, room.token).then(
      function (snap) {
        if (!snap.isHost) A.rooms.forget(room.code);
        else if (snap.name !== room.name) A.rooms.save(room.code, room.token, snap.name);
        renderMyRooms();
      },
      function (err) {
        // 이 서비스가 "없는 수업방"이라고 답한 경우에만 목록에서 뺍니다. (일시적인 오류로 권한을 잃지 않도록)
        if (err.status === 404 && err.code === 'not_found') {
          A.rooms.forget(room.code);
          renderMyRooms();
        }
      }
    );
  });

  // ------------------------------------------------------------ 서버 설정 반영

  A.api('GET', '/api/config').then(
    function (config) {
      $('password-field').hidden = !config.requirePassword;
      var days = config.roomTtlMs / 86400000;
      var keep = days >= 1 ? Math.round(days) + '일' : Math.max(1, Math.round(days * 24)) + '시간';
      $('footnote').textContent =
        '파일은 하나에 최대 ' + A.formatBytes(config.maxFileBytes) + '까지 올릴 수 있고, 수업방은 마지막 사용 후 ' + keep + ' 동안 보관됩니다.';
    },
    function (err) {
      // 설정을 못 읽어도 기본 화면은 그대로 쓸 수 있습니다. 다만 서버 준비가 덜 된 경우에는 알려 줍니다.
      if (err && err.code === 'not_configured') {
        $('footnote').className = 'footnote form-error';
        $('footnote').textContent = A.errorText(err);
      }
    }
  );
})();
