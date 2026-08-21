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
    assert.equal(result.value, 288.15); // default temperature resolution is 0.01K
  });

  test("drops readings that don't move past the resolution's hysteresis margin", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "environment.water.temperature", 288.134, true);
    clock.advance(1000);
    const result = filter.process("vessels.self", "environment.water.temperature", 288.137, true); // +0.003, well under 0.015
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

describe("SquelchFilter — text/boolean state values", () => {
  test("forwards a changing string value every time", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    for (const state of ["standby", "auto", "wind", "standby"]) {
      clock.advance(1000);
      const result = filter.process("vessels.self", "steering.autopilot.state", state, true);
      assert.deepEqual(result, { keep: true, value: state });
    }
  });

  test("forwards a boolean value every time it changes", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    assert.equal(filter.process("vessels.self", "electrical.switches.nav.state", true, true).keep, true);
    clock.advance(1000);
    assert.equal(filter.process("vessels.self", "electrical.switches.nav.state", false, true).keep, true);
  });

  test("forwards the first n unchanging readings, then squelches, using the default threshold of 10", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    for (let i = 0; i < 10; i++) {
      clock.advance(1000);
      const result = filter.process("vessels.self", "navigation.state", "sailing", true);
      assert.equal(result.keep, true, `reading ${i + 1} of the first 10 should be forwarded`);
    }
    clock.advance(1000);
    const result = filter.process("vessels.self", "navigation.state", "sailing", true); // 11th identical reading
    assert.equal(result.keep, false);
  });

  test("resets the unchanging count once the value changes again", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ unchangingCountThreshold: 2 }, clock);
    filter.process("vessels.self", "navigation.state", "sailing", true);
    clock.advance(1000);
    filter.process("vessels.self", "navigation.state", "sailing", true);
    clock.advance(1000);
    assert.equal(filter.process("vessels.self", "navigation.state", "sailing", true).keep, false); // 3rd identical, past threshold
    clock.advance(1000);
    const changed = filter.process("vessels.self", "navigation.state", "motoring", true);
    assert.deepEqual(changed, { keep: true, value: "motoring" });
    clock.advance(1000);
    assert.equal(filter.process("vessels.self", "navigation.state", "motoring", true).keep, true); // back within the new threshold
  });

  test("unchangingCountThreshold is configurable", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ unchangingCountThreshold: 3 }, clock);
    for (let i = 0; i < 3; i++) {
      clock.advance(1000);
      assert.equal(filter.process("vessels.self", "navigation.state", "sailing", true).keep, true);
    }
    clock.advance(1000);
    assert.equal(filter.process("vessels.self", "navigation.state", "sailing", true).keep, false);
  });

  test("still forwards a heartbeat once suppressed", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ heartbeatSeconds: 10, unchangingCountThreshold: 1 }, clock);
    filter.process("vessels.self", "navigation.state", "sailing", true);
    clock.advance(1000);
    assert.equal(filter.process("vessels.self", "navigation.state", "sailing", true).keep, false); // squelched, past threshold of 1
    clock.advance(9500); // total 10.5s since last forward
    const result = filter.process("vessels.self", "navigation.state", "sailing", true);
    assert.equal(result.keep, true);
  });

  test("per-path unchangingCountThreshold override takes effect", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ paths: [{ path: "navigation.state", unchangingCountThreshold: 1 }] }, clock);
    filter.process("vessels.self", "navigation.state", "sailing", true);
    clock.advance(1000);
    const result = filter.process("vessels.self", "navigation.state", "sailing", true); // 2nd identical, past threshold of 1
    assert.equal(result.keep, false);
  });

  test("counts squelched state readings as suppressed", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ unchangingCountThreshold: 1 }, clock);
    filter.process("vessels.self", "navigation.state", "sailing", true);
    clock.advance(1000);
    filter.process("vessels.self", "navigation.state", "sailing", true); // suppressed
    assert.deepEqual(filter.takeStats(), { suppressed: 1, spikes: 0 });
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
    assert.equal(result.value.latitude, 55.772581);
    assert.equal(result.value.longitude, -4.857908);
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

  test("does not misclassify a tiny real movement as a spike just because it arrived ~1ms later in wall-clock time", () => {
    // Reproduces a field report: two navigation.position deltas landed ~1ms
    // apart in processing time (multiple sentences/sources in a burst, not
    // two genuinely independent fixes), 0.4m apart — naively dividing gives
    // an impossible ~365m/s "spike" for what's actually ordinary wander.
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "navigation.position", anchored, true);
    clock.advance(1); // 1ms — far below any real GPS/AIS update interval
    const nearby = { latitude: anchored.latitude + 0.0000036, longitude: anchored.longitude }; // ~0.4m away
    const result = filter.process("vessels.self", "navigation.position", nearby, true);
    assert.equal(result.keep, true);
    assert.notEqual(result.reason, "spike");
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

  test("reports the rejected spike's distance and implied speed", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "navigation.position", anchored, true);
    clock.advance(1000);
    const result = filter.process("vessels.self", "navigation.position", spike, true);
    assert.equal(result.reason, "spike");
    assert.deepEqual(result.spike.from, anchored);
    assert.deepEqual(result.spike.to, spike);
    assert.ok(result.spike.distanceM > 1000);
    assert.ok(result.spike.impliedSpeedMs > 100);
  });

  test("reports the source of both the accepted fix and the rejected spike", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "navigation.position", anchored, true, "garmin-gps.1");
    clock.advance(1000);
    const result = filter.process("vessels.self", "navigation.position", spike, true, "garmin-gps.1");
    assert.equal(result.spike.fromSource, "garmin-gps.1");
    assert.equal(result.spike.toSource, "garmin-gps.1");
  });
});

