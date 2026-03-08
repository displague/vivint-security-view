const path = require("path");
const fs = require("fs");
const fsExtra = require("fs-extra");
const { spawn } = require("child_process");

class StreamManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.processes = new Map();
  }

  async init() {
    await fsExtra.ensureDir(this.config.streamRoot);
  }

  cameraDir(cameraId) {
    return path.join(this.config.streamRoot, cameraId);
  }

  playlistPath(cameraId) {
    return path.join(this.cameraDir(cameraId), "index.m3u8");
  }

  async ensureRunning(camera) {
    const existing = this.processes.get(camera.id);
    if (existing && !existing.exited) {
      return;
    }

    const outDir = this.cameraDir(camera.id);
    await fsExtra.emptyDir(outDir);

    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-rtsp_transport",
      "tcp",
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
      lastStderr: ""
    };
    this.processes.set(camera.id, state);

    child.stdout.on("data", (chunk) => {
      this.logger.debug(`[ffmpeg:${camera.id}] ${chunk.toString().trim()}`);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      state.lastStderr = text || state.lastStderr;
      this.logger.debug(`[ffmpeg:${camera.id}] ${text}`);
    });

    child.on("error", (err) => {
      state.startError = err;
      state.exited = true;
      this.logger.error(`ffmpeg start error for ${camera.id}: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      state.exited = true;
      this.logger.warn(
        `ffmpeg for ${camera.id} exited (code=${code}, signal=${signal || "none"})`
      );
    });
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

  stopAll() {
    for (const [cameraId, state] of this.processes.entries()) {
      if (!state.exited) {
        this.logger.info(`Stopping ffmpeg for ${cameraId}`);
        state.proc.kill("SIGTERM");
      }
    }
    this.processes.clear();
  }
}

module.exports = {
  StreamManager
};
