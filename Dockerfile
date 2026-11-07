# syntax=docker/dockerfile:1
# Multi-arch (linux/amd64, linux/arm64) without emulation: the final stage only copies files, so
# nothing runs under QEMU. ffmpeg comes from a static multi-arch build, and the npm dependencies
# (pure JavaScript, no native modules) are installed once on the build machine's own platform.

FROM mwader/static-ffmpeg:9.0.2-1 AS ffmpeg

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /out/streams

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts/refresh_vivint_rtsp_urls.js ./scripts/
COPY README.md LICENSE cameras.example.json ./
# HLS output goes to /app/streams, owned by the image's unprivileged node user (uid 1000).
COPY --from=deps --chown=1000:1000 /out/streams ./streams
USER node

EXPOSE 8080

CMD ["node", "src/index.js"]
