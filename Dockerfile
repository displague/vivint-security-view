# Multi-arch (linux/amd64, linux/arm64): the base image and Debian's ffmpeg exist for both.
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts/refresh_vivint_rtsp_urls.js ./scripts/
COPY README.md ./
COPY cameras.example.json ./

# HLS output goes to /app/streams; run as the image's unprivileged node user (uid 1000).
RUN mkdir -p /app/streams && chown node:node /app/streams
USER node

EXPOSE 8080

CMD ["node", "src/index.js"]
