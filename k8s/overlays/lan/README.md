# lan overlay: home-network-only Vivint ingest

Runs the viewer in a home cluster as the one always-on puller of the Vivint panel.
It is reachable only on the home network, at `http://vivint.local`.

- **No public exposure.** There is no Ingress, no external-dns and no Google Smart Home or OAuth
  bridge routes. `APP_MODE=lan` returns 404 for `/smarthome`, `/oauth/*` and `/google/*`.
- **vivint.local.** The LAN-only Ingress `vivint-lan` (host `vivint.local`) goes through the cluster's
  ingress controller on its LAN address. An mDNS publisher that watches Ingresses, such as
  external-mdns, answers `vivint.local` on the LAN. The Service is ClusterIP, because the ingress
  controller usually already holds port 80 on that address.
- **Your own overlay.** Node placement (for example, nodes that can attach your storage class),
  the ingress class and the sign-in hostname are cluster-specific. Put them in an overlay on top of
  this one, such as the git-ignored `k8s/overlays/local/`.
- **Keepalive.** `STREAM_KEEPALIVE=1` pulls every camera continuously. A camera that drops is
  restarted with backoff from 5 s to 5 min. Video is copied, not re-encoded.
- **Settings on a PVC.** An init container copies `settings.json` from the `vivint-panel` Secret
  onto the `vivint-settings` PVC once. Later refreshes write the PVC, and the server reloads it.

## Secrets (never in git or the hub)

Generate them on the machine that has the panel's `settings.json`:

```sh
VIVINT_SIGNIN_ALLOWED_EMAILS="<comma-separated Google accounts>" \
  node scripts/make_lan_secrets.js             # writes k8s/overlays/lan/secrets.local.yaml
kubectl apply -f k8s/overlays/lan/secrets.local.yaml
```

| Secret | Keys | Used for |
|---|---|---|
| `vivint-panel` | `settings.json` | Panel RTSP URLs, including the long-lived panel credential |
| `vivint-app` | `STREAM_TOKEN` | Random token for `/stream/*`; in-cluster consumers read it here |
| `vivint-signin` | `SESSION_SECRET`, `GOOGLE_SIGNIN_ALLOWED_EMAILS`, later the Google client | Optional sign-in gate, off |

The image is private on GHCR, so the namespace also needs `ghcr-pull-secret` (a read:packages token),
or import the image into k3s and drop `imagePullSecrets`.

## Deploy

```sh
kubectl apply -k k8s/overlays/lan
```

Image: `ghcr.io/displague/vivint-security-view`, built for linux/amd64 and linux/arm64 on every push
to main. Tags are `latest` and `sha-<short commit>`. Pin a `sha-` tag under `images:` for repeatable rollouts.

## Health

- `GET /healthz` always returns 200, so a dead camera never restarts the pod. The JSON has
  `camerasLive`, a per-camera `status` (`live`, `starting`, `backoff`, `down`, `idle`) with
  `lastFailure` (`not_found`, `auth_failed`, `unreachable`, `error`), and `credential`.
- `credential.needsRefresh` turns true when every attempted camera is refused with `auth_failed`.
  The panel credential has no stated expiry, so `expiresAt` is null and `lastAcceptedAt` shows when
  it last worked. Raise the owner's to-do from `needsRefresh`.
- `GET /health` is the same information as a page.

## Refreshing the panel credential

The refresh needs the owner's Vivint login and an MFA code. Run it inside the pod; the server
notices the new `settings.json` within 15 s and restarts the streams:

```sh
kubectl -n vivint exec -it deploy/vivint-bridge -- node scripts/refresh_vivint_rtsp_urls.js
```

The `/security` page's refresh button only works from localhost, so it doesn't work through the Service.

## Audio

The HLS output keeps camera audio for the viewer. In-cluster consumers that must not carry audio
(a relay feeding a vision pipeline, say) should take the video track only.
