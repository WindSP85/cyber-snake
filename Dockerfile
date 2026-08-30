# NEON://SNAKE — игровой сервер (Node, ноль сборки)
# Внутри только вендорная библиотека ws — npm install не нужен.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY server/server.js server/store.js server/bot.js ./
COPY server/ws ./ws

# данные (scores.json / duels.json) живут в volume
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data
ENV PORT=8080

EXPOSE 8080
USER node
CMD ["node", "server.js"]
