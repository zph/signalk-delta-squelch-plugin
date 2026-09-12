"use strict";

const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FIXTURE = path.join(__dirname, "server-fixture.js");
const PLUGIN_ID = "signalk-delta-squelch-plugin";
const TIMEOUT_MS = 5000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

async function reservePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Signal K fixture startup timed out")), 30_000);
    const onMessage = (message) => {
      if (message?.type !== "ready" && message?.type !== "startup-error") return;
      clearTimeout(timeout);
      child.off("message", onMessage);
      message.type === "ready" ? resolve(message) : reject(new Error(message.error));
    };
    child.on("message", onMessage);
  });
}

function request(child, type, payload = {}) {
  const id = `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Fixture request timed out: ${type}`)), TIMEOUT_MS);
    const onMessage = (message) => {
      if (message?.id !== id) return;
      clearTimeout(timeout);
      child.off("message", onMessage);
      message.ok ? resolve(message) : reject(new Error(message.error));
    };
    child.on("message", onMessage);
    child.send({ id, type, ...payload });
  });
}

function delta(pathName, value, source) {
  return {
    context: "vessels.self",
    updates: [
      {
        $source: source,
        timestamp: new Date().toISOString(),
        values: [{ path: pathName, value }],
      },
    ],
  };
}

async function fetchPath(baseUrl, pathName) {
  const response = await fetch(`${baseUrl}/signalk/v1/api/vessels/self/${pathName.replaceAll(".", "/")}`);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

async function openAllSourcesSocket(port, pathName) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/signalk/v1/stream?subscribe=none`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
  socket.send(
    JSON.stringify({
      context: "vessels.self",
      sourcePolicy: "all",
      subscribe: [{ path: pathName }],
    }),
  );
  return socket;
}

async function collectValues(socket, pathName, milliseconds) {
  const values = [];
  const onMessage = (event) => {
    try {
      const message = JSON.parse(String(event.data));
      for (const update of message.updates || []) {
        for (const pathValue of update.values || []) {
          if (pathValue.path === pathName) values.push({ source: update.$source, value: pathValue.value });
        }
      }
    } catch {
      // Ignore Primus control frames.
    }
  };
  socket.addEventListener("message", onMessage);
  await delay(milliseconds);
  socket.removeEventListener("message", onMessage);
  return values;
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  socket.close();
  await Promise.race([closed, delay(1000)]);
}

test("the fork is safe across a real Signal K pipeline", async (t) => {
  const port = await reservePort();
  const configPath = await fs.mkdtemp(path.join(os.tmpdir(), "signalk-squelch-fixed-"));
  const child = fork(FIXTURE, [], {
    env: {
      ...process.env,
      SIGNALK_DISABLE_SERVER_UPDATES: "1",
      SKIP_ADMINUI_VERSION_CHECK: "1",
      SQUELCH_TEST_CONFIG_PATH: configPath,
      SQUELCH_TEST_PORT: String(port),
    },
    silent: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const ready = await waitForReady(child);
  assert.equal(ready.pluginVersion, "0.5.0-zph.1");
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await t.test("raw and derived position both preserve altitude", async () => {
      const socket = await openAllSourcesSocket(port, "navigation.position");
      const collecting = collectValues(socket, "navigation.position", 250);
      const position = { latitude: 47.6, longitude: -122.3, altitude: 14.2 };
      await request(child, "inject", {
        providerId: "integration.position",
        delta: delta("navigation.position", position, "integration.position"),
      });
      const values = await collecting;
      assert.deepEqual(new Set(values.map(({ source }) => source)), new Set(["integration.position", PLUGIN_ID]));
      assert.ok(values.every(({ value }) => value.altitude === 14.2));
      const current = await fetchPath(baseUrl, "navigation.position");
      assert.equal(current.$source, PLUGIN_ID);
      assert.equal(current.value.altitude, 14.2);
      await closeSocket(socket);
    });

    await t.test("a delayed jump is rejected only from derived output and remains in raw data", async () => {
      const start = { latitude: 47.6, longitude: -122.3, altitude: 14.2 };
      for (let index = 0; index < 5; index += 1) {
        await delay(40);
        await request(child, "inject", {
          providerId: "integration.position",
          delta: delta("navigation.position", start, "integration.position"),
        });
      }
      const socket = await openAllSourcesSocket(port, "navigation.position");
      const collecting = collectValues(socket, "navigation.position", 250);
      const jumped = { ...start, latitude: start.latitude + 3 / 111_195 };
      await request(child, "inject", {
        providerId: "integration.position",
        delta: delta("navigation.position", jumped, "integration.position"),
      });
      const values = await collecting;
      const jumpValues = values.filter(({ value }) => value.latitude === jumped.latitude);
      assert.deepEqual(jumpValues, [{ source: "integration.position", value: jumped }]);
      assert.equal(
        values.some(({ source, value }) => source === PLUGIN_ID && value.latitude === jumped.latitude),
        false,
      );
      const current = await fetchPath(baseUrl, "navigation.position");
      assert.equal(current.$source, PLUGIN_ID);
      assert.equal(current.value.latitude, start.latitude);
      await closeSocket(socket);
    });

    await t.test("preferred raw-source activity prevents false backup takeover", async () => {
      await request(child, "inject", {
        providerId: "integration.primary",
        delta: delta("navigation.speedOverGround", 5, "integration.primary"),
      });
      await request(child, "inject", {
        providerId: "integration.backup",
        delta: delta("navigation.speedOverGround", 5.2, "integration.backup"),
      });
      await delay(1100);
      await request(child, "inject", {
        providerId: "integration.primary",
        delta: delta("navigation.speedOverGround", 5.01, "integration.primary"),
      });
      await delay(1100);
      await request(child, "inject", {
        providerId: "integration.backup",
        delta: delta("navigation.speedOverGround", 5.4, "integration.backup"),
      });
      const current = await fetchPath(baseUrl, "navigation.speedOverGround");
      assert.equal(current.$source, PLUGIN_ID);
      assert.equal(current.value, 5);
    });

    await t.test("a historian-style all-source subscriber retains every raw sample", async () => {
      const raw = [];
      for (let index = 0; index < 60; index += 1) {
        raw.push(10);
        await request(child, "inject", {
          providerId: "integration.wind",
          delta: delta("environment.wind.speedTrue", 10, "integration.wind"),
        });
      }
      for (let index = 0; index < 10; index += 1) {
        const value = index % 2 === 0 ? 11 : 12;
        raw.push(value);
        await request(child, "inject", {
          providerId: "integration.wind",
          delta: delta("environment.wind.speedTrue", value, "integration.wind"),
        });
      }
      const history = (await request(child, "history-values")).values;
      const storedRaw = history.filter(({ source }) => source === "integration.wind").map(({ value }) => value);
      assert.equal(storedRaw.length, 70);
      assert.equal(mean(storedRaw).toFixed(3), mean(raw).toFixed(3));
    });

    await t.test("ratio paths are neither rounded nor duplicated as derived values", async () => {
      const pathName = "performance.polarSpeedRatio";
      const socket = await openAllSourcesSocket(port, pathName);
      const collecting = collectValues(socket, pathName, 250);
      await request(child, "inject", {
        providerId: "integration.performance",
        delta: delta(pathName, 0.923, "integration.performance"),
      });
      const values = await collecting;
      assert.deepEqual(values, [{ source: "integration.performance", value: 0.923 }]);
      await closeSocket(socket);
    });

    await t.test("depth output follows a changed value within one resolution step", async () => {
      await request(child, "inject", {
        providerId: "integration.depth",
        delta: delta("environment.depth.belowTransducer", 10.051, "integration.depth"),
      });
      await request(child, "inject", {
        providerId: "integration.depth",
        delta: delta("environment.depth.belowTransducer", 9.9021, "integration.depth"),
      });
      const current = await fetchPath(baseUrl, "environment.depth.belowTransducer");
      assert.equal(current.$source, PLUGIN_ID);
      assert.equal(current.value, 9.9);
    });
  } finally {
    try {
      await request(child, "shutdown");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000).then(() => child.kill("SIGKILL"))]);
    await fs.rm(configPath, { recursive: true, force: true });
  }

  assert.equal(child.exitCode, 0, output);
});
