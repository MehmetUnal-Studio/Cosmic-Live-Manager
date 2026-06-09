# Cosmic Live Manager

Web dashboard + Node hub to monitor and control the OSCQuery-enabled
instruments used in the Cosmic Live performance (Max-for-Live tablets, Ring +
Kinect, TV, VR rigs, web/Android instruments, TouchDesigner servers, …).
Replaces the previous Max + Node.js patch with a maintainable Vite + Vue 3
front-end and a Node helper that doubles as a central OSCQuery hub.

The app has two pages, switchable from the top tab bar:

- **Dashboard** — the main control surface: live device cards with
  parameters, presets, peer-link (Announce) and per-device recording /
  playback.
- **Performance Mode** — a blank canvas of resizable, draggable preset
  shortcuts. Click to fire. Designed for live use, kept separate from the
  more diagnostic Dashboard.

## Architecture

```
┌──────────────────────┐    HTTP /api + WS /ws/hub    ┌────────────────────────┐
│  Browser (Vue 3)     │ ───────────────────────────▶ │  Node hub (helper)     │
│  - HubDashboard      │ ◀─────────────────────────── │  - Bonjour publish +   │
│  - PerformanceMode   │   namespace, value           │    browse              │
│  - DeviceCard        │   updates, save hints        │  - per-device OSCQuery │
│  - ParameterControl  │                              │    client (HTTP + WS)  │
│  - PresetSection     │                              │  - aggregated OSCQuery │
│  - RecordingPanel    │                              │    tree re-exposed     │
│  - DiscoveredCard    │                              │    at GET /            │
└──────────────────────┘                              │  - UDP OSC inbound on  │
                                                      │    OSC_PORT            │
                                                      │  - /subscribe relay    │
                                                      │  - Ableton forwarder   │
                                                      └─────────┬──────────────┘
                                                                │ TCP / UDP
                                                                ▼
                                                  Tablet / Ring / TV / VR /
                                                  TouchDesigner / Android …
                                                  (each running its own
                                                  OSCQuery server)
```

The browser never talks to the instruments directly. The Node hub at
`127.0.0.1:7400`:

- Loads device declarations from `manifests/*.json` (live-watched — drop a
  file in or edit one and the hub picks it up).
- Opens an OSCQuery client (HTTP + WebSocket) to every enabled device,
  fetches the namespace, and subscribes to value changes. Auto-reconnects
  on drop.
- Aggregates every device's namespace under a single tree (rooted at the
  device name) and re-exposes it as a standard OSCQuery server at
  `GET /`, so third parties on the LAN can read the whole rig as one source.
- Publishes itself as `_oscjson._tcp` + `_osc._udp` (Bonjour) and also
  browses for other `_oscjson._tcp` services on the LAN. Both lists feed
  the dashboard's "Discovered on Network" section and the per-device
  LINK target picker.
- Pushes `PATH_CHANGED`, `DEVICE_UPDATED`, `DEVICE_NAMESPACE`,
  `DEVICES_RELOADED`, `DISCOVERED_DEVICES`, `ANNOUNCE_RESULT`, and
  `SAVE_HINT` events to the dashboard over `/ws/hub`. Accepts
  `SET_DEVICE_PARAM`, `UPDATE_DEVICE`, `RECONNECT_DEVICE`, `REMOVE_DEVICE`,
  `ADD_DISCOVERED`, `RELOAD_MANIFESTS`, `REDISCOVER`, and `ANNOUNCE_DEVICE`
  on the same socket.
- Listens for UDP/OSC on `OSC_LISTEN_PORT` and supports `/subscribe` /
  `/unsubscribe` for classic OSC relay clients.
- Forwards every received value to Ableton on `ABLETON_PORT` with the
  legacy `device<id> <path> <value>` packet shape (compatible with the
  existing Cosmic Unity M4L patch). Disable with `ABLETON_FORWARD=0`.

## Run

```bash
npm install
npm run dev
```

This starts:

- the Vite dev server on every interface, port `5173` (bound to `0.0.0.0`
  so tablets / phones / other Macs on the same LAN can open the dashboard)
