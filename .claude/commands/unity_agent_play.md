---
name: unity_agent_play
description: Play DungeonSweeper2 inside the Unity Editor via a Unity MCP bridge — enter Play Mode, simulate the game's two controls (left-click reveal/attack, right-click flag/context menu) on board tiles, read game state and the console, take screenshots, and report findings. Swappable personalities find bugs or evaluate game balance, new-player onboarding, and experienced-player depth.
model: sonnet
---

# Unity Agent Play (In-Editor)

You play **DungeonSweeper2 in the Unity Editor** in a closed loop — **act → read state → read
console → (screenshot) → decide → repeat** — to find bugs or evaluate game balance by actually
playing.

The game is a 2D mobile-style Minesweeper dungeon crawler with essentially **two controls**:
- **Left-click a tile** — reveal it (Hidden → fight/reveal) or, on an already-revealed object,
  interact/attack/consume it (Revealed → Conquered).
- **Right-click a tile** (or long-press on mobile) — toggle the **TileContextMenu** to flag or
  annotate the tile.

Everything else is menu/UI buttons. Gameplay is turn-based, so tool-call latency is never a
problem; you do not need to freeze the game to think.

## Starting point

The parameter (optional) names the personality to run (default `bug-hunter`):
- `bug-hunter` — adversarial QA: exceptions, softlocks, illegal states, visual bugs. Click
  everything, in weird orders, at boundaries.
- `balance-tester` — play many boards, record outcomes: win/loss, deaths and their causes, HP/level
  curve over the run, which tiles/classes feel over/underpowered. Report with numbers.
- `new-player` — play naively; is the game learnable, fair, and readable without prior knowledge?
- `experienced-player` — play optimally; skill ceiling, dominant strategies, replayability.

## One-time setup: the Unity MCP bridge

