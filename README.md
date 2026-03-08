# Vivint -> Google Home Bridge (Proxy Scaffold)

This app is a local proxy and webhook scaffold to expose camera streams to Google Smart Home.

It does two jobs:

1. Pulls camera RTSP streams and repackages them as local HLS (`ffmpeg`).
2. Implements Google Smart Home intents (`SYNC`, `QUERY`, `EXECUTE`) for camera stream URLs.

## Important Constraint

Google camera streaming (`action.devices.traits.CameraStream`) is cloud-to-cloud and is not supported by Local Home SDK for local-only camera streaming.  
This means Google must reach this service over HTTPS and account linking must be configured for Home Graph integration.

## Project Layout

- `src/index.js`: Express app, routes, static HLS serving
- `src/google-smart-home.js`: Smart Home intent handler
- `src/stream-manager.js`: FFmpeg process lifecycle
- `src/config.js`: environment and camera config loader
- `cameras.example.json`: example camera configuration
- `.env.example`: environment template

## Requirements

- Node.js 20+
- `ffmpeg` installed and in `PATH` (or set `FFMPEG_BIN`)

## Setup

1. Install dependencies:
   `npm install`
2. Place your Vivint extraction output in `settings.json` (recommended), or use `cameras.json` + `.env` fallback.
3. Optional environment file for fallback/overrides:
   `Copy-Item .env.example .env`
4. Optional camera config fallback:
   `Copy-Item cameras.example.json cameras.json`
5. Set `BASE_URL` in `.env` only if not using `proxy.baseUrl` in `settings.json`.

## Deployment Modes

- `hybrid` (default): local viewer, local bridge, Google endpoints all enabled
- `public-bridge`: intended for public HTTPS deployment; disable the local viewer routes and serve only OAuth, Smart Home, and stream endpoints

Relevant env flags:

- `APP_MODE=public-bridge`
- `ENABLE_ROOT_INDEX=0`
- `ENABLE_SECURITY_VIEW=0`
- `SETTINGS_FILE=/var/run/vivint-bridge/settings.json`
- `STREAM_SOURCE_PREFERENCE=external`

## Run

`npm start`

Health check:

`http://localhost:8080/healthz`

Security wall:

`http://localhost:8080/security`

Google setup helper:

`http://localhost:8080/google/setup`

Features:
- all cameras live in one grid
- hover over a tile to unmute that camera (others stay muted)
- playback rate selector (1.0x to 2.0x)
- auto catch-up mode for reduced live lag
- fill-screen mode for larger feed area
- focus view modes: `all`, `1`, `2`, `4` (top moving cameras)
- optional browser face detection with count and on-video face boxes (when FaceDetector API is supported)
- signal-loss overlay with automatic reconnect when the server comes back

## Camera Config

Preferred: `settings.json` using the output of `scripts/get_vivint_rtsp_urls.py`.  
The app will pick a stream URL in this order for each camera:
`rtspUrl` -> `internal_rtsp_hd` -> `direct_rtsp_hd` -> `internal_rtsp_sd` -> `direct_rtsp_sd` -> `external_rtsp_hd` -> `external_rtsp_sd`.

Fallback: `cameras.json` format:

```json
{
  "cameras": [
    {
      "id": "front-door",
      "name": "Front Door",
      "rtspUrl": "rtsp://username:password@192.168.1.120:554/stream1"
    }
  ]
}
```

Optional `settings.json` proxy fields:

```json
{
  "proxy": {
    "port": 8080,
    "baseUrl": "http://192.168.16.10:8080",
    "streamToken": "change-me"
  }
}
```

For Kubernetes/public deployment, use only the `cameras` section and prefer `external_rtsp_hd` / `external_rtsp_sd`.

`STREAM_TRANSCODE` (default `1`) controls video behavior:
- `1`: transcode to H.264/yuv420p with forced keyframes for broad player compatibility
- `0`: stream copy (`-c:v copy`) for lower CPU usage

Audio is included when available from the RTSP source and encoded as AAC.

For lower latency, defaults are tuned to:
- `HLS_SEGMENT_TIME=1`
- `HLS_LIST_SIZE=3`

Encoder options:
- `VIDEO_ENCODER=libx264` with `VIDEO_PRESET=veryfast` (default)
- `VIDEO_ENCODER=h264_nvenc` with `VIDEO_PRESET=p4` (recommended on RTX GPUs)

