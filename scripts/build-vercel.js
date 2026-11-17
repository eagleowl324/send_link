#!/usr/bin/env node
'use strict';

// Vercel에 올릴 때 실행되는 빌드: public/ 을 dist/ 로 복사하면서 화면에 서비스 이름을 넣습니다.
// (자체 서버에서는 서버가 응답할 때 넣지만, Vercel에서는 정적 파일을 그대로 내보내므로 미리 넣어 둡니다)
// vercel.json 의 buildCommand 로 지정되어 있습니다. 직접 실행: node scripts/build-vercel.js

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'public');
const OUTPUT = path.join(ROOT, 'dist');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function copy(from, to, siteName) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copy(source, target, siteName);
    } else if (entry.name.endsWith('.html')) {
      const html = fs.readFileSync(source, 'utf8').replace(/\{\{SITE_NAME\}\}/g, () => siteName);
      fs.writeFileSync(target, html);
    } else {
      fs.copyFileSync(source, target);
    }
  }
}

function build(env = process.env) {
  const siteName = escapeHtml(loadConfig(env).siteName);
  fs.rmSync(OUTPUT, { recursive: true, force: true });
  copy(SOURCE, OUTPUT, siteName);
  // 지금 떠 있는 것이 언제 만든 배포인지 밖에서 확인할 수 있게 적어 둡니다. (https://<주소>/version.json)
  // 환경 변수를 바꾼 뒤 "다시 배포"가 실제로 됐는지 볼 때 씁니다.
  const sha = String(env.VERCEL_GIT_COMMIT_SHA || '');
  const version = { commit: /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : null, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUTPUT, 'version.json'), JSON.stringify(version) + '\n');
  return OUTPUT;
}

if (require.main === module) {
  const out = build();
  console.log(`정적 파일을 만들었습니다: ${path.relative(ROOT, out)}/`);
}

module.exports = { build };
