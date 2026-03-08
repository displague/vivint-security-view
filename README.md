# Vivint -> Google Home Bridge (Proxy Scaffold)

This app is a local proxy and webhook scaffold to expose camera streams to Google Smart Home.

It does two jobs:

1. Pulls camera RTSP streams and repackages them as local HLS (`ffmpeg`).
2. Implements Google Smart Home intents (`SYNC`, `QUERY`, `EXECUTE`) for camera stream URLs.

## Important Constraint

Google camera streaming (`action.devices.traits.CameraStream`) is cloud-to-cloud and is not supported by Local Home SDK for local-only camera streaming.  
This means a LAN-only proxy is not enough by itself; Google must reach a fulfillment endpoint and account linking must be configured for Home Graph integration.

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

## Run

`npm start`

Health check:

`http://localhost:8080/healthz`

Security wall:

`http://localhost:8080/security`

Features:
- all cameras live in one grid
- hover over a tile to unmute that camera (others stay muted)
- playback rate selector (1.0x to 2.0x)
- auto catch-up mode for reduced live lag
- fill-screen mode for larger feed area
- auto-focus mode that highlights the camera with strongest detected motion
- optional browser face detection overlay count (when FaceDetector API is supported)

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
    "baseUrl": "http://192.168.1.50:8080",
    "streamToken": "change-me"
  }
}
```

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

Supported intents:

- `action.devices.SYNC`
- `action.devices.QUERY`
- `action.devices.EXECUTE` (`GetCameraStream`)

For `EXECUTE`, the app returns:

- `cameraStreamProtocol: "hls"`
- `cameraStreamAccessUrl: <BASE_URL>/stream/<camera-id>/index.m3u8`

If `STREAM_TOKEN` is set, the token is required on direct playlist requests and appended to URLs returned for Google.

## Vivint Notes

Vivint does not publicly document a generic local RTSP endpoint for all camera models/setups.  
If your Vivint system does not expose RTSP locally, this bridge still works structurally, but you need a stream source URL that FFmpeg can read (RTSP/HTTP-compatible).

## Next Integration Step (Google)

To make devices appear in Google Home, create a Google Smart Home Action:

1. Configure account linking.
2. Point fulfillment to this app (publicly reachable HTTPS endpoint).
3. Test with your own account in Google Home developer test flow.
4. Validate stream response fields and URL reachability from Google.
