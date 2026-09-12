"use strict";

const PLUGIN_ID = "signalk-delta-squelch-plugin";

module.exports = function (app) {
  const plugin = {
    id: PLUGIN_ID,
    name: "Delta Squelch",
    description:
      "Rounds noisy SignalK values (position, temperature, velocity, heading, height, voltage, pressure, humidity) to their sensor's real precision, " +
      "squelches repeated text/boolean values, and publishes a separate derived source while preserving the authoritative raw stream.",
  };

  // ── Config schema ──────────────────────────────────────────────────────

  plugin.schema = {
    type: "object",
    properties: {
      heartbeatSeconds: {
        type: "number",
        title: "Maximum output silence while input continues (seconds)",
        description:
          "When new input is still arriving, republish an unchanged derived value after this interval. This does not fabricate updates after an input source stops.",
        default: 5,
        minimum: 1,
      },
      stateTtlSeconds: {
        type: "number",
        title: "Inactive state retention (seconds)",
        description: "Forget state for inactive context/path/source combinations after this interval.",
        default: 3600,
        minimum: 60,
      },
      maxStateEntries: {
        type: "integer",
        title: "Maximum tracked context/path/source combinations",
        description: "Evict the least-recently-seen state when this bound is reached.",
        default: 10000,
        minimum: 100,
      },
      unchangingCountThreshold: {
        type: "integer",
        title: "Unchanging value threshold (text/boolean paths)",
        description:
          "Text and boolean values (state/switch paths, etc.) have no rounding resolution, so they're squelched by exact-value repetition instead: this many consecutive identical readings must be seen before further repeats are dropped. Earlier repeats, and the refresh above, are always forwarded. Notification paths are never republished.",
        default: 10,
        minimum: 1,
      },
      categoryResolution: {
        type: "object",
        title: "Default rounding resolution per category",
        description: "Applied to any recognised path without its own override below. Units are each category's native SignalK SI unit.",
        properties: {
          temperature: { type: "number", title: "Temperature (K, i.e. 0.01 == 0.01°C step)", default: 0.01 },
          velocity: { type: "number", title: "Velocity (m/s)", default: 0.05 },
          heading: { type: "number", title: "Heading / angle (rad, 0.01745 ≈ 1°)", default: 0.01745 },
          height: { type: "number", title: "Height / depth (m)", default: 0.1 },
          voltage: { type: "number", title: "Voltage (V)", default: 0.1 },
          pressure: { type: "number", title: "Pressure (Pa, 100 == 1 mbar)", default: 100 },
          humidity: { type: "number", title: "Humidity (ratio 0-1, 0.001 == 0.1%)", default: 0.001 },
        },
      },
      positionResolution: {
        type: "object",
        title: "Default position rounding (degrees)",
        properties: {
          latitude: { type: "number", title: "Latitude resolution (deg, 0.000001 ≈ 0.11m)", default: 0.000001 },
          longitude: {
            type: "number",
            title: "Longitude resolution (deg, 0.000001 ≈ 0.11m at Equator, 0.044m at Polar Circles )",
            default: 0.000001,
          },
        },
      },
      positionOutlier: {
        type: "object",
        title: "Position outlier rejection (anchor-watch GNSS glitch guard)",
        description:
          "Rejects a single own-vessel position spike implying an unrealistic speed. Tackles the classic anchor-watch false-alarm " +
          "problem; it does not address slow GNSS wander at rest.",
        properties: {
          enabled: { type: "boolean", title: "Enabled", default: true },
          maxVesselSpeedKnots: {
            type: "number",
            title: "Max realistic vessel speed (knots)",
            description:
              "Set above your vessel's actual top speed. A position implying faster travel than this is treated as a GNSS glitch.",
            default: 25,
            minimum: 0,
          },
          speedMarginMultiplier: { type: "number", title: "Safety margin multiplier", default: 1.5, minimum: 1 },
          minDistanceM: {
            type: "number",
            title: "Minimum spike distance (meters)",
            description:
              "A jump smaller than this is never rejected as a spike, no matter how fast it implies the vessel moved — it's ordinary " +
              "GNSS scatter, and that variation is what lets a 'cocked hat' of recent fixes average out to a better position than any " +
              "single fix.",
            default: 2,
            minimum: 0,
          },
          confirmationCount: {
            type: "integer",
            title: "Consecutive confirming samples before accepting a jump",
            description:
              "How many readings in a row must agree on the new position before it's trusted as real movement rather than a one-off spike.",
            default: 2,
            minimum: 1,
          },
          maxConfirmationGapSeconds: { type: "number", title: "Max time between confirming samples (seconds)", default: 30, minimum: 1 },
        },
      },
      paths: {
        type: "array",
        title: "Path-specific overrides",
        description: "Add an entry to override the category default for a specific path, or to handle a path that isn't auto-recognised.",
        items: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", title: "SignalK path", description: 'e.g. "navigation.position" or "propulsion.main.temperature"' },
            category: {
              type: "string",
              title: "Category (optional — auto-detected if omitted)",
              enum: ["position", "temperature", "velocity", "heading", "height", "voltage", "pressure", "humidity", "custom"],
            },
            resolution: { type: "number", title: "Resolution (non-position paths)" },
            latResolution: { type: "number", title: "Latitude resolution (deg, position only)" },
            lonResolution: { type: "number", title: "Longitude resolution (deg, position only)" },
            heartbeatSeconds: { type: "number", title: "Maximum output silence override (seconds)" },
            unchangingCountThreshold: {
              type: "integer",
              title: "Unchanging value threshold override (text/boolean paths)",
              minimum: 1,
            },
          },
        },
        default: [],
      },
    },
  };

  plugin.uiSchema = {
    paths: {
      items: {
        path: { "ui:placeholder": "navigation.position" },
      },
    },
  };

  // ── Start / stop ───────────────────────────────────────────────────────

  let filter = null;
  let statsTimer = null;
  let pruneTimer = null;
  let unsubscribes = [];
  const STATS_INTERVAL_MS = 60 * 60 * 1000;
  const PRUNE_INTERVAL_MS = 60 * 1000;

  plugin.start = function (options) {
    const { SquelchFilter } = require("./lib/filter");
    filter = new SquelchFilter(options || {}, { getMetadata: app.getMetadata });

    statsTimer = setInterval(() => {
      const { total, suppressed, spikes } = filter.takeStats();
      const pct = total > 0 ? ((suppressed / total) * 100).toFixed(1) : "0.0";
      app.debug(`squelch: suppressed ${suppressed}/${total} value(s) (${pct}%) in the past hour, ${spikes} rejected GNSS spike(s)`);
    }, STATS_INTERVAL_MS);
    statsTimer.unref?.();

    pruneTimer = setInterval(() => filter?.prune(), PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();

    unsubscribes = [];
    app.subscriptionmanager.subscribe(
      {
        context: "*",
        sourcePolicy: "preferred",
        excludeSelf: true,
        subscribe: [{ path: "*" }],
      },
      unsubscribes,
      (error) => app.setPluginError(`Subscription error: ${error?.message || error}`),
      (delta) => {
        if (!filter || !delta?.updates) return;

        const isSelf = delta.context === app.selfContext;
        const updates = [];

        for (const update of delta.updates) {
          const source = update.$source || update.source?.label || "unknown";
          if (source === PLUGIN_ID || !Array.isArray(update.values)) continue;

          const values = [];
          for (const pathValue of update.values) {
            if (!filter.handles(pathValue.path, pathValue.value)) continue;

            const result = filter.process(delta.context, pathValue.path, pathValue.value, isSelf, source);
            if (!result.keep) {
              if (result.reason === "spike") {
                const { from, to, source: spikeSource, distanceM, impliedSpeedMs, elapsedS } = result.spike;
                const loggedContext = isSelf ? "self" : delta.context;
                app.debug(
                  `squelch: rejected GNSS spike on ${loggedContext}:${pathValue.path} [${spikeSource || "unknown"}] — ` +
                    `(${from.latitude}, ${from.longitude}) -> (${to.latitude}, ${to.longitude}) ` +
                    `over ${elapsedS.toFixed(2)}s, ${distanceM.toFixed(1)}m implying ${impliedSpeedMs.toFixed(2)}m/s`,
                );
              }
              continue;
            }

            values.push({ ...pathValue, value: result.value });
          }

          if (values.length > 0) {
            updates.push({
              $source: PLUGIN_ID,
              timestamp: update.timestamp || new Date().toISOString(),
              values,
            });
          }
        }

        if (updates.length > 0) {
          app.handleMessage(PLUGIN_ID, { context: delta.context, updates });
        }
      },
    );

    app.setPluginStatus(`Publishing safe derived values as ${PLUGIN_ID}`);
  };

  plugin.stop = function () {
    unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
    filter = null;
    if (statsTimer) clearInterval(statsTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    statsTimer = null;
    pruneTimer = null;
  };

  return plugin;
};
