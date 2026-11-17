#!/usr/bin/env node
'use strict';

// 수업공유 — 수업 중에 링크·텍스트·파일을 학생에게 바로 전달하는 작은 웹 서비스
// 실행: node server.js   (Node.js 18 이상, 추가 설치 없음)

const { loadConfig, MB, DAY } = require('./src/config');
const { createApp } = require('./src/app');
const util = require('./src/util');

async function main() {
  const config = loadConfig(process.env);
  const app = await createApp(config);

  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`포트 ${config.port}을(를) 이미 다른 프로그램이 쓰고 있습니다. PORT 환경 변수로 다른 포트를 지정하세요.`);
    } else {
      console.error('서버를 시작하지 못했습니다:', err.message);
    }
    process.exit(1);
  });

  app.server.listen(config.port, config.host, () => {
    const port = app.port();
    const lines = ['', `  ${config.siteName} 서버가 시작되었습니다.`, ''];
    if (config.publicUrl) {
      lines.push(`  접속 주소           ${config.publicUrl}`);
    } else {
      lines.push(`  이 컴퓨터에서       http://localhost:${port}`);
      for (const ip of util.lanAddresses()) {
        lines.push(`  같은 네트워크에서   http://${ip}:${port}`);
      }
    }
    lines.push(
      '',
      `  데이터 폴더         ${config.dataDir}`,
      `  수업방 만들기       ${config.teacherPassword ? '비밀번호 필요 (TEACHER_PASSWORD)' : '누구나 가능 — 인터넷에 공개한다면 TEACHER_PASSWORD 설정을 권장합니다'}`,
      `  파일 크기 제한      파일당 ${Math.round(config.maxFileBytes / MB)}MB · 수업방당 ${Math.round(config.maxRoomBytes / MB)}MB`,
      `  수업방 보관         마지막 사용 후 ${formatDays(config.roomTtlMs / DAY)}`,
      '',
      '  끝내려면 Ctrl+C',
      ''
    );
    console.log(lines.join('\n'));
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} — 저장하고 종료합니다…`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    try {
      await app.close();
    } catch (err) {
      console.error(err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function formatDays(days) {
  if (days >= 1) return `${Math.round(days * 10) / 10}일`;
  return `${Math.round(days * 24 * 10) / 10}시간`;
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

main().catch((err) => {
  console.error('서버를 시작하지 못했습니다:', err);
  process.exit(1);
});