describe("SquelchFilter — per-source state isolation", () => {
  // This plugin runs upstream of the SignalK server's own source-priority
  // resolution, so a path fed by more than one source is seen here as each
  // source's raw, independent stream, interleaved — squelch state is keyed
  // by source (as well as context/path) so one source's readings are never
  // compared against another's.
  test("a different source's first fix is never spike-checked against another source's last position", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    const poorFix = { latitude: 55.772581, longitude: -4.857908 };
    filter.process("vessels.self", "navigation.position", poorFix, true, "teltonika-gps.1");
    clock.advance(1000);
    // ~1.1km away — would look like an impossible jump if compared against
    // the Teltonika fix, but it's a different device's very first reading.
    const betterFix = { latitude: 55.7826, longitude: -4.857908 };
    const result = filter.process("vessels.self", "navigation.position", betterFix, true, "garmin-gps.1");
    assert.equal(result.keep, true);
    assert.notEqual(result.reason, "spike");
  });

  test("two sources on the same numeric path are squelched independently", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "environment.water.temperature", 288.0, true, "sensorA");
    clock.advance(1000);
    // sensorB's first-ever reading is always forwarded, even though it's
    // close enough to sensorA's last value that source-less keying would
    // have squelched it as "no movement".
    const result = filter.process("vessels.self", "environment.water.temperature", 288.005, true, "sensorB");
    assert.equal(result.keep, true);
  });

  test("two sources on the same text path are squelched independently", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({ unchangingCountThreshold: 1 }, clock);
    filter.process("vessels.self", "navigation.state", "sailing", true, "sourceA");
    clock.advance(1000);
    assert.equal(filter.process("vessels.self", "navigation.state", "sailing", true, "sourceA").keep, false); // sourceA past its threshold
    clock.advance(1000);
    const result = filter.process("vessels.self", "navigation.state", "sailing", true, "sourceB"); // sourceB's first-ever reading
    assert.equal(result.keep, true);
  });
});

describe("SquelchFilter — stats", () => {
  test("starts at zero and is unaffected by kept values", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "environment.water.temperature", 288.0, true);
    assert.deepEqual(filter.takeStats(), { suppressed: 0, spikes: 0 });
  });

  test("counts squelched scalar and position readings as suppressed", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "environment.water.temperature", 288.0, true);
    clock.advance(1000);
    filter.process("vessels.self", "environment.water.temperature", 288.01, true); // suppressed
    assert.deepEqual(filter.takeStats(), { suppressed: 1, spikes: 0 });
  });

  test("counts a rejected GPS spike as both suppressed and a spike", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    const anchored = { latitude: 55.772581, longitude: -4.857908 };
    const spike = { latitude: 55.7826, longitude: -4.857908 };
    filter.process("vessels.self", "navigation.position", anchored, true);
    clock.advance(1000);
    filter.process("vessels.self", "navigation.position", spike, true); // rejected spike
    assert.deepEqual(filter.takeStats(), { suppressed: 1, spikes: 1 });
  });

  test("resets counts after being read", () => {
    const clock = makeClock(0);
    const filter = new SquelchFilter({}, clock);
    filter.process("vessels.self", "environment.water.temperature", 288.0, true);
    clock.advance(1000);
    filter.process("vessels.self", "environment.water.temperature", 288.01, true);
    filter.takeStats();
    assert.deepEqual(filter.takeStats(), { suppressed: 0, spikes: 0 });
  });
});
