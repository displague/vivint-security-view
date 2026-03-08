const crypto = require("crypto");

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

class OAuthStore {
  constructor(config) {
    this.config = config;
    this.authCodes = new Map();
    this.accessTokens = new Map();
    this.refreshTokens = new Map();
  }

  isConfigured() {
    return Boolean(
      this.config.googleClientId &&
        this.config.googleClientSecret &&
        this.config.googleAuthUser &&
        this.config.googleAuthPass
    );
  }

  validateLocalUser(username, password) {
    return (
      username === this.config.googleAuthUser &&
      password === this.config.googleAuthPass
    );
  }

  validateClient(clientId, clientSecret) {
    return (
      clientId === this.config.googleClientId &&
      clientSecret === this.config.googleClientSecret
    );
  }

  issueAuthCode({ clientId, redirectUri, userId }) {
    const code = crypto.randomUUID();
    this.authCodes.set(code, {
      clientId,
      redirectUri,
      userId,
      expiresAt: nowSeconds() + 300
    });
    return code;
  }

  consumeAuthCode(code, { clientId, redirectUri }) {
    const record = this.authCodes.get(code);
    this.authCodes.delete(code);
    if (!record) {
      return null;
    }
    if (record.expiresAt < nowSeconds()) {
      return null;
    }
    if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
      return null;
    }
    return this.issueTokenSet(record.userId);
  }

  issueTokenSet(userId) {
    const accessToken = crypto.randomUUID();
    const refreshToken = crypto.randomUUID();
    const expiresIn = 3600;
    const tokenRecord = {
      userId,
      expiresAt: nowSeconds() + expiresIn
    };
    this.accessTokens.set(accessToken, tokenRecord);
    this.refreshTokens.set(refreshToken, { userId });
    return {
      token_type: "bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn
    };
  }

  refreshAccessToken(refreshToken) {
    const record = this.refreshTokens.get(refreshToken);
    if (!record) {
      return null;
    }
    return this.issueTokenSet(record.userId);
  }

  verifyAccessToken(accessToken) {
    const record = this.accessTokens.get(accessToken);
    if (!record) {
      return null;
    }
    if (record.expiresAt < nowSeconds()) {
      this.accessTokens.delete(accessToken);
      return null;
    }
    return record;
  }
}

module.exports = {
  OAuthStore
};
