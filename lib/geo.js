"use strict";

const EARTH_RADIUS_M = 6371000;
const KNOTS_TO_MS = 0.514444;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two {latitude, longitude} points, in metres.
function haversineMeters(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function knotsToMs(knots) {
  return knots * KNOTS_TO_MS;
}

// Snap a value to the nearest multiple of `resolution`. A resolution of 0 or
// undefined means "no rounding" (used for paths without a sensible default).
// toPrecision strips the binary float noise a plain multiply/divide leaves
// behind (e.g. 288.09999999999997 instead of 288.1) — the whole point is to
// hand consumers a clean, sensible value, not just fewer of them.
function roundTo(value, resolution) {
  if (!resolution) return value;
  const snapped = Math.round(value / resolution) * resolution;
  return Number(snapped.toPrecision(12));
}

module.exports = { haversineMeters, knotsToMs, roundTo };
