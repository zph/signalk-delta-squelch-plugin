"use strict";

const { categorize, CATEGORY_DEFAULTS, POSITION_PATH, DEFAULT_POSITION_RESOLUTION_DEG } = require("./categorize");
const { haversineMeters, knotsToMs, roundTo } = require("./geo");

// A value must move more than one rounding step (with this margin) past the
// last value actually forwarded before it's forwarded again. Comparing
// against the last *raw* forwarded value (not the rounded one) with a margin
// > 1 step is what stops a value sitting right on a rounding-grid boundary
// from chattering back and forth every sample.
const HYSTERESIS_FACTOR = 1.5;

class SquelchFilter {
  constructor(config = {}, { now = () => Date.now() } = {}) {
    this.now = now;
    this.defaultHeartbeatSeconds = config.heartbeatSeconds ?? 60;
    this.categoryResolution = { ...CATEGORY_DEFAULTS, ...config.categoryResolution };
    this.positionResolution = {
      latitude: config.positionResolution?.latitude ?? DEFAULT_POSITION_RESOLUTION_DEG,
      longitude: config.positionResolution?.longitude ?? DEFAULT_POSITION_RESOLUTION_DEG,
    };
    this.pathOverrides = new Map((config.paths || []).map((p) => [p.path, p]));

    const outlierCfg = config.positionOutlier || {};
    this.outlier = {
      enabled: outlierCfg.enabled ?? true,
      maxSpeedMs: knotsToMs(outlierCfg.maxVesselSpeedKnots ?? 25) * (outlierCfg.speedMarginMultiplier ?? 1.5),
      confirmationCount: outlierCfg.confirmationCount ?? 2,
      maxConfirmationGapMs: (outlierCfg.maxConfirmationGapSeconds ?? 30) * 1000,
    };

    this.lastAccepted = new Map(); // key -> { raw, time }
    this.pendingSpike = new Map(); // key -> { lastPos, lastTime, count }
    this.stats = { suppressed: 0, spikes: 0 };
  }

  // Returns the counts accumulated since the last call, and resets them —
  // lets a caller (e.g. an hourly log summary) sample a window without
  // needing its own clock/timer logic here.
  takeStats() {
    const stats = this.stats;
    this.stats = { suppressed: 0, spikes: 0 };
    return stats;
  }

  // Effective handling for a path: an explicit per-path override, else a
  // recognised category's default, else null (path is left untouched).
  resolveConfig(path) {
    const override = this.pathOverrides.get(path);
    const category = override?.category && override.category !== "custom" ? override.category : categorize(path);
    const heartbeatSeconds = override?.heartbeatSeconds ?? this.defaultHeartbeatSeconds;

    if (category === "position" || path === POSITION_PATH) {
      return {
        category: "position",
        latResolution: override?.latResolution ?? this.positionResolution.latitude,
        lonResolution: override?.lonResolution ?? this.positionResolution.longitude,
        heartbeatMs: heartbeatSeconds * 1000,
      };
    }

    const resolution = override?.resolution ?? this.categoryResolution[category];
    if (resolution === undefined || resolution === null) return null;
    return { category: category || "custom", resolution, heartbeatMs: heartbeatSeconds * 1000 };
  }

  // Returns { keep: false } to drop the value entirely, or
  // { keep: true, value } with the value replaced by its rounded form.
  // `isSelf` scopes GPS-spike rejection to the vessel's own position reports
  // — a fast AIS contact isn't an "outlier" just because it isn't us.
  process(context, path, rawValue, isSelf) {
    const cfg = this.resolveConfig(path);
    if (!cfg) return { keep: true, value: rawValue };

    if (cfg.category === "position") {
      if (!rawValue || typeof rawValue.latitude !== "number" || typeof rawValue.longitude !== "number") {
        return { keep: true, value: rawValue };
      }
      return this._processPosition(`${context}:${path}`, cfg, rawValue, this.now(), isSelf);
    }

    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      return { keep: true, value: rawValue };
    }
    return this._processScalar(`${context}:${path}`, cfg, rawValue, this.now());
  }

  _processScalar(key, cfg, value, now) {
    const prev = this.lastAccepted.get(key);
    const moved = !prev || Math.abs(value - prev.raw) >= cfg.resolution * HYSTERESIS_FACTOR;
    const stale = prev && now - prev.time >= cfg.heartbeatMs;
    if (!moved && !stale) {
      this.stats.suppressed += 1;
      return { keep: false };
    }
    this.lastAccepted.set(key, { raw: value, time: now });
    return { keep: true, value: roundTo(value, cfg.resolution) };
  }

  _processPosition(key, cfg, value, now, isSelf) {
    const prev = this.lastAccepted.get(key);

    if (this.outlier.enabled && isSelf && prev) {
      const spike = this._isSpike(key, prev, value, now);
      if (spike.reject) {
        this.stats.suppressed += 1;
        this.stats.spikes += 1;
        return {
          keep: false,
          reason: "spike",
          spike: { context: key, from: prev.raw, to: value, distanceM: spike.distanceM, impliedSpeedMs: spike.impliedSpeedMs },
        };
      }
    }

    const moved =
      !prev ||
      Math.abs(value.latitude - prev.raw.latitude) >= cfg.latResolution * HYSTERESIS_FACTOR ||
      Math.abs(value.longitude - prev.raw.longitude) >= cfg.lonResolution * HYSTERESIS_FACTOR;
    const stale = prev && now - prev.time >= cfg.heartbeatMs;
    if (!moved && !stale) {
      this.stats.suppressed += 1;
      return { keep: false };
    }

    this.lastAccepted.set(key, { raw: value, time: now });
    return {
      keep: true,
      value: { latitude: roundTo(value.latitude, cfg.latResolution), longitude: roundTo(value.longitude, cfg.lonResolution) },
    };
  }

  // Classic anchor-watch GPS-glitch guard: reject a position implying a speed
  // beyond what the vessel can realistically do, unless several consecutive
  // readings agree on the new spot — that's real movement (e.g. after a GPS
  // dropout), not a one-off multipath/ionospheric spike. Tackles the big
  // single-fix jump; it does nothing for the slow, small-scale wander that
  // rounding/hysteresis above already handles.
  _isSpike(key, prev, value, now) {
    const elapsedS = Math.max((now - prev.time) / 1000, 0.001);
    const distanceM = haversineMeters(prev.raw, value);
    const impliedSpeedMs = distanceM / elapsedS;
    if (impliedSpeedMs <= this.outlier.maxSpeedMs) {
      this.pendingSpike.delete(key);
      return { reject: false };
    }

    const pending = this.pendingSpike.get(key);
    const gapMs = pending ? now - pending.lastTime : Infinity;
    const clusterSpeed = pending ? haversineMeters(pending.lastPos, value) / Math.max(gapMs / 1000, 0.001) : Infinity;
    const consistent = pending && gapMs <= this.outlier.maxConfirmationGapMs && clusterSpeed <= this.outlier.maxSpeedMs;

    if (consistent) {
      pending.count += 1;
      pending.lastPos = value;
      pending.lastTime = now;
    } else {
      this.pendingSpike.set(key, { lastPos: value, lastTime: now, count: 1 });
    }

    if (this.pendingSpike.get(key).count >= this.outlier.confirmationCount) {
      this.pendingSpike.delete(key);
      return { reject: false }; // confirmed as real movement — let it through
    }
    return { reject: true, distanceM, impliedSpeedMs }; // still just a single/unconfirmed spike — reject
  }
}

module.exports = { SquelchFilter };
