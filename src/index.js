const fs = require("fs");
const https = require("https");
const path = require("path");
const express = require("express");
const morgan = require("morgan");
const { createGoogleSignIn } = require("./google-signin");
const {
  loadConfig,
  loadSettingsDocument,
  reloadIntoConfig,
  saveSettingsDocument
} = require("./config");
const { StreamManager, redactRtsp } = require("./stream-manager");
const { createSmartHomeHandler } = require("./google-smart-home");
const { OAuthStore } = require("./oauth-store");
const {
  VivintClient,
  VivintMfaRequiredError,
  collectVivintCameraRecords,
  mergeCameraRecords
} = require("./vivint-refresh");

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

function buildStreamUrl(config, cameraId) {
  const pathname = `/stream/${encodeURIComponent(String(cameraId))}/index.m3u8`;
  if (!config.streamToken) {
    return pathname;
  }
  return `${pathname}?token=${encodeURIComponent(config.streamToken)}`;
}

function invalidTokenPage(cameraId) {
  const cameraPath = cameraId
    ? `/camera/${encodeURIComponent(String(cameraId))}`
    : "/";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Invalid Stream Token</title>
    <style>
      :root {
        --bg: #0b0f14;
        --panel: #111923;
        --text: #dbe7f5;
        --muted: #90a4bf;
        --line: #233246;
        --warn: #f4b740;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at 15% 10%, #172130 0%, var(--bg) 45%);
        color: var(--text);
        font-family: "Segoe UI", Tahoma, sans-serif;
      }
      .card {
        width: min(520px, 92vw);
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #0e1621 0%, #0a1119 100%);
        border-radius: 14px;
        padding: 20px;
      }
      h1 { margin: 0 0 10px; font-size: 22px; }
      p { color: var(--muted); line-height: 1.5; }
      .pill {
        display: inline-block;
        color: var(--warn);
        background: rgba(244,183,64,0.12);
        border: 1px solid rgba(244,183,64,0.25);
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 12px;
        font-weight: 700;
      }
      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 16px;
      }
      a {
        color: #dbe7f5;
        background: #12314d;
        border: 1px solid #2e5477;
        border-radius: 8px;
        text-decoration: none;
        padding: 10px 12px;
      }
    </style>
  </head>
  <body>
    <section class="card">
      <div class="pill">Invalid token</div>
      <h1>Stream access requires the bridge token</h1>
      <p>This is the bridge's local stream guard, not your Vivint account login. Open the security view or the single-camera viewer so the correct signed stream URL is used.</p>
      <div class="actions">
        <a href="${cameraPath}">Open Camera View</a>
        <a href="/security">Open Security View</a>
        <a href="/">Back Home</a>
      </div>
    </section>
  </body>
