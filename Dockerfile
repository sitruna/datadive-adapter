FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV TRANSPORT=http
# PORT, DATADIVE_API_KEY, MCP_OAUTH_ENABLED,
# CLERK_OAUTH_ISSUER, MCP_OAUTH_EMAIL_DOMAIN are set as Railway env vars

EXPOSE 3000

# MCP endpoint: /mcp  |  Railway healthcheck: /sse (returns "ok")  |  liveness: /health
CMD ["node", "/app/dist/index.js"]
