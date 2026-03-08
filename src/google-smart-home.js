function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildSyncPayload(config) {
  return {
    requestId: "sync-local",
    payload: {
      agentUserId: "local-user",
      devices: config.cameras.map((camera) => ({
        id: camera.id,
        type: "action.devices.types.CAMERA",
        traits: ["action.devices.traits.CameraStream"],
        name: {
          name: camera.name
        },
        willReportState: false,
        attributes: {
          cameraStreamSupportedProtocols: ["hls"],
          cameraStreamNeedAuthToken: config.streamToken.length > 0,
          cameraStreamNeedDrmEncryption: false
        },
        deviceInfo: {
          manufacturer: "Vivint (proxied)",
          model: "Local RTSP Proxy",
          hwVersion: "1.0",
          swVersion: "0.1.0"
        },
        customData: {
          cameraId: camera.id
        }
      }))
    }
  };
}

function buildQueryPayload(config, deviceIds) {
  const devices = {};
  for (const id of deviceIds) {
    const exists = config.cameras.some((camera) => camera.id === id);
    devices[id] = {
      online: exists
    };
  }
  return {
    requestId: "query-local",
    payload: {
      devices
    }
  };
}

function streamUrl(config, cameraId) {
  const token =
    config.streamToken.length > 0
      ? `?token=${encodeURIComponent(config.streamToken)}`
      : "";
  return `${config.baseUrl}/stream/${encodeURIComponent(cameraId)}/index.m3u8${token}`;
}

function buildExecutePayload(config, commands) {
  const results = [];

  for (const command of asArray(commands)) {
    const execs = asArray(command.execution);
    const deviceIds = asArray(command.devices).map((d) => d.id).filter(Boolean);

    for (const deviceId of deviceIds) {
      for (const execution of execs) {
        if (execution.command !== "action.devices.commands.GetCameraStream") {
          results.push({
            ids: [deviceId],
            status: "ERROR",
            errorCode: "notSupported"
          });
          continue;
        }

        results.push({
          ids: [deviceId],
          status: "SUCCESS",
          states: {
            online: true,
            cameraStreamAccessUrl: streamUrl(config, deviceId),
            cameraStreamProtocol: "hls"
          }
        });
      }
    }
  }

  return {
    requestId: "execute-local",
    payload: {
      commands: results
    }
  };
}

function parseIntent(body) {
  const inputs = asArray(body.inputs);
  if (inputs.length === 0) {
    return null;
  }
  return inputs[0].intent || null;
}

function createSmartHomeHandler({ config, logger, streamManager }) {
  const syncResponse = buildSyncPayload(config);

  return async function smartHomeHandler(req, res) {
    try {
      const intent = parseIntent(req.body);
      if (!intent) {
        return res.status(400).json({ error: "Malformed payload: missing inputs/intent" });
      }

      if (intent === "action.devices.SYNC") {
        return res.json(syncResponse);
      }

      if (intent === "action.devices.QUERY") {
        const ids = asArray(req.body.inputs?.[0]?.payload?.devices)
          .map((d) => d.id)
          .filter(Boolean);
        return res.json(buildQueryPayload(config, ids));
      }

      if (intent === "action.devices.EXECUTE") {
        const commands = asArray(req.body.inputs?.[0]?.payload?.commands);
        const deviceIds = new Set();
        for (const command of commands) {
          for (const d of asArray(command.devices)) {
            if (d?.id) {
              deviceIds.add(d.id);
            }
          }
        }

        for (const id of deviceIds) {
          const camera = config.cameras.find((c) => c.id === id);
          if (camera) {
            await streamManager.ensureRunning(camera);
          } else {
            logger.warn(`Unknown camera id from EXECUTE: ${id}`);
          }
        }

        return res.json(buildExecutePayload(config, commands));
      }

      return res.status(400).json({ error: `Unsupported intent: ${intent}` });
    } catch (err) {
      logger.error(`Smart Home handler error: ${err.stack || err.message}`);
      return res.status(500).json({
        error: "internalError"
      });
    }
  };
}

module.exports = {
  createSmartHomeHandler
};
