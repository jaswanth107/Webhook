# syntax=docker/dockerfile:1

# ---- build stage ------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY server ./server
RUN npx tsc -p tsconfig.build.json

# ---- production dependencies ------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PUBLIC_DIR=/app/public
RUN apk add --no-cache curl
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# SQL migrations are read at runtime and are not emitted by tsc.
COPY server/src/db/migrations ./dist/server/src/db/migrations
COPY public ./public
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server/src/index.js"]