- the Node hub on every interface, port `7400` (with `--watch` reload)

Open `http://localhost:5173` locally, or `http://<this-machine-LAN-IP>:5173`
from another device on the same network. The startup logs print every LAN
address the server is reachable on.

The header shows `helper online · N device(s) · M msg/s`, a live counter
of packets forwarded to Ableton, and a `⟳ Rediscover` button that flushes
the helper's Bonjour cache (without needing `sudo killall -HUP
mDNSResponder`).

Each manifest in `manifests/` becomes a card in the dashboard. From a card
you can:

- toggle the device on/off, edit its name, host, and OSCQuery port inline
- reconnect after a network change, or **remove** the device via the `×`
  in the top-right of the card (deletes its manifest file)
- browse the parameter tree (grouped by parent path, collapsible per group)
- edit parameters with type-aware widgets (see below)
- save/recall **presets** scoped to that device (stored in `localStorage`)
- **LINK** (announce) the device to another OSCQuery target on the LAN
  (writes `/system/peer/{peer_id, host, oscquery_port, udp_port}` and
  bangs `/system/peer/connect`). Manual push only — no auto-fire.
- **Record / play back** the live PATH_CHANGED stream for that device
  (see *Recording* below).

The "Discovered on Network" panel — sits above the Manifest Devices grid —
lists every `_oscjson._tcp` service the hub finds on the LAN that isn't
already a managed device. Click "Add" on any of them to auto-create a
manifest and **auto-connect** in one step.

Press-and-hold a manifest card to drag-and-drop it into a new position;
the order is persisted in `localStorage`.

Environment variables (all optional):

| var               | default                | meaning                                          |
| ----------------- | ---------------------- | ------------------------------------------------ |
| `PORT`            | `7400`                 | hub HTTP/WS + aggregated OSCQuery HTTP           |
| `OSC_LISTEN_PORT` | `9001`                 | UDP OSC inbound (instruments → hub)              |
| `ABLETON_HOST`    | `127.0.0.1`            | Ableton/M4L target                               |
| `ABLETON_PORT`    | `10000`                | hub → Ableton `udpreceive` port                  |
| `ABLETON_FORWARD` | `1`                    | set to `0` to disable the Ableton mirror         |
| `HUB_NAME`        | `Cosmic Live Manager`  | Bonjour name advertised by the hub               |
| `MANIFESTS_DIR`   | `./manifests`          | where manifests are loaded/watched               |

## Parameter widgets

`ParameterControl.vue` picks the widget by inspecting the OSCQuery node
metadata. The rules are applied **in this order**:

1. **Trigger** — `TYPE = "N"` or `"I"` → a button that sends the address with
   no args (OSC impulse). Used for actions like `ResetSpectrum`.
2. **Boolean** — `TYPE` is `"T"`, `"F"`, `"TF"`, `"FT"`, or `"B"` → toggle.
3. **Enum / menu** — any `RANGE[0].VALS` array present → dropdown.
   This branch wins regardless of `TYPE`. The dropdown shows the labels from
   `VALS`; for `TYPE = "i"` (the Max scanner emits menus this way), the
   `VALUE` is an **integer index** into `VALS` and the widget translates the
   selected label back to its index on commit. For `TYPE = "s"` (the
   TouchDesigner-style format) the `VALUE` is the label string itself.
4. **Multi-component numeric** — `TYPE` matches `^[fid]+$` with length > 1
   (e.g. `ff`, `fff`, `ii`) → one numeric input per component.
5. **Scalar numeric** — `TYPE = "f"` or `"i"` → a single numbox with:
   - click to focus + type (Enter or blur commits)
   - vertical mouse drag to change quickly (above 4 px threshold so clicks
     still focus). Shift = 10× faster, Alt = 10× finer.
   - for `"i"` only: a stacked `▲ / ▼` spinner on the **left** of the box
     (so it never covers the value) for ±1 steps
   - `RANGE.MIN`/`MAX` is enforced as `min`/`max` and as a clamp on drag.
6. **String** — text input (with editing/draft handling so remote updates
   don't blow away your keystrokes).
7. **Fallback** — `JSON.stringify(VALUE)` as a text input; you can paste in a
   replacement JSON literal.

The label shown above each parameter is `node.DESCRIPTION` (if the server
provides one) with the last path segment as a fallback. The full
`FULL_PATH` is the tooltip.

## Section toggles inside a DeviceCard

Each device card has four collapsible sections, visually uniform (`▶`
chevron that rotates to `▼` on open):

- **Presets** — per-device saved snapshots, click a chip to recall.
- **Parameters** — the namespace tree with widgets (see above).
- **LINK** — peer announce: pick a discovered target, set `peer_id`,
  optionally override `udp_port`, click **Push**. The `↺` button next to
  Peer ID resets it to the sanitized device name (useful when localStorage
  has a stale entry).
- **Recordings** — live capture / playback of PATH_CHANGED events (see
  next section).

## Recording

Every connected device has its own recording engine in its card. The
panel header is collapsible and shows live status: `● REC · N ev · 1.3s`
while capturing, `▶ PLAY · 1.2 / 5.0 s` during playback.

Flow:

1. Click **● Record**. The composable subscribes to every PATH_CHANGED
   event for that device and pushes `{ t, path, value }` into an
   in-memory buffer (`t` is ms since the start of recording, via
   `performance.now()`). No throttling, no dedup — every event ends up in
   the buffer.
2. Click **■ Stop**. The buffer is promoted to a "loaded recording" and
   the path histogram is built (one row per unique path with its event
   count). The path list is showed in the panel and each row has a
   checkbox to **exclude** that path from playback — useful for noisy
   sources like heartbeats or accelerometers.
3. **⬇ Download** saves the recording as `clm-recording-<device>-<ts>.json`
   with a versioned schema. Recordings live ONLY in memory between Record
   and Discard — if you want to keep one across reloads, download it.
4. **⬆ Load JSON** reloads a previously downloaded recording. The events
   become the new playback source; the device the recording targets is
   identified informationally only — playback always goes to the device
   the panel is mounted on.
5. **▶ Play** replays the (filtered) events in real time, preserving the
   original gaps with `setTimeout`. **Loop** restarts on completion.
   **■ Stop** cancels every pending timer.

JSON schema (version 1):

```json
{
  "version":    1,
  "kind":       "clm-recording",
  "deviceId":   3,
  "deviceName": "Ring-Instrument",
  "recordedAt": "2026-05-20T12:34:56Z",
  "durationMs": 12345,
  "eventCount": 234,
  "events": [
    { "t": 0,    "path": "/dial", "value": [1.0] },
    { "t": 23,   "path": "/play", "value": [0, 1, 0.85, 0.39, 1] },
    ...
  ]
}
```

### Playing a recording back into Ableton

The dashboard's playback dispatches each event as `SET_DEVICE_PARAM` to the
hub, which forwards it to the target M4L device. **For the device to
actually hear the playback inside Ableton, set the M4L patch's `Play Msg
Protocol` to `WebSocket`**. The default may be UDP/OSC, which won't see
playback messages because they arrive through the OSCQuery WebSocket
channel, not the raw OSC UDP port.

If you don't hear anything during playback but see the helper log
`SET_DEVICE_PARAM` events going through, this is almost certainly the
cause — switch the protocol selector on the M4L device and re-play.

### Debug flags

Two `localStorage` flags can be flipped from DevTools to surface diagnostic
logs without touching the code:

```js
localStorage.setItem('clm:debug:recording', '1')   // log every captured event
localStorage.setItem('clm:debug:applyValue', '1')  // log PATH_CHANGED that
                                                   // can't resolve a device
