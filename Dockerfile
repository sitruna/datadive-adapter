FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY . .
RUN npm run build

# Install supergateway globally
RUN npm install -g supergateway

ENV NODE_ENV=production
# PORT is set by Railway automatically
# DATADIVE_API_KEY is set as a Railway env var

EXPOSE 3000

CMD sh -c "supergateway --stdio 'node /app/dist/index.js' --port ${PORT:-3000}"
