/* 수업공유 — 관리자 페이지: 처음 설정, 로그인, 수업방 만들기 비밀번호, 수업방 목록 */
(function () {
  'use strict';

  var A = window.App;
  var $ = A.$;
  var el = A.el;

  // 로그인 정보는 이 탭에만 둡니다. 탭을 닫으면 로그아웃됩니다. (교실의 공용 컴퓨터를 생각해서)
  var SESSION_KEY = 'classshare.admin';
  var session = null; // { token, expiresAt }
  var overview = null; // 서버가 준 현재 상태

  function loadSession() {
    try {
      var value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (value && typeof value.token === 'string' && value.expiresAt > Date.now()) return value;
    } catch (err) {
      /* 저장소를 쓸 수 없는 환경 */
    }
    return null;
  }

  function saveSession(value) {
    session = value && typeof value.token === 'string' ? { token: value.token, expiresAt: value.expiresAt } : null;
    try {
      if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* 저장하지 못해도 이 화면에서는 계속 쓸 수 있습니다 */
    }
  }

  // ------------------------------------------------------------ 화면 전환

  function show(state) {
    document.body.setAttribute('data-state', state);
    $('setup').hidden = state !== 'setup';
    $('login').hidden = state !== 'login';
    $('notice').hidden = state !== 'notice';
    $('board').hidden = state !== 'ready';
    $('logout').hidden = state !== 'ready';
  }

  function showNotice(title, text) {
    $('notice-title').textContent = title;
    $('notice-text').textContent = text;
    show('notice');
  }

  function showError(node, message) {
    node.textContent = message || '';
    node.hidden = !message;
  }

  // 입력이 잘못됐을 때: 이유를 보여 주고 그 칸으로 보냅니다.
  function reject(errorNode, message, inputId) {
    showError(errorNode, message);
    if (inputId) $(inputId).focus();
  }

  function showLogin(message) {
    $('login-password').value = '';
    showError($('login-error'), message || '');
    $('login-button').disabled = false;
    show('login');
    $('login-password').focus();
  }

  function showSetup(needsProof) {
    $('setup-proof-field').hidden = !needsProof;
    $('setup-button').disabled = false;
    show('setup');
    (needsProof ? $('setup-proof') : $('setup-password')).focus();
  }

  // 로그인이 필요한 요청. 로그인이 풀렸으면 로그인 화면으로 보냅니다.
  function call(method, path, body) {
    return A.api(method, path, body, session ? session.token : '').catch(function (err) {
      if (err && err.status === 401) {
        saveSession(null);
        showLogin('로그인 시간이 지났습니다. 다시 로그인해 주세요.');
      }
      throw err;
    });
  }

  // ------------------------------------------------------------ 표시 형식

  function ago(ms) {
    var minutes = Math.floor((Date.now() - ms) / 60000);
    if (minutes < 1) return '방금';
    if (minutes < 60) return minutes + '분 전';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + '시간 전';
    return Math.floor(hours / 24) + '일 전';
  }

  function span(ms) {
    var hours = Math.max(1, Math.round(ms / 3600000));
    return hours < 48 ? hours + '시간' : Math.round(hours / 24) + '일';
  }

  // ------------------------------------------------------------ 시작

  function start() {
    session = loadSession();
    A.api('GET', '/api/admin', null, session ? session.token : '').then(
      function (status) {
        if (status.signedIn) {
          loadOverview(true);
          return;
        }
        saveSession(null);
        if (status.configured) showLogin('');
        else showSetup(status.needsProof);
      },
      function (err) {
        if (err.status === 404) {
          showNotice('관리자 페이지를 쓸 수 없습니다', '직접 서버로 실행하는 방식에서는 관리자 페이지를 지원하지 않습니다. 설정은 환경 변수로 해 주세요.');
        } else if (err.code === 'not_configured') {
          showNotice('서버 설정이 아직 끝나지 않았습니다', (err.data && err.data.message) || '저장소 연결을 확인해 주세요.');
        } else {
          showNotice('불러오지 못했습니다', A.errorText(err));
        }
      }
    );
  }

  function loadOverview(first) {
    return call('GET', '/api/admin/overview').then(
      function (data) {
        overview = data;
        renderTeacher();
        renderRooms();
        renderStatus();
        renderAccount();
        show('ready');
      },
      function (err) {
        if (err.status === 401) return;
        if (first) showNotice('불러오지 못했습니다', A.errorText(err));
        else A.toast(A.errorText(err), 'error');
      }
    );
  }

  // ------------------------------------------------------------ 처음 설정

  $('setup-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = $('setup-error');
    var needsProof = !$('setup-proof-field').hidden;
    var body = { password: $('setup-password').value };
    if (needsProof) {
      body.proof = $('setup-proof').value;
      if (!body.proof) return reject(error, '지금 쓰고 있는 수업방 생성 비밀번호를 입력해 주세요.', 'setup-proof');
    }
    if (body.password.length < 8) return reject(error, '관리자 비밀번호는 8자 이상으로 정해 주세요.', 'setup-password');
    if (body.password !== $('setup-confirm').value) return reject(error, '두 번 입력한 비밀번호가 서로 다릅니다.', 'setup-confirm');

    showError(error, '');
    $('setup-button').disabled = true;
    A.api('POST', '/api/admin/setup', body).then(
      function (made) {
        saveSession(made);
        $('setup-password').value = '';
        $('setup-confirm').value = '';
        $('setup-proof').value = '';
        A.toast('관리자 비밀번호를 만들었습니다.');
        loadOverview(true);
      },
      function (err) {
        $('setup-button').disabled = false;
        if (err.code === 'already_configured') {
          showLogin('이미 관리자가 정해져 있습니다. 로그인해 주세요.');
        } else if (err.code === 'bad_password') {
          reject(error, '수업방 생성 비밀번호가 올바르지 않습니다.', 'setup-proof');
        } else {
          showError(error, A.errorText(err));
        }
      }
    );
  });

  // ------------------------------------------------------------ 로그인 · 로그아웃

  $('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = $('login-error');
    var password = $('login-password').value;
    if (!password) return reject(error, '관리자 비밀번호를 입력해 주세요.', 'login-password');
    showError(error, '');
    $('login-button').disabled = true;
    A.api('POST', '/api/admin/login', { password: password }).then(
      function (made) {
        saveSession(made);
        $('login-password').value = '';
        loadOverview(true);
      },
      function (err) {
        $('login-button').disabled = false;
        if (err.code === 'admin_not_set') {
          start(); // 그 사이 처음 상태로 되돌려진 경우
          return;
        }
        reject(error, A.errorText(err), 'login-password');
        $('login-password').select();
      }
    );
  });

  $('logout').addEventListener('click', function () {
    var token = session ? session.token : '';
    saveSession(null);
    overview = null;
    showLogin('');
    if (token) {
      A.api('POST', '/api/admin/logout', null, token).catch(function () {
        /* 이 탭에서는 이미 로그아웃됐습니다 */
      });
    }
  });

  // ------------------------------------------------------------ 수업방 만들기 비밀번호

  function renderTeacher() {
    var teacher = overview.teacher;
    var state = $('teacher-state');
    var form = $('teacher-form');
    state.className = 'admin__state';
    if (teacher.source === 'env') {
      state.textContent = '환경 변수(TEACHER_PASSWORD)로 정해져 있습니다. 바꾸려면 Vercel에서 환경 변수를 고친 뒤 다시 배포해 주세요.';
      form.hidden = true;
      return;
    }
    form.hidden = false;
    if (teacher.mode === 'password') {
      state.textContent = '수업방을 만들 때 비밀번호를 물어봅니다.' + (teacher.at ? ' (' + A.formatTime(teacher.at) + '에 정함)' : '');
      state.className = 'admin__state admin__state--ok';
      $('teacher-open-row').hidden = false;
    } else if (teacher.mode === 'open') {
      state.textContent = '지금은 비밀번호 없이 누구나 수업방을 만들 수 있습니다.';
      state.className = 'admin__state admin__state--warn';
      $('teacher-open-row').hidden = true;
    } else {
      state.textContent = '아직 정하지 않았습니다. 수업방을 만들 때 물어볼 비밀번호를 정해야 수업방을 만들 수 있습니다.';
      state.className = 'admin__state admin__state--warn';
      $('teacher-open-row').hidden = false;
    }
  }

  function applyTeacher(result, message) {
    overview.teacher = result.teacher;
    $('teacher-password').value = '';
    $('teacher-password').type = 'password';
    $('teacher-show').checked = false;
    showError($('teacher-error'), '');
    renderTeacher();
    A.toast(message);
  }

  $('teacher-show').addEventListener('change', function () {
    $('teacher-password').type = $('teacher-show').checked ? 'text' : 'password';
  });

  $('teacher-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = $('teacher-error');
    var password = $('teacher-password').value;
    if (password.length < 4) return reject(error, '수업방 만들기 비밀번호는 4자 이상으로 정해 주세요.', 'teacher-password');
    showError(error, '');
    $('teacher-save').disabled = true;
    call('PUT', '/api/admin/teacher', { mode: 'password', password: password }).then(
      function (result) {
        $('teacher-save').disabled = false;
        applyTeacher(result, '수업방 만들기 비밀번호를 저장했습니다.');
      },
      function (err) {
        $('teacher-save').disabled = false;
        if (err.status !== 401) showError(error, A.errorText(err));
      }
    );
  });

  $('teacher-open').addEventListener('click', function () {
    A.ask({
      title: '비밀번호 없이 만들 수 있게 할까요?',
      message: '이 사이트 주소를 아는 사람은 누구나 수업방을 만들고 파일을 올릴 수 있게 됩니다.',
      okLabel: '비밀번호 없이 허용',
      danger: true
    }).then(function (answer) {
      if (!answer) return;
      call('PUT', '/api/admin/teacher', { mode: 'open' }).then(
        function (result) {
          applyTeacher(result, '이제 비밀번호 없이 수업방을 만들 수 있습니다.');
        },
        function (err) {
          if (err.status !== 401) A.toast(A.errorText(err), 'error');
        }
      );
    });
  });

  // ------------------------------------------------------------ 수업방 목록

  function roomRow(room) {
    var name = room.name || '이름 없는 수업방';
    var meta = ['만든 때 ' + A.formatTime(room.createdAt), '마지막 사용 ' + ago(room.usedAt), '항목 ' + room.items + '개'];
    if (room.bytes) meta.push('파일 ' + A.formatBytes(room.bytes));
    if (room.viewers) meta.push('지금 접속 ' + room.viewers + '명');
    if (room.expiresAt) meta.push(span(room.expiresAt - Date.now()) + ' 뒤 자동 삭제');
    return el('li', { class: 'admin-room' }, [
      el('div', { class: 'admin-room__main' }, [
        el('p', { class: 'admin-room__name' }, [
          el('span', { class: 'admin-room__label', text: name }),
          el('span', { class: 'admin-room__code', text: A.formatCode(room.code) })
        ]),
        el('p', { class: 'admin-room__meta', text: meta.join(' · ') })
      ]),
      el('div', { class: 'admin-room__actions' }, [
        el('a', { class: 'btn btn--sm', href: '/' + room.code, target: '_blank', rel: 'noopener', 'aria-label': name + ' 열기', text: '열기' }),
        el('button', {
          class: 'btn btn--sm btn--danger',
          type: 'button',
          'aria-label': name + ' 삭제',
          text: '삭제',
          onclick: function () {
            removeRoom(room, name);
          }
        })
      ])
    ]);
  }

  function renderRooms() {
    var rooms = overview.rooms;
    var list = $('rooms-list');
    var bytes = 0;
    var viewers = 0;
    list.textContent = '';
    rooms.forEach(function (room) {
      bytes += room.bytes;
      viewers += room.viewers;
      list.appendChild(roomRow(room));
    });
    $('rooms-empty').hidden = rooms.length > 0;
    list.hidden = rooms.length === 0;
    var summary = '';
    if (rooms.length) {
      summary = '모두 ' + overview.totalRooms + '개 · 파일 ' + A.formatBytes(bytes);
      if (viewers) summary += ' · 지금 접속 ' + viewers + '명';
      if (overview.totalRooms > rooms.length) summary += ' (최근에 쓴 ' + rooms.length + '개만 표시)';
    }
    $('rooms-summary').textContent = summary;
    $('rooms-summary').hidden = !summary;
  }

  function removeRoom(room, name) {
    A.ask({
      title: '"' + name + '" 수업방을 삭제할까요?',
      message: '공유한 내용과 파일이 모두 지워지고, 학생들은 더 이상 이 수업방에 들어올 수 없습니다. 되돌릴 수 없습니다.',
      okLabel: '수업방 삭제',
      danger: true
    }).then(function (answer) {
      if (!answer) return;
      call('DELETE', '/api/admin/rooms/' + room.code).then(
        function () {
          overview.rooms = overview.rooms.filter(function (other) {
            return other.code !== room.code;
          });
          overview.totalRooms = Math.max(overview.rooms.length, overview.totalRooms - 1);
          renderRooms();
          A.toast('수업방을 삭제했습니다.');
        },
        function (err) {
          if (err.status !== 401) A.toast(A.errorText(err), 'error');
        }
      );
    });
  }

  $('rooms-refresh').addEventListener('click', function () {
    var button = $('rooms-refresh');
    button.disabled = true;
    loadOverview(false).then(function () {
      button.disabled = false;
    });
  });

  // ------------------------------------------------------------ 사이트 상태

  function renderStatus() {
    var status = overview.status;
    var list = $('status-list');
    list.textContent = '';
    function fact(term, text) {
      var value = el('dd', { text: text });
      list.appendChild(el('dt', { text: term }));
      list.appendChild(value);
      return value;
    }
    fact('파일 크기', '파일 하나에 ' + A.formatBytes(status.maxFileBytes) + '까지, 수업방 하나에 ' + A.formatBytes(status.maxRoomBytes) + '까지');
    fact('보관 기간', '마지막으로 쓴 뒤 ' + span(status.roomTtlMs) + ' 동안 (지나면 수업방이 자동으로 지워집니다)');
    fact('파일 정리', status.cleanupAt ? A.formatTime(status.cleanupAt) + '에 마지막으로 실행' : '아직 실행된 적 없음 (하루에 한 번 자동으로 실행됩니다)');
    var deployed = fact('배포', status.build ? '버전 ' + status.build : '확인 중…');
    // 지금 떠 있는 배포를 만든 시각 (빌드할 때 만들어 두는 파일)
    A.api('GET', '/version.json').then(
      function (version) {
        var at = Date.parse(version.builtAt);
        if (at) deployed.textContent = A.formatTime(at) + '에 배포' + (version.commit ? ' (버전 ' + version.commit + ')' : '');
      },
      function () {
        if (!status.build) deployed.textContent = '알 수 없음';
      }
    );
  }

  // ------------------------------------------------------------ 관리자 비밀번호

  function renderAccount() {
    var fixed = overview.admin.source === 'env';
    $('account-details').hidden = fixed;
    document.querySelector('.admin__danger').hidden = fixed;
    $('account-state').hidden = !fixed;
    $('account-state').textContent = fixed
      ? '환경 변수(ADMIN_PASSWORD)로 정해져 있습니다. 바꾸려면 Vercel에서 환경 변수를 고친 뒤 다시 배포해 주세요.'
      : '';
  }

  $('account-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = $('account-error');
    var current = $('account-current').value;
    var next = $('account-next').value;
    if (!current) return reject(error, '지금 비밀번호를 입력해 주세요.', 'account-current');
    if (next.length < 8) return reject(error, '새 비밀번호는 8자 이상으로 정해 주세요.', 'account-next');
    if (next !== $('account-confirm').value) return reject(error, '두 번 입력한 새 비밀번호가 서로 다릅니다.', 'account-confirm');
    showError(error, '');
    $('account-save').disabled = true;
    call('PUT', '/api/admin/password', { current: current, next: next }).then(
      function (made) {
        $('account-save').disabled = false;
        saveSession(made);
        $('account-current').value = '';
        $('account-next').value = '';
        $('account-confirm').value = '';
        $('account-details').open = false;
        A.toast('관리자 비밀번호를 바꿨습니다.');
      },
      function (err) {
        $('account-save').disabled = false;
        if (err.status === 401) return;
        if (err.code === 'bad_password') reject(error, '지금 비밀번호가 올바르지 않습니다.', 'account-current');
        else showError(error, A.errorText(err));
      }
    );
  });

  $('reset').addEventListener('click', function () {
    A.ask({
      title: '처음 상태로 되돌릴까요?',
      message: '관리자 비밀번호와 수업방 만들기 비밀번호가 지워지고, 다시 설정하기 전까지는 새 수업방을 만들 수 없습니다. 계속하려면 관리자 비밀번호를 입력해 주세요.',
      input: { type: 'password', placeholder: '관리자 비밀번호' },
      okLabel: '되돌리기',
      danger: true
    }).then(function (password) {
      if (password === null) return;
      call('DELETE', '/api/admin', { password: password }).then(
        function () {
          saveSession(null);
          overview = null;
          A.toast('처음 상태로 되돌렸습니다.');
          start();
        },
        function (err) {
          if (err.status === 401) return;
          A.toast(err.code === 'bad_password' ? '관리자 비밀번호가 올바르지 않습니다.' : A.errorText(err), 'error');
        }
      );
    });
  });

  start();
})();
