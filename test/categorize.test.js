"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { categorize } = require("../lib/categorize");

describe("categorize", () => {
  test("recognises navigation.position as position", () => {
    assert.equal(categorize("navigation.position"), "position");
  });

  test("recognises temperature paths", () => {
    assert.equal(categorize("environment.water.temperature"), "temperature");
    assert.equal(categorize("propulsion.main.temperature"), "temperature");
  });

  test("recognises speed paths as velocity", () => {
    assert.equal(categorize("navigation.speedOverGround"), "velocity");
    assert.equal(categorize("navigation.speedThroughWater"), "velocity");
  });

  test("recognises heading/course/angle paths as heading", () => {
    assert.equal(categorize("navigation.headingTrue"), "heading");
    assert.equal(categorize("navigation.courseOverGroundTrue"), "heading");
    assert.equal(categorize("environment.wind.angleApparent"), "heading");
  });

  test("recognises depth/altitude/draft paths as height", () => {
    assert.equal(categorize("environment.depth.belowTransducer"), "height");
    assert.equal(categorize("navigation.gnss.antennaAltitude"), "height");
  });

  test("recognises voltage paths", () => {
    assert.equal(categorize("electrical.batteries.house.voltage"), "voltage");
  });

  test("recognises pressure paths", () => {
    assert.equal(categorize("environment.outside.pressure"), "pressure");
  });

  test("recognises humidity paths", () => {
    assert.equal(categorize("environment.outside.humidity"), "humidity");
  });

  test("returns null for unrecognised paths", () => {
    assert.equal(categorize("electrical.batteries.house.stateOfCharge"), null);
  });

  test("does not infer units from misleading compound path names", () => {
    assert.equal(categorize("performance.polarSpeedRatio"), null);
    assert.equal(categorize("navigation.magneticVariationAgeOfService"), null);
    assert.equal(categorize("performance.beatAngleVelocityMadeGood"), "velocity");
  });

  test("prefers declared Signal K units and rejects unknown unit categories", () => {
    assert.equal(categorize("custom.anything", "m/s"), "velocity");
    assert.equal(categorize("performance.polarSpeedRatio", "ratio"), null);
    assert.equal(categorize("environment.outside.humidity", "ratio"), "humidity");
  });
});
