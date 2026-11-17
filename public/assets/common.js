/* 수업공유 — 두 화면(처음 화면, 수업방)이 함께 쓰는 도구 모음 */
(function () {
  'use strict';

  var App = (window.App = {});

  // ------------------------------------------------------------ DOM

  App.$ = function (id) {
    return document.getElementById(id);
  };

  // el('a', { class: 'btn', href: url, onclick: fn }, [child, '글자'])
  App.el = function (tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  };

  // ------------------------------------------------------------ 아이콘

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var ICONS = {
    link: [
      ['path', { d: 'M9 15l6-6' }],
      ['path', { d: 'M11 6l1-1a4.24 4.24 0 0 1 6 6l-1 1' }],
      ['path', { d: 'M13 18l-1 1a4.24 4.24 0 0 1-6-6l1-1' }]
    ],
    text: [['path', { d: 'M4 6h16M4 12h16M4 18h10' }]],
    file: [
      ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }],
      ['path', { d: 'M14 3v5h5' }]
    ],
    copy: [
      ['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }],
      ['path', { d: 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' }]
    ],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    download: [['path', { d: 'M12 4v11' }], ['path', { d: 'M7 11l5 5 5-5' }], ['path', { d: 'M5 20h14' }]],
    open: [
      ['path', { d: 'M14 4h6v6' }],
      ['path', { d: 'M20 4l-9 9' }],
      ['path', { d: 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4' }]
    ],
    trash: [
      ['path', { d: 'M4 7h16' }],
      ['path', { d: 'M9 7V4h6v3' }],
      ['path', { d: 'M6 7l1 13h10l1-13' }],
      ['path', { d: 'M10 11v5M14 11v5' }]
    ],
    close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    retry: [['path', { d: 'M20 12a8 8 0 1 1-2.6-5.9' }], ['path', { d: 'M20 4v5h-5' }]]
  };

  App.icon = function (name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (shape) {
      var node = document.createElementNS(SVG_NS, shape[0]);
      Object.keys(shape[1]).forEach(function (key) {
        node.setAttribute(key, String(shape[1][key]));
      });
      svg.appendChild(node);
    });
    return svg;
  };

  // ------------------------------------------------------------ 서버 호출

  // 응답이 오지 않는 요청에 화면이 묶이지 않도록 시간 제한을 둡니다.
  App.api = function (method, path, body, token, timeoutMs) {
    var options = { method: method, headers: {}, cache: 'no-store' };
    if (token) options.headers.Authorization = 'Bearer ' + token;
    if (body !== undefined && body !== null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) options.signal = controller.signal;
    var timer = null;
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (controller) controller.abort();
        var err = new Error('timeout');
        err.code = 'timeout';
        reject(err);
      }, timeoutMs || 15000);
    });
    return Promise.race([send(path, options), timeout]).then(
      function (value) {
        clearTimeout(timer);
        return value;
      },
      function (err) {
        clearTimeout(timer);
        throw err;
      }
    );
  };

  function send(path, options) {
    return fetch(path, options).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (res.ok) return data;
          var err = new Error(data.error || 'http_' + res.status);
          err.status = res.status;
          err.code = data.error || '';
          err.data = data;
          throw err;
        });
    });
  }

  var ERRORS = {
    not_found: '수업방을 찾을 수 없습니다.',
    forbidden: '이 기기에는 선생님 권한이 없습니다.',
    too_many_attempts: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    bad_password: '비밀번호가 올바르지 않습니다.',
    empty: '공유할 내용을 입력해 주세요.',
    text_too_long: '텍스트가 너무 깁니다. 파일로 올려 주세요.',
    too_large: '내용이 너무 큽니다.',
    too_many_items: '항목이 너무 많습니다. 지난 항목을 지운 뒤 다시 시도해 주세요.',
    text_full: '이 수업방에 글이 너무 많이 쌓였습니다. 지난 항목을 지운 뒤 다시 시도해 주세요.',
    upload_busy: '다른 파일을 올리는 중입니다. 잠시 뒤 다시 시도해 주세요.',
    unavailable: '지금은 이 수업방을 열 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
    cross_site: '허용되지 않는 요청입니다.',
    not_configured: '서버 설정이 아직 끝나지 않았습니다. (관리자: 저장소 연결을 확인해 주세요)',
    upload_not_found: '올리기 허가 시간이 지났습니다. 다시 시도해 주세요.',
    upload_missing: '파일이 저장소에 올라가지 않았습니다. 다시 시도해 주세요.',
    storage_auth: '파일 저장소에 접속하지 못했습니다. (관리자: Vercel에서 Blob 저장소 연결을 확인해 주세요)',
    storage_private: '연결된 파일 저장소가 비공개(Private)용이라 파일을 올릴 수 없습니다. (관리자: 공개(Public) Blob 저장소를 연결해 주세요)',
    storage_error: '파일 저장소가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.',
    file_too_large: '파일이 너무 큽니다.',
    room_full: '수업방 저장 공간이 부족합니다. 지난 파일을 지운 뒤 다시 시도해 주세요.',
    server_full: '서버 저장 공간이 부족합니다.',
    empty_file: '빈 파일은 올릴 수 없습니다.',
    too_many_rooms: '지금은 수업방을 더 만들 수 없습니다.',
    busy: '접속이 많습니다. 잠시 후 다시 시도해 주세요.'
  };

  App.errorText = function (err) {
    if (!err || !err.status) return '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.';
    return ERRORS[err.code] || '요청을 처리하지 못했습니다. (오류 ' + err.status + ')';
  };

  // ------------------------------------------------------------ 알림·복사

  App.toast = function (message, kind, ms) {
    var box = App.$('toasts');
    if (!box) return;
    var node = App.el('div', { class: 'toast' + (kind === 'error' ? ' toast--error' : ''), text: message });
    box.appendChild(node);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, ms || (kind === 'error' ? 5000 : 2600));
  };

  // https가 아닌 주소(교실 내부망)에서는 클립보드 API를 쓸 수 없어 예전 방식으로 복사합니다.
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var host = document.querySelector('dialog[open]') || document.body;
      var active = document.activeElement;
      var area = document.createElement('textarea');
      area.className = 'clip-helper';
      area.setAttribute('readonly', '');
      area.value = text;
      host.appendChild(area);
      var ok = false;
      try {
        area.focus();
        area.select();
        area.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      host.removeChild(area);
      if (active && active.focus) {
        try {
          active.focus();
        } catch (err) {
          /* 무시 */
        }
      }
      if (ok) resolve();
      else reject(new Error('copy_failed'));
    });
  }

  App.copyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  };

  // ------------------------------------------------------------ 표시 형식

  App.formatBytes = function (bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB'];
    var value = bytes / 1024;
    var index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    var text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
    return text + ' ' + units[index];
  };

  App.formatTime = function (ms) {
    var date = new Date(ms);
    var time;
    try {
      time = date.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
    } catch (err) {
      time = date.getHours() + ':' + ('0' + date.getMinutes()).slice(-2);
    }
    if (date.toDateString() === new Date().toDateString()) return time;
    return date.getMonth() + 1 + '월 ' + date.getDate() + '일 ' + time;
  };

  App.formatCode = function (code) {
    return String(code).slice(0, 3) + ' ' + String(code).slice(3);
  };

  // ------------------------------------------------------------ 이 기기에 저장한 수업방 (선생님 권한)

  var STORAGE_KEY = 'classshare.rooms.v1';

  function readRooms() {
    try {
      var value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (err) {
      return {};
    }
  }

  function writeRooms(map) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (err) {
      /* 저장소를 쓸 수 없는 환경(사생활 보호 모드 등) */
    }
  }

  App.rooms = {
    all: function () {
      var map = readRooms();
      return Object.keys(map)
        .filter(function (code) {
          return /^\d{6}$/.test(code) && map[code] && typeof map[code].token === 'string';
        })
        .map(function (code) {
          return { code: code, token: map[code].token, name: map[code].name || '', savedAt: map[code].savedAt || 0 };
        })
        .sort(function (a, b) {
          return b.savedAt - a.savedAt;
        });
    },
    token: function (code) {
      var entry = readRooms()[code];
      return entry && typeof entry.token === 'string' ? entry.token : '';
    },
    save: function (code, token, name) {
      var map = readRooms();
      var prev = map[code] || {};
      map[code] = {
        token: token,
        name: typeof name === 'string' ? name : prev.name || '',
        savedAt: prev.savedAt || Date.now()
      };
      writeRooms(map);
    },
    forget: function (code) {
      var map = readRooms();
      if (map[code]) {
        delete map[code];
        writeRooms(map);
      }
    }
  };

  App.pref = {
    get: function (key) {
      try {
        return localStorage.getItem('classshare.' + key) || '';
      } catch (err) {
        return '';
      }
    },
    set: function (key, value) {
      try {
        localStorage.setItem('classshare.' + key, value);
      } catch (err) {
        /* 무시 */
      }
    }
  };

  // ------------------------------------------------------------ 확인·입력 대화상자

  // 확인: resolve(true) / 취소: resolve(null). input 옵션을 주면 입력한 문자열로 resolve.
  App.ask = function (options) {
    return new Promise(function (resolve) {
      var supported = typeof HTMLDialogElement === 'function' && typeof HTMLDialogElement.prototype.showModal === 'function';
      if (!supported) {
        var plain = options.title + (options.message ? '\n\n' + options.message : '');
        if (options.input) {
          var typed = window.prompt(plain, options.input.value || '');
          resolve(typed === null ? null : typed);
        } else {
          resolve(window.confirm(plain) ? true : null);
        }
        return;
      }

      var input = null;
      if (options.input) {
        input = App.el('input', {
          class: 'input',
          type: 'text',
          maxlength: options.input.maxLength || 100,
          placeholder: options.input.placeholder || '',
          'aria-label': options.title
        });
        input.value = options.input.value || '';
      }
      var result = null;
      var cancel = App.el('button', { class: 'btn', type: 'button', text: '취소' });
      var ok = App.el('button', {
        class: 'btn ' + (options.danger ? 'btn--danger-solid' : 'btn--primary'),
        type: 'submit',
        text: options.okLabel || '확인'
      });
      var form = App.el('form', { class: 'ask', novalidate: true }, [
        App.el('h2', { class: 'ask__title', text: options.title }),
        options.message ? App.el('p', { class: 'ask__msg', text: options.message }) : null,
        input,
        App.el('div', { class: 'ask__buttons' }, [cancel, ok])
      ]);
      var dialog = App.el('dialog', null, [form]);

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        result = input ? input.value : true;
        dialog.close();
      });
      cancel.addEventListener('click', function () {
        dialog.close();
      });
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) dialog.close(); // 바깥(어두운 부분)을 누르면 닫기
      });
      dialog.addEventListener('close', function () {
        if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
        resolve(result);
      });

      document.body.appendChild(dialog);
      dialog.showModal();
      if (input) {
        input.focus();
        input.select();
      } else if (options.danger) {
        cancel.focus(); // 되돌릴 수 없는 동작은 실수로 Enter를 눌러도 실행되지 않게
      }
    });
  };
})();
