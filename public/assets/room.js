/* 수업공유 — 수업방 화면 (학생: 받기 / 선생님: 공유·관리) */
(function () {
  'use strict';

  var A = window.App;
  var $ = A.$;
  var el = A.el;

  var code = location.pathname.replace(/^\/+/, '').slice(0, 6);
  var roomUrl = '/api/rooms/' + code;
  var siteName = document.body.getAttribute('data-site') || '';

  var state = {
    token: '',
    isHost: false,
    config: null,
    name: '',
    items: [], // 오래된 것 → 새것
    version: -1,
    viewers: 0,
    boot: '', // 서버가 켜질 때마다 바뀌는 값
    key: '', // 이 수업방을 열어 본 브라우저임을 알리는 열쇠 (접속 제한 예외)
    closed: false,
    bases: [location.origin],
    base: location.origin
  };

  function noop() {}

  // ============================================================ 시작

  // 선생님용 링크(…/123456#host=토큰)로 들어온 경우 주소에서 토큰을 지우고, 서버가 맞다고 확인해 준 뒤에만 이 기기에 저장합니다.
  // (잘못된 토큰이 실린 링크를 눌렀다고 해서, 원래 저장돼 있던 권한이 지워지면 안 됩니다)
  var hashToken = '';

  function captureHostToken() {
    var m = /[#&]host=([^&]+)/.exec(location.hash);
    if (m) {
      try {
        hashToken = decodeURIComponent(m[1]);
      } catch (err) {
        hashToken = '';
      }
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } catch (err) {
        location.hash = '';
      }
    }
    state.token = hashToken || A.rooms.token(code);
    state.key = A.pref.get('key.' + code);
  }

  function load(attempt) {
    Promise.all([A.api('GET', '/api/config'), A.api('GET', roomUrl + keyQuery(true), null, state.token)]).then(
      function (results) {
        var snap = results[1];
        var stored = A.rooms.token(code);
        if (hashToken && snap.isHost !== true && stored && stored !== hashToken) {
          // 링크의 토큰이 맞지 않으면 이 기기에 저장돼 있던 권한으로 다시 확인합니다.
          hashToken = '';
          state.token = stored;
          load(attempt);
          return;
        }
        state.config = results[0];
        start(snap);
      },
      function (err) {
        if (isGone(err)) {
          A.rooms.forget(code);
          showScreen('notfound');
        } else if (err.status === 429) {
          showScreen('blocked');
        } else if (err.status === 503 && err.code === 'unavailable') {
          showScreen('unavailable');
        } else {
          $('loading').textContent = '서버에 연결하는 중입니다…';
          setTimeout(function () {
            load(attempt + 1);
          }, Math.min(8000, 1500 * (attempt + 1)));
        }
      }
    );
  }

  function start(snap) {
    state.isHost = snap.isHost === true;
    if (state.token && !state.isHost) {
      if (A.rooms.token(code) === state.token) A.rooms.forget(code); // 저장돼 있던 권한이 더는 유효하지 않음
      state.token = '';
    }
    document.body.classList.toggle('is-host', state.isHost);
    // 화면에 보이는 상태에서 그려야 긴 글의 높이를 재서 접을 수 있습니다.
    document.body.setAttribute('data-state', 'ready');
    applySnapshot(snap, false);
    if (state.isHost) {
      A.rooms.save(code, state.token, state.name);
      initHost();
    }
    initCommon();
    connect();
  }

  function showScreen(kind) {
    var screens = {
      notfound: ['없는 수업방입니다', '주소의 숫자 6자리를 다시 확인해 주세요. 오래 쓰지 않은 수업방은 자동으로 지워집니다.'],
      closed: ['수업방이 종료되었습니다', '선생님이 수업방을 닫았습니다.'],
      blocked: ['잠시 후 다시 시도해 주세요', '짧은 시간에 요청이 너무 많았습니다. 몇 분 뒤에 새로 고침해 주세요.'],
      unavailable: ['이 수업방을 지금 열 수 없습니다', '서버에서 수업방 정보를 읽지 못했습니다. 잠시 뒤 다시 시도하거나 관리자에게 알려 주세요.']
    };
    var content = screens[kind] || screens.notfound;
    $('screen-title').textContent = content[0];
    $('screen-text').textContent = content[1];
    $('screen').hidden = false;
    document.body.setAttribute('data-state', 'screen');
    setStatus('closed');
  }

  // ============================================================ 상태 반영

  function applySnapshot(snap, highlight) {
    var known = {};
    state.items.forEach(function (item) {
      known[item.id] = true;
    });
    var fresh = {};
    var freshCount = 0;
    snap.items.forEach(function (item) {
      if (!known[item.id]) {
        fresh[item.id] = true;
        freshCount += 1;
      }
    });
    if (snap.v !== state.version) lastChangeAt = Date.now();
    state.items = snap.items.slice();
    state.version = snap.v;
    if (snap.boot) state.boot = snap.boot;
    if (snap.key && snap.key !== state.key) {
      state.key = snap.key;
      A.pref.set('key.' + code, snap.key);
    }
    setName(snap.name);
    if (typeof snap.viewers === 'number') setViewers(snap.viewers);
    renderFeed(highlight ? fresh : null);
    if (highlight && freshCount) noteNew(freshCount);
  }

  function addItem(item, highlight) {
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].id === item.id) return false;
    }
    state.items.push(item);
    var fresh = {};
    fresh[item.id] = true;
    renderFeed(highlight ? fresh : null);
    return true;
  }

  function removeItem(id) {
    var before = state.items.length;
    state.items = state.items.filter(function (item) {
      return item.id !== id;
    });
    if (state.items.length !== before) renderFeed(null);
  }

  function displayName() {
    return state.name || '수업방';
  }

  function setName(name) {
    state.name = name || '';
    $('room-name').textContent = displayName();
    $('jd-title').textContent = state.name || '수업 자료 받기';
    updateTitle();
  }

  function setViewers(n) {
    state.viewers = n;
    $('viewers').hidden = !state.isHost;
    $('viewers-text').textContent = '접속 ' + n + '명';
  }

  var unseen = 0;

  function updateTitle() {
    document.title = (unseen ? '(' + unseen + ') ' : '') + displayName() + (siteName ? ' · ' + siteName : '');
  }

  function setStatus(kind) {
    var texts = { live: '실시간 연결됨', polling: '연결됨', connecting: '연결 중…', closed: '종료됨' };
    $('status').setAttribute('data-state', kind);
    $('status-text').textContent = texts[kind] || '';
  }

  // 새 항목이 왔음을 알립니다 (다른 탭을 보고 있거나, 아래로 내려가 있는 학생을 위해).
  function noteNew(count) {
    if (document.hidden) {
      unseen += count;
      updateTitle();
    }
    if (!state.isHost && window.pageYOffset > 240) $('new-pill').hidden = false;
    $('live').textContent = '새로운 내용이 공유되었습니다. 지금까지 ' + state.items.length + '개';
  }

  // ============================================================ 목록 그리기

  var nodes = {}; // 항목 id → <li>

  function renderFeed(fresh) {
    var feed = $('feed');
    var created = [];
    var prev = null;
    var i;

    // 사라진 항목을 먼저 치웁니다. (남은 항목을 옮기지 않아야 강조 효과가 다시 재생되지 않습니다)
    var alive = {};
    for (i = 0; i < state.items.length; i += 1) alive[state.items[i].id] = true;
    Object.keys(nodes).forEach(function (id) {
      if (alive[id]) return;
      if (nodes[id].parentNode) nodes[id].parentNode.removeChild(nodes[id]);
      delete nodes[id];
    });

    for (i = state.items.length - 1; i >= 0; i -= 1) {
      var item = state.items[i];
      var node = nodes[item.id];
      if (!node) {
        node = nodes[item.id] = buildItemSafely(item);
        if (fresh && fresh[item.id]) markNew(node);
        created.push(node);
      }
      var expected = prev ? prev.nextSibling : feed.firstChild;
      if (node !== expected) feed.insertBefore(node, expected);
      prev = node;
    }
    created.forEach(clampIfLong);

    var count = state.items.length;
    $('item-count').textContent = count ? String(count) : '';
    $('empty').hidden = count > 0;
    $('clear-all').hidden = !state.isHost || count === 0;
  }

  // 방금 도착한 항목을 잠깐 강조합니다. 효과가 끝나면 표시를 지워 다시 재생되지 않게 합니다.
  function markNew(node) {
    node.classList.add('is-new');
    var clear = function () {
      node.classList.remove('is-new');
    };
    node.addEventListener('animationend', clear);
    setTimeout(clear, 4000);
  }

  // 긴 글은 접어 두고 "더 보기"로 펼칩니다.
  function clampIfLong(node) {
    var wrap = node.querySelector('.item__textwrap');
    if (!wrap) return;
    var text = wrap.querySelector('.item__text');
    var more = wrap.querySelector('.item__more');
    if (text.scrollHeight > 380) {
      wrap.classList.add('is-clamped');
      more.hidden = false;
    }
  }

  function safeHttpUrl(value) {
    try {
      var url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (err) {
      return '';
    }
  }

  // 서버가 알려 준 파일 주소: 이 사이트 안의 경로이거나 http(s) 주소만 씁니다.
  function linkUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    if (value.charAt(0) === '/' && value.charAt(1) !== '/') return value;
    return safeHttpUrl(value);
  }

  function displayUrl(url) {
    try {
      return decodeURI(url);
    } catch (err) {
      return url;
    }
  }

  // 주소 끝에 붙은 문장 부호를 떼어 냅니다. 닫는 괄호는 주소 안에 여는 괄호가 없을 때만 뗍니다.
  function trimUrlEnd(raw) {
    var hasParen = raw.indexOf('(') >= 0;
    var hasBracket = raw.indexOf('[') >= 0;
    var end = raw.length;
    while (end > 0) {
      var ch = raw.charAt(end - 1);
      if ('.,;:!?\'"'.indexOf(ch) >= 0) end -= 1;
      else if (ch === ')' && !hasParen) end -= 1;
      else if (ch === ']' && !hasBracket) end -= 1;
      else break;
    }
    return raw.slice(0, end);
  }

  // 글 속의 주소를 누를 수 있는 링크로 바꿉니다. (한글 조사가 바로 붙어도 주소만 인식)
  var URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`ㄱ-ㆎ가-힣]+/gi;

  function appendLinkified(parent, text) {
    var last = 0;
    var m;
    URL_PATTERN.lastIndex = 0;
    while ((m = URL_PATTERN.exec(text))) {
      var raw = trimUrlEnd(m[0]);
      var href = raw ? safeHttpUrl(/^www\./i.test(raw) ? 'https://' + raw : raw) : '';
      if (!href) continue;
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      parent.appendChild(el('a', { href: href, target: '_blank', rel: 'noopener noreferrer', text: raw }));
      last = m.index + raw.length;
      URL_PATTERN.lastIndex = last;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function copyButton(text, label) {
    var labelNode = el('span', { text: label });
    var button = el('button', { class: 'btn', type: 'button' }, [A.icon('copy'), labelNode]);
    var timer = null;
    button.addEventListener('click', function () {
      A.copyText(text).then(
        function () {
          clearTimeout(timer);
          button.classList.add('is-done');
          button.replaceChild(A.icon('check'), button.firstChild);
          labelNode.textContent = '복사됨';
          timer = setTimeout(function () {
            button.classList.remove('is-done');
            button.replaceChild(A.icon('copy'), button.firstChild);
            labelNode.textContent = label;
          }, 1600);
        },
        function () {
          A.toast('복사하지 못했습니다. 글자를 길게 눌러 직접 복사해 주세요.', 'error');
        }
      );
    });
    return button;
  }

  // 항목 하나를 그리다 문제가 생겨도 나머지 화면은 그대로 쓸 수 있게 합니다.
  function buildItemSafely(item) {
    try {
      return buildItem(item);
    } catch (err) {
      var head = el('div', { class: 'item__head' }, [el('span', { class: 'item__type', text: '표시할 수 없는 항목' })]);
      if (state.isHost) {
        head.appendChild(
          el(
            'button',
            {
              class: 'btn btn--ghost btn--icon btn--sm btn--danger item__del',
              type: 'button',
              title: '이 항목 지우기',
              'aria-label': '이 항목 지우기',
              onclick: function () {
                deleteItem(item, this);
              }
            },
            [A.icon('trash')]
          )
        );
      }
      return el('li', { class: 'item' }, [head]);
    }
  }

  var TYPE_LABEL = { link: '링크', text: '텍스트', file: '파일' };
  var THUMB_MAX_BYTES = 12 * 1024 * 1024;

  function buildItem(item) {
    var head = el('div', { class: 'item__head' }, [
      el('span', { class: 'item__type' }, [A.icon(item.type), TYPE_LABEL[item.type] || '']),
      el('time', { text: A.formatTime(item.at), datetime: new Date(item.at).toISOString() })
    ]);
    if (state.isHost) {
      head.appendChild(
        el(
          'button',
          {
            class: 'btn btn--ghost btn--icon btn--sm btn--danger item__del',
            type: 'button',
            title: '이 항목 지우기',
            'aria-label': '이 항목 지우기',
            onclick: function () {
              deleteItem(item, this);
            }
          },
          [A.icon('trash')]
        )
      );
    }

    var body;
    var actions = el('div', { class: 'item__actions' });

    if (item.type === 'link') {
      var href = safeHttpUrl(item.url);
      body = el('a', {
        class: 'item__link',
        href: href || null,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: displayUrl(item.url)
      });
      if (href) {
        actions.appendChild(
          el('a', { class: 'btn btn--primary', href: href, target: '_blank', rel: 'noopener noreferrer' }, [
            A.icon('open'),
            '열기'
          ])
        );
      }
      actions.appendChild(copyButton(item.url, '주소 복사'));
    } else if (item.type === 'file') {
      var fileUrl = linkUrl(item.url);
      var openUrl = linkUrl(item.openUrl);
      var visual;
      if (item.kind === 'image' && openUrl && item.size <= THUMB_MAX_BYTES) {
        visual = el('a', { class: 'item__thumblink', href: openUrl, target: '_blank', rel: 'noopener noreferrer', 'aria-label': item.name + ' 크게 보기' }, [
          el('img', { class: 'item__thumb', src: openUrl, alt: '', loading: 'lazy' })
        ]);
      } else {
        visual = el('span', { class: 'item__ext', text: (item.ext || '파일').slice(0, 4).toUpperCase() });
      }
      body = el('div', { class: 'item__file' }, [
        visual,
        el('div', { class: 'item__fileinfo' }, [
          el('div', { class: 'item__name', text: item.name }),
          el('div', { class: 'item__size', text: A.formatBytes(item.size) })
        ])
      ]);
      actions.appendChild(
        el('a', { class: 'btn btn--primary', href: fileUrl || null, download: item.name, rel: 'noopener noreferrer' }, [
          A.icon('download'),
          '다운로드'
        ])
      );
      if (openUrl) {
        actions.appendChild(
          el('a', { class: 'btn', href: openUrl, target: '_blank', rel: 'noopener noreferrer' }, [
            A.icon('open'),
            '바로 열기'
          ])
        );
      }
    } else {
      var textNode = el('div', { class: 'item__text' + (item.mono ? ' is-mono' : '') });
      appendLinkified(textNode, item.text);
      var more = el('button', { class: 'btn btn--ghost btn--sm item__more', type: 'button', text: '더 보기', hidden: true });
      body = el('div', { class: 'item__textwrap' }, [textNode, more]);
      more.addEventListener('click', function () {
        var clamped = body.classList.toggle('is-clamped');
        more.textContent = clamped ? '더 보기' : '접기';
      });
      actions.appendChild(copyButton(item.text, '복사'));
    }

    return el('li', { class: 'item item--' + item.type }, [head, body, actions]);
  }

  // ============================================================ 최신 상태 받기

  // 서버가 알려 준 방식(config.transport)에 따라 두 가지로 최신 상태를 받습니다.
  //   'sse'  : 서버가 변경을 바로 밀어 주는 실시간 스트림. 막히거나 멈추면 아래의 주기 확인으로 넘어갑니다.
  //   'poll' : 몇 초마다 "바뀐 것 있나요?"만 가볍게 묻고, 바뀌었을 때만 전체 상태를 받습니다.

  var source = null;
  var lastBeat = 0;
  var lastAttempt = 0;
  var retryTimer = null;
  var retryDelay = 1000;
  var pollTimer = null;
  var pollTicks = 0;
  var helloTimer = null;
  var hiddenTimer = null;
  var suspended = false; // 화면이 가려져 있어 스트림을 닫아 둔 상태
  var refreshing = null;
  var checking = null;
  var lastHere = 0;
  var lastChangeAt = Date.now(); // 수업방 내용이 마지막으로 바뀐 때
  // 실시간 스트림이 한 번이라도 늦게 오거나 멈춘 적이 있으면(중간 장비가 붙잡는 네트워크),
  // 스트림이 다시 살아나도 몇 초마다 직접 확인하는 방식을 함께 켜 둡니다.
  var distrustStream = false;
  var clientId = makeClientId();

  // 접속자 수를 셀 때 이 탭을 구분하는 임의의 값 (개인 정보 아님)
  function makeClientId() {
    var id = '';
    try {
      id = sessionStorage.getItem('classshare.client') || '';
    } catch (err) {
      id = '';
    }
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) {
      id = 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      try {
        sessionStorage.setItem('classshare.client', id);
      } catch (err) {
        /* 저장하지 못해도 이번 화면에서는 그대로 씁니다 */
      }
    }
    return id;
  }

  function useStream() {
    return Boolean(state.config) && state.config.transport === 'sse' && Boolean(window.EventSource);
  }

  function keyQuery(first) {
    return state.key ? (first ? '?' : '&') + 'k=' + encodeURIComponent(state.key) : '';
  }

  // 이 서비스가 "그런 수업방은 없다"고 답한 경우만 참. (앞단 프록시가 잠깐 내는 404와 구분)
  function isGone(err) {
    return Boolean(err) && err.status === 404 && err.code === 'not_found';
  }

  function statusKind() {
    return $('status').getAttribute('data-state');
  }

  function connect() {
    if (state.closed) return;
    clearTimeout(retryTimer);
    clearTimeout(helloTimer);
    if (source) {
      source.close();
      source = null;
    }
    lastAttempt = lastBeat = Date.now();
    if (!useStream() || (suspended && document.hidden)) {
      startPolling();
      return;
    }
    if (!pollTimer) setStatus('connecting');

    var stream = new EventSource(
      roomUrl + '/events?c=' + clientId + (state.isHost ? '&role=host' : '') + keyQuery(false)
    );
    source = stream;

    // 서버는 연결되자마자 첫 신호를 보냅니다. 몇 초 안에 오지 않으면 스트림을 믿지 않습니다.
    helloTimer = setTimeout(function () {
      if (source !== stream || state.closed) return;
      distrustStream = true;
      startPolling();
    }, 6000);

    function on(name, handler) {
      stream.addEventListener(name, function (event) {
        if (source !== stream) return;
        lastBeat = Date.now();
        var data;
        try {
          data = JSON.parse(event.data);
        } catch (err) {
          return;
        }
        handler(data);
      });
    }

    on('hello', function (data) {
      clearTimeout(helloTimer);
      retryDelay = 1000;
      if (!distrustStream) stopPolling();
      applySnapshot(data, true);
      setStatus('live');
    });
    on('add', function (data) {
      if (!acceptVersion(data.v)) return;
      if (addItem(data.item, true)) noteNew(1);
    });
    on('remove', function (data) {
      if (acceptVersion(data.v)) removeItem(data.id);
    });
    on('clear', function (data) {
      if (!acceptVersion(data.v)) return;
      state.items = [];
      renderFeed(null);
    });
    on('room', function (data) {
      if (!acceptVersion(data.v)) return;
      setName(data.name);
      if (state.isHost) A.rooms.save(code, state.token, state.name);
    });
    on('viewers', function (data) {
      setViewers(data.n);
    });
    on('ping', noop);
    on('closed', roomClosed);

    stream.onerror = function () {
      if (source !== stream || state.closed) return;
      clearTimeout(helloTimer);
      setStatus(pollTimer ? 'polling' : 'connecting');
      // 스트림이 다시 붙을 때까지는 몇 초마다 직접 확인합니다. (수업방이 지워졌는지도 여기서 알게 됩니다)
      startPolling();
      if (stream.readyState === 2) {
        // 브라우저가 재연결을 포기한 경우(서버가 오류로 응답): 간격을 늘려 가며 직접 다시 시도
        source = null;
        scheduleReconnect();
      }
    };
  }

  // 변경 번호가 바로 다음 것이면 반영, 이미 본 것이면 무시, 건너뛰었으면 전체를 다시 받습니다.
  function acceptVersion(v) {
    if (typeof v !== 'number' || v <= state.version) return false;
    if (v === state.version + 1) {
      state.version = v;
      lastChangeAt = Date.now();
      return true;
    }
    refresh().catch(noop);
    return false;
  }

  function scheduleReconnect() {
    if (state.closed) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(15000, retryDelay * 2);
  }

  // 수업방 전체 상태를 다시 받아 옵니다.
  function refresh(version) {
    if (state.closed) return Promise.resolve();
    if (refreshing) return refreshing;
    var url = roomUrl + keyQuery(true);
    // 학생들은 같은 변경에 대해 같은 주소로 요청하게 해서, 서버 앞의 캐시가 한 번만 받아 오면 되도록 합니다.
    if (!state.token && typeof version === 'number') url += (state.key ? '&' : '?') + 'v=' + version;
    refreshing = A.api('GET', url, null, state.token).then(
      function (snap) {
        refreshing = null;
        if (state.closed) return;
        // 서버가 다시 시작된 경우(boot가 바뀜)에는 번호가 작아졌더라도 받아들입니다.
        if (snap.boot !== state.boot || snap.v >= state.version) applySnapshot(snap, true);
      },
      function (err) {
        refreshing = null;
        if (isGone(err)) roomClosed();
        throw err;
      }
    );
    return refreshing;
  }

  // 바뀐 것이 있는지만 가볍게 확인하고, 있으면 전체 상태를 받습니다.
  function check() {
    if (state.closed) return Promise.resolve();
    if (checking) return checking;
    checking = A.api('GET', roomUrl + '/poll' + keyQuery(true)).then(
      function (info) {
        checking = null;
        if (state.closed) return undefined;
        if (info.boot !== state.boot || info.v > state.version) return refresh(info.v);
        return undefined;
      },
      function (err) {
        checking = null;
        if (isGone(err)) roomClosed();
        throw err;
      }
    );
    return checking;
  }

  // 실시간 스트림을 쓰지 않거나 쓸 수 없을 때: 몇 초마다 확인합니다.
  function startPolling() {
    if (pollTimer || state.closed) return;
    var tick = function () {
      pollTicks += 1;
      if (pollTicks % pollStride()) return;
      check().then(
        function () {
          if (pollTimer && !state.closed && statusKind() !== 'live') setStatus('polling');
        },
        function () {
          if (pollTimer && !state.closed && statusKind() !== 'live') setStatus('connecting');
        }
      );
    };
    pollTimer = setInterval(tick, (state.config && state.config.pollMs) || 4000);
    pollTicks = -1;
    tick();
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // 확인 요청을 몇 번에 한 번 보낼지. 요청 수를 아끼기 위해, 가려진 화면이나 한동안 변화가 없던 수업방은 덜 자주 확인합니다.
  // (무언가 공유되면 다시 매번 확인으로 돌아옵니다)
  function pollStride() {
    if (document.hidden) return 4;
    var quiet = Date.now() - lastChangeAt;
    if (quiet > 15 * 60 * 1000) return 3;
    if (quiet > 3 * 60 * 1000) return 2;
    return 1;
  }

  // ------------------------------------------------------------ 접속 알림

  function presenceEvery() {
    var every = (state.config && state.config.presenceMs) || 45000;
    // 주기 확인 방식에서는 선생님 화면의 접속자 수가 이 신호의 응답으로만 갱신되므로 더 자주 보냅니다.
    return state.isHost && !useStream() ? Math.min(every, 10000) : every;
  }

  // "아직 보고 있어요" 신호. 서버는 이 신호가 끊기면 접속자 수에서 뺍니다.
  function sendHere(seconds) {
    if (state.closed) return;
    lastHere = Date.now();
    var ttl = seconds || Math.ceil((presenceEvery() / 1000) * 1.6) + 5;
    A.api('POST', roomUrl + '/here' + keyQuery(true), { c: clientId, t: ttl }, state.token).then(
      function (info) {
        if (state.closed) return;
        if (typeof info.viewers === 'number') setViewers(info.viewers);
        if (info.boot !== state.boot || info.v > state.version) refresh().catch(noop);
      },
      function (err) {
        if (isGone(err)) roomClosed();
      }
    );
  }

  function sayGoodbye() {
    if (state.closed || !navigator.sendBeacon) return;
    try {
      navigator.sendBeacon(roomUrl + '/here' + keyQuery(true), JSON.stringify({ c: clientId, t: 0 }));
    } catch (err) {
      /* 못 보내도 서버가 잠시 뒤 알아서 뺍니다 */
    }
  }

  // ------------------------------------------------------------ 종료·다시 연결

  function roomClosed() {
    if (state.closed) return;
    state.closed = true;
    if (source) {
      source.close();
      source = null;
    }
    stopPolling();
    clearTimeout(retryTimer);
    clearTimeout(helloTimer);
    clearTimeout(hiddenTimer);
    if (state.token) A.rooms.forget(code);
    var dialog = document.querySelector('dialog[open]');
    if (dialog && dialog.close) dialog.close();
    showScreen('closed');
  }

  function reconnectNow() {
    if (state.closed) return;
    suspended = false;
    check().catch(noop);
    connect();
  }

  // 브라우저는 한 사이트에 동시에 6개까지만 연결을 엽니다. 보이지 않는 탭이 스트림을 붙잡고 있으면
  // 다른 탭(예: 반마다 하나씩 연 수업방)이 멈출 수 있어서, 가려진 지 조금 지나면 스트림을 닫고 가끔씩만 확인합니다.
  function suspendWhenHidden() {
    clearTimeout(hiddenTimer);
    if (!document.hidden || state.closed) return;
    hiddenTimer = setTimeout(function () {
      if (!document.hidden || state.closed || !source) return;
      suspended = true;
      clearTimeout(retryTimer);
      clearTimeout(helloTimer);
      source.close();
      source = null;
      startPolling();
    }, 10000);
  }

  function initCommon() {
    $('empty-title').textContent = state.isHost ? '아직 공유한 내용이 없습니다' : '아직 공유된 내용이 없습니다';
    $('empty-text').textContent = state.isHost
      ? '링크·텍스트·파일을 공유하면 학생 화면에 바로 나타납니다.'
      : '선생님이 공유하면 이 화면에 바로 나타납니다. 새로 고침하지 않아도 됩니다.';

    if (!state.isHost) {
      // 학생 화면에 실수로 파일을 떨어뜨렸을 때 브라우저가 그 파일을 열어 버리지 않도록
      ['dragover', 'drop'].forEach(function (type) {
        window.addEventListener(type, function (event) {
          if (hasFiles(event)) event.preventDefault();
        });
      });
    }

    setInterval(function () {
      if (state.closed) return;
      var now = Date.now();
      if (now - lastHere >= presenceEvery()) sendHere(document.hidden ? 150 : 0);
      if (document.hidden || suspended || !useStream()) return;
      // 서버는 25초마다 신호를 보냅니다. 한동안 아무것도 오지 않으면 스트림이 죽은 것으로 봅니다.
      if (now - lastBeat > 40000 && now - lastAttempt > 40000) {
        distrustStream = true;
        startPolling();
        connect();
      }
    }, 5000);

    document.addEventListener('visibilitychange', function () {
      if (state.closed) return;
      if (document.hidden) {
        suspendWhenHidden();
        // 가려진 동안에는 브라우저가 타이머를 늦추므로 넉넉하게 알려 둡니다.
        // 탭을 닫을 때도 "가려짐"이 먼저 오기 때문에, 잠깐 뒤에도 여전히 열려 있을 때만 보냅니다.
        setTimeout(function () {
          if (document.hidden && !state.closed) sendHere(150);
        }, 1500);
        return;
      }
      clearTimeout(hiddenTimer);
      if (unseen) {
        unseen = 0;
        updateTitle();
      }
      sendHere();
      if (!useStream()) check().catch(noop);
      else if (suspended || !source || source.readyState === 2 || Date.now() - lastBeat > 40000) reconnectNow();
    });
    window.addEventListener('pageshow', function (event) {
      if (!event.persisted || state.closed) return;
      sendHere();
      reconnectNow();
    });
    window.addEventListener('pagehide', sayGoodbye);
    window.addEventListener('online', reconnectNow);

    window.addEventListener(
      'scroll',
      function () {
        if (window.pageYOffset < 120) $('new-pill').hidden = true;
      },
      { passive: true }
    );
    $('new-pill').addEventListener('click', function () {
      $('new-pill').hidden = true;
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        window.scrollTo(0, 0);
      }
    });

    sendHere();
    suspendWhenHidden(); // 처음부터 가려진 채로 열린 탭
  }

  // ============================================================ 선생님 기능

  function loadScript(src, onload) {
    var script = document.createElement('script');
    script.src = src;
    if (onload) script.onload = onload;
    document.head.appendChild(script);
  }

  function initHost() {
    $('host-panel').hidden = false;
    if (state.config.upload === 'blob') {
      // 파일을 저장소로 직접 올리는 방식일 때만 필요한 스크립트
      loadScript('/assets/blob-upload.js');
    }
    setupJoin();
    setupComposer();
    setupDropAndPaste();
    setupManage();
  }

  // ------------------------------------------------------------ 접속 안내·QR

  function joinUrl() {
    return state.base + '/' + code;
  }

  function fillUrl(target) {
    target.textContent = '';
    target.appendChild(document.createTextNode(state.base.replace(/^https?:\/\//, '') + '/'));
    target.appendChild(el('b', { text: code }));
  }

  function drawQr(target, text) {
    var qr;
    try {
      qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
    } catch (err) {
      return;
    }
    var ns = 'http://www.w3.org/2000/svg';
    var count = qr.getModuleCount();
    var quiet = 4; // 인식에 필요한 흰 여백
    var size = count + quiet * 2;
    var path = '';
    for (var row = 0; row < count; row += 1) {
      for (var col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) path += 'M' + (col + quiet) + ' ' + (row + quiet) + 'h1v1h-1z';
      }
    }
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '수업방 접속 QR 코드');
    var background = document.createElementNS(ns, 'rect');
    background.setAttribute('width', String(size));
    background.setAttribute('height', String(size));
    background.setAttribute('fill', '#ffffff');
    var modules = document.createElementNS(ns, 'path');
    modules.setAttribute('d', path);
    modules.setAttribute('fill', '#000000');
    svg.appendChild(background);
    svg.appendChild(modules);
    target.textContent = '';
    target.appendChild(svg);
  }

  function renderJoin() {
    fillUrl($('join-url'));
    fillUrl($('jd-url'));
    if (window.qrcode) {
      drawQr($('join-qr'), joinUrl());
      drawQr($('jd-qr'), joinUrl());
    }
  }

  function setupJoin() {
    var config = state.config;
    var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    var lan = config.lanUrls || [];

    if (config.publicUrl) state.bases = [config.publicUrl];
    else if (local && lan.length) state.bases = lan;
    else state.bases = [location.origin];

    var remembered = A.pref.get('base');
    state.base = state.bases.indexOf(remembered) >= 0 ? remembered : state.bases[0];

    var note = $('join-note');
    if (!config.publicUrl && local) {
      note.hidden = false;
      if (lan.length) {
        note.textContent = '이 컴퓨터와 같은 네트워크(Wi-Fi)에 연결된 기기에서만 열 수 있는 주소입니다.';
      } else {
        note.className = 'note note--warn';
        note.textContent = '지금 주소(localhost)는 학생 기기에서 열 수 없습니다. 이 컴퓨터의 IP 주소로 이 페이지를 열거나, 서버에 PUBLIC_URL을 설정해 주세요.';
      }
    }

    if (state.bases.length > 1) {
      var select = $('lan-select');
      state.bases.forEach(function (base) {
        var option = el('option', { value: base, text: base.replace(/^https?:\/\//, '') });
        if (base === state.base) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', function () {
        state.base = select.value;
        A.pref.set('base', state.base);
        renderJoin();
      });
      $('lan-row').hidden = false;
    }

    renderJoin();
    loadScript('/assets/vendor/qrcode.js', renderJoin);

    var dialog = $('join-dialog');
    var openDialog = function () {
      if (typeof dialog.showModal !== 'function') {
        A.toast('이 브라우저에서는 크게 보기를 쓸 수 없습니다.', 'error');
        return;
      }
      dialog.showModal();
      document.body.classList.add('is-printing-join');
    };
    $('join-qr').addEventListener('click', openDialog);
    $('join-open').addEventListener('click', openDialog);
    dialog.addEventListener('close', function () {
      document.body.classList.remove('is-printing-join');
    });
    $('jd-close').addEventListener('click', function () {
      dialog.close();
    });
    $('jd-print').addEventListener('click', function () {
      window.print();
    });
    $('join-copy').addEventListener('click', function () {
      A.copyText(joinUrl()).then(
        function () {
          A.toast('학생용 주소를 복사했습니다.');
        },
        function () {
          A.toast('복사하지 못했습니다.', 'error');
        }
      );
    });
  }

  // ------------------------------------------------------------ 공유하기

  var staged = []; // 보낼 파일 { key, file, name, size, status, progress, error, cancel, previewUrl, metaNode, barNode }
  var stagedSeq = 0;
  var uploading = null;
  var sendingText = false;
  var MAX_STAGED = 30;

  function byteLength(text) {
    try {
      return new Blob([text]).size;
    } catch (err) {
      return text.length * 3;
    }
  }

  // 반쪽만 남은 이모지 조각을 지웁니다. (남아 있으면 주소로 바꿀 때 오류가 납니다)
  function stripLoneSurrogates(text) {
    var out = '';
    for (var i = 0; i < text.length; i += 1) {
      var unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += text.charAt(i) + text.charAt(i + 1);
          i += 1;
        }
      } else if (unit < 0xdc00 || unit > 0xdfff) {
        out += text.charAt(i);
      }
    }
    return out;
  }

  function usedBytes() {
    return state.items.reduce(function (sum, item) {
      return sum + (item.type === 'file' ? item.size : 0);
    }, 0);
  }

  function autosize() {
    var area = $('composer-text');
    area.style.height = 'auto';
    area.style.height = Math.min(260, area.scrollHeight + 3) + 'px';
  }

  function setupComposer() {
    var area = $('composer-text');
    var mono = $('composer-mono');
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var limit = A.formatBytes(state.config.maxFileBytes);

    var pasteKey = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘V' : 'Ctrl+V';
    $('composer-hint').textContent = coarse
      ? '파일은 하나에 최대 ' + limit + '까지 올릴 수 있습니다.'
      : 'Enter로 공유 · Shift+Enter로 줄바꿈 · 파일은 끌어다 놓거나 ' + pasteKey + ' (하나에 최대 ' + limit + ')';

    area.addEventListener('input', autosize);
    area.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return; // 한글 조합 중 Enter는 무시
      var send = event.ctrlKey || event.metaKey || (!coarse && !event.shiftKey && !event.altKey);
      if (send) {
        event.preventDefault();
        shareAll();
      }
    });
    mono.addEventListener('change', function () {
      $('composer').classList.toggle('is-mono', mono.checked);
      autosize();
    });
    $('composer-form').addEventListener('submit', function (event) {
      event.preventDefault();
      shareAll();
    });
    $('pick-files').addEventListener('click', function () {
      $('file-input').click();
    });
    $('file-input').addEventListener('change', function () {
      stageFiles(Array.prototype.slice.call(this.files || []));
      this.value = '';
    });
    window.addEventListener('beforeunload', function (event) {
      var busy = staged.some(function (entry) {
        return entry.status === 'uploading' || entry.status === 'queued';
      });
      if (busy) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    if (!coarse) area.focus();
  }

  function shareAll() {
    var area = $('composer-text');
    var text = area.value;
    var hasText = text.trim().length > 0;
    var files = staged.filter(function (entry) {
      return entry.status === 'staged';
    });
    if (!hasText && !files.length) {
      area.focus();
      return;
    }

    if (hasText && !sendingText) {
      if (byteLength(text) > state.config.maxTextBytes) {
        A.toast('글이 너무 깁니다. (최대 ' + A.formatBytes(state.config.maxTextBytes) + ') 파일로 올려 주세요.', 'error');
      } else {
        sendingText = true;
        $('share-button').disabled = true;
        // 보내는 동안 이어서 쓴 글과 섞이지 않도록 입력창을 먼저 비우고, 실패하면 되돌려 놓습니다.
        area.value = '';
        autosize();
        A.api('POST', roomUrl + '/items', { text: text, mono: $('composer-mono').checked }, state.token)
          .then(
            function (result) {
              addItem(result.item, true);
            },
            function (err) {
              area.value = text + (area.value ? '\n' + area.value : '');
              autosize();
              A.toast(err.status === 403 ? '선생님 권한이 없어 공유하지 못했습니다.' : A.errorText(err), 'error');
            }
          )
          .then(function () {
            sendingText = false;
            $('share-button').disabled = false;
          });
      }
    }

    if (files.length) {
      files.forEach(function (entry) {
        entry.status = 'queued';
      });
      renderStaged();
      pumpUploads();
    }
    area.focus();
  }

  function stageFiles(files) {
    var maxBytes = state.config.maxFileBytes;
    var added = 0;
    files.forEach(function (file) {
      var name = stripLoneSurrogates(file.stagedName || file.name || '') || '파일';
      if (!file.size) {
        A.toast('빈 파일이나 폴더는 올릴 수 없습니다. 폴더는 압축(zip)해서 올려 주세요.', 'error');
        return;
      }
      if (file.size > maxBytes) {
        A.toast('"' + name + '" 파일이 너무 큽니다. 하나에 최대 ' + A.formatBytes(maxBytes) + '까지 올릴 수 있습니다.', 'error');
        return;
      }
      if (staged.length >= MAX_STAGED) {
        A.toast('한 번에 ' + MAX_STAGED + '개까지 담을 수 있습니다.', 'error');
        return;
      }
      stagedSeq += 1;
      staged.push({
        key: stagedSeq,
        file: file,
        name: name,
        size: file.size,
        status: 'staged',
        progress: 0,
        error: '',
        cancel: null,
        previewUrl: /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(file.type) && window.URL ? URL.createObjectURL(file) : '',
        metaNode: null,
        barNode: null
      });
      added += 1;
    });
    if (added) {
      renderStaged();
      $('share-button').focus();
    }
  }

  function unstage(entry) {
    var index = staged.indexOf(entry);
    if (index >= 0) staged.splice(index, 1);
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    renderStaged();
  }

  function chipMeta(entry) {
    if (entry.status === 'uploading') return '올리는 중… ' + Math.round(entry.progress * 100) + '%';
    if (entry.status === 'queued') return '차례를 기다리는 중…';
    if (entry.status === 'error') return entry.error;
    return A.formatBytes(entry.size);
  }

  function renderStaged() {
    var list = $('staged');
    list.textContent = '';
    staged.forEach(function (entry) {
      var thumb = entry.previewUrl
        ? el('img', { class: 'chip__thumb', src: entry.previewUrl, alt: '' })
        : el('span', { class: 'chip__thumb', text: (/\.([^.]+)$/.exec(entry.name) || ['', '파일'])[1].slice(0, 4).toUpperCase() });
      entry.metaNode = el('span', { class: 'chip__meta', text: chipMeta(entry) });
      entry.barNode = entry.status === 'uploading' ? el('progress', { max: '1', value: String(entry.progress) }) : null;

      var buttons = [];
      if (entry.status === 'error') {
        buttons.push(
          el(
            'button',
            {
              class: 'btn btn--ghost btn--icon btn--sm',
              type: 'button',
              title: '다시 시도',
              'aria-label': entry.name + ' 다시 올리기',
              onclick: function () {
                entry.status = 'queued';
                entry.error = '';
                renderStaged();
                pumpUploads();
              }
            },
            [A.icon('retry')]
          )
        );
      }
      buttons.push(
        el(
          'button',
          {
            class: 'btn btn--ghost btn--icon btn--sm',
            type: 'button',
            title: entry.status === 'uploading' ? '올리기 취소' : '목록에서 빼기',
            'aria-label': entry.name + (entry.status === 'uploading' ? ' 올리기 취소' : ' 목록에서 빼기'),
            onclick: function () {
              if (entry.status === 'uploading' && entry.cancel) entry.cancel();
              else unstage(entry);
            }
          },
          [A.icon('close')]
        )
      );

      list.appendChild(
        el('li', { class: 'chip' + (entry.status === 'error' ? ' is-error' : '') }, [
          thumb,
          el('span', { class: 'chip__main' }, [el('span', { class: 'chip__name', text: entry.name }), entry.metaNode, entry.barNode])
        ].concat(buttons))
      );
    });
    list.hidden = staged.length === 0;
  }

  // 파일은 한 번에 하나씩 올립니다.
  function pumpUploads() {
    if (uploading) return;
    var entry = null;
    for (var i = 0; i < staged.length; i += 1) {
      if (staged[i].status === 'queued') {
        entry = staged[i];
        break;
      }
    }
    if (!entry) return;

    var settled = false;
    var finish = function () {
      entry.cancel = null;
      uploading = null;
      pumpUploads();
    };
    var hooks = {
      progress: function (fraction) {
        entry.progress = Math.max(0, Math.min(1, fraction));
        if (entry.metaNode) entry.metaNode.textContent = chipMeta(entry);
        if (entry.barNode) entry.barNode.value = entry.progress;
      },
      done: function (item) {
        if (settled) return;
        settled = true;
        addItem(item, true);
        unstage(entry);
        finish();
      },
      fail: function (message) {
        if (settled) return;
        settled = true;
        entry.status = 'error';
        entry.error = message;
        renderStaged();
        finish();
      },
      cancelled: function () {
        if (settled) return;
        settled = true;
        unstage(entry);
        finish();
      }
    };

    uploading = entry;
    if (usedBytes() + entry.size > state.config.maxRoomBytes) {
      hooks.fail('수업방 저장 공간이 부족합니다. 지난 파일을 지운 뒤 다시 시도해 주세요.');
      return;
    }

    entry.status = 'uploading';
    entry.progress = 0;
    renderStaged();
    try {
      // 서버 설정에 따라 이 서버로 바로 올리거나(direct), 파일 저장소로 직접 올립니다(blob).
      var uploader = uploadDirect;
      if (state.config.upload === 'blob') {
        if (!window.App.uploadToBlob) {
          hooks.fail('올릴 준비가 아직 끝나지 않았습니다. 잠시 뒤 다시 시도해 주세요.');
          return;
        }
        uploader = window.App.uploadToBlob;
      }
      entry.cancel = uploader(entry, hooks, { roomUrl: roomUrl, token: state.token, config: state.config });
    } catch (err) {
      hooks.fail('이 파일은 올릴 수 없습니다.');
    }
  }

  function uploadErrorText(status, errorCode) {
    if (errorCode === 'file_too_large') {
      return '파일이 너무 큽니다. (하나에 최대 ' + A.formatBytes(state.config.maxFileBytes) + ')';
    }
    if (status === 413 && !errorCode) {
      // 이 서비스가 아니라 앞단의 프록시(nginx 등)가 거절한 경우
      return '서버 앞단(프록시)의 업로드 크기 제한에 걸렸습니다. 관리자에게 문의해 주세요.';
    }
    return A.errorText({ status: status, code: errorCode });
  }

  // 이 서버로 바로 올리기. 취소할 때 부를 함수를 돌려줍니다.
  function uploadDirect(entry, hooks) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', roomUrl + '/files');
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(entry.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function (event) {
      if (event.lengthComputable && event.total) hooks.progress(event.loaded / event.total);
    };
    xhr.onload = function () {
      var data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        data = {};
      }
      if (xhr.status === 201 && data.item) hooks.done(data.item);
      else hooks.fail(uploadErrorText(xhr.status, data.error));
    };
    xhr.onerror = function () {
      hooks.fail('올리지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    };
    xhr.onabort = function () {
      hooks.cancelled();
    };
    xhr.send(entry.file);
    return function () {
      xhr.abort();
    };
  }

  // ------------------------------------------------------------ 끌어다 놓기·붙여넣기

  function hasFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  function modalOpen() {
    return Boolean(document.querySelector('dialog[open]'));
  }

  function setupDropAndPaste() {
    var depth = 0;
    var zone = $('dropzone');

    window.addEventListener('dragenter', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      if (!modalOpen()) zone.hidden = false;
    });
    window.addEventListener('dragover', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault(); // 이게 없으면 브라우저가 파일을 열어 버립니다
      event.dataTransfer.dropEffect = modalOpen() ? 'none' : 'copy';
    });
    window.addEventListener('dragleave', function (event) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.hidden = true;
    });
    window.addEventListener('drop', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      zone.hidden = true;
      if (modalOpen()) return;

      var transfer = event.dataTransfer;
      var files = [];
      var folder = false;
      var items = transfer.items;
      if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
        for (var i = 0; i < items.length; i += 1) {
          if (items[i].kind !== 'file') continue;
          var entry = items[i].webkitGetAsEntry();
          if (entry && entry.isDirectory) {
            folder = true;
            continue;
          }
          var file = items[i].getAsFile();
          if (file) files.push(file);
        }
      } else {
        files = Array.prototype.slice.call(transfer.files || []);
      }
      if (folder) A.toast('폴더는 올릴 수 없습니다. 압축(zip)한 뒤 올려 주세요.', 'error');
      stageFiles(files);
    });

    document.addEventListener('paste', function (event) {
      if (modalOpen()) return;
      var data = event.clipboardData;
      if (!data) return;
      var text = data.getData('text/plain');
      var files = Array.prototype.slice.call(data.files || []);
      var types = Array.prototype.slice.call(data.types || []);
      // 엑셀·워드에서 복사하면 글자와 함께 그림도 딸려 옵니다. 그럴 때는 글자를 우선합니다.
      var rich = types.indexOf('text/html') >= 0 || types.indexOf('text/rtf') >= 0;

      if (files.length && (!text || !rich)) {
        event.preventDefault();
        var stamp = new Date();
        var clock = [stamp.getHours(), stamp.getMinutes(), stamp.getSeconds()]
          .map(function (n) {
            return ('0' + n).slice(-2);
          })
          .join('');
        files.forEach(function (file, index) {
          // 화면 캡처를 붙여넣으면 이름이 모두 "image.png"라서 구분되는 이름을 붙입니다.
          if (!file.name || /^image\.\w+$/i.test(file.name)) {
            var ext = (/\/(\w+)/.exec(file.type) || ['', 'png'])[1].replace('jpeg', 'jpg');
            try {
              file.stagedName = '붙여넣은 이미지 ' + clock + (index ? '-' + (index + 1) : '') + '.' + ext;
            } catch (err) {
              /* 이름을 못 바꾸면 원래 이름 사용 */
            }
          }
        });
        stageFiles(files);
        return;
      }

      var target = event.target;
      var inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
      if (text && !inField) {
        event.preventDefault();
        var area = $('composer-text');
        area.focus();
        if (typeof area.setRangeText === 'function') {
          area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
        } else {
          area.value += text;
        }
        autosize();
      }
    });
  }

  // ------------------------------------------------------------ 항목·수업방 관리

  function deleteItem(item, button) {
    button.disabled = true;
    A.api('DELETE', roomUrl + '/items/' + item.id, null, state.token).then(
      function () {
        removeItem(item.id);
      },
      function (err) {
        button.disabled = false;
        A.toast(A.errorText(err), 'error');
      }
    );
  }

  function setupManage() {
    $('clear-all').addEventListener('click', function () {
      A.ask({
        title: '공유한 내용을 모두 지울까요?',
        message: '학생 화면에서도 바로 사라지며, 올린 파일도 함께 지워집니다.',
        okLabel: '모두 지우기',
        danger: true
      }).then(function (answer) {
        if (!answer) return;
        A.api('DELETE', roomUrl + '/items', null, state.token).then(
          function () {
            state.items = [];
            renderFeed(null);
          },
          function (err) {
            A.toast(A.errorText(err), 'error');
          }
        );
      });
    });

    $('rename-room').addEventListener('click', function () {
      A.ask({
        title: '수업방 이름',
        input: { value: state.name, maxLength: 40, placeholder: '예: 3학년 2반 정보' },
        okLabel: '저장'
      }).then(function (answer) {
        if (answer === null) return;
        A.api('PATCH', roomUrl, { name: answer }, state.token).then(
          function (result) {
            setName(result.name);
            A.rooms.save(code, state.token, state.name);
          },
          function (err) {
            A.toast(A.errorText(err), 'error');
          }
        );
      });
    });

    $('copy-host-link').addEventListener('click', function () {
      var link = joinUrl() + '#host=' + encodeURIComponent(state.token);
      A.copyText(link).then(
        function () {
          A.toast('선생님용 링크를 복사했습니다. 이 링크로 들어오면 누구나 공유·삭제를 할 수 있으니 학생에게는 보내지 마세요.', '', 7000);
        },
        function () {
          A.toast('복사하지 못했습니다.', 'error');
        }
      );
    });

    $('delete-room').addEventListener('click', function () {
      A.ask({
        title: '수업방을 삭제할까요?',
        message: '공유한 내용과 파일이 모두 지워지고, 학생들은 더 이상 이 주소로 들어올 수 없습니다. 되돌릴 수 없습니다.',
        okLabel: '수업방 삭제',
        danger: true
      }).then(function (answer) {
        if (!answer) return;
        A.api('DELETE', roomUrl, null, state.token).then(
          function () {
            state.closed = true;
            A.rooms.forget(code);
            location.href = '/';
          },
          function (err) {
            A.toast(A.errorText(err), 'error');
          }
        );
      });
    });
  }

  // ============================================================

  // 이미 수업방을 연 탭의 주소창에 선생님용 링크를 붙여넣으면 페이지가 다시 열리지 않으므로, 직접 다시 불러옵니다.
  window.addEventListener('hashchange', function () {
    if (/[#&]host=/.test(location.hash)) location.reload();
  });

  if (!/^\d{6}$/.test(code)) {
    showScreen('notfound');
  } else {
    captureHostToken();
    load(0);
  }
})();
