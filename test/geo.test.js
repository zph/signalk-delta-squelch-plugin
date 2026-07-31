"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { haversineMeters, knotsToMs, roundTo } = require("../lib/geo");

describe("haversineMeters", () => {
  test("is zero for an identical point", () => {
    const p = { latitude: 55.772581, longitude: -4.857908 };
    assert.equal(haversineMeters(p, p), 0);
  });

  test("matches a known one-degree-of-latitude distance (~111.2km)", () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 1, longitude: 0 };
    const d = haversineMeters(a, b);
    assert.ok(Math.abs(d - 111195) < 100, `expected ~111195m, got ${d}`);
  });
});

describe("knotsToMs", () => {
  test("converts knots to m/s", () => {
    assert.ok(Math.abs(knotsToMs(1) - 0.514444) < 1e-9);
    assert.equal(knotsToMs(0), 0);
  });
});

describe("roundTo", () => {
  test("snaps to the nearest multiple of the resolution", () => {
    assert.equal(roundTo(55.772581233333334, 0.00001), 55.77258);
    assert.equal(roundTo(1.23, 0.1), 1.2);
    assert.equal(roundTo(1.26, 0.1), 1.3);
  });

  test("passes the value through unchanged when resolution is falsy", () => {
    assert.equal(roundTo(1.23456, 0), 1.23456);
    assert.equal(roundTo(1.23456, undefined), 1.23456);
  });
});
