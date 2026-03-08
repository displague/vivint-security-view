const path = require("path");
const express = require("express");
const morgan = require("morgan");
const { loadConfig } = require("./config");
const { StreamManager } = require("./stream-manager");
const { createSmartHomeHandler } = require("./google-smart-home");

function logger() {
  return {
    info: (msg) => console.log(`[INFO] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
    debug: (msg) => {
      if (process.env.DEBUG === "1") {
        console.log(`[DEBUG] ${msg}`);
      }
    }
  };
}

async function main() {
  const log = logger();
  const config = loadConfig();
  const streamManager = new StreamManager(config, log);
  await streamManager.init();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("dev"));

  app.get("/healthz", (req, res) => {
    res.json({
      ok: true,
      cameras: config.cameras.map((c) => c.id)
    });
  });

  app.get("/", (req, res) => {
    const list = config.cameras
      .map(
        (camera) =>
          `<li>${camera.name} (${camera.id}) - <a href="/stream/${camera.id}/index.m3u8">playlist</a></li>`
      )
      .join("");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<h1>Vivint Local Camera Bridge</h1><p><a href="/security">Open Security View</a></p><ul>${list}</ul>`
    );
  });

  app.get("/security", (req, res) => {
    const camerasJson = JSON.stringify(
      config.cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        url: `/stream/${encodeURIComponent(camera.id)}/index.m3u8`
      }))
    );

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Security View</title>
    <style>
      :root {
        --bg: #0b0f14;
        --panel: #111923;
        --text: #dbe7f5;
        --muted: #90a4bf;
        --accent: #39d98a;
        --warn: #f4b740;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(circle at 15% 10%, #172130 0%, var(--bg) 45%);
        color: var(--text);
        font-family: "Segoe UI", Tahoma, sans-serif;
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 5;
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        align-items: center;
        padding: 10px 14px;
        background: rgba(9, 13, 18, 0.9);
        border-bottom: 1px solid #233246;
        backdrop-filter: blur(8px);
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .control {
        display: inline-flex;
        gap: 8px;
        align-items: center;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 12px;
        padding: 12px;
      }
      .tile {
        background: linear-gradient(180deg, #0e1621 0%, #0a1119 100%);
        border: 1px solid #243347;
        border-radius: 10px;
        overflow: hidden;
      }
      .tile-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 10px;
        font-size: 13px;
        border-bottom: 1px solid #223348;
      }
      .latency { color: var(--muted); font-variant-numeric: tabular-nums; }
      .live { color: var(--accent); }
      .video-wrap {
        position: relative;
        background: #000;
        aspect-ratio: 16 / 9;
      }
      video {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: cover;
      }
      .hint {
        position: absolute;
        left: 8px;
        bottom: 8px;
        font-size: 11px;
        color: #d7e5f7;
        background: rgba(0, 0, 0, 0.55);
        padding: 3px 6px;
        border-radius: 5px;
        transition: opacity 140ms ease;
      }
      .tile:hover .hint { opacity: 0; }
      button {
        background: #12314d;
        color: #e4f0ff;
        border: 1px solid #2e5477;
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
        cursor: default;
      }
      a { color: #9bd2ff; }
      select, input[type="checkbox"] {
        background: #0f1a28;
        color: var(--text);
        border: 1px solid #29415e;
        border-radius: 6px;
      }
      select { padding: 3px 6px; }
      @media (max-width: 700px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="topbar">
      <strong>Security View</strong>
      <span><a href="/">Back</a></span>
      <div class="control">
        <span class="label">Hover Audio</span>
        <input id="hoverAudio" type="checkbox" checked />
      </div>
      <div class="control">
        <button id="audioArmBtn">Enable Audio</button>
        <span id="audioStatus" class="label">click to allow unmute on hover</span>
      </div>
      <div class="control">
        <span class="label">Playback Rate</span>
        <select id="rate">
          <option value="1">1.00x</option>
          <option value="1.1">1.10x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.50x</option>
          <option value="2">2.00x</option>
        </select>
      </div>
      <div class="control">
        <span class="label">Auto Catch-up</span>
        <input id="catchup" type="checkbox" checked />
      </div>
    </div>
    <div id="grid" class="grid"></div>

    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
    <script>
      const cameras = ${camerasJson};
      const grid = document.getElementById("grid");
      const hoverAudioEl = document.getElementById("hoverAudio");
      const audioArmBtn = document.getElementById("audioArmBtn");
      const audioStatus = document.getElementById("audioStatus");
      const rateEl = document.getElementById("rate");
      const catchupEl = document.getElementById("catchup");

      const sessions = [];
      let activeAudioCameraId = null;
      let audioArmed = false;

      function applyBasePlaybackRate() {
        const base = Number(rateEl.value || "1");
        for (const s of sessions) {
          if (Number.isFinite(base) && base > 0) {
            s.video.playbackRate = base;
          }
        }
      }

      function muteAllExcept(cameraId) {
        for (const s of sessions) {
          const shouldMute = s.camera.id !== cameraId;
          s.video.muted = shouldMute;
          if (shouldMute) {
            s.video.volume = 0;
          } else {
            s.video.volume = 1;
          }
        }
      }

      function setAudioStatus(text) {
        audioStatus.textContent = text;
      }

      async function armAudio() {
        for (const s of sessions) {
          try {
            s.video.muted = true;
            await s.video.play();
          } catch (_e) {}
        }
        audioArmed = true;
        audioArmBtn.disabled = true;
        setAudioStatus("audio enabled");
      }

      function attachStream(video, url, latencyEl) {
        if (window.Hls && Hls.isSupported()) {
          const hls = new Hls({
            lowLatencyMode: true,
            liveSyncDurationCount: 1,
            liveMaxLatencyDurationCount: 3,
            maxLiveSyncPlaybackRate: 1.8,
            backBufferLength: 4
          });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data && data.fatal) {
              latencyEl.textContent = "error";
              latencyEl.style.color = "var(--warn)";
            }
          });
          return hls;
        }

        video.src = url;
        return null;
      }

      function startLatencyLoop(session) {
        setInterval(() => {
          const baseRate = Number(rateEl.value || "1");
          const hls = session.hls;
          if (!hls || typeof hls.latency !== "number") {
            session.latencyEl.textContent = "live";
            return;
          }
          const latency = hls.latency;
          session.latencyEl.textContent = latency.toFixed(1) + "s";
          if (!catchupEl.checked) {
            session.video.playbackRate = baseRate;
            return;
          }
          const target = Number(hls.targetLatency || 1.5);
          const drift = latency - target;
          if (drift > 1.5) {
            session.video.playbackRate = Math.max(baseRate, 1.25);
          } else {
            session.video.playbackRate = baseRate;
          }
        }, 1000);
      }

      for (const camera of cameras) {
        const tile = document.createElement("section");
        tile.className = "tile";
        tile.innerHTML = \`
          <div class="tile-head">
            <div>\${camera.name}</div>
            <div class="latency live">live</div>
          </div>
          <div class="video-wrap">
            <video autoplay muted playsinline controls></video>
            <div class="hint">hover to unmute</div>
          </div>
        \`;
        grid.appendChild(tile);

        const video = tile.querySelector("video");
        const latencyEl = tile.querySelector(".latency");
        const hls = attachStream(video, camera.url, latencyEl);
        const session = { camera, video, hls, latencyEl };
        sessions.push(session);

        video.addEventListener("loadedmetadata", () => {
          applyBasePlaybackRate();
          video.play().catch(() => {});
        });

        tile.addEventListener("mouseenter", () => {
          if (!hoverAudioEl.checked) {
            return;
          }
          if (!audioArmed) {
            setAudioStatus("click Enable Audio first");
            return;
          }
          activeAudioCameraId = camera.id;
          muteAllExcept(camera.id);
        });
        tile.addEventListener("mouseleave", () => {
          if (activeAudioCameraId !== camera.id) {
            return;
          }
          activeAudioCameraId = null;
          muteAllExcept(null);
        });

        startLatencyLoop(session);
      }

      rateEl.addEventListener("change", applyBasePlaybackRate);
      audioArmBtn.addEventListener("click", () => {
        armAudio();
      });
      hoverAudioEl.addEventListener("change", () => {
        if (!hoverAudioEl.checked) {
          activeAudioCameraId = null;
          muteAllExcept(null);
        }
      });

      document.addEventListener("visibilitychange", () => {
        for (const s of sessions) {
          if (!document.hidden) {
            s.video.play().catch(() => {});
          }
        }
      });
    </script>
  </body>
</html>`);
  });

  app.post(
    "/smarthome",
    createSmartHomeHandler({
      config,
      logger: log,
      streamManager
    })
  );

  app.get("/stream/:cameraId/index.m3u8", async (req, res) => {
    const { cameraId } = req.params;
    if (config.streamToken && req.query.token !== config.streamToken) {
      return res.status(401).send("Invalid token");
    }

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    const camera = config.cameras.find((c) => c.id === cameraId);
    if (!camera) {
      return res.status(404).send("Camera not found");
    }

    await streamManager.ensureRunning(camera);
    const ready = await streamManager.waitForPlaylist(cameraId, 10000);
    if (!ready) {
      const status = streamManager.getStatus(cameraId);
      const reason =
        status?.startError?.message ||
        status?.lastStderr ||
        "stream not ready yet";
      return res.status(503).json({
        error: "streamUnavailable",
        cameraId,
        reason
      });
    }

    return res.sendFile(streamManager.playlistPath(cameraId));
  });

  app.use(
    "/stream",
    express.static(path.resolve(config.streamRoot), {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".m3u8")) {
          res.setHeader("content-type", "application/vnd.apple.mpegurl");
        }
        if (filePath.endsWith(".ts")) {
          res.setHeader("content-type", "video/mp2t");
        }
      }
    })
  );

  const server = app.listen(config.port, () => {
    log.info(`Bridge listening on port ${config.port}`);
    log.info(`Base URL: ${config.baseUrl}`);
    log.info(`Cameras: ${config.cameras.map((c) => c.id).join(", ")}`);
  });

  function shutdown() {
    log.info("Shutting down...");
    streamManager.stopAll();
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
