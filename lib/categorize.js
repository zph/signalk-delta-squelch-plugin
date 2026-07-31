"use strict";

const POSITION_PATH = "navigation.position";

// Default rounding resolution per category, in that path's native SignalK SI
// unit. Position is handled separately (per-axis, in degrees) since lat/lon
// aren't a single scalar path.
const CATEGORY_DEFAULTS = {
  temperature: 0.1, // K (== 0.1 degC step)
  velocity: 0.05, // m/s (~0.1 knot)
  heading: 0.01745, // rad (~1 degree)
  height: 0.1, // m (depth, altitude, draft, freeboard...)
  voltage: 0.1, // V
  pressure: 100, // Pa (== 1 mbar)
  humidity: 0.001, // ratio, 0-1 (== 0.1%)
};

const DEFAULT_POSITION_RESOLUTION_DEG = 0.00001; // ~1.1m at the equator

// Keyword rules for auto-detecting a path's category when it isn't given an
// explicit override. Order matters: "temperature" is checked before the
// looser rules so e.g. "environment.water.temperature" isn't ever mistaken
// for anything else.
const CATEGORY_RULES = [
  { category: "temperature", test: (p) => /temperature/i.test(p) },
  { category: "velocity", test: (p) => /speed/i.test(p) },
  { category: "heading", test: (p) => /(heading|course|angle|direction|variation|deviation)/i.test(p) },
  { category: "height", test: (p) => /(depth|height|altitude|draft|freeboard)/i.test(p) },
  { category: "voltage", test: (p) => /voltage/i.test(p) },
  { category: "pressure", test: (p) => /pressure/i.test(p) },
  { category: "humidity", test: (p) => /humidity/i.test(p) },
];

// Returns one of "position" | "temperature" | "velocity" | "heading" |
// "height" | "voltage" | "pressure" | "humidity", or null if the path isn't
// recognised.
function categorize(path) {
  if (path === POSITION_PATH) return "position";
  const rule = CATEGORY_RULES.find((r) => r.test(path));
  return rule ? rule.category : null;
}

module.exports = { categorize, CATEGORY_DEFAULTS, POSITION_PATH, DEFAULT_POSITION_RESOLUTION_DEG };
