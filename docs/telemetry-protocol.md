# Game telemetry protocol (optional, own-game targets only)

In-game time is an **optional enrichment, not a core assumption** (tech-stack
report §3.5). It applies only when the capture target is a game whose source
you control. Everything else — third-party games, videos, apps, device
mirrors — records marks with `videoMs` alone and the pipeline works unchanged.

The payoff: marks stamped `{videoMs, gameTimeMs}` make the
"I pause the game while dictating" case legible in reports — video time
advances while game time holds still.

## Protocol

The game hosts a tiny localhost HTTP endpoint; the recorder polls it
(default 2 Hz, configurable) while a session is running.

```
GET http://127.0.0.1:46333/playtest/time
```

Response — `200 OK`, `application/json`:

```json
{
  "gameTimeMs": 123456,
  "paused": false
}
```

| Field        | Type    | Meaning                                                        |
|--------------|---------|----------------------------------------------------------------|
| `gameTimeMs` | number  | Current in-game time in ms (your definition: run timer, level time, total play time — just be consistent). MUST NOT advance while the game is paused. |
| `paused`     | boolean | Whether the game is currently paused.                          |

`game_time_ms` (snake_case) is accepted as an alias. Unknown extra fields are
ignored — you can add `scene`, `level`, etc. for future event support.

Recorder behavior (apps/recorder/src/main/telemetry.ts):

- Poll failures are silent; after ~2.5 s without a good sample the telemetry
  is considered lost (logged as a session event) and marks fall back to
  `gameTimeMs: null`.
- At a mark, the recorder extrapolates from the last sample when unpaused
  (`gameTimeMs + (now - sampleTime)`) and freezes at `gameTimeMs` when paused.
- Sparse samples (every 5 s) are logged into the sidecar for timeline
  reconstruction.

Bind to `127.0.0.1` only — never `0.0.0.0`. A named-pipe transport is a
possible later addition for anti-cheat-sensitive contexts; HTTP-on-localhost
is the v1 because every engine can serve it in a few lines.

## Reference implementation

`sdk/unity/PlaytestTelemetry.cs` — drop the component into any scene
(Unity 2020+, no packages needed). Enable telemetry in the recorder settings
and start a session; the status log shows `telemetry-connected`.