</html>`;
}

function isLoopbackAddress(ip) {
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip === "::ffff:127.0.0.1"
  );
}

function localOnly(req, res, next) {
  if (isLoopbackAddress(req.ip)) {
    return next();
  }
  return res.status(403).json({
    error: "forbidden",
    message: "This endpoint is only available from localhost."
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
  const googleSignIn = createGoogleSignIn({ config, logger: log });
  const pendingVivintRefreshes = new Map();
  await streamManager.init();

  function prunePendingVivintRefreshes() {
    const now = Date.now();
    for (const [id, entry] of pendingVivintRefreshes.entries()) {
      if (entry.expiresAt <= now) {
        pendingVivintRefreshes.delete(id);
      }
    }
  }

  function createPendingVivintRefresh(username, client) {
    prunePendingVivintRefreshes();
    const id = `vr_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    pendingVivintRefreshes.set(id, {
      client,
      username,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    return id;
  }

  function consumePendingVivintRefresh(id) {
    prunePendingVivintRefreshes();
    const entry = pendingVivintRefreshes.get(id) || null;
    if (entry) {
      pendingVivintRefreshes.delete(id);
    }
    return entry;
  }

  function cameraFingerprint(cameras) {
    return JSON.stringify(cameras.map((camera) => [camera.id, camera.name, camera.rtspUrl]));
  }

  async function restartStreamsFromSettings() {
    streamManager.stopAll();
    reloadIntoConfig(config);
    await streamManager.init();
    if (config.keepalive) {
      await streamManager.startAll();
    }
  }

  async function applyRefreshedCameraDocument(document, cameras) {
    const next = {
      ...(document || {}),
      cameras: mergeCameraRecords(document?.cameras, cameras)
    };
    const savedPath = saveSettingsDocument(next);
    await restartStreamsFromSettings();
    return {
      ok: true,
      updatedSettingsPath: savedPath,
      cameraCount: cameras.length,
      cameraIds: cameras.map((camera) => camera.camera_id)
    };
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  // Keep stream tokens and OAuth codes out of request logs.
  morgan.token("safe-url", (req) =>
    String(req.originalUrl || req.url).replace(
      /([?&](?:token|code|state|access_token)=)[^&]*/gi,
      "$1***"
    )
  );
  app.use(
    morgan(":method :safe-url :status :response-time ms - :res[content-length]")
  );

  if (!config.googleHomeRoutesEnabled) {
    // LAN mode: the Google Smart Home bridge and its OAuth server are not served at all.
    app.use((req, res, next) => {
      if (/^\/(smarthome|oauth|google)(\/|$)/.test(req.path)) {
        return res.status(404).send("Not found");
      }
      return next();
    });
  }

  app.use(googleSignIn.middleware);
  googleSignIn.register(app);

  function settingsUpdatedAt() {
    try {
      return new Date(fs.statSync(config.settingsPath).mtimeMs).toISOString();
    } catch {
      return null;
    }
  }

  // The panel RTSP credential carries no expiry. It is judged by whether the panel accepts it.
  function healthSummary() {
    const cameras = streamManager.health();
    const live = cameras.filter((camera) => camera.status === "live").length;
    const attempted = cameras.filter((camera) => camera.status !== "idle");
    const rejected = attempted.filter((camera) => camera.lastFailure === "auth_failed");
    let credentialState = "unknown";
    if (live > 0) {
      credentialState = "accepted";
    } else if (attempted.length > 0 && rejected.length === attempted.length) {
      credentialState = "rejected";
    }
    if (live > 0) {
      lastCredentialAcceptedAt = new Date().toISOString();
    }
    return {
      ok: true,
      appMode: config.appMode,
      keepalive: config.keepalive,
      signInRequired: googleSignIn.enabled,
      googleHomeRoutes: config.googleHomeRoutesEnabled,
      googleOAuthConfigured: config.googleHomeRoutesEnabled ? oauthStore.isConfigured() : false,
      camerasLive: live,
      camerasTotal: cameras.length,
      credential: {
        kind: "panel-rtsp",
        expiresAt: null,
        expiryNote: "The panel issues no expiry; a rejected credential shows as auth_failed on every camera.",
        state: credentialState,
        needsRefresh: credentialState === "rejected",
        lastAcceptedAt: lastCredentialAcceptedAt,
        settingsUpdatedAt: settingsUpdatedAt()
      },
      cameras
    };
  }

  let lastCredentialAcceptedAt = null;

  app.get("/healthz", (req, res) => {
    // Always 200 so a dead camera never restarts the pod; read the body for camera state.
    res.json(healthSummary());
  });

  app.get("/health", (req, res) => {
    const summary = healthSummary();
    const when = (value) => (value ? escapeHtml(value.replace("T", " ").replace(/\..*$/, "Z")) : "-");
    const rows = summary.cameras
      .map(
        (camera) => `<tr class="${escapeHtml(camera.status)}">
          <td>${escapeHtml(camera.id)}</td>
          <td>${escapeHtml(camera.name)}</td>
          <td><span class="badge">${escapeHtml(camera.status)}</span></td>
          <td>${when(camera.lastSegmentAt)}</td>
          <td>${escapeHtml(camera.lastFailure || "-")}<br><small>${when(camera.lastFailureAt)}</small></td>
          <td>${escapeHtml(String(camera.restarts))}</td>
          <td>${when(camera.nextRetryAt)}</td>
        </tr>`
      )
      .join("");
    const credential = summary.credential;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="15" />
    <title>Camera Health</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #0b0f14; color: #e6edf3; margin: 0; padding: 16px; }
      h1 { font-size: 1.3rem; }
      .card { background: #111923; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; }
      .table-wrap { overflow-x: auto; }
      table { border-collapse: collapse; width: 100%; min-width: 640px; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #22303f; vertical-align: top; }
      small { color: #8b98a5; }
      .badge { padding: 2px 8px; border-radius: 999px; background: #22303f; }
      tr.live .badge { background: #1f6f43; }
      tr.starting .badge { background: #6b5b1a; }
      tr.backoff .badge, tr.down .badge { background: #7a2630; }
      .warn { color: #ff9b9b; font-weight: 600; }
      a { color: #6cb6ff; }
    </style>
  </head>
  <body>
    <h1>Camera health</h1>
    <div class="card">
      <div>${summary.camerasLive} of ${summary.camerasTotal} cameras live. Mode ${escapeHtml(summary.appMode)}, keepalive ${summary.keepalive ? "on" : "off"}, sign-in ${summary.signInRequired ? "required" : "off"}.</div>
      <div>Panel credential: <strong class="${credential.needsRefresh ? "warn" : ""}">${escapeHtml(credential.state)}</strong>${credential.needsRefresh ? " - run the Vivint refresh" : ""}. Last accepted ${when(credential.lastAcceptedAt)}. Settings updated ${when(credential.settingsUpdatedAt)}.</div>
      <div><small>${escapeHtml(credential.expiryNote)}</small></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Camera</th><th>State</th><th>Last segment</th><th>Last failure</th><th>Restarts</th><th>Next retry</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p><a href="/security">Security view</a> · <a href="/healthz">JSON</a></p>
  </body>
</html>`);
  });

  app.get("/", (req, res) => {
    if (!config.enableRootIndex) {
      return res.status(404).send("Not found");
    }

    const list = config.cameras
      .map(
        (camera) =>
          `<article class="camera-card">
            <div class="camera-title">${escapeHtml(camera.name)}</div>
            <div class="camera-meta">Camera ${escapeHtml(camera.id)}</div>
            <div class="camera-actions">
              <a href="/camera/${encodeURIComponent(camera.id)}">Open Camera</a>
              <a href="${buildStreamUrl(config, camera.id)}">Playlist</a>
            </div>
          </article>`
      )
      .join("");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vivint Bridge</title>
    <style>
      :root {
        --bg: #0b0f14;
        --panel: #111923;
        --text: #dbe7f5;
        --muted: #90a4bf;
        --line: #233246;
        --accent: #39d98a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(circle at 15% 10%, #172130 0%, var(--bg) 45%);
        color: var(--text);
        font-family: "Segoe UI", Tahoma, sans-serif;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 24px 16px 32px;
      }
      .hero {
        display: grid;
        grid-template-columns: 1.3fr 1fr;
        gap: 16px;
        margin-bottom: 18px;
      }
      .panel {
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #0e1621 0%, #0a1119 100%);
        border-radius: 14px;
        padding: 18px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 30px;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }
      .actions, .quick-links {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 14px;
      }
      a {
        color: #dbe7f5;
        background: #12314d;
        border: 1px solid #2e5477;
        border-radius: 8px;
        text-decoration: none;
        padding: 10px 12px;
      }
      .accent {
        color: #072013;
        background: var(--accent);
        border-color: rgba(57,217,138,0.3);
      }
      .camera-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 12px;
      }
      .camera-card {
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #0e1621 0%, #0a1119 100%);
        border-radius: 12px;
        padding: 14px;
      }
      .camera-title {
        font-weight: 700;
        margin-bottom: 6px;
      }
      .camera-meta {
        color: var(--muted);
        font-size: 13px;
        margin-bottom: 12px;
      }
      .camera-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .stat {
        color: var(--accent);
        font-size: 26px;
        font-weight: 800;
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      @media (max-width: 860px) {
        .hero {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="panel">
          <h1>Vivint Security Bridge</h1>
          <p>Local security wall, single-camera viewers, and Google-facing stream proxy on one surface. Use the security wall to refresh expired Vivint camera URLs without editing settings.json manually.</p>
          <div class="actions">
            <a class="accent" href="/security">Open Security View</a>
            <a href="/google/setup">Google Setup</a>
          </div>
        </div>
        <div class="panel">
          <div class="label">Cameras</div>
          <div class="stat">${config.cameras.length}</div>
          <div class="quick-links">
            <a href="/healthz">Health</a>
            <a href="/oauth/authorize?client_id=demo-client&redirect_uri=http://localhost/callback&response_type=code&state=demo">OAuth Demo</a>
          </div>
        </div>
      </section>
      <section class="camera-grid">${list}</section>
    </main>
  </body>
</html>`);
  });

  app.get("/camera/:cameraId", (req, res) => {
    const camera = config.cameras.find((item) => item.id === req.params.cameraId);
    if (!camera) {
      return res.status(404).send("Camera not found");
    }
    const streamUrl = buildStreamUrl(config, camera.id);
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(camera.name)}</title>
    <style>
      :root {
        --bg: #0b0f14;
        --panel: #111923;
        --text: #dbe7f5;
        --muted: #90a4bf;
        --line: #233246;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(circle at 15% 10%, #172130 0%, var(--bg) 45%);
        color: var(--text);
        font-family: "Segoe UI", Tahoma, sans-serif;
      }
      main { max-width: 1100px; margin: 0 auto; padding: 18px; }
      .topbar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-bottom: 14px;
      }
      a {
        color: #dbe7f5;
        background: #12314d;
        border: 1px solid #2e5477;
        border-radius: 8px;
        text-decoration: none;
        padding: 10px 12px;
      }
      .stage {
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #0e1621 0%, #0a1119 100%);
        border-radius: 14px;
        overflow: hidden;
      }
      .meta {
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
      }
      .meta h1 { margin: 0 0 6px; font-size: 24px; }
      .meta p { margin: 0; color: var(--muted); }
      video {
        display: block;
        width: 100%;
        background: #000;
        aspect-ratio: 16 / 9;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="topbar">
        <div>
          <a href="/">Home</a>
          <a href="/security">Security View</a>
        </div>
      </div>
      <section class="stage">
        <div class="meta">
          <h1>${escapeHtml(camera.name)}</h1>
          <p>Camera ${escapeHtml(camera.id)}</p>
        </div>
        <video id="video" controls autoplay muted playsinline></video>
      </section>
    </main>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
    <script>
      const streamUrl = ${JSON.stringify(streamUrl)};
      const video = document.getElementById("video");
      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: true,
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 3
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
      } else {
        video.src = streamUrl;
      }
    </script>
  </body>
</html>`);
  });

  app.get("/google/setup", (req, res) => {
    const redirectProd = `https://oauth-redirect.googleusercontent.com/r/${config.googleProjectId}`;
    const redirectSandbox = `https://oauth-redirect-sandbox.googleusercontent.com/r/${config.googleProjectId}`;
    const publicBaseUrl = config.baseUrl;
    const oauthConfigured = oauthStore.isConfigured();
    const isHttps = /^https:\/\//i.test(publicBaseUrl);
    const isLocalBaseUrl = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(
      publicBaseUrl
    );
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
      <p>Use this page to verify the bridge's Google-facing configuration. For Google Home, the base URL must be a public HTTPS host that Google can reach.</p>

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
            <li>Base URL is not localhost: <span class="status ${!isLocalBaseUrl ? "ok" : "bad"}">${htmlBool(!isLocalBaseUrl)}</span></li>
            <li>OAuth client configured in app: <span class="status ${clientConfigured ? "ok" : "bad"}">${htmlBool(clientConfigured)}</span></li>
            <li>Local bridge login configured: <span class="status ${oauthConfigured ? "ok" : "bad"}">${htmlBool(oauthConfigured)}</span></li>
          </ul>
          ${
            isLocalBaseUrl
              ? `<div class="status bad" style="margin-top:12px">Localhost cannot be used for Google Home account linking.</div>`
              : ""
          }
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
          <h2>App Config Status</h2>
          <pre>GOOGLE_PROJECT_ID=${escapeHtml(config.googleProjectId)}
GOOGLE_CLIENT_ID=${config.googleClientId ? "[configured]" : "[missing]"}
GOOGLE_CLIENT_SECRET=${config.googleClientSecret ? "[configured]" : "[missing]"}
GOOGLE_AUTH_USER=${config.googleAuthUser ? "[configured]" : "[missing]"}
GOOGLE_AUTH_PASS=${config.googleAuthPass ? "[configured]" : "[missing]"}
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
        url: buildStreamUrl(config, camera.id)
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
      <div class="control">
        <button id="refreshVivintBtn">Refresh Vivint</button>
        <span id="refreshStatus" class="label">refresh expired camera URLs</span>
      </div>
    </div>
    <div id="grid" class="grid"></div>
    <div id="signalLoss" class="signal-loss">
      <div class="signal-loss-card">
        <div class="signal-title">Signal Lost</div>
        <div class="signal-sub">Attempting reconnect. This view will refresh when the server is back.</div>
      </div>
    </div>
    <div id="refreshModal" class="signal-loss">
      <div class="signal-loss-card" style="min-width: 340px; text-align:left;">
        <div class="signal-title">Refresh Vivint URLs</div>
        <div class="signal-sub" style="margin-bottom: 12px;">Credentials stay local and are only used to update your camera config.</div>
        <form id="refreshForm">
          <label class="label" for="vivintUser">Vivint Username</label>
          <input id="vivintUser" name="username" style="width:100%; margin:6px 0 10px; padding:8px 10px;" autocomplete="username" />
          <label class="label" for="vivintPass">Vivint Password</label>
          <input id="vivintPass" name="password" type="password" style="width:100%; margin:6px 0 10px; padding:8px 10px;" autocomplete="current-password" />
          <div id="mfaWrap" style="display:none;">
            <label class="label" for="vivintMfa">MFA Code</label>
            <input id="vivintMfa" name="mfaCode" style="width:100%; margin:6px 0 10px; padding:8px 10px;" inputmode="numeric" autocomplete="one-time-code" />
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button type="button" id="refreshCancelBtn">Cancel</button>
            <button type="submit" id="refreshSubmitBtn">Refresh</button>
          </div>
        </form>
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
      const refreshVivintBtn = document.getElementById("refreshVivintBtn");
      const refreshStatusEl = document.getElementById("refreshStatus");
      const refreshModal = document.getElementById("refreshModal");
      const refreshForm = document.getElementById("refreshForm");
      const refreshCancelBtn = document.getElementById("refreshCancelBtn");
      const refreshSubmitBtn = document.getElementById("refreshSubmitBtn");
      const mfaWrap = document.getElementById("mfaWrap");
      const vivintMfa = document.getElementById("vivintMfa");
      let pendingRefreshId = null;

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

      function showRefreshModal(show) {
        refreshModal.classList.toggle("show", show);
        if (show) {
          document.getElementById("vivintUser").focus();
        }
      }

      function setRefreshStatus(text) {
        refreshStatusEl.textContent = text;
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
      refreshVivintBtn.addEventListener("click", () => {
        mfaWrap.style.display = "none";
        vivintMfa.value = "";
        pendingRefreshId = null;
        refreshSubmitBtn.textContent = "Refresh";
        setRefreshStatus("waiting for Vivint credentials");
        showRefreshModal(true);
      });
      refreshCancelBtn.addEventListener("click", () => {
        showRefreshModal(false);
        pendingRefreshId = null;
        refreshForm.reset();
        mfaWrap.style.display = "none";
        refreshSubmitBtn.textContent = "Refresh";
        setRefreshStatus("refresh expired camera URLs");
      });
      refreshForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        refreshSubmitBtn.disabled = true;
        setRefreshStatus("refreshing URLs...");
        const form = new FormData(refreshForm);
        const payload = {
          username: String(form.get("username") || "").trim(),
          password: String(form.get("password") || ""),
          mfaCode: String(form.get("mfaCode") || "").trim(),
          pendingId: pendingRefreshId
        };
        try {
          const response = await fetch("/admin/vivint/refresh", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });
          const data = await response.json().catch(() => ({}));
          if (response.status === 409 && data.error === "mfa_required") {
            pendingRefreshId = data.pendingId || null;
            mfaWrap.style.display = "block";
            refreshSubmitBtn.textContent = "Verify Code";
            setRefreshStatus("enter MFA code");
            vivintMfa.focus();
            return;
          }
          if (!response.ok) {
            throw new Error(data.message || data.error || "Refresh failed.");
          }
          pendingRefreshId = null;
          setRefreshStatus("camera URLs refreshed");
          showRefreshModal(false);
          window.location.reload();
        } catch (error) {
          setRefreshStatus(error.message || "Refresh failed.");
        } finally {
          refreshSubmitBtn.disabled = false;
        }
      });

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

  app.post("/admin/vivint/refresh", localOnly, async (req, res) => {
    // Require JSON so a cross-site HTML form cannot trigger this without a CORS preflight.
    if (!req.is("application/json")) {
      return res.status(415).json({
        error: "unsupported_media_type",
        message: "Send the refresh request as application/json."
      });
    }

    const settingsDocument = loadSettingsDocument();
    if (!settingsDocument) {
      return res.status(400).json({
        error: "settings_missing",
        message: "settings.json is required for Vivint refresh."
      });
    }

    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const mfaCode = String(req.body?.mfaCode || "").trim();
    const pendingId = String(req.body?.pendingId || "").trim();

    if (pendingId) {
      const pending = consumePendingVivintRefresh(pendingId);
      if (!pending) {
        return res.status(410).json({
          error: "mfa_session_expired",
          message: "The pending Vivint MFA session expired. Start the refresh again."
        });
      }
      if (!mfaCode) {
        return res.status(400).json({
          error: "missing_mfa_code",
          message: "Vivint MFA code is required."
        });
      }

      try {
        await pending.client.verifyMfa(mfaCode);
        const freshCameras = await collectVivintCameraRecords(pending.client);
        const result = await applyRefreshedCameraDocument(
          settingsDocument,
          freshCameras
        );
        return res.json(result);
      } catch (error) {
        if (error instanceof VivintMfaRequiredError) {
          const nextPendingId = createPendingVivintRefresh(pending.username, pending.client);
          return res.status(409).json({
            error: "mfa_required",
            message: error.message,
            mfaType: error.mfaType,
            pendingId: nextPendingId
          });
        }
        log.error(`Vivint refresh MFA verification failed: ${error.message}`);
        return res.status(502).json({
          error: "vivint_refresh_failed",
          message: error.message
        });
      }
    }

    if (!username || !password) {
      return res.status(400).json({
        error: "missing_credentials",
        message: "Vivint username and password are required."
      });
    }

    const client = new VivintClient({ username, password });
    try {
      await client.connect();
      const freshCameras = await collectVivintCameraRecords(client);
      const result = await applyRefreshedCameraDocument(settingsDocument, freshCameras);
      return res.json(result);
    } catch (error) {
      if (error instanceof VivintMfaRequiredError) {
        const nextPendingId = createPendingVivintRefresh(username, client);
        return res.status(409).json({
          error: "mfa_required",
          message: error.message,
          mfaType: error.mfaType,
          pendingId: nextPendingId
        });
      }
      log.error(`Vivint refresh failed: ${error.message}`);
      return res.status(502).json({
        error: "vivint_refresh_failed",
        message: error.message
      });
    }
  });

  app.get("/stream/:cameraId/index.m3u8", async (req, res) => {
    const { cameraId } = req.params;
    if (config.streamToken && req.query.token !== config.streamToken) {
      const acceptsHtml = String(req.headers.accept || "").includes("text/html");
      if (acceptsHtml) {
        res.status(401).setHeader("content-type", "text/html; charset=utf-8");
        return res.end(invalidTokenPage(cameraId));
      }
      return res.status(401).json({
        error: "invalid_token",
        message: "Invalid stream token.",
        cameraId
      });
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
      const reason = redactRtsp(
        status?.startError?.message ||
          status?.lastStderr ||
          "stream not ready yet"
      );
      return res.status(503).json({
        error: "streamUnavailable",
        cameraId,
        reason
      });
    }

    if (req.query.token) {
      // Carry the token onto segment URLs so token-only clients get past the sign-in gate.
      const playlist = await fs.promises.readFile(streamManager.playlistPath(cameraId), "utf8");
      const suffix = `?token=${encodeURIComponent(String(req.query.token))}`;
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      return res.send(
        playlist.replace(/^(?!#)(\S+\.ts)$/gm, (segment) => `${segment}${suffix}`)
      );
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
    log.info(
      `Mode ${config.appMode}; keepalive ${config.keepalive ? "on" : "off"}; Google sign-in ${googleSignIn.enabled ? "on" : "off"}`
    );
  });

  let httpsServer = null;
  if (config.tls.certFile && config.tls.keyFile) {
    httpsServer = https
      .createServer(
        {
          cert: fs.readFileSync(config.tls.certFile),
          key: fs.readFileSync(config.tls.keyFile)
        },
        app
      )
      .listen(config.tls.port, () => {
        log.info(`HTTPS listening on port ${config.tls.port}`);
      });
  }

  if (config.keepalive) {
    await streamManager.startAll();
  }

  // Pick up settings written outside this process, such as the refresh CLI run with kubectl exec.
  if (fs.existsSync(config.settingsPath)) {
    fs.watchFile(config.settingsPath, { interval: 15000 }, () => {
      let next;
      try {
        next = loadConfig();
      } catch (error) {
        log.error(`settings.json changed but could not be loaded: ${redactRtsp(error.message)}`);
        return;
      }
      if (cameraFingerprint(next.cameras) === cameraFingerprint(config.cameras)) {
        return;
      }
      log.info("settings.json changed; restarting camera streams");
      restartStreamsFromSettings().catch((error) => {
        log.error(`stream restart failed: ${redactRtsp(error.message)}`);
      });
    });
  }

  function shutdown() {
    log.info("Shutting down...");
    fs.unwatchFile(config.settingsPath);
    streamManager.stopAll();
    httpsServer?.close();
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
