const crypto = require("crypto");

const AUTH_ENDPOINT = "https://id.vivint.com";
const API_ENDPOINT = "https://www.vivintsky.com/api";
const CLIENT_ID = "ios";
const REDIRECT_URI = "vivint://app/oauth_redirect";
const CAMERA_SKIP_DIRECT_TYPES = new Set(["alpha_cs6022_camera_device"]);

class VivintMfaRequiredError extends Error {
  constructor(message, mfaType) {
    super(message || "Multi-factor authentication required");
    this.name = "VivintMfaRequiredError";
    this.code = "mfa_required";
    this.mfaType = mfaType || "code";
  }
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  setFromHeaders(headers) {
    const values =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie")]
          : [];
    for (const value of values) {
      if (!value) {
        continue;
      }
      const firstPart = value.split(";")[0];
      const separator = firstPart.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const name = firstPart.slice(0, separator).trim();
      const cookieValue = firstPart.slice(separator + 1).trim();
      this.cookies.set(name, cookieValue);
    }
  }

  toHeader() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function generateState() {
  return crypto.randomBytes(40).toString("base64url");
}

function generateCodeChallenge() {
  const verifier = crypto
    .randomBytes(40)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");
  return {
    verifier,
    challenge
  };
}

function withQuery(url, params) {
  const target = new URL(url);
  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

function parseResponseBody(contentType, text) {
  if (/application\/json/i.test(contentType || "")) {
    return text ? JSON.parse(text) : null;
  }
  return text;
}

function isCameraDevice(device) {
  if (!device || typeof device !== "object") {
    return false;
  }
  const type = String(device.t || "");
  const actualType = String(device.act || "");
  return type === "camera_device" || actualType.includes("camera_device");
}

function normalizeRtspUrl(url, username, password) {
  if (!url || typeof url !== "string") {
    return null;
  }
  if (!username || !password) {
    return null;
  }
  if (!url.startsWith("rtsp://")) {
    return null;
  }
  return `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${url.slice(7)}`;
}

function buildDirectRtsp(device, hd) {
  if (!device.cda) {
    return null;
  }
  if (CAMERA_SKIP_DIRECT_TYPES.has(String(device.act || ""))) {
    return null;
  }
  const path = hd ? device.cdp : device.cdps;
  if (!path || !device.un || !device.pswd || !device.caip || !device.cap) {
    return null;
  }
  return `rtsp://${encodeURIComponent(String(device.un))}:${encodeURIComponent(
    String(device.pswd)
  )}@${device.caip}:${device.cap}/${path}`;
}

function firstUrl(value) {
  if (Array.isArray(value) && value.length > 0 && value[0]) {
    return String(value[0]);
  }
  if (typeof value === "string" && value) {
    return value;
  }
  return null;
}

function buildPanelRtsp(device, credentials, type, hd) {
  const username = credentials?.n;
  const password = credentials?.pswd;
  const key = type === "internal" ? (hd ? "ciu" : "cius") : hd ? "ceu" : "ceus";
  const fallbackKey =
    type === "external" && !hd
      ? "cetus"
      : null;
  const source = firstUrl(device[key]) || (fallbackKey ? firstUrl(device[fallbackKey]) : null);
  return normalizeRtspUrl(source, username, password);
}

function buildCameraRecord(systemId, panelId, partitionId, device, credentials) {
  return {
    system_id: systemId,
    panel_id: panelId,
    partition_id: partitionId,
    camera_name: device.n || `Camera ${device._id}`,
    camera_id: device._id,
    camera_ip: device.caip || null,
    direct_rtsp_hd: buildDirectRtsp(device, true),
    direct_rtsp_sd: buildDirectRtsp(device, false),
    internal_rtsp_hd: buildPanelRtsp(device, credentials, "internal", true),
    internal_rtsp_sd: buildPanelRtsp(device, credentials, "internal", false),
    external_rtsp_hd: buildPanelRtsp(device, credentials, "external", true),
    external_rtsp_sd: buildPanelRtsp(device, credentials, "external", false)
  };
}

function mergeCameraRecords(existing, fresh) {
  const byId = new Map(
    (Array.isArray(existing) ? existing : []).map((camera) => [
      String(camera.camera_id ?? camera.id),
      camera
    ])
  );

  return fresh.map((camera) => {
    const current = byId.get(String(camera.camera_id));
    if (!current) {
      return camera;
    }
    return {
      ...current,
      ...camera
    };
  });
}

class VivintClient {
  constructor({ username, password }) {
    this.username = username;
    this.password = password;
    this.cookies = new CookieJar();
    this.codeVerifier = null;
    this.tokens = null;
    this.mfaType = "code";
  }

  async request(url, options = {}) {
    const {
      method = "GET",
      headers = {},
      params,
      body,
      allowRedirects = true,
      includeAuth = false
    } = options;

    const finalHeaders = {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      ...headers
    };
    const cookieHeader = this.cookies.toHeader();
    if (cookieHeader) {
      finalHeaders.Cookie = cookieHeader;
    }
    if (includeAuth && this.tokens?.access_token) {
      finalHeaders.Authorization = `Bearer ${this.tokens.access_token}`;
    }

    const response = await fetch(withQuery(url, params), {
      method,
      headers: finalHeaders,
      body,
      redirect: allowRedirects ? "follow" : "manual"
    });

    this.cookies.setFromHeaders(response.headers);
    const text = await response.text();
    const data = parseResponseBody(response.headers.get("content-type"), text);
    return {
      status: response.status,
      ok: response.ok,
      data,
      location: response.headers.get("location"),
      headers: response.headers
    };
  }

  async connect() {
    const state = generateState();
    const { verifier, challenge } = generateCodeChallenge();
    this.codeVerifier = verifier;

    const authResponse = await this.request(`${AUTH_ENDPOINT}/oauth2/auth`, {
      allowRedirects: false,
      params: {
        response_type: "code",
        client_id: CLIENT_ID,
        scope: "openid email devices email_verified",
        redirect_uri: REDIRECT_URI,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256"
      }
    });

    if (authResponse.location && authResponse.location.startsWith(REDIRECT_URI)) {
      const authCode = new URL(authResponse.location).searchParams.get("code");
      if (!authCode) {
        throw new Error("Vivint auth redirect did not include an authorization code.");
      }
      await this.exchangeAuthCode(authCode);
      return;
    }

    const loginResponse = await this.request(`${AUTH_ENDPOINT}/idp/api/submit`, {
      method: "POST",
      params: { client_id: CLIENT_ID },
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: this.username,
        password: this.password
      })
    });

    if (loginResponse.status >= 400) {
      const message =
        loginResponse.data?.msg ||
        loginResponse.data?.message ||
        loginResponse.data?.error_description ||
        loginResponse.data?.error ||
        "Vivint authentication failed.";
      throw new Error(message);
    }

    if (loginResponse.data && typeof loginResponse.data === "object") {
      if (loginResponse.data.validate) {
        this.mfaType = "code";
        throw new VivintMfaRequiredError(
          "Vivint requires a verification code.",
          this.mfaType
        );
      }
      if (loginResponse.data.mfa) {
        this.mfaType = "mfa";
        throw new VivintMfaRequiredError(
          "Vivint requires an authenticator code.",
          this.mfaType
        );
      }
      this.tokens = loginResponse.data;
      return;
    }

    throw new Error("Unexpected Vivint login response.");
  }

