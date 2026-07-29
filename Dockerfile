FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node sql ./sql
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/backfill-meta-phones.js ./scripts/backfill-meta-phones.js
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
