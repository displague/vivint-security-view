# lan-signin overlay: optional Google sign-in for the viewer (off by default)

This overlay is the `lan` overlay plus a Google sign-in gate on the web pages. Only accounts in
`GOOGLE_SIGNIN_ALLOWED_EMAILS` (in the `vivint-signin` Secret) get in. Nothing here is applied
unless someone chooses to: `kubectl apply -k k8s/overlays/lan` leaves the gate off.

## Why it needs a real domain, not vivint.local

Google only accepts OAuth redirect URIs that use HTTPS and whose top-level domain is on the public
suffix list. `.local` is not, so `https://vivint.local/...` is refused. Google never resolves or
contacts the redirect host, so a name under a domain you own that only resolves inside the house
works, for example `vivint.home.example.com`:

- Point a wildcard record such as `*.home.example.com` at the LAN ingress address, in a zone or
  split-horizon resolver that only the home network uses. No public record is needed for `vivint`.
- Issue a wildcard certificate by ACME DNS-01 (cert-manager can do this), so nothing has to reach
  the house and `vivint` stays out of Certificate Transparency logs.
- Terminate TLS on a Gateway API Gateway. `httproute.yaml` attaches the name to it and redirects
  HTTP to HTTPS.

`vivint.home.example.com` and the Gateway reference are placeholders. Patch them, and
`GOOGLE_SIGNIN_REDIRECT_URL` and `BASE_URL` in the ConfigMap, in your own overlay
(`k8s/overlays/local/` is git-ignored for that).

When the gate is on, browsers that open `http://vivint.local` are sent to the https name, because
the session cookie is Secure and can't be set over plain HTTP.

## What the gate covers

- **Gated:** every page and API, including `/security`, `/health` and the refresh endpoint.
- **Not gated:** `/healthz` for probes, and `/stream/*` requests that carry the stream token,
  so in-cluster consumers keep working. Playlists fetched with the token carry it onto segment URLs.

## Turning it on

1. In Google Cloud console, create an OAuth client of type *Web application*. Set its authorized
   redirect URI to `https://<your name>/auth/callback`. The consent screen only needs the
   `openid` and `email` scopes; keep it in testing mode with the allowed accounts as test users.
2. Add the client to the Secret and apply it:

   ```sh
   GOOGLE_SIGNIN_CLIENT_ID=... GOOGLE_SIGNIN_CLIENT_SECRET=... node scripts/make_lan_secrets.js
   kubectl apply -f k8s/overlays/lan/secrets.local.yaml
   ```

3. `kubectl apply -k k8s/overlays/lan-signin`, or your overlay built on it.

The server refuses to start with the gate on if the client, redirect URL, allowlist or a session key
of 32+ characters is missing. To turn the gate off again, apply `k8s/overlays/lan`.
Removing someone from the allowlist ends their session at the next restart.
