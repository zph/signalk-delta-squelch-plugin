"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { SquelchFilter } = require("../lib/filter");

function makeClock(startMs) {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("SquelchFilter — unrecognised paths", () => {
  test("passes values through unchanged", () => {
    const filter = new SquelchFilter();
    const result = filter.process("vessels.self", "electrical.batteries.house.stateOfCharge", 12.68765, true);
    assert.deepEqual(result, { keep: true, value: 12.68765 });
  });
});

describe("SquelchFilter — scalar categories (e.g. temperature)", () => {
  test("keeps the first reading, rounded", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    const result = filter.process("vessels.self", "environment.water.temperature", 288.146, true);
    assert.equal(result.keep, true);
    assert.equal(result.value, 288.1); // default temperature resolution is 0.1K
  });

  test("drops readings that don't move past the resolution's hysteresis margin", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "environment.water.temperature", 288.14, true);
    clock.advance(1000);
    const result = filter.process("vessels.self", "environment.water.temperature", 288.17, true); // +0.03, well under 0.15
    assert.equal(result.keep, false);
  });

  test("forwards once the raw value moves past the hysteresis margin", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "environment.water.temperature", 288.0, true);
    clock.advance(1000);
    const result = filter.process("vessels.self", "environment.water.temperature", 288.2, true); // +0.2, past 0.15 margin
    assert.equal(result.keep, true);
    assert.equal(result.value, 288.2);
  });

  test("forwards a heartbeat once the interval elapses, even with no movement", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ heartbeatSeconds: 10 }, clock);
    filter.process("vessels.self", "environment.water.temperature", 288.0, true);
    clock.advance(5000);
    assert.equal(filter.process("vessels.self", "environment.water.temperature", 288.01, true).keep, false);
    clock.advance(6000); // total 11s since last forward
    const result = filter.process("vessels.self", "environment.water.temperature", 288.01, true);
    assert.equal(result.keep, true);
  });
});

describe("SquelchFilter — position rounding", () => {
  // The exact noisy at-anchor sequence from the field report this plugin exists for.
  const samples = [
    { latitude: 55.772581233333334, longitude: -4.857908233333333 },
    { latitude: 55.7725812, longitude: -4.857908233333333 },
    { latitude: 55.7725811, longitude: -4.8579082499999995 },
    { latitude: 55.77258103333333, longitude: -4.857908383333333 },
    { latitude: 55.77258101666666, longitude: -4.857908366666667 },
    { latitude: 55.772580966666666, longitude: -4.8579083333333335 },
  ];

  test("keeps the first fix, rounded to the configured resolution", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    const result = filter.process("vessels.self", "navigation.position", samples[0], true);
    assert.equal(result.keep, true);
    assert.equal(result.value.latitude, 55.77258);
    assert.equal(result.value.longitude, -4.85791);
  });

  test("squelches subsequent at-anchor GPS wander that never exceeds the resolution", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "navigation.position", samples[0], true);
    for (let i = 1; i < samples.length; i++) {
      clock.advance(5000);
      const result = filter.process("vessels.self", "navigation.position", samples[i], true);
      assert.equal(result.keep, false, `sample ${i} should have been squelched`);
    }
  });

  test("per-path lat/lon resolution overrides take effect", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ paths: [{ path: "navigation.position", latResolution: 0.001, lonResolution: 0.001 }] }, clock);
    const result = filter.process("vessels.self", "navigation.position", samples[0], true);
    assert.equal(result.value.latitude, 55.773);
    assert.equal(result.value.longitude, -4.858);
  });
});

describe("SquelchFilter — position outlier (anchor-watch GPS spike) rejection", () => {
  const anchored = { latitude: 55.772581, longitude: -4.857908 };
  // ~1.1km away — reachable only at an unrealistic speed within a few seconds.
  const spike = { latitude: 55.7826, longitude: -4.857908 };

  test("rejects a single GPS spike implying an unrealistic speed", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "navigation.position", anchored, true);
    clock.advance(1000);
    const result = filter.process("vessels.self", "navigation.position", spike, true);
    assert.equal(result.keep, false);
  });

  test("accepts the jump once enough consecutive readings confirm it", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "navigation.position", anchored, true);
    clock.advance(1000);
    assert.equal(filter.process("vessels.self", "navigation.position", spike, true).keep, false);
    clock.advance(1000);
    const result = filter.process("vessels.self", "navigation.position", spike, true); // 2nd confirming sample
    assert.equal(result.keep, true);
  });

  test("does not apply outlier rejection to non-self contexts (e.g. AIS targets)", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    const otherVessel = "vessels.urn:mrn:imo:mmsi:235094115";
    filter.process(otherVessel, "navigation.position", anchored, false);
    clock.advance(1000);
    const result = filter.process(otherVessel, "navigation.position", spike, false);
    assert.equal(result.keep, true);
  });

  test("can be disabled via config", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ positionOutlier: { enabled: false } }, clock);
    filter.process("vessels.self", "navigation.position", anchored, true);
    clock.advance(1000);
    const result = filter.process("vessels.self", "navigation.position", spike, true);
    assert.equal(result.keep, true);
  });
});
