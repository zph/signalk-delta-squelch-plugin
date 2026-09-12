"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const pluginFactory = require("../index");

test("subscribes safely and publishes a separate derived source without mutating raw data", () => {
  let command;
  let callback;
  let unsubscribed = false;
  const emitted = [];
  const app = {
    selfContext: "vessels.self",
    debug: () => {},
    getMetadata: () => undefined,
    setPluginError: (error) => assert.fail(error),
    setPluginStatus: () => {},
    handleMessage: (providerId, delta) => emitted.push({ providerId, delta }),
    subscriptionmanager: {
      subscribe: (nextCommand, unsubscribes, _errorCallback, nextCallback) => {
        command = nextCommand;
        callback = nextCallback;
        unsubscribes.push(() => {
          unsubscribed = true;
        });
      },
    },
  };
  const plugin = pluginFactory(app);
  plugin.start({ positionOutlier: { enabled: false } });

  assert.equal(command.sourcePolicy, "preferred");
  assert.equal(command.excludeSelf, true);
  assert.deepEqual(command.subscribe, [{ path: "*" }]);

  const raw = {
    context: "vessels.self",
    updates: [
      {
        $source: "gps.1",
        timestamp: "2026-09-12T12:00:00Z",
        values: [
          {
            path: "navigation.position",
            value: { latitude: 47.6000002, longitude: -122.3000002, altitude: 14.2 },
          },
          { path: "performance.polarSpeedRatio", value: 0.923 },
        ],
      },
    ],
  };
  const original = structuredClone(raw);
  callback(raw);

  assert.deepEqual(raw, original);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].providerId, "signalk-delta-squelch-plugin");
  assert.equal(emitted[0].delta.updates[0].$source, "signalk-delta-squelch-plugin");
  assert.deepEqual(emitted[0].delta.updates[0].values, [
    {
      path: "navigation.position",
      value: { latitude: 47.6, longitude: -122.3, altitude: 14.2 },
    },
  ]);

  callback({
    context: "vessels.self",
    updates: [
      {
        $source: "signalk-delta-squelch-plugin",
        values: [{ path: "navigation.position", value: { latitude: 1, longitude: 1 } }],
      },
    ],
  });
  assert.equal(emitted.length, 1, "the derived source must not feed back into itself");

  plugin.stop();
  assert.equal(unsubscribed, true);
});
