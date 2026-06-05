FROM node:22-alpine

WORKDIR /app

# Install OpenCode CLI
RUN npm install -g opencode-ai

COPY server/package*.json ./
RUN npm ci --production

COPY server/ ./

EXPOSE 8000

CMD ["node", "index.js"]
