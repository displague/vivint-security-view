# syntax=docker/dockerfile:1
# Multi-arch (linux/amd64, linux/arm64) on the official node Alpine image. The only step that runs
# under emulation for arm64 is apk installing ffmpeg, which is quick. The npm dependencies (pure
# JavaScript, no native modules) are installed once on the build machine's own platform.

FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# HLS output goes to /app/streams, owned by the image's unprivileged node user (uid 1000).
RUN apk add --no-cache ffmpeg \
  && mkdir -p /app/streams && chown node:node /app/streams
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts/refresh_vivint_rtsp_urls.js ./scripts/
COPY README.md LICENSE cameras.example.json ./
USER node

EXPOSE 8080

CMD ["node", "src/index.js"]
