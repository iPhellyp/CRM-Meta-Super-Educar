FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node sql ./sql
COPY --chown=node:node public ./public
ARG RELEASE_VERSION=dev
RUN sed -i "s/__ASSET_VERSION__/${RELEASE_VERSION}/g" public/service-worker.js public/offline.html
COPY --chown=node:node scripts/backfill-meta-phones.js ./scripts/backfill-meta-phones.js
COPY --chown=node:node scripts/backfill-meta-qualified.js ./scripts/backfill-meta-qualified.js
COPY --chown=node:node scripts/rebind-wa2-chat-b1.mjs ./scripts/rebind-wa2-chat-b1.mjs
COPY --chown=node:node scripts/rebind-normal-lead-crm02.mjs ./scripts/rebind-normal-lead-crm02.mjs
COPY --chown=node:node scripts/meta-clean-canary.mjs ./scripts/meta-clean-canary.mjs
COPY --chown=node:node scripts/meta-clean-historical.mjs ./scripts/meta-clean-historical.mjs
COPY --chown=node:node scripts/import-univc-spreadsheet.mjs ./scripts/import-univc-spreadsheet.mjs
COPY --chown=node:node scripts/reprocess-wa2-technical.mjs ./scripts/reprocess-wa2-technical.mjs
COPY --chown=node:node scripts/wa2-instance-replacement.mjs ./scripts/wa2-instance-replacement.mjs
COPY --chown=node:node scripts/migrate-wa2-data.mjs ./scripts/migrate-wa2-data.mjs
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
