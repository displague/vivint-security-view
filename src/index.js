const path = require("path");
const express = require("express");
const morgan = require("morgan");
const { loadConfig } = require("./config");
const { StreamManager } = require("./stream-manager");
const { createSmartHomeHandler } = require("./google-smart-home");
const { OAuthStore } = require("./oauth-store");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlBool(value) {
  return value ? "Yes" : "No";
}

function oauthError(res, status, error, description) {
  return res.status(status).json({
    error,
    error_description: description
  });
}

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
  const oauthStore = new OAuthStore(config);
  await streamManager.init();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(morgan("dev"));

  app.get("/healthz", (req, res) => {
    res.json({
      ok: true,
      cameras: config.cameras.map((c) => c.id),
      googleOAuthConfigured: oauthStore.isConfigured(),
      appMode: config.appMode
    });
  });

  app.get("/", (req, res) => {
    if (!config.enableRootIndex) {
      return res.status(404).send("Not found");
    }

    const list = config.cameras
      .map(
        (camera) =>
          `<li>${camera.name} (${camera.id}) - <a href="/stream/${camera.id}/index.m3u8">playlist</a></li>`
      )
      .join("");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<h1>Vivint Local Camera Bridge</h1><p><a href="/security">Open Security View</a></p><p><a href="/google/setup">Google Setup</a></p><p><a href="/oauth/authorize?client_id=demo-client&redirect_uri=http://localhost/callback&response_type=code&state=demo">OAuth Demo</a></p><ul>${list}</ul>`
    );
  });

  app.get("/google/setup", (req, res) => {
    const redirectProd = `https://oauth-redirect.googleusercontent.com/r/${config.googleProjectId}`;
    const redirectSandbox = `https://oauth-redirect-sandbox.googleusercontent.com/r/${config.googleProjectId}`;
    const publicBaseUrl = config.baseUrl;
    const oauthConfigured = oauthStore.isConfigured();
    const isHttps = /^https:\/\//i.test(publicBaseUrl);
    const clientConfigured = Boolean(
      config.googleClientId && config.googleClientSecret
    );

    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Google Setup</title>
    <style>
      :root {
        --bg: #0b1220;
        --panel: #111a2a;
        --line: #26384f;
        --text: #e7eef8;
        --muted: #94a8c4;
        --ok: #39d98a;
        --warn: #f4b740;
        --bad: #ff6b6b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(circle at top left, #16253a 0%, var(--bg) 48%);
        color: var(--text);
        font-family: "Segoe UI", Tahoma, sans-serif;
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 24px 18px 40px;
      }
      h1, h2 { margin: 0 0 12px; }
      p { color: var(--muted); }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 16px;
      }
      .card {
        background: linear-gradient(180deg, rgba(19,30,47,0.96), rgba(11,18,31,0.96));
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 16px;
      }
      .status {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
      }
      .ok { background: rgba(57,217,138,0.15); color: var(--ok); }
      .warn { background: rgba(244,183,64,0.15); color: var(--warn); }
      .bad { background: rgba(255,107,107,0.15); color: var(--bad); }
      code, pre {
        font-family: Consolas, "Courier New", monospace;
      }
      pre {
        margin: 10px 0 0;
        padding: 12px;
        background: #09111d;
        border: 1px solid #203146;
        border-radius: 10px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      ul {
        margin: 10px 0 0;
        padding-left: 18px;
        color: var(--text);
      }
      li { margin: 6px 0; }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      a { color: #9bd2ff; }
    </style>
  </head>
  <body>
    <main>
      <h1>Google Home Setup</h1>
      <p>Use this page to fill the Google Cloud OAuth client and Google Home cloud-to-cloud configuration with the exact values this bridge expects.</p>

      <div class="grid">
        <section class="card">
          <h2>Current Status</h2>
          <div class="label">Base URL</div>
          <pre>${escapeHtml(publicBaseUrl)}</pre>
          <div class="label" style="margin-top:12px">Project ID</div>
          <pre>${escapeHtml(config.googleProjectId)}</pre>
          <div class="label" style="margin-top:12px">Checks</div>
          <ul>
            <li>Public HTTPS base URL: <span class="status ${isHttps ? "ok" : "bad"}">${htmlBool(isHttps)}</span></li>
            <li>OAuth client configured in app: <span class="status ${clientConfigured ? "ok" : "bad"}">${htmlBool(clientConfigured)}</span></li>
            <li>Local bridge login configured: <span class="status ${oauthConfigured ? "ok" : "bad"}">${htmlBool(oauthConfigured)}</span></li>
          </ul>
        </section>

        <section class="card">
          <h2>Google Cloud OAuth Client</h2>
          <p>Create an OAuth client of type <strong>Web application</strong>.</p>
          <div class="label">Authorized JavaScript origins</div>
          <pre>None required for this server-side flow</pre>
          <div class="label" style="margin-top:12px">Authorized redirect URIs</div>
          <pre>${escapeHtml(redirectProd)}
${escapeHtml(redirectSandbox)}</pre>
        </section>

        <section class="card">
          <h2>Google Home Cloud-to-cloud</h2>
          <div class="label">Fulfillment URL</div>
          <pre>${escapeHtml(`${publicBaseUrl}/smarthome`)}</pre>
          <div class="label" style="margin-top:12px">Authorization URL</div>
          <pre>${escapeHtml(`${publicBaseUrl}/oauth/authorize`)}</pre>
          <div class="label" style="margin-top:12px">Token URL</div>
          <pre>${escapeHtml(`${publicBaseUrl}/oauth/token`)}</pre>
        </section>

        <section class="card">
          <h2>Env Vars To Set</h2>
          <pre>GOOGLE_PROJECT_ID=${escapeHtml(config.googleProjectId)}
GOOGLE_CLIENT_ID=${escapeHtml(config.googleClientId || "paste-client-id-here")}
GOOGLE_CLIENT_SECRET=${escapeHtml(config.googleClientSecret || "paste-client-secret-here")}
GOOGLE_AUTH_USER=${escapeHtml(config.googleAuthUser || "local-admin-username")}
GOOGLE_AUTH_PASS=${escapeHtml(config.googleAuthPass ? "configured" : "local-admin-password")}
BASE_URL=${escapeHtml(publicBaseUrl)}</pre>
        </section>
      </div>
    </main>
  </body>
</html>`);
  });

  app.get("/oauth/authorize", (req, res) => {
    if (!oauthStore.isConfigured()) {
      return res.status(500).send(
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_AUTH_USER, and GOOGLE_AUTH_PASS."
      );
    }

    const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType, state } = req.query;
    if (responseType !== "code" || !clientId || !redirectUri) {
      return res.status(400).send("Invalid OAuth authorize request.");
    }

    if (clientId !== config.googleClientId) {
      return res.status(400).send("Unknown client_id.");
    }

    const error = req.query.error ? `<p style="color:#b33">${escapeHtml(req.query.error)}</p>` : "";
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize Google Home</title>
    <style>
      body { font-family: "Segoe UI", Tahoma, sans-serif; background:#0f1720; color:#e7eef8; display:grid; place-items:center; min-height:100vh; margin:0; }
      form { width:min(420px, 92vw); background:#162230; border:1px solid #29415e; border-radius:12px; padding:24px; }
      label { display:block; margin:12px 0 6px; font-size:14px; color:#9eb1c8; }
      input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid #35506f; background:#0d1823; color:#eef5ff; }
      button { margin-top:18px; width:100%; padding:11px 12px; border-radius:8px; border:0; background:#39d98a; color:#082112; font-weight:700; cursor:pointer; }
      .sub { font-size:13px; color:#9eb1c8; margin-top:4px; }
    </style>
  </head>
  <body>
    <form method="post" action="/oauth/login">
      <h1 style="margin:0 0 8px">Authorize Google Home</h1>
      <div class="sub">Sign in with the local bridge account to link cameras.</div>
      ${error}
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
      <input type="hidden" name="state" value="${escapeHtml(state || "")}" />
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" />
      <button type="submit">Link Cameras</button>
    </form>
  </body>
</html>`);
  });

  app.post("/oauth/login", (req, res) => {
    const { client_id: clientId, redirect_uri: redirectUri, state, username, password } = req.body;
    if (!oauthStore.validateLocalUser(username, password)) {
      const params = new URLSearchParams({
        client_id: clientId || "",
        redirect_uri: redirectUri || "",
        response_type: "code",
        state: state || "",
        error: "Invalid username or password."
      });
      return res.redirect(`/oauth/authorize?${params.toString()}`);
    }

    const code = oauthStore.issueAuthCode({
      clientId,
      redirectUri,
      userId: config.googleAgentUserId
    });

    const redirect = new URL(String(redirectUri));
    redirect.searchParams.set("code", code);
    if (state) {
      redirect.searchParams.set("state", state);
    }
    return res.redirect(redirect.toString());
  });

  app.post("/oauth/token", (req, res) => {
    if (!oauthStore.isConfigured()) {
      return oauthError(res, 500, "server_error", "OAuth is not configured.");
    }

    const {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: grantType,
      code,
      redirect_uri: redirectUri,
      refresh_token: refreshToken
    } = req.body;

    if (!oauthStore.validateClient(clientId, clientSecret)) {
      return oauthError(res, 401, "invalid_client", "Client authentication failed.");
    }

    if (grantType === "authorization_code") {
      const tokenSet = oauthStore.consumeAuthCode(code, {
        clientId,
        redirectUri
      });
      if (!tokenSet) {
        return oauthError(res, 400, "invalid_grant", "Authorization code is invalid.");
      }
      return res.json(tokenSet);
    }

    if (grantType === "refresh_token") {
      const tokenSet = oauthStore.refreshAccessToken(refreshToken);
      if (!tokenSet) {
        return oauthError(res, 400, "invalid_grant", "Refresh token is invalid.");
      }
      return res.json(tokenSet);
    }

    return oauthError(res, 400, "unsupported_grant_type", "Unsupported grant_type.");
  });

  app.get("/security", (req, res) => {
    if (!config.enableSecurityView) {
      return res.status(404).send("Security view disabled");
    }

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
      body.fill .grid {
        grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
        gap: 6px;
        padding: 6px;
        height: calc(100vh - 58px);
      }
      .tile {
        background: linear-gradient(180deg, #0e1621 0%, #0a1119 100%);
        border: 1px solid #243347;
        border-radius: 10px;
        overflow: hidden;
        transition: transform 140ms ease, opacity 180ms ease, border-color 180ms ease;
      }
      body.fill .tile {
        border-radius: 6px;
        border-color: #1f2d3f;
      }
      .tile-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 10px;
        font-size: 13px;
        border-bottom: 1px solid #223348;
      }
      body.fill .tile-head {
        padding: 5px 8px;
        font-size: 12px;
      }
      .latency { color: var(--muted); font-variant-numeric: tabular-nums; }
      .live { color: var(--accent); }
      .meta {
        display: inline-flex;
        gap: 8px;
        align-items: center;
      }
      .motion {
        color: #9bd2ff;
        font-variant-numeric: tabular-nums;
      }
      .faces {
        color: #ffd58a;
        font-variant-numeric: tabular-nums;
      }
      .video-wrap {
        position: relative;
        background: #000;
        aspect-ratio: 16 / 9;
      }
      body.fill .video-wrap {
        aspect-ratio: auto;
        height: calc((100vh - 58px - 18px) / 2);
      }
      video {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: cover;
      }
      .face-overlay {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
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
      body.focus .tile { opacity: 0.45; transform: scale(0.99); }
      body.focus .tile.focused {
        opacity: 1;
        transform: none;
        border-color: #39d98a;
      }
      body.focus .tile.hidden { display: none; }
      body.focus .tile.focused { border-color: #39d98a; }
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
      .signal-loss {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        text-align: center;
        background: rgba(5, 8, 12, 0.86);
        backdrop-filter: blur(3px);
        z-index: 999;
      }
      .signal-loss.show { display: flex; }
      .signal-loss-card {
        border: 1px solid #35506f;
        background: #0f1b2a;
        border-radius: 12px;
        padding: 18px 22px;
        min-width: 280px;
      }
      .signal-title {
        font-size: 18px;
        margin-bottom: 8px;
      }
      .signal-sub {
        color: var(--muted);
        font-size: 13px;
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
        <span class="label">Fill Screen</span>
        <input id="fillScreen" type="checkbox" />
      </div>
      <div class="control">
        <span class="label">Face Detect</span>
        <input id="facedetect" type="checkbox" />
      </div>
      <div class="control">
        <span class="label">Focus View</span>
        <select id="focusMode">
          <option value="all">all</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="4">4</option>
        </select>
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
    <div id="signalLoss" class="signal-loss">
      <div class="signal-loss-card">
        <div class="signal-title">Signal Lost</div>
        <div class="signal-sub">Attempting reconnect. This view will refresh when the server is back.</div>
      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
    <script>
      const cameras = ${camerasJson};
      const grid = document.getElementById("grid");
      const hoverAudioEl = document.getElementById("hoverAudio");
      const fillScreenEl = document.getElementById("fillScreen");
      const faceDetectEl = document.getElementById("facedetect");
      const focusModeEl = document.getElementById("focusMode");
      const audioArmBtn = document.getElementById("audioArmBtn");
      const audioStatus = document.getElementById("audioStatus");
      const rateEl = document.getElementById("rate");
      const catchupEl = document.getElementById("catchup");
      const signalLossEl = document.getElementById("signalLoss");

      const sessions = [];
      let activeAudioCameraId = null;
      let audioArmed = false;
      let focusedCameraId = null;
      let focusOrder = [];
      const motionThreshold = 12;
      const frameWidth = 80;
      const frameHeight = 45;
      const hasFaceDetector = typeof window.FaceDetector !== "undefined";
      const faceDetector = hasFaceDetector
        ? new window.FaceDetector({ fastMode: true, maxDetectedFaces: 6 })
        : null;
      let wasServerOffline = false;

      if (!hasFaceDetector) {
        faceDetectEl.disabled = true;
      }

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

      function setFocusedCamera(cameraId) {
        focusedCameraId = cameraId;
      }

      function showSignalLoss(show) {
        signalLossEl.classList.toggle("show", show);
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

      async function checkServerOnline() {
        try {
          const r = await fetch("/healthz", { cache: "no-store" });
          return r.ok;
        } catch (_e) {
          return false;
        }
      }

      function applyFocusMode() {
        const mode = focusModeEl.value;
        if (mode === "all") {
          document.body.classList.remove("focus");
          focusOrder = [];
          for (const s of sessions) {
            s.tile.classList.remove("hidden");
            s.tile.classList.remove("focused");
            s.tile.style.order = "";
          }
          return;
        }

        const count = Number(mode);
        if (!Number.isFinite(count) || count <= 0) {
          return;
        }
        const sorted = [...sessions].sort((a, b) => b.motionScore - a.motionScore);
        const top = sorted.slice(0, count).map((s) => s.camera.id);
        const nextSet = new Set(top);
        const currentSet = new Set(focusOrder);
        const sameMembers =
          focusOrder.length === top.length &&
          [...nextSet].every((id) => currentSet.has(id));
        const orderedIds = sameMembers ? focusOrder : top;
        focusOrder = orderedIds;
        const topIds = new Set(orderedIds);
        document.body.classList.add("focus");

        for (const s of sessions) {
          const inTop = topIds.has(s.camera.id);
          s.tile.classList.toggle("hidden", !inTop);
          s.tile.classList.toggle("focused", inTop);
          s.tile.style.order = inTop ? String(orderedIds.indexOf(s.camera.id)) : "";
        }
      }

      function analyzeMotion(session) {
        if (!session.canvasCtx || session.video.readyState < 2) {
          return;
        }
        const ctx = session.canvasCtx;
        ctx.drawImage(session.video, 0, 0, frameWidth, frameHeight);
        const data = ctx.getImageData(0, 0, frameWidth, frameHeight).data;
        const gray = new Uint8Array(frameWidth * frameHeight);
        for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
          gray[j] = (data[i] * 3 + data[i + 1] * 4 + data[i + 2]) >> 3;
        }
        if (session.prevGray) {
          let diff = 0;
          for (let i = 0; i < gray.length; i += 1) {
            diff += Math.abs(gray[i] - session.prevGray[i]);
          }
          session.motionScore = diff / gray.length;
          session.motionEl.textContent = "M " + session.motionScore.toFixed(1);
        }
        session.prevGray = gray;
      }

      async function analyzeFaces(session) {
        if (!faceDetector || !faceDetectEl.checked || session.video.readyState < 2) {
          session.faceEl.textContent = "F -";
          session.lastFaces = [];
          drawFaceBoxes(session);
          return;
        }
        const now = Date.now();
        if (now - session.lastFaceAt < 1200) {
          return;
        }
        session.lastFaceAt = now;
        try {
          const faces = await faceDetector.detect(session.video);
          session.faceCount = faces.length;
          session.lastFaces = faces;
          session.faceEl.textContent = "F " + String(faces.length);
          drawFaceBoxes(session);
        } catch (_e) {
          session.faceEl.textContent = "F ?";
          session.lastFaces = [];
          drawFaceBoxes(session);
        }
      }

      function drawFaceBoxes(session) {
        const canvas = session.faceCanvas;
        const ctx = session.faceCtx;
        if (!canvas || !ctx) {
          return;
        }
        const w = session.video.clientWidth || 0;
        const h = session.video.clientHeight || 0;
        if (w <= 0 || h <= 0) {
          return;
        }
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!faceDetectEl.checked || !Array.isArray(session.lastFaces) || session.lastFaces.length === 0) {
          return;
        }

        const vw = session.video.videoWidth || w;
        const vh = session.video.videoHeight || h;
        const sx = canvas.width / vw;
        const sy = canvas.height / vh;

        ctx.strokeStyle = "#f4b740";
        ctx.fillStyle = "rgba(244,183,64,0.15)";
        ctx.lineWidth = 2;

        for (const face of session.lastFaces) {
          const box = face.boundingBox;
          if (!box) {
            continue;
          }
          const x = box.x * sx;
          const y = box.y * sy;
          const bw = box.width * sx;
          const bh = box.height * sy;
          ctx.fillRect(x, y, bw, bh);
          ctx.strokeRect(x, y, bw, bh);
        }
      }

      for (const camera of cameras) {
        const tile = document.createElement("section");
        tile.className = "tile";
        tile.innerHTML = \`
          <div class="tile-head">
            <div>\${camera.name}</div>
            <div class="meta">
              <span class="motion">M 0.0</span>
              <span class="faces">F -</span>
              <span class="latency live">live</span>
            </div>
          </div>
          <div class="video-wrap">
            <video autoplay muted playsinline controls></video>
            <canvas class="face-overlay"></canvas>
            <div class="hint">hover to unmute</div>
          </div>
        \`;
        grid.appendChild(tile);

        const video = tile.querySelector("video");
        const faceCanvas = tile.querySelector(".face-overlay");
        const latencyEl = tile.querySelector(".latency");
        const motionEl = tile.querySelector(".motion");
        const faceEl = tile.querySelector(".faces");
        const hls = attachStream(video, camera.url, latencyEl);
        const canvas = document.createElement("canvas");
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        const session = {
          camera,
          tile,
          video,
          hls,
          latencyEl,
          motionEl,
          faceEl,
          faceCanvas,
          faceCtx: faceCanvas.getContext("2d"),
          canvasCtx: canvas.getContext("2d", { willReadFrequently: true }),
          prevGray: null,
          motionScore: 0,
          faceCount: 0,
          lastFaceAt: 0,
          lastFaces: []
        };
        sessions.push(session);

        video.addEventListener("loadedmetadata", () => {
          applyBasePlaybackRate();
          video.play().catch(() => {});
          drawFaceBoxes(session);
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
      fillScreenEl.addEventListener("change", () => {
        document.body.classList.toggle("fill", fillScreenEl.checked);
      });
      focusModeEl.addEventListener("change", applyFocusMode);

      document.addEventListener("visibilitychange", () => {
        for (const s of sessions) {
          if (!document.hidden) {
            s.video.play().catch(() => {});
          }
        }
      });

      setInterval(() => {
        for (const s of sessions) {
          analyzeMotion(s);
          analyzeFaces(s);
        }
        let best = null;
        for (const s of sessions) {
          if (!best || s.motionScore > best.motionScore) {
            best = s;
          }
        }
        if (!best || best.motionScore < motionThreshold) {
          applyFocusMode();
        } else {
          if (focusedCameraId !== best.camera.id) {
            setFocusedCamera(best.camera.id);
          }
          applyFocusMode();
        }
      }, 500);

      setInterval(async () => {
        const online = await checkServerOnline();
        if (!online) {
          wasServerOffline = true;
          showSignalLoss(true);
          return;
        }
        if (wasServerOffline) {
          location.reload();
        }
      }, 2000);
    </script>
  </body>
</html>`);
  });

  app.post(
    "/smarthome",
    createSmartHomeHandler({
      config,
      logger: log,
      streamManager,
      oauthStore
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
