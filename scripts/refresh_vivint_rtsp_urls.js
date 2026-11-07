#!/usr/bin/env node

const readline = require("readline");
const {
  loadSettingsDocument,
  saveSettingsDocument,
  selectSettingsPath
} = require("../src/config");
const {
  VivintMfaRequiredError,
  refreshSettingsDocument
} = require("../src/vivint-refresh");

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    if (!silent) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    const onData = (char) => {
      const text = String(char);
      switch (text) {
        case "\n":
        case "\r":
        case "\u0004":
          process.stdin.off("data", onData);
          rl.output.write("\n");
          break;
        default:
          rl.output.clearLine(0);
          rl.output.cursorTo(0);
          rl.output.write(`${question}${"*".repeat(rl.line.length)}`);
          break;
      }
    };

    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.off("data", onData);
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const settings = loadSettingsDocument();
  if (!settings) {
    throw new Error(
      `Missing settings.json at ${selectSettingsPath()}. This refresh flow expects settings.json to exist.`
    );
  }

  const username = await ask("Vivint username/email: ");
  const password = await ask("Vivint password: ", { silent: true });

  let updated;
  try {
    updated = await refreshSettingsDocument(settings, {
      username,
      password
    });
  } catch (error) {
    if (!(error instanceof VivintMfaRequiredError)) {
      throw error;
    }
    const mfaCode = await ask("Vivint MFA code: ");
    updated = await refreshSettingsDocument(settings, {
      username,
      password,
      mfaCode
    });
  }

  const savedPath = saveSettingsDocument(updated.document);
  process.stdout.write(
    `${JSON.stringify(
      {
        updatedSettingsPath: savedPath,
        cameraCount: updated.cameras.length,
        cameraIds: updated.cameras.map((camera) => camera.camera_id)
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