```

Remove them with `localStorage.removeItem(...)`. Both are no-ops by default.

## Performance Mode

A second page (tab in the top bar) showing a blank canvas of preset
shortcuts. Each shortcut is a coloured rectangle bound to a `(device,
path, value)` tuple — click it and the value is fired.

- **+ Add preset** opens a modal: device dropdown, parameter picker
  (auto-populated with the current value, editable), name, colour from a
  palette or custom picker.
- Drag the body of a rectangle to **move**; drag a corner/edge to
  **resize**. Both snap to a 20 px grid on release. The cursor changes to
  the appropriate `nwse-resize` / `ew-resize` / etc. when hovering an edge.
- Double-click the name to **rename inline**.
- Hover to reveal a small `×` for delete (with confirm).
- **⬇ Export** dumps the full layout as a JSON file; **⬆ Import** merges
  another layout into the current canvas (re-ids on import to avoid
  collisions). Persistence is also automatic via `localStorage`.

The Performance Mode is intentionally minimal: no parameter tree, no
device-by-device controls. It is the surface you use during a live
performance to fire pre-prepared states.

## Notes on OSCQuery

Each instrument should expose:

- HTTP on a TCP port returning the namespace tree as JSON (and the
  `?HOST_INFO` query reporting at least `OSC_PORT` + `OSC_TRANSPORT`).
- A WebSocket on the same port for live updates and LISTEN/IGNORE.

Different implementations push value updates differently — some emit JSON
`{FULL_PATH, VALUE}`, some emit raw OSC binary (including bundles). The
hub decodes binary on the way in so the dashboard only sees JSON events.

For the Max-for-Live side of the rig, see the companion project under
`../M4L/` for the actual M4L devices (`Cosmic Unity`, `Cosmic Ring`) and
their internal scripts (`oscquery.server.js`, `oscquery.client.js`,
`ws_register.js`, `presentation-scanner.js`). The presentation-scanner
exposes objects annotated with `@oscquery` in their Annotation field.

## Project layout

```
package.json
vite.config.js              # Vite with host: true, /ws proxy to the hub
index.html
manifests/                  # one JSON per managed device; live-watched
server/
  index.js                  # Node hub: mDNS, /ws/hub, OSCQuery aggregator,
                            # UDP listener, Ableton forwarder, manifest CRUD
  oscqueryClient.js         # per-device OSCQuery client (HTTP + WS + relays,
                            # binary OSC + bundle decoder)
