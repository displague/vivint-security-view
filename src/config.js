const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const rootDir = path.resolve(__dirname, "..");
const defaultCamerasPath = path.join(rootDir, "cameras.json");
const defaultSettingsPath = path.join(rootDir, "settings.json");
const streamRoot = path.join(rootDir, "streams");

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function selectCameraPath() {
  return process.env.CAMERAS_FILE || defaultCamerasPath;
}

function selectSettingsPath() {
  return process.env.SETTINGS_FILE || defaultSettingsPath;
}

function loadJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadCameras() {
  const camerasPath = selectCameraPath();
  if (!fs.existsSync(camerasPath)) {
    throw new Error(
      `Missing camera config at ${camerasPath}. Copy cameras.example.json to cameras.json and set your camera URLs.`
    );
  }

  const raw = fs.readFileSync(camerasPath, "utf8");
  const parsed = JSON.parse(raw);
  const cameras = Array.isArray(parsed.cameras) ? parsed.cameras : [];
  if (cameras.length === 0) {
    throw new Error("cameras.json contains no cameras.");
  }

  return cameras.map((camera) => {
    if (!camera.id || !camera.name || !camera.rtspUrl) {
      throw new Error(
        "Each camera must include id, name, and rtspUrl fields in cameras.json."
      );
    }
    return {
      id: String(camera.id),
      name: String(camera.name),
      rtspUrl: String(camera.rtspUrl)
    };
  });
}

function pickRtspUrl(camera, sourcePreference) {
  const order =
    sourcePreference === "external"
      ? [
          camera.rtspUrl,
          camera.external_rtsp_hd,
          camera.external_rtsp_sd,
          camera.internal_rtsp_hd,
          camera.direct_rtsp_hd,
          camera.internal_rtsp_sd,
          camera.direct_rtsp_sd
        ]
      : [
          camera.rtspUrl,
          camera.internal_rtsp_hd,
          camera.direct_rtsp_hd,
          camera.internal_rtsp_sd,
          camera.direct_rtsp_sd,
          camera.external_rtsp_hd,
          camera.external_rtsp_sd
        ];
  return (
    order.find(Boolean) ||
    null
  );
}

function normalizeCamera(camera, sourceName, sourcePreference) {
  const id = camera.id ?? camera.camera_id;
  const name = camera.name ?? camera.camera_name;
  const rtspUrl = pickRtspUrl(camera, sourcePreference);

  if (!id || !name || !rtspUrl) {
    throw new Error(
      `Each camera in ${sourceName} must include id/name plus a usable RTSP URL field (rtspUrl, internal_rtsp_hd, direct_rtsp_hd, etc).`
    );
  }

  return {
    id: String(id),
    name: String(name),
    rtspUrl: String(rtspUrl)
  };
}

function loadSettingsJson(sourcePreference) {
  const settingsPath = selectSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return null;
  }
  const parsed = loadJsonFile(settingsPath);
  const cameras = Array.isArray(parsed.cameras) ? parsed.cameras : [];
  if (cameras.length === 0) {
    throw new Error("settings.json contains no cameras.");
  }
  return {
    cameras: cameras.map((camera) =>
      normalizeCamera(camera, "settings.json", sourcePreference)
    ),
    proxy: typeof parsed.proxy === "object" && parsed.proxy ? parsed.proxy : {}
  };
}

function loadConfig() {
  const streamSourcePreference = process.env.STREAM_SOURCE_PREFERENCE || "internal";
  const settings = loadSettingsJson(streamSourcePreference);

  const port = parsePositiveInt(
    settings?.proxy?.port ?? process.env.PORT,
    8080
  );
  const baseUrl =
    settings?.proxy?.baseUrl || process.env.BASE_URL || `http://localhost:${port}`;
  const streamToken = settings?.proxy?.streamToken || process.env.STREAM_TOKEN || "";
  const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
  const hlsSegmentTime = parsePositiveInt(process.env.HLS_SEGMENT_TIME, 1);
  const hlsListSize = parsePositiveInt(process.env.HLS_LIST_SIZE, 3);
  const streamTranscode = parseBoolean(process.env.STREAM_TRANSCODE, true);
  const videoEncoder = process.env.VIDEO_ENCODER || "libx264";
  const videoPreset = process.env.VIDEO_PRESET || "veryfast";
  const googleProjectId = process.env.GOOGLE_PROJECT_ID || "dev-local-project";
  const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const googleAuthUser = process.env.GOOGLE_AUTH_USER || "";
  const googleAuthPass = process.env.GOOGLE_AUTH_PASS || "";
  const googleAgentUserId = process.env.GOOGLE_AGENT_USER_ID || "local-user";
  const enableSecurityView = parseBoolean(process.env.ENABLE_SECURITY_VIEW, true);
  const enableRootIndex = parseBoolean(process.env.ENABLE_ROOT_INDEX, true);
  const appMode = process.env.APP_MODE || "hybrid";
  // lan: home network only. The Google Smart Home and OAuth bridge routes are not served.
  const googleHomeRoutesEnabled = appMode !== "lan";
  const keepalive = parseBoolean(process.env.STREAM_KEEPALIVE, false);
  const rtspTimeoutSeconds = parsePositiveInt(process.env.RTSP_TIMEOUT_SECONDS, 15);
  const googleSignInEnabled = parseBoolean(process.env.GOOGLE_SIGNIN_ENABLED, false);
  const googleSignInAllowedEmails = String(process.env.GOOGLE_SIGNIN_ALLOWED_EMAILS || "")
    .split(/[\s,]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return {
    port,
    baseUrl: baseUrl.replace(/\/$/, ""),
    streamToken,
    ffmpegBin,
    hlsSegmentTime,
    hlsListSize,
    streamTranscode,
    videoEncoder,
    videoPreset,
    googleProjectId,
    googleClientId,
    googleClientSecret,
    googleAuthUser,
    googleAuthPass,
    googleAgentUserId,
    enableSecurityView,
    enableRootIndex,
    appMode,
    googleHomeRoutesEnabled,
    keepalive,
    rtspTimeoutSeconds,
    googleSignIn: {
      enabled: googleSignInEnabled,
      clientId: process.env.GOOGLE_SIGNIN_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_SIGNIN_CLIENT_SECRET || "",
      redirectUrl: process.env.GOOGLE_SIGNIN_REDIRECT_URL || "",
      allowedEmails: googleSignInAllowedEmails,
      sessionSecret: process.env.SESSION_SECRET || "",
      sessionTtlSeconds: parsePositiveInt(process.env.SESSION_TTL_SECONDS, 7 * 24 * 3600)
    },
    tls: {
      certFile: process.env.TLS_CERT_FILE || "",
      keyFile: process.env.TLS_KEY_FILE || "",
      port: parsePositiveInt(process.env.HTTPS_PORT, 8443)
    },
    settingsPath: selectSettingsPath(),
    streamSourcePreference,
    streamRoot,
    cameras: settings?.cameras || loadCameras()
  };
}

function loadSettingsDocument() {
  const settingsPath = selectSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return null;
  }
  return loadJsonFile(settingsPath);
}

function saveSettingsDocument(document) {
  const settingsPath = selectSettingsPath();
  fs.writeFileSync(settingsPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return settingsPath;
}

function reloadIntoConfig(target) {
  const next = loadConfig();
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
  return target;
}

module.exports = {
  loadConfig,
  loadSettingsDocument,
  reloadIntoConfig,
  saveSettingsDocument,
  selectSettingsPath
};
