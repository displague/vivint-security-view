// Optional Google sign-in gate for the web pages. Off unless GOOGLE_SIGNIN_ENABLED=1.
// Only verified Google accounts on GOOGLE_SIGNIN_ALLOWED_EMAILS get a session.
const crypto = require("crypto");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SESSION_COOKIE = "vsv_session";
const LOGIN_COOKIE = "vsv_login";
const LOGIN_TTL_SECONDS = 600;

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function randomToken(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function safeNextPath(value) {
  const next = String(value || "/");
  // Relative paths only, so the sign-in flow can't be used as an open redirect.
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next;
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new Error("malformed id_token");
  }
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function validateSignInConfig(signIn) {
  if (!signIn.enabled) {
    return;
  }
  const missing = [];
  if (!signIn.clientId) missing.push("GOOGLE_SIGNIN_CLIENT_ID");
  if (!signIn.clientSecret) missing.push("GOOGLE_SIGNIN_CLIENT_SECRET");
  if (!signIn.redirectUrl) missing.push("GOOGLE_SIGNIN_REDIRECT_URL");
  if (signIn.allowedEmails.length === 0) missing.push("GOOGLE_SIGNIN_ALLOWED_EMAILS");
  if (signIn.sessionSecret.length < 32) missing.push("SESSION_SECRET (32+ characters)");
  if (missing.length > 0) {
    throw new Error(`Google sign-in is enabled but not configured: ${missing.join(", ")}`);
  }
  if (!signIn.redirectUrl.startsWith("https://")) {
    throw new Error("GOOGLE_SIGNIN_REDIRECT_URL must be https:// (Google rejects http and .local hosts).");
  }
}

function createGoogleSignIn({ config, logger }) {
  const signIn = config.googleSignIn;
  validateSignInConfig(signIn);
  const allowed = new Set(signIn.allowedEmails);
  const callbackUrl = signIn.enabled ? new URL(signIn.redirectUrl) : null;
  const callbackPath = callbackUrl ? callbackUrl.pathname : "/auth/callback";
  const canonicalHost = callbackUrl ? callbackUrl.host : "";

  function sign(payload) {
    const body = base64url(JSON.stringify(payload));
    const mac = base64url(
      crypto.createHmac("sha256", signIn.sessionSecret).update(body).digest()
    );
    return `${body}.${mac}`;
  }

  function verify(value) {
    const [body, mac] = String(value || "").split(".");
    if (!body || !mac) {
      return null;
    }
    const expected = base64url(
      crypto.createHmac("sha256", signIn.sessionSecret).update(body).digest()
    );
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return payload.exp && payload.exp > nowSeconds() ? payload : null;
    } catch {
      return null;
    }
  }

  function cookie(res, name, value, maxAgeSeconds) {
    res.append(
      "Set-Cookie",
      `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
    );
  }

  function currentUser(req) {
    if (!signIn.enabled) {
      return null;
    }
    const session = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    // Re-check the allowlist so removing someone from the Secret ends their session on restart.
    return session && allowed.has(session.email) ? session : null;
  }

  function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:1.5rem;background:#111923;border-radius:12px}a{color:#6cb6ff}</style></head><body><main>${body}</main></body></html>`;
  }

  function register(app) {
    if (!signIn.enabled) {
      return;
    }

    app.get("/auth/login", (req, res) => {
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken(48);
      const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
      cookie(
        res,
        LOGIN_COOKIE,
        sign({ state, nonce, verifier, next: safeNextPath(req.query.next), exp: nowSeconds() + LOGIN_TTL_SECONDS }),
        LOGIN_TTL_SECONDS
      );
      const url = new URL(AUTH_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: signIn.clientId,
        redirect_uri: signIn.redirectUrl,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account"
      }).toString();
      res.redirect(url.toString());
    });

    app.get(callbackPath, async (req, res) => {
      const login = verify(parseCookies(req.headers.cookie)[LOGIN_COOKIE]);
      cookie(res, LOGIN_COOKIE, "", 0);
      if (!login || !req.query.state || req.query.state !== login.state || !req.query.code) {
        return res.status(400).send(page("Sign-in failed", "<p>The sign-in attempt expired or didn't match. <a href=\"/auth/login\">Try again</a>.</p>"));
      }

      try {
        const response = await fetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: String(req.query.code),
            client_id: signIn.clientId,
            client_secret: signIn.clientSecret,
            redirect_uri: signIn.redirectUrl,
            grant_type: "authorization_code",
            code_verifier: login.verifier
          })
        });
        const tokens = await response.json();
        if (!response.ok || !tokens.id_token) {
          throw new Error(`token exchange failed (${response.status})`);
        }
        // The ID token came straight from Google's token endpoint over TLS, so per OpenID
        // Connect Core 3.1.3.7 its claims are checked here without a JWKS signature check.
        const claims = decodeJwtPayload(tokens.id_token);
        const email = String(claims.email || "").toLowerCase();
        if (
          !GOOGLE_ISSUERS.has(claims.iss) ||
          claims.aud !== signIn.clientId ||
          !(claims.exp > nowSeconds()) ||
          claims.nonce !== login.nonce
        ) {
          throw new Error("id_token claims did not validate");
        }
        if (claims.email_verified !== true || !allowed.has(email)) {
          logger.warn("Google sign-in refused for an account not on the allowlist");
          return res.status(403).send(page("Not allowed", "<p>This Google account isn't allowed here. <a href=\"/auth/login\">Use another account</a>.</p>"));
        }
        cookie(res, SESSION_COOKIE, sign({ email, exp: nowSeconds() + signIn.sessionTtlSeconds }), signIn.sessionTtlSeconds);
        logger.info("Google sign-in accepted");
        return res.redirect(login.next || "/");
      } catch (error) {
        logger.error(`Google sign-in failed: ${error.message}`);
        return res.status(502).send(page("Sign-in failed", "<p>Google sign-in didn't complete. <a href=\"/auth/login\">Try again</a>.</p>"));
      }
    });

    app.get("/auth/logout", (req, res) => {
      cookie(res, SESSION_COOKIE, "", 0);
      res.send(page("Signed out", "<p>Signed out. <a href=\"/auth/login\">Sign in again</a>.</p>"));
    });
  }

  // Gate everything except health probes, the sign-in routes and token-bearing stream requests.
  function middleware(req, res, next) {
    if (!signIn.enabled) {
      return next();
    }
    if (req.path === "/healthz" || req.path === "/favicon.ico") {
      return next();
    }
    if (
      req.path.startsWith("/stream/") &&
      config.streamToken &&
      req.query.token === config.streamToken
    ) {
      return next();
    }
    // Sign-in cookies are Secure, so browsers on http://vivint.local move to the https name first.
    if (req.method === "GET" && req.get("host") !== canonicalHost) {
      return res.redirect(`https://${canonicalHost}${req.originalUrl}`);
    }
    if (req.path.startsWith("/auth/") || req.path === callbackPath) {
      return next();
    }
    if (currentUser(req)) {
      return next();
    }
    const wantsHtml = req.method === "GET" && String(req.headers.accept || "").includes("text/html");
    if (wantsHtml) {
      return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({ error: "sign_in_required" });
  }

  return { enabled: signIn.enabled, register, middleware, currentUser };
}

module.exports = {
  createGoogleSignIn,
  safeNextPath
};
