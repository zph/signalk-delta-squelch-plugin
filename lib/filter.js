"use strict";

const { categorize, CATEGORY_DEFAULTS, POSITION_PATH, DEFAULT_POSITION_RESOLUTION_DEG } = require("./categorize");
const { haversineMeters, knotsToMs, roundTo } = require("./geo");

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
  constructor(config = {}, { now = () => Date.now(), getMetadata } = {}) {
    this.now = now;
    this.getMetadata = getMetadata;
    this.defaultHeartbeatSeconds = config.heartbeatSeconds ?? 5;
    this.defaultUnchangingCountThreshold = config.unchangingCountThreshold ?? 10;
    this.stateTtlMs = (config.stateTtlSeconds ?? 3600) * 1000;
    this.maxStateEntries = config.maxStateEntries ?? 10_000;
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
      minDistanceM: outlierCfg.minDistanceM ?? 2,
      confirmationCount: outlierCfg.confirmationCount ?? 2,
      maxConfirmationGapMs: (outlierCfg.maxConfirmationGapSeconds ?? 30) * 1000,
    };

    this.lastAccepted = new Map(); // key -> { raw, value, time }
    this.lastReceivedPosition = new Map(); // key -> latest plausible raw fix
    this.pendingSpike = new Map(); // key -> { lastPos, lastTime, count }
    this.unchangingCount = new Map(); // key -> consecutive identical readings seen, including the current one
    this.lastSeen = new Map(); // insertion order is least-recently-seen first
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
    const category = override?.category && override.category !== "custom" ? override.category : categorize(path, this._metadataUnits(path));
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
  // `isSelf` scopes GNSS-spike rejection to the vessel's own position reports
  // — a fast AIS contact isn't an "outlier" just because it isn't us.
  //
  // `source` is the preferred input update's `$source` (e.g. a specific
  // GPS/AIS device), and is folded into the state key below. If Signal K
  // changes preferred sources, the newly selected device starts with clean
  // quantizer and spike-detection state instead of being compared with the
  // previous device's fixes.
  process(context, path, rawValue, isSelf, source) {
    this.stats.total += 1;
    const key = `${context}:${path}:${source}`;
    const now = this.now();
    this._touch(key, now);

    // Text/boolean paths (switch/autopilot state, etc.) have no
    // physical resolution to round to, so they're handled uniformly here
    // rather than needing a recognised category like the numeric ones below.
    if (typeof rawValue === "boolean" || typeof rawValue === "string") {
      return this._processState(key, this._stateConfig(path), rawValue, now);
    }

    const cfg = this.resolveConfig(path);
    if (!cfg) return { keep: true, value: rawValue };

    if (cfg.category === "position") {
      if (!rawValue || typeof rawValue.latitude !== "number" || typeof rawValue.longitude !== "number") {
        return { keep: true, value: rawValue };
      }
      return this._processPosition(key, cfg, rawValue, now, isSelf, source);
    }

    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      return { keep: true, value: rawValue };
    }
    return this._processScalar(key, cfg, rawValue, now);
  }

  handles(path, value) {
    if (typeof path !== "string") return false;
    if (path === "notifications" || path.startsWith("notifications.")) return false;
    return typeof value === "boolean" || typeof value === "string" || this.resolveConfig(path) !== null;
  }

  prune(now = this.now()) {
    let removed = 0;
    for (const [key, seenAt] of this.lastSeen) {
      if (now - seenAt < this.stateTtlMs && this.lastSeen.size <= this.maxStateEntries) break;
      this._deleteKey(key);
      removed += 1;
    }
    return removed;
  }

  _metadataUnits(path) {
    if (typeof this.getMetadata !== "function") return undefined;
    try {
      return (this.getMetadata(`vessels.self.${path}`) || this.getMetadata(path))?.units;
    } catch {
      return undefined;
    }
  }

  _touch(key, now) {
    if (this.lastSeen.has(key)) this.lastSeen.delete(key);
    this.lastSeen.set(key, now);
    this.prune(now);
  }

  _deleteKey(key) {
    this.lastSeen.delete(key);
    this.lastAccepted.delete(key);
    this.lastReceivedPosition.delete(key);
    this.pendingSpike.delete(key);
    this.unchangingCount.delete(key);
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
    const moved = !prev || Math.abs(value - prev.value) >= cfg.resolution;
    const stale = prev && now - prev.time >= cfg.heartbeatMs;
    if (!moved && !stale) {
      this.stats.suppressed += 1;
      return { keep: false };
    }
    const rounded = roundTo(value, cfg.resolution);
    this.lastAccepted.set(key, { raw: value, value: rounded, time: now });
    return { keep: true, value: rounded };
  }

  _processPosition(key, cfg, value, now, isSelf, source) {
    const prev = this.lastAccepted.get(key);
    const lastReceived = this.lastReceivedPosition.get(key);

    if (this.outlier.enabled && isSelf && lastReceived) {
      const spike = this._isSpike(key, lastReceived, value, now);
      if (spike.reject) {
        this.stats.suppressed += 1;
        this.stats.spikes += 1;
        return {
          keep: false,
          reason: "spike",
          spike: {
            from: lastReceived.raw,
            to: value,
            source,
            distanceM: spike.distanceM,
            impliedSpeedMs: spike.impliedSpeedMs,
            elapsedS: spike.elapsedS,
          },
        };
      }
    }

    this.lastReceivedPosition.set(key, { raw: value, time: now });

    const moved =
      !prev ||
      Math.abs(value.latitude - prev.value.latitude) >= cfg.latResolution ||
      Math.abs(value.longitude - prev.value.longitude) >= cfg.lonResolution;
    const stale = prev && now - prev.time >= cfg.heartbeatMs;
    if (!moved && !stale) {
      this.stats.suppressed += 1;
      return { keep: false };
    }

    const rounded = {
      ...value,
      latitude: roundTo(value.latitude, cfg.latResolution),
      longitude: roundTo(value.longitude, cfg.lonResolution),
    };
    this.lastAccepted.set(key, { raw: value, value: rounded, time: now, source });
    return {
      keep: true,
      value: rounded,
    };
  }

  // Classic anchor-watch GNSS-glitch guard: reject a position implying a speed
  // beyond what the vessel can realistically do, unless several consecutive
  // readings agree on the new spot — that's real movement (e.g. after a GPS
  // dropout), not a one-off multipath/ionospheric spike. Tackles the big
  // single-fix jump; it does nothing for the slow, small-scale wander that
  // rounding/hysteresis above already handles.
  //
  // A jump under `minDistanceM` is never treated as a spike, regardless of
  // implied speed — at that scale it's ordinary GNSS scatter, and rejecting
  // it would throw away the very variation that lets a "cocked hat" of
  // recent fixes average out to a better position estimate than any single
  // fix. It also guards against the MIN_SPIKE_ELAPSED_S floor manufacturing
  // an inflated implied speed from a tiny, real distance over a near-zero
  // wall-clock gap.
  _isSpike(key, prev, value, now) {
    const elapsedS = Math.max((now - prev.time) / 1000, MIN_SPIKE_ELAPSED_S);
    const distanceM = haversineMeters(prev.raw, value);
    const impliedSpeedMs = distanceM / elapsedS;
    if (distanceM < this.outlier.minDistanceM || impliedSpeedMs <= this.outlier.maxSpeedMs) {
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
    return { reject: true, distanceM, impliedSpeedMs, elapsedS }; // still just a single/unconfirmed spike — reject
  }
}

module.exports = { SquelchFilter };
