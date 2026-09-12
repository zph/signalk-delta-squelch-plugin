"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Server = require("signalk-server");

const PLUGIN_ID = "signalk-delta-squelch-plugin";
const HISTORY_PATH = "environment.wind.speedTrue";
const port = Number(process.env.SQUELCH_TEST_PORT);
const configPath = process.env.SQUELCH_TEST_CONFIG_PATH;

if (!Number.isInteger(port) || port <= 0 || !configPath) {
  throw new Error("SQUELCH_TEST_PORT and SQUELCH_TEST_CONFIG_PATH are required");
}

const pluginRoot = path.resolve(__dirname, "../..");
const scopedModules = path.join(configPath, "node_modules", "@rhizomatics");
fs.mkdirSync(scopedModules, { recursive: true });
fs.symlinkSync(pluginRoot, path.join(scopedModules, "signalk-delta-squelch-plugin"), "dir");

const pluginConfigPath = path.join(configPath, "plugin-config-data");
fs.mkdirSync(pluginConfigPath, { recursive: true });
fs.writeFileSync(
  path.join(pluginConfigPath, `${PLUGIN_ID}.json`),
  JSON.stringify({
    enabled: true,
    configuration: {
      heartbeatSeconds: 3600,
      paths: [{ path: "navigation.speedOverGround", heartbeatSeconds: 1 }],
      positionOutlier: {
        enabled: true,
        confirmationCount: 2,
        maxConfirmationGapSeconds: 30,
        maxVesselSpeedKnots: 25,
        minDistanceM: 0,
        speedMarginMultiplier: 1.5,
      },
    },
  }),
);
for (const pluginId of ["course-provider", "resources-provider"]) {
  fs.writeFileSync(path.join(pluginConfigPath, `${pluginId}.json`), JSON.stringify({ enabled: false }));
}

const settings = {
  interfaces: {
    applicationData: false,
    appstore: false,
    logfiles: false,
    mfd_webapp: false,
    "n2k-discovery": false,
    "nmea-tcp": false,
    playground: false,
    plugins: true,
    providers: false,
    rest: true,
    tcp: false,
    "unitpreferences-api": false,
    wasm: false,
    webapps: false,
    ws: true,
  },
  mdns: false,
  pipedProviders: [],
  port,
  priorityOverrides: {
    "environment.depth.belowTransducer": [
      { sourceRef: PLUGIN_ID, timeout: 0 },
      { sourceRef: "integration.depth", timeout: 100 },
    ],
    "navigation.position": [
      { sourceRef: PLUGIN_ID, timeout: 0 },
      { sourceRef: "integration.position", timeout: 2000 },
    ],
    "navigation.speedOverGround": [
      { sourceRef: PLUGIN_ID, timeout: 0 },
      { sourceRef: "integration.primary", timeout: 0 },
      { sourceRef: "integration.backup", timeout: 2000 },
    ],
  },
  ssl: false,
  wsPingInterval: 0,
};

const serverRoot = path.dirname(require.resolve("signalk-server/package.json"));
const server = new Server({ config: { appPath: serverRoot, configPath, settings } });
const app = server.app;
const historyValues = [];
const historyUnsubscribes = [];
let plugin;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  historyUnsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
  plugin?.stop();
  await server.stop();
  process.exit(0);
}

process.on("message", async (message) => {
  const { id, type } = message || {};
  try {
    if (type === "inject") {
      app.handleMessage(message.providerId, message.delta);
      process.send?.({ id, ok: true });
      return;
    }
    if (type === "history-values") {
      process.send?.({ id, ok: true, values: historyValues.slice() });
      return;
    }
    if (type === "shutdown") {
      process.send?.({ id, ok: true });
      await shutdown();
      return;
    }
    throw new Error(`Unknown fixture message type: ${type}`);
  } catch (error) {
    process.send?.({ id, ok: false, error: error.stack || String(error) });
  }
});

process.on("SIGTERM", () => shutdown().catch(() => process.exit(1)));

server
  .start()
  .then(() => {
    plugin = app.pluginsMap?.[PLUGIN_ID];
    if (!plugin || plugin.version !== "0.5.0-zph.1") {
      throw new Error(`Local fork was not loaded: ${plugin?.version || "missing"}`);
    }
    app.subscriptionmanager.subscribe(
      { context: "vessels.self", subscribe: [{ path: HISTORY_PATH }] },
      historyUnsubscribes,
      (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
      (delta) => {
        for (const update of delta.updates || []) {
          for (const pathValue of update.values || []) {
            if (pathValue.path === HISTORY_PATH) {
              historyValues.push({ source: update.$source, value: pathValue.value });
            }
          }
        }
      },
      undefined,
      "all",
    );
    process.send?.({ type: "ready", pluginVersion: plugin.version, port });
  })
  .catch((error) => {
    process.send?.({ type: "startup-error", error: error.stack || String(error) });
    process.exit(1);
  });
