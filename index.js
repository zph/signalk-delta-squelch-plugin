"use strict";

const PLUGIN_ID = "signalk-delta-squelch-plugin";

module.exports = function (app) {
  const plugin = {
    id: PLUGIN_ID,
    name: "Squelch",
    description:
      "Rounds noisy SignalK values (position, temperature, velocity, heading, height) to their sensor's real precision and " +
      "drops deltas that don't change at that precision — cutting delta volume at the source, for every consumer, not just one subscriber.",
  };

  // ── Config schema ──────────────────────────────────────────────────────

  plugin.schema = {
    type: "object",
    properties: {
      heartbeatSeconds: {
        type: "number",
        title: "Heartbeat interval (seconds)",
        description:
          "Forward a value at least this often even if it hasn't moved past its rounding resolution, so consumers don't see a stale timestamp.",
        default: 60,
        minimum: 1,
      },
      categoryResolution: {
        type: "object",
        title: "Default rounding resolution per category",
        description: "Applied to any recognised path without its own override below. Units are each category's native SignalK SI unit.",
        properties: {
          temperature: { type: "number", title: "Temperature (K, i.e. 0.1 == 0.1°C step)", default: 0.1 },
          velocity: { type: "number", title: "Velocity (m/s)", default: 0.05 },
          heading: { type: "number", title: "Heading / angle (rad, 0.01745 ≈ 1°)", default: 0.01745 },
          height: { type: "number", title: "Height / depth (m)", default: 0.1 },
        },
      },
      positionResolution: {
        type: "object",
        title: "Default position rounding (degrees)",
        properties: {
          latitude: { type: "number", title: "Latitude resolution (deg, 0.00001 ≈ 1.1m)", default: 0.00001 },
          longitude: { type: "number", title: "Longitude resolution (deg)", default: 0.00001 },
        },
      },
      positionOutlier: {
        type: "object",
        title: "Position outlier rejection (anchor-watch GPS glitch guard)",
        description:
          "Rejects a single own-vessel position spike implying an unrealistic speed. Tackles the classic anchor-watch false-alarm " +
          "problem; it does not address slow GPS wander at rest — that's what the position rounding above is for.",
        properties: {
          enabled: { type: "boolean", title: "Enabled", default: true },
          maxVesselSpeedKnots: {
            type: "number",
            title: "Max realistic vessel speed (knots)",
            description:
              "Set above your vessel's actual top speed. A position implying faster travel than this is treated as a GPS glitch.",
            default: 25,
            minimum: 0,
          },
          speedMarginMultiplier: { type: "number", title: "Safety margin multiplier", default: 1.5, minimum: 1 },
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
              enum: ["position", "temperature", "velocity", "heading", "height", "custom"],
            },
            resolution: { type: "number", title: "Resolution (non-position paths)" },
            latResolution: { type: "number", title: "Latitude resolution (deg, position only)" },
            lonResolution: { type: "number", title: "Longitude resolution (deg, position only)" },
            heartbeatSeconds: { type: "number", title: "Heartbeat override (seconds)" },
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

  plugin.start = function (options) {
    const { SquelchFilter } = require("./lib/filter");
    filter = new SquelchFilter(options || {});

    app.registerDeltaInputHandler((delta, next) => {
      // Once stopped, `filter` is cleared but the server API gives plugins no
      // way to unregister a delta input handler, so this closure keeps
      // running — pass everything through untouched rather than crash.
      if (!filter || !delta.updates) return next(delta);

      const isSelf = delta.context === app.selfContext;

      delta.updates = delta.updates.filter((update) => {
        if (update.values && update.values.length > 0) {
          update.values = update.values.filter((pv) => {
            const result = filter.process(delta.context, pv.path, pv.value, isSelf);
            if (!result.keep) return false;
            pv.value = result.value;
            return true;
          });
        }
        return (update.values && update.values.length > 0) || (update.meta && update.meta.length > 0);
      });

      if (delta.updates.length > 0) next(delta);
      // else: the whole delta was redundant noise — intentionally dropped
    });

    app.setPluginStatus("Filtering active");
  };

  plugin.stop = function () {
    filter = null;
  };

  return plugin;
};
