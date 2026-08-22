"use strict";

const { categorize, CATEGORY_DEFAULTS, POSITION_PATH, DEFAULT_POSITION_RESOLUTION_DEG } = require("./categorize");
const { haversineMeters, knotsToMs, roundTo } = require("./geo");

// A value must move more than one rounding step (with this margin) past the
// last value actually forwarded before it's forwarded again. Comparing
// against the last *raw* forwarded value (not the rounded one) with a margin
// > 1 step is what stops a value sitting right on a rounding-grid boundary
// from chattering back and forth every sample.
const HYSTERESIS_FACTOR = 1.5;

// Floor for the elapsed time used in spike speed calculations. No real GPS
// or AIS source updates faster than this (a 10Hz GPS puck is still 100ms
// between fixes) — but two deltas for the same path can easily land within
// a millisecond of each other in wall-clock processing time (e.g. two NMEA
// sentences from the same burst, or two source devices both feeding
// navigation.position), well before the server's own source resolution
// happens downstream of this plugin. Dividing a tiny, real distance by that
// near-zero gap manufactures a physically impossible "implied speed" for
// what's actually just ordinary noise — flooring the gap at a realistic
// minimum keeps the spike check meaningful instead of firing on burst
// artifacts.
const MIN_SPIKE_ELAPSED_S = 0.05;

class SquelchFilter {
  constructor(config = {}, { now = () => Date.now() } = {}) {
    this.now = now;
    this.defaultHeartbeatSeconds = config.heartbeatSeconds ?? 60;
    this.defaultUnchangingCountThreshold = config.unchangingCountThreshold ?? 10;
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
    this.unchangingCount = new Map(); // key -> consecutive identical readings seen, including the current one
    this.stats = { total: 0, suppressed: 0, spikes: 0 };
  }

  // Returns the counts accumulated since the last call, and resets them —
  // lets a caller (e.g. an hourly log summary) sample a window without
  // needing its own clock/timer logic here.
  takeStats() {
    const stats = this.stats;
    this.stats = { total: 0, suppressed: 0, spikes: 0 };
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
  //
  // `source` is the delta update's `$source` (e.g. a specific GPS/AIS
  // device), and is folded into the state key below — this plugin runs
  // upstream of the server's own source-priority resolution (see
  // registerDeltaInputHandler in the docs), so a path fed by more than one
  // source is seen here as each source's raw, independently-noisy stream,
  // interleaved. Squelching per-path-and-source keeps one source's hysteresis
  // and spike tracking from being polluted by another's — otherwise a
  // legitimate correction from a poor fix to a better one (or vice versa,
  // after SignalK's priority rules pick a different source) can look like the
  // vessel teleporting relative to whichever source happened to report last.
  process(context, path, rawValue, isSelf, source) {
    this.stats.total += 1;
    const key = `${context}:${path}:${source}`;

    // Text/boolean paths (notifications, switch/autopilot state, ...) have no
    // physical resolution to round to, so they're handled uniformly here
    // rather than needing a recognised category like the numeric ones below.
    if (typeof rawValue === "boolean" || typeof rawValue === "string") {
      return this._processState(key, this._stateConfig(path), rawValue, this.now());
    }

    const cfg = this.resolveConfig(path);
    if (!cfg) return { keep: true, value: rawValue };

    if (cfg.category === "position") {
      if (!rawValue || typeof rawValue.latitude !== "number" || typeof rawValue.longitude !== "number") {
        return { keep: true, value: rawValue };
      }
      return this._processPosition(key, cfg, rawValue, this.now(), isSelf, source);
    }

    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      return { keep: true, value: rawValue };
    }
    return this._processScalar(key, cfg, rawValue, this.now());
  }

  _stateConfig(path) {
    const override = this.pathOverrides.get(path);
    return {
      heartbeatMs: (override?.heartbeatSeconds ?? this.defaultHeartbeatSeconds) * 1000,
      unchangingCountThreshold: override?.unchangingCountThreshold ?? this.defaultUnchangingCountThreshold,
    };
  }

  // Text/boolean values are deduplicated on exact equality rather than a
  // rounding resolution. The first `unchangingCountThreshold` consecutive
  // identical readings are still forwarded — only once a value has proven
  // itself steady for that long does it start being squelched — so a path
  // that only ever fires when something changes (the common case) never hits
  // the threshold and is never squelched at all.
  _processState(key, cfg, value, now) {
    const prev = this.lastAccepted.get(key);
    const changed = !prev || value !== prev.raw;
    const count = changed ? 1 : (this.unchangingCount.get(key) ?? 1) + 1;
    this.unchangingCount.set(key, count);

    const stale = prev && now - prev.time >= cfg.heartbeatMs;
    if (changed || count <= cfg.unchangingCountThreshold || stale) {
      this.lastAccepted.set(key, { raw: value, time: now });
      return { keep: true, value };
    }

    this.stats.suppressed += 1;
    return { keep: false };
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

  _processPosition(key, cfg, value, now, isSelf, source) {
    const prev = this.lastAccepted.get(key);

    if (this.outlier.enabled && isSelf && prev) {
      const spike = this._isSpike(key, prev, value, now);
      if (spike.reject) {
        this.stats.suppressed += 1;
        this.stats.spikes += 1;
        return {
          keep: false,
          reason: "spike",
          spike: {
            context: key,
            from: prev.raw,
            to: value,
            fromSource: prev.source,
            toSource: source,
            distanceM: spike.distanceM,
            impliedSpeedMs: spike.impliedSpeedMs,
          },
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

    this.lastAccepted.set(key, { raw: value, time: now, source });
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
    const elapsedS = Math.max((now - prev.time) / 1000, MIN_SPIKE_ELAPSED_S);
    const distanceM = haversineMeters(prev.raw, value);
    const impliedSpeedMs = distanceM / elapsedS;
    if (impliedSpeedMs <= this.outlier.maxSpeedMs) {
      this.pendingSpike.delete(key);
      return { reject: false };
    }

    const pending = this.pendingSpike.get(key);
    const gapMs = pending ? now - pending.lastTime : Infinity;
    const clusterSpeed = pending ? haversineMeters(pending.lastPos, value) / Math.max(gapMs / 1000, MIN_SPIKE_ELAPSED_S) : Infinity;
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
