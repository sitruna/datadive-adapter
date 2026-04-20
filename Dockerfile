FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY . .
RUN npm run build

# Install supergateway globally (pinned for reproducibility)
RUN npm install -g supergateway@3.4.3

ENV NODE_ENV=production
# PORT is set by Railway automatically
# DATADIVE_API_KEY is set as a Railway env var

EXPOSE 3000

# Stateful Streamable HTTP mode: spawns a fresh stdio subprocess per MCP session,
# fixing the "Already connected to a transport" crash on concurrent clients.
# MCP endpoint: /mcp  |  Railway healthcheck endpoint: /sse (returns "ok").
CMD sh -c "supergateway --stdio 'node /app/dist/index.js' --outputTransport streamableHttp --port ${PORT:-3000} --healthEndpoint /sse"