  async verifyMfa(code) {
    if (!code) {
      throw new VivintMfaRequiredError("Vivint MFA code required.", this.mfaType);
    }
    const response = await this.request(
      `${AUTH_ENDPOINT}/idp/api/${this.mfaType === "code" ? "validate" : "submit"}`,
      {
        method: "POST",
        params: { client_id: CLIENT_ID },
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          [this.mfaType]: code,
          username: this.username,
          password: this.password
        })
      }
    );

    if (response.status >= 400) {
      const message =
        response.data?.message ||
        response.data?.msg ||
        response.data?.error ||
        "Vivint MFA verification failed.";
      throw new Error(message);
    }

    if (!response.data?.url) {
      throw new Error("Vivint MFA verification did not return a continuation URL.");
    }

    const continuation = await this.request(`${AUTH_ENDPOINT}${response.data.url}`, {
      allowRedirects: false
    });
    if (!continuation.location) {
      throw new Error("Vivint MFA continuation did not redirect to an auth code.");
    }
    const authCode = new URL(continuation.location).searchParams.get("code");
    if (!authCode) {
      throw new Error("Vivint MFA continuation did not include an authorization code.");
    }
    await this.exchangeAuthCode(authCode);
  }

  async exchangeAuthCode(code) {
    const response = await this.request(`${AUTH_ENDPOINT}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code,
        code_verifier: this.codeVerifier || ""
      }).toString()
    });
    if (response.status >= 400 || !response.data?.access_token) {
      const message =
        response.data?.error_description ||
        response.data?.error ||
        "Vivint token exchange failed.";
      throw new Error(message);
    }
    this.tokens = response.data;
  }

  async getAuthUserData() {
    const response = await this.request(`${API_ENDPOINT}/authuser`, {
      includeAuth: true
    });
    if (response.status >= 400 || !response.data) {
      throw new Error("Unable to load Vivint authuser data.");
    }
    return response.data;
  }

  async getPanelCredentials(panelId) {
    const response = await this.request(`${API_ENDPOINT}/panel-login/${panelId}`, {
      includeAuth: true
    });
    if (response.status >= 400 || !response.data) {
      throw new Error(`Unable to load panel credentials for panel ${panelId}.`);
    }
    return response.data;
  }

  async getSystemData(panelId) {
    const response = await this.request(`${API_ENDPOINT}/systems/${panelId}`, {
      includeAuth: true,
      params: {
        includerules: "false"
      }
    });
    if (response.status >= 400 || !response.data) {
      throw new Error(`Unable to load system data for panel ${panelId}.`);
    }
    return response.data;
  }
}

async function collectVivintCameraRecords(client) {
  const authUser = await client.getAuthUserData();
  const systems = authUser?.u?.system;
  if (!Array.isArray(systems) || systems.length === 0) {
    throw new Error("Vivint returned no systems for this account.");
  }

  const cameras = [];
  for (const summary of systems) {
    const panelId = summary?.panid;
    if (!panelId) {
      continue;
    }
    const credentials = await client.getPanelCredentials(panelId);
    const systemData = await client.getSystemData(panelId);
    const partitions = systemData?.system?.par;
    if (!Array.isArray(partitions)) {
      continue;
    }

    for (const partition of partitions) {
      const partitionId = partition?.parid ?? 1;
      const devices = Array.isArray(partition?.d) ? partition.d : [];
      for (const device of devices) {
        if (!isCameraDevice(device)) {
          continue;
        }
        cameras.push(
          buildCameraRecord(
            systemData?.system?.panid ?? panelId,
            panelId,
            partitionId,
            device,
            credentials
          )
        );
      }
    }
  }

  if (cameras.length === 0) {
    throw new Error("Vivint returned no camera devices for this account.");
  }

  return cameras;
}

async function fetchVivintCameraRecords({ username, password, mfaCode }) {
  const client = new VivintClient({ username, password });
  try {
    await client.connect();
  } catch (error) {
    if (error instanceof VivintMfaRequiredError) {
      if (!mfaCode) {
        throw error;
      }
      await client.verifyMfa(mfaCode);
    } else {
      throw error;
    }
  }

  return collectVivintCameraRecords(client);
}

async function refreshSettingsDocument(existingDocument, credentials) {
  const freshCameras = await fetchVivintCameraRecords(credentials);
  const next = {
    ...(existingDocument || {}),
    cameras: mergeCameraRecords(existingDocument?.cameras, freshCameras)
  };
  return {
    document: next,
    cameras: next.cameras
  };
}

module.exports = {
  VivintClient,
  VivintMfaRequiredError,
  collectVivintCameraRecords,
  fetchVivintCameraRecords,
  mergeCameraRecords,
  refreshSettingsDocument
};
