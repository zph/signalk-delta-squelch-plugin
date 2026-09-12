"use strict";

const POSITION_PATH = "navigation.position";

// Default rounding resolution per category, in that path's native SignalK SI
// unit. Position is handled separately (per-axis, in degrees) since lat/lon
// aren't a single scalar path.
const CATEGORY_DEFAULTS = {
  temperature: 0.01, // K (== 0.01 degC step)
  velocity: 0.05, // m/s (~0.1 knot)
  heading: 0.01745, // rad (~1 degree)
  height: 0.1, // m (depth, altitude, draft, freeboard...)
  voltage: 0.1, // V
  pressure: 100, // Pa (== 1 mbar)
  humidity: 0.001, // ratio, 0-1 (== 0.1%)
};

const DEFAULT_POSITION_RESOLUTION_DEG = 0.000001; // ~0.11m at the equator

const UNIT_CATEGORIES = new Map([
  ["K", "temperature"],
  ["m/s", "velocity"],
  ["rad", "heading"],
  ["m", "height"],
  ["V", "voltage"],
  ["Pa", "pressure"],
]);

// Conservative fallbacks for servers or custom paths without metadata. These
// match complete leaf names or well-known namespaces, never arbitrary words
// in an ancestor/compound path (for example polarSpeedRatio is not velocity).
const CATEGORY_RULES = [
  { category: "temperature", test: (p) => /(?:^|\.)[^.]*temperature$/i.test(p) },
  {
    category: "velocity",
    test: (p) => /(?:^|\.)(?:speed[A-Z][^.]*|velocityMadeGood|beatAngleVelocityMadeGood)$/i.test(p),
  },
  {
    category: "heading",
    test: (p) =>
      /(?:^|\.)(?:heading(?:True|Magnetic)|courseOverGround(?:True|Magnetic)|angle(?:Apparent|TrueWater)|direction(?:True|Magnetic)|magnetic(?:Variation|Deviation))$/i.test(
        p,
      ),
  },
  { category: "height", test: (p) => /(?:^|\.)(?:depth\.[^.]+|[^.]*(?:height|altitude|draft|freeboard))$/i.test(p) },
  { category: "voltage", test: (p) => /(?:^|\.)[^.]*voltage$/i.test(p) },
  { category: "pressure", test: (p) => /(?:^|\.)[^.]*pressure$/i.test(p) },
  { category: "humidity", test: (p) => /(?:^|\.)[^.]*humidity$/i.test(p) },
];

// Returns one of "position" | "temperature" | "velocity" | "heading" |
// "height" | "voltage" | "pressure" | "humidity", or null if the path isn't
// recognised.
function categorize(path, units) {
  if (path === POSITION_PATH) return "position";

  if (units !== undefined && units !== null) {
    const unitCategory = UNIT_CATEGORIES.get(units);
    if (unitCategory) return unitCategory;
    if (units === "ratio" && /(?:^|\.)[^.]*humidity$/i.test(path)) return "humidity";
    return null;
  }

  const rule = CATEGORY_RULES.find((r) => r.test(path));
  return rule ? rule.category : null;
}

module.exports = { categorize, CATEGORY_DEFAULTS, POSITION_PATH, DEFAULT_POSITION_RESOLUTION_DEG, UNIT_CATEGORIES };
