FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY sql ./sql
COPY public ./public
EXPOSE 3000
CMD ["node", "src/server.js"]
