const path = require("path");
const fs = require("fs");
const fsExtra = require("fs-extra");
const { spawn } = require("child_process");

const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
// A run that lasted this long counts as healthy, so the next failure starts the backoff over.
const STABLE_RUN_MS = 60 * 1000;

// ffmpeg echoes the input URL in its errors, and panel URLs carry the RTSP user and password.
function redactRtsp(text) {
  return String(text || "").replace(/(rtsps?:\/\/)[^@/\s]*@/gi, "$1***@");
}

function classifyFailure(text) {
  const value = String(text || "");
  if (/404|not found/i.test(value)) {
    return "not_found";
  }
  if (/401|403|unauthori[sz]ed|forbidden/i.test(value)) {
    return "auth_failed";
  }
  if (/timed out|timeout|refused|no route|unreachable|network is down|resolve/i.test(value)) {
    return "unreachable";
  }
  return value ? "error" : null;
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

class StreamManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.processes = new Map();
    this.stopping = false;
  }

  async init() {
    this.stopping = false;
    await fsExtra.ensureDir(this.config.streamRoot);
  }

  cameraDir(cameraId) {
    return path.join(this.config.streamRoot, cameraId);
  }

  playlistPath(cameraId) {
    return path.join(this.cameraDir(cameraId), "index.m3u8");
  }

  // Keep every configured camera pulling; each one restarts with backoff when it drops.
  async startAll() {
    for (const camera of this.config.cameras) {
      await this.ensureRunning(camera);
    }
  }

  async ensureRunning(camera) {
    const existing = this.processes.get(camera.id);
    if (existing && !existing.exited) {
      return;
    }
    if (existing?.retryTimer) {
      clearTimeout(existing.retryTimer);
      existing.retryTimer = null;
    }

    const outDir = this.cameraDir(camera.id);
    await fsExtra.emptyDir(outDir);

    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-rtsp_transport",
      "tcp",
      // Exit when the socket stalls, so keepalive notices and reconnects.
      "-timeout",
      String(this.config.rtspTimeoutSeconds * 1000000),
      "-i",
      camera.rtspUrl,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?"
    ];

    if (this.config.streamTranscode) {
      const fps = 24;
      const gop = fps * 2;
      const useNvenc = this.config.videoEncoder === "h264_nvenc";

      const videoArgs = useNvenc
        ? [
            "-c:v",
            "h264_nvenc",
            "-preset",
            this.config.videoPreset,
            "-tune",
            "ll",
            "-rc",
            "cbr_ld_hq",
            "-b:v",
            "4M",
            "-maxrate",
            "4M",
            "-bufsize",
            "2M",
            "-pix_fmt",
            "yuv420p",
            "-r",
            String(fps),
            "-g",
            String(gop),
            "-keyint_min",
            String(gop)
          ]
        : [
            "-vf",
            "format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            this.config.videoPreset,
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "main",
            "-r",
            String(fps),
            "-g",
            String(gop),
            "-keyint_min",
            String(gop)
          ];

      args.push(
        ...videoArgs,
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "hls",
        "-hls_time",
        String(this.config.hlsSegmentTime),
        "-hls_list_size",
        String(this.config.hlsListSize),
        "-hls_flags",
        "delete_segments+append_list+omit_endlist+independent_segments",
        path.join(outDir, "index.m3u8")
      );
    } else {
      args.push(
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "hls",
        "-hls_time",
        String(this.config.hlsSegmentTime),
        "-hls_list_size",
        String(this.config.hlsListSize),
        "-hls_flags",
        "delete_segments+append_list+omit_endlist",
        path.join(outDir, "index.m3u8")
      );
    }

    const child = spawn(this.config.ffmpegBin, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const state = {
      proc: child,
      exited: false,
      startError: null,
      lastStderr: existing?.lastStderr || "",
      startedAt: Date.now(),
      lastExitAt: existing?.lastExitAt || null,
      lastFailure: existing?.lastFailure || null,
      lastFailureAt: existing?.lastFailureAt || null,
      failures: existing?.failures || 0,
      restarts: existing ? existing.restarts + 1 : 0,
      retryTimer: null,
      nextRetryAt: null
    };
    this.processes.set(camera.id, state);

    child.stdout.on("data", (chunk) => {
      this.logger.debug(`[ffmpeg:${camera.id}] ${redactRtsp(chunk.toString().trim())}`);
    });

    child.stderr.on("data", (chunk) => {
      const text = redactRtsp(chunk.toString().trim());
      state.lastStderr = text || state.lastStderr;
      this.logger.debug(`[ffmpeg:${camera.id}] ${text}`);
    });

    child.on("error", (err) => {
      state.startError = err;
      state.lastStderr = redactRtsp(err.message);
      this.logger.error(`ffmpeg start error for ${camera.id}: ${state.lastStderr}`);
      this.onExit(camera, state, null, null);
    });

    child.on("exit", (code, signal) => {
      this.onExit(camera, state, code, signal);
    });
  }

  onExit(camera, state, code, signal) {
    if (state.exited) {
      return;
    }
    state.exited = true;
    state.lastExitAt = Date.now();
    if (state.lastExitAt - state.startedAt >= STABLE_RUN_MS) {
      state.failures = 0;
    }
    state.failures += 1;
    state.lastFailure = classifyFailure(state.lastStderr) || "exited";
    state.lastFailureAt = state.lastExitAt;
    this.logger.warn(
      `ffmpeg for ${camera.id} exited (code=${code}, signal=${signal || "none"}, reason=${state.lastFailure})`
    );

    if (this.stopping || !this.config.keepalive) {
      return;
    }
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** Math.max(0, state.failures - 1),
      BACKOFF_MAX_MS
    );
    state.nextRetryAt = Date.now() + delay;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (this.stopping || this.processes.get(camera.id) !== state) {
        return;
      }
      this.ensureRunning(camera).catch((err) => {
        this.logger.error(`keepalive restart failed for ${camera.id}: ${redactRtsp(err.message)}`);
      });
    }, delay);
    state.retryTimer.unref?.();
  }

  hasPlaylist(cameraId) {
    return fs.existsSync(this.playlistPath(cameraId));
  }

  getStatus(cameraId) {
    return this.processes.get(cameraId) || null;
  }

  async waitForPlaylist(cameraId, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.hasPlaylist(cameraId)) {
        return true;
      }
      const status = this.getStatus(cameraId);
      if (status?.startError || status?.exited) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return this.hasPlaylist(cameraId);
  }

  playlistUpdatedAt(cameraId) {
    try {
      return fs.statSync(this.playlistPath(cameraId)).mtimeMs;
    } catch {
      return null;
    }
  }

  // One entry per configured camera: live, starting, backoff, down or idle.
  health() {
    const now = Date.now();
    const staleMs = Math.max(15000, this.config.hlsSegmentTime * 1000 * 6);
    return this.config.cameras.map((camera) => {
      const state = this.processes.get(camera.id);
      const lastSegmentAt = this.playlistUpdatedAt(camera.id);
      let status = "idle";
      if (state && !state.exited) {
        status = lastSegmentAt && now - lastSegmentAt < staleMs ? "live" : "starting";
      } else if (state?.retryTimer) {
        status = "backoff";
      } else if (state) {
        status = "down";
      }
      return {
        id: camera.id,
        name: camera.name,
        status,
        lastSegmentAt: iso(lastSegmentAt),
        runningSince: state && !state.exited ? iso(state.startedAt) : null,
        lastFailure: state?.lastFailure || null,
        lastFailureAt: iso(state?.lastFailureAt),
        lastError: state?.lastFailure ? state.lastStderr.slice(-300) : null,
        consecutiveFailures: state?.failures || 0,
        restarts: state?.restarts || 0,
        nextRetryAt: state?.retryTimer ? iso(state.nextRetryAt) : null
      };
    });
  }

  stopAll() {
    this.stopping = true;
    for (const [cameraId, state] of this.processes.entries()) {
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
      if (!state.exited) {
        this.logger.info(`Stopping ffmpeg for ${cameraId}`);
        state.proc.kill("SIGTERM");
      }
    }
    this.processes.clear();
  }
}

module.exports = {
  StreamManager,
  redactRtsp
};