This skill drives the Editor through a **Unity MCP server** (recommended:
[MCP for Unity by CoplayDev](https://github.com/CoplayDev/unity-mcp), free, supports Unity 6).
Setup, once:

1. In Unity: **Window → Package Manager → Install package from git URL**, using the URL from the
   repo README above.
2. Open the package's setup window (**Window → MCP For Unity**) and use its auto-configure for
   **Claude Code** — it registers the server in the MCP client config. Restart the Claude Code
   session so the tools appear.
3. Verify: list the MCP tools. You need, in whatever names the installed version uses:
   **run C# in the editor (`execute_code`)**, **read the console**, **control play mode / editor
   state**, and ideally **screenshot the Game view**. If a capability is missing, the fallback is
   an editor helper script (see Notes).

The Unity Editor must be open with the project loaded (main scene: `Assets/Scenes/Game.unity`).

## How to play (the two controls)

Prefer the **semantic path** — call the same public methods the UI events call. It is exact,
deterministic, and immune to canvas scaling. All examples run via the MCP `execute_code` tool.

**Get a tile** (board is `Grid`, reachable through the `ServiceLocator` singleton; coordinates are
`(x, y)` from `(0,0)`; grid size is discovered by probing bounds):

```csharp
var grid = ServiceLocator.Instance.Grid;
var tile = grid.GetTileTransform(x, y).GetComponent<Tile>();   // null transform = out of bounds
```

**Left-click** (reveal / attack / consume — full game logic, including safety interlocks):

```csharp
tile.OnTileClicked();
```

**Right-click** (toggle flag/context menu — go through the pointer handler so it behaves exactly
like a real right-click):

```csharp
var ev = new UnityEngine.EventSystems.PointerEventData(UnityEngine.EventSystems.EventSystem.current)
         { button = UnityEngine.EventSystems.PointerEventData.InputButton.Right };
tile.OnPointerDown(ev);
// The TileContextMenu is now open for this tile — drive its buttons to place a flag,
// or send the same right-click again to toggle it closed.
```

**Raw input path (optional check):** occasionally also click via the MCP input-simulation tool at
the tile's screen position, to exercise the real EventSystem/GraphicRaycaster/`GridDragger` path:

```csharp
// Screen position of a tile (Canvas is Screen Space Overlay):
var rt = (RectTransform)tile.transform;
Vector2 screen = RectTransformUtility.WorldToScreenPoint(null, rt.position);
```

Use semantic clicks for the bulk of play; use a few raw clicks per session to confirm the input
layer itself works (drag-to-scroll the board via `GridDragger` counts too — wide boards scroll
horizontally).

## Reading state

```csharp
var grid   = ServiceLocator.Instance.Grid;
var player = ServiceLocator.Instance.Player;
// Per tile: tile.State (Hidden/Revealed/RevealThroughCombat/Conquered/Empty...),
//           tile.XCoordinate, tile.YCoordinate, tile.GetHousedObject()?.name
// Helpers:  grid.IsTileRevealed(x,y), grid.TEMP_GetTotalNeighborPower(x,y), grid.InGridBounds(x,y)
// Player:   player.CurrentPlayerHealth, player.CurrentPlayerLevel
```

Return a compact JSON snapshot from `execute_code` (board as a grid of state chars + player stats)
rather than dumping objects — you will read it every turn.

After **every** action: read the console (errors + exceptions are the bug-hunter's primary
signal). Screenshot the Game view on a cadence (every ~5–10 actions, plus immediately after
anything surprising) to catch visual bugs the state can't show.

## The loop

1. Ensure Play Mode is running (enter it via the MCP editor-state tool). Wait for the board to
   generate, then take an initial snapshot + screenshot.
2. Decide an action from the personality's goals + current snapshot. Play like the personality
   would — don't cheat with information a player can't see (`bug-hunter` may cheat; players don't).
3. Execute (left-click / right-click / UI button / drag). Wait ~0.5s for DOTween animations before
   snapshotting — state changes can lag the click slightly.
4. Read console → read state → note anything anomalous with the screenshot/step number.
5. Repeat. On game over (or win), record the outcome; for `balance-tester`, exit and re-enter Play
   Mode for a fresh board and keep a running tally across runs (aim for 10+ runs before drawing
   conclusions; you may raise `Time.timeScale` via `execute_code` to grind faster).

## Report

Write findings to `thoughts/shared/agent_play/<YYYY-MM-DD>-<personality>.md`:
- `bug-hunter`: each bug with severity, repro steps (exact clicks/coordinates), console output,
  and screenshot references.
- `balance-tester`: outcome table (runs, wins, deaths by cause), HP/level curves, per-tile-type
  threat assessment, and concrete tuning suggestions.
- player personalities: a narrated assessment with moments (step numbers) backing each claim.

## Notes

- **Editor-only.** This skill drives Play Mode through the MCP editor bridge; it does not cover
  standalone or WebGL builds.
- **Never edit scripts while in Play Mode** — a recompile triggers domain reload and kills the run.
  Finish/abort the run first.
- **Game-logic interlocks are features, not bugs**: left-clicking a tile annotated as a known mine
  is blocked when the safe-mines option is on ("Error" sfx + shake), as is a click that
  `PreventConsumeIfKillingBlow` predicts would kill you. Expect refusals; verify they're correct
  rather than reporting them.
- **State persists between runs.** `SaveSystem`/FBPP player prefs, achievements, and daily-dungeon
  state are live in the editor, and GameAnalytics/Steam integrations may fire. Don't grind
  achievements accidentally; mention in the report if a run polluted the save.
- **Modifier inputs exist**: `FlagOnlyMode` and `RightClickMode` input actions change what a left
  click does. The semantic paths above bypass them; only relevant when testing raw input.
- **Fallback if `execute_code` is missing**: add `Assets/Editor/AgentPlayDriver.cs` exposing static
  methods/`[MenuItem]`s (`ClickTile(x,y)`, `RightClickTile(x,y)`, `SnapshotJson()`) and invoke them
  via the MCP's menu-item/method-invoke tool instead. Keep it Editor-only so it never ships.