## Smart Home Endpoint

Webhook URL:

`POST /smarthome`

OAuth endpoints:

- `GET /oauth/authorize`
- `POST /oauth/login`
- `POST /oauth/token`

Supported intents:

- `action.devices.SYNC`
- `action.devices.QUERY`
- `action.devices.EXECUTE` (`GetCameraStream`)

For `EXECUTE`, the app returns:

- `cameraStreamProtocol: "hls"`
- `cameraStreamAccessUrl: <BASE_URL>/stream/<camera-id>/index.m3u8`

If `STREAM_TOKEN` is set, the token is required on direct playlist requests and appended to URLs returned for Google.

## Google Home Setup

Set these environment variables before exposing the bridge publicly:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_AUTH_USER`
- `GOOGLE_AUTH_PASS`
- `GOOGLE_AGENT_USER_ID`

In Google Home Developer Console / Google Cloud smart home setup:

1. Use cloud-to-cloud fulfillment.
2. Set fulfillment URL to `https://<your-public-host>/smarthome`
3. Set OAuth authorization URL to `https://<your-public-host>/oauth/authorize`
4. Set OAuth token URL to `https://<your-public-host>/oauth/token`
5. Register the same client id / client secret in both Google and this app.
6. Ensure `BASE_URL` points to the same public HTTPS host so returned HLS URLs are reachable by Google.

For the Google Cloud OAuth client itself:

1. Choose application type `Web application`
2. Leave `Authorized JavaScript origins` empty
3. Add redirect URIs:
   `https://oauth-redirect.googleusercontent.com/r/<GOOGLE_PROJECT_ID>`
   `https://oauth-redirect-sandbox.googleusercontent.com/r/<GOOGLE_PROJECT_ID>`

The `/google/setup` page renders these values directly from your current config so you do not have to derive them manually.

## Kubernetes Deployment

This repo includes manifests under `k8s/` for a dedicated namespace:

- `k8s/base/`
- `k8s/secret.example.yaml`
- `k8s/kustomization.yaml`
- `k8s/overlays/example/`

Intended split:

- local machine keeps `/security` and your private `settings.json`
- cluster runs the public Google-facing bridge at your chosen public host
- cluster bridge reads a secret-mounted `settings.json` containing only the cameras and their external Vivint RTSP URLs

Important:

- Do not commit real `settings.json` or `.env`
- Do not put RTSP URLs in a ConfigMap; they contain credentials and belong in a Secret
- Do not push client secrets into Docker image layers; inject them only through Kubernetes secrets

Suggested flow:

1. Push this repo to a private GitHub repository
2. Let GitHub Actions publish the image to private GHCR on pushes to `main`
3. Copy `k8s/overlays/example/` to `k8s/overlays/local/`
4. Edit the local overlay patches with your real host, project id, and image
5. Create real secrets from local files instead of editing `secret.example.yaml` in place
6. Create a `ghcr-pull-secret` in the namespace so the cluster can pull the private image
7. Apply the local overlay to the `vivint-bridge` namespace

Helper for local secret creation:

- `k8s/apply-secrets.example.ps1`

That script is intended to stay local. Keep the real filled-in copy out of git.

Kustomize usage:

- Safe committed base: `kubectl apply -k k8s`
- Safe committed example: `kubectl apply -k k8s/overlays/example`
- Intended real deployment: `kubectl apply -k k8s/overlays/local`

The example overlay is commit-safe. The local overlay should be copied from it and kept out of git via `.gitignore`.

GitHub Actions:

- `.github/workflows/publish.yml` publishes `ghcr.io/<owner>/vivint-security-view`
- packages should remain private
- the cluster should pull the image using the `ghcr-pull-secret`

This implementation is intentionally single-account and local-admin oriented. It is suitable for personal use and Google test-mode linking, not multi-user production.

## Vivint Notes

Vivint does not publicly document a generic local RTSP endpoint for all camera models/setups.  
If your Vivint system does not expose RTSP locally, this bridge still works structurally, but you need a stream source URL that FFmpeg can read (RTSP/HTTP-compatible).

## Next Integration Step (Google)

To make devices appear in Google Home, create a Google Smart Home Action:

1. Configure account linking.
2. Point fulfillment to this app (publicly reachable HTTPS endpoint).
3. Test with your own account in Google Home developer test flow.
4. Validate stream response fields and URL reachability from Google.
