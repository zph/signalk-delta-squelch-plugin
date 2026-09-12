# signalk-delta-squelch-plugin

> This is a safety-focused fork of
> [`rhizomatics/signalk-delta-squelch-plugin`](https://github.com/rhizomatics/signalk-delta-squelch-plugin).
> Many thanks to Jey Burrows and the upstream contributors for creating and
> sharing the original plugin. I am happy to upstream useful changes; this fork
> is where I am iterating to learn which behavior is safe and practical aboard.

[![Signal K Plugin CI](https://github.com/zph/signalk-delta-squelch-plugin/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/zph/signalk-delta-squelch-plugin/actions/workflows/signalk-ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Publishes a lower-noise derived Signal K stream while preserving the original
sensor data. Numeric measurements are quantized to configurable real-world
resolution, repeated state values are thinned, and own-vessel GNSS spikes can
be rejected from the derived stream.

## Safety model

This fork does **not** use `registerDeltaInputHandler` and does not delete or
rewrite incoming deltas. Raw values still reach Signal K's cache, source
priority engine, alarms, derived-data plugins, historians, and clients.

The plugin subscribes to Signal K's preferred raw values while excluding its
own output, then publishes accepted values under the separate source:

```text
signalk-delta-squelch-plugin
```

This requires Signal K 2.31.1 or newer, whose plugin subscriptions support
`excludeSelf`. The callback also rejects its own source defensively.

Nothing uses the derived stream automatically. To display it as the current
value, rank `signalk-delta-squelch-plugin` above the physical sources for the
specific paths you want filtered. The plugin's self-excluding subscription
continues to receive the preferred physical source, so this does not create a
feedback loop.

Keep raw sources available to anchor alarms, forensic logging, and statistical
aggregation until the configuration has been validated with recorded boat
data. A sample-count mean of an intentionally thinned derived stream is not the
same as the mean of the raw samples.

## What it does

For supported values, the derived stream:

1. Quantizes numeric measurements to a configured resolution.
2. Emits a changed numeric value once it moves one full resolution step from
   the displayed value. This avoids boundary chatter while keeping maximum lag
   below one step.
3. Thins repeated strings and booleans after a configurable count.
4. Republishes an unchanged value after the refresh interval **only when a new
   raw sample arrives**. It never fabricates a heartbeat after a sensor stops.
5. Rejects an implausible own-vessel position jump until consecutive fixes
   confirm the new location.

Position output preserves every property in the input object, including
`altitude`; only latitude and longitude are quantized.

GNSS speed checks use the latest plausible received fix, not the last emitted
fix. Suppressing stable positions therefore cannot make the detector weaker as
time passes.

Inactive filter state expires after one hour by default. A separate maximum
entry count bounds retained state even on servers that see many AIS contexts.

## Unit-safe categories

Signal K metadata units take precedence over path names. An explicit path
override takes precedence over both. If metadata is unavailable, only
conservative leaf-name and well-known namespace rules are used.

| Category      | Signal K unit             |           Default resolution |
| ------------- | ------------------------- | ---------------------------: |
| Position      | position object           | 0.000001° latitude/longitude |
| Temperature   | `K`                       |                       0.01 K |
| Velocity      | `m/s`                     |                     0.05 m/s |
| Heading/angle | `rad`                     |                  0.01745 rad |
| Height/depth  | `m`                       |                        0.1 m |
| Voltage       | `V`                       |                        0.1 V |
| Pressure      | `Pa`                      |                       100 Pa |
| Humidity      | `ratio` on humidity paths |                        0.001 |

Compound names no longer determine units. For example,
`performance.polarSpeedRatio` is not treated as velocity, and
`navigation.magneticVariationAgeOfService` is not treated as an angle.

## GNSS spike rejection

A position that implies more than the configured vessel speed and safety
margin is withheld from the derived stream. If the configured number of
consecutive fixes cluster at the new location, the move is accepted as real.
Small jumps below `minDistanceM` are always allowed.

Rejection is limited to `app.selfContext`; fast AIS targets are not treated as
own-vessel glitches. State is isolated by input source so the first position
from a newly selected GNSS receiver is never compared with another receiver.

This protects only the derived output. The original position remains available
under its physical source for diagnostics and safety consumers.

## Configuration

- **Maximum output silence while input continues**: defaults to 5 seconds and
  can be overridden per path. Keep it shorter than the applicable source
  priority failover timeout.
- **Unchanging value threshold**: repeated string/boolean values forwarded
  before thinning starts; defaults to 10.
- **Category resolution**: quantization steps in native Signal K SI units.
- **Position resolution**: independent latitude and longitude steps.
- **Position outlier settings**: maximum vessel speed, margin, minimum jump,
  confirmation count, and confirmation window.
- **Inactive state retention**: expiry for context/path/source state; defaults
  to 3600 seconds.
- **Maximum tracked state entries**: least-recently-seen entries are evicted at
  this bound; defaults to 10,000.
- **Path overrides**: explicit category, resolution, refresh interval, or state
  repetition count.

## Install this fork

Until the changes are published under a distinct npm package, install the fork
from GitHub in the Signal K settings directory:

```bash
cd ~/.signalk
npm install github:zph/signalk-delta-squelch-plugin
```

Enable **Delta Squelch** under **Apps & Plugins → Configuration**, then add its
derived source to source priority only for paths you have validated.

## Verification

```bash
npm ci
npm test
npm run test:integration
npm run test:coverage
npm run lint
npm run fmt:check
```

The test suite covers raw-data preservation, derived-source publication,
position field preservation, recent-fix GNSS checks, conservative unit
classification, bounded state, and quantization lag.

## License

Apache-2.0. See [LICENSE](LICENSE) and the upstream project for attribution and
history.
