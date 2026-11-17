# 수업공유 — 추가 패키지 없이 Node.js만으로 실행됩니다.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public

# 수업방과 올린 파일이 저장되는 곳. 컨테이너를 새로 만들어도 남도록 볼륨으로 연결하세요.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "server.js"]