src/
  main.js
  App.vue                   # 2-tab switch: Dashboard / Performance Mode
  styles.css
  components/
    HubDashboard.vue        # Dashboard page: stats, scenes, discovered,
                            #   manifest grid, drag-reorder
    PerformanceMode.vue     # Blank canvas of preset shortcuts
    DeviceCard.vue          # Header + host/port + Presets + Parameters
                            #   + LINK + Recordings
    DiscoveredCard.vue      # Bonjour-only entries waiting to be added
    ParameterControl.vue    # Widget picker (trigger / bool / enum / num / …)
    PresetSection.vue       # Per-device preset save / recall list
    RecordingPanel.vue      # Per-device recording + playback UI
    PerformancePreset.vue   # Draggable/resizable rectangle (PM)
    AddPresetModal.vue      # New PM preset dialog
    SceneBar.vue            # Global scene chips above the device grid
  composables/
    useHub.js               # /ws/hub client (singleton), devices,
                            #   deviceParams, onPathChange subscribe API
    useHubPresets.js        # localStorage-backed presets per device
    useDiscovery.js         # mirror of the hub's Bonjour discovery list
    usePeer.js              # peer_id sanitisation for the LINK flow
    useRecording.js         # per-device record buffer + JSON export +
                            #   real-time playback engine
    usePerformancePresets.js# global PM preset store (localStorage + JSON
                            #   export/import)
    useScenes.js            # global scenes (whole-rig snapshots)
    useHelperInfo.js        # helper LAN addresses + OSC listen port
```

## Roadmap (what's not in yet)

- Per-parameter manual LISTEN toggles (the hub currently subscribes to
  every device's whole namespace).
- A built-in editor for `manifests/*.json` (today you edit the files
  directly; the hub reloads them on save).
- A more honest scalar-vs-enum heuristic for non-standard servers that
  put `VALS` on numeric ranges they don't mean as enums.
- Optional UDP OSC sniffer (a separate UDP port bound by the hub) for
  observing traffic that bypasses OSCQuery.
- Recording playback speed control (currently always real-time).
- Performance Mode: alignment guides while dragging, lock/unlock layout,
  optional fullscreen mode for live use.
