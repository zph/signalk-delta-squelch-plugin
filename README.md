# signalk-delta-squelch-plugin

Cuts noisy, redundant SignalK deltas at the source, before they reach the full
data model, other plugins, or connected clients.

BETA, use at own risk.

## The problem

Sources like GPS receivers emit far more precision, and far more frequent
updates, than the physical measurement actually supports. At anchor, a typical
GPS fix wanders by several metres from multipath and receiver noise alone —
producing a stream of deltas like:

```json
{"path": "navigation.position", "value": {"latitude": 54.372581233333334, "longitude": -4.907908233333333}}
{"path": "navigation.position", "value": {"latitude": 54.3725812,         "longitude": -4.907908233333333}}
{"path": "navigation.position", "value": {"latitude": 54.3725811,         "longitude": -4.9079082499999995}}
```

None of that movement is real; all of it costs CPU, eMMC and SD Card wear, and power to generate, log, and re-broadcast — multiplied by every plugin and client subscribed to the path. Throttling a single websocket subscription doesn't help: the noise is still generated, still processed by every other consumer, and often still written to disk.

## What this plugin does

It registers a [`registerDeltaInputHandler`](https://demo.signalk.org/documentation/develop/plugins/server_plugin_api.html)
— a hook that runs _before_ the server applies a delta to the full data model
or forwards it to anyone. For each value on a recognised path, it:

1. **Rounds** the value to a resolution matching the sensor's real-world
   accuracy (configurable per category, or per path).
2. **Squelches** updates that don't move past that resolution, so consumers
   see clean, sensible numbers arriving only when something actually changed.
3. Still forwards a **heartbeat** at a configurable interval even with no
   change, so nothing downstream mistakes a quiet source for a dead one.
4. Optionally **rejects GPS position spikes** — the classic anchor-watch
   false-alarm cause, where a single bad fix implies the boat teleported.

Everything is gated on the _raw_ value with a hysteresis margin (1.5× the
rounding step), not the rounded value — a reading sitting right on a rounding
boundary won't flip back and forth every sample.

### Categories and defaults

| Category      | Matches (auto-detected)                                      | Default resolution         |
| ------------- | ------------------------------------------------------------ | -------------------------- |
| `position`    | `navigation.position` only                                   | 0.00001° lat & lon (~1.1m) |
| `temperature` | any path containing "temperature"                            | 0.1 K                      |
| `velocity`    | any path containing "speed"                                  | 0.05 m/s (~0.1 knot)       |
| `heading`     | heading / course / angle / direction / variation / deviation | 0.01745 rad (~1°)          |
| `height`      | depth / height / altitude / draft / freeboard                | 0.1 m                      |
| `voltage`     | any path containing "voltage"                                | 0.1 V                      |
| `pressure`    | any path containing "pressure"                               | 100 Pa (1 mbar)            |
| `humidity`    | any path containing "humidity"                               | 0.001 (0.1%)               |

Any path that doesn't match one of these is passed through untouched unless
you add an explicit override.

### Position outlier rejection (anchor-watch GPS spikes)

A single position implying a speed above your configured maximum (with a
safety margin) is treated as a GPS glitch and dropped — the boat stays at its
last good fix. If several readings in a row _agree_ on the new location
within a short window, it's accepted as real movement (e.g. after a GPS
dropout), not a one-off spike.

This only applies to the vessel's own position (`app.selfContext`) — an AIS
target moving fast isn't an anomaly just because it isn't us — and it only
addresses large, single-fix jumps. It does **not** fix slow GPS wander at
anchor - these are genuinely different problems: a spike is one bad sample surrounded by good ones, wander is every sample being slightly wrong in a way no single-sample check can detect.

## Configuration

All of the above is configurable from the plugin's config screen:

- **Heartbeat interval** — global default, overridable per path.
- **Default rounding resolution per category** — temperature, velocity,
  heading, height, voltage, pressure, humidity (native SignalK SI units), and
  position (lat/lon in degrees, settable independently).
- **Position outlier settings** — enable/disable, max vessel speed (knots),
  safety margin multiplier, confirmation count, and confirmation window.
- **Path-specific overrides** — add a path to set its own resolution (or
  lat/lon resolution, for position-shaped paths), category, or heartbeat,
  overriding the category default or handling a path that isn't
  auto-recognised.

## Install

Install from the SignalK admin UI **Appstore**, or:

```bash
cd ~/.signalk && npm install @rhizomatics/signalk-delta-squelch-plugin
```

Then enable it under Server → Plugin Config → Delta Squelch.

## License

Apache-2.0
