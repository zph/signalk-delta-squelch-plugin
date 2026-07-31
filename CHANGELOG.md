# Changelog

All notable changes to this plugin are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.3.0]

- Additional logging, to summarize suppressed deltas, and for spike detection

## [0.2.0]

- Added voltage, humidity and pressure to scope

## [0.1.0]

- Initial release
- Rounds/squelches position, temperature, velocity, heading, and height paths via `registerDeltaInputHandler`
- Anchor-watch GPS spike rejection for the vessel's own position, with multi-sample confirmation for real jumps, ignores other AIS vessels
- Per-path overrides (category, resolution, lat/lon resolution, heartbeat)
