# Cosmic Live Manager

Web dashboard + Node hub to monitor and control the OSCQuery-enabled
instruments used in the Cosmic Live performance (Max-for-Live tablets, Ring +
Kinect, TV, VR rigs, web/Android instruments, …). Replaces the previous Max +
Node.js patch with a maintainable Vite + Vue 3 front-end and a Node helper
that doubles as a central OSCQuery hub.

## Architecture

```
┌──────────────────────┐    HTTP /api + WS /ws/hub    ┌────────────────────────┐
│  Browser (Vue 3)     │ ───────────────────────────▶ │  Node hub (helper)     │
│  - HubDashboard      │ ◀─────────────────────────── │  - Bonjour publish +   │
│  - DeviceCard        │   namespace, value           │    browse              │
│  - ParameterControl  │   updates, save hints        │  - per-device OSCQuery │
│  - PresetSection     │                              │    client (HTTP + WS)  │
│  - DiscoveredCard    │                              │  - aggregated OSCQuery │
└──────────────────────┘                              │    tree re-exposed     │
                                                      │    at GET /            │
                                                      │  - UDP OSC inbound on  │
                                                      │    OSC_PORT            │
                                                      │  - /subscribe relay    │
                                                      │  - Ableton forwarder   │
                                                      └─────────┬──────────────┘
                                                                │ TCP / UDP
                                                                ▼
                                                  Tablet / Ring / TV / VR / …
                                                  (each running its own
                                                  OSCQuery server)
```

The browser never talks to the instruments directly. The Node hub at
`127.0.0.1:7400`:

- Loads device declarations from `manifests/*.json` (live-watched — drop a
  file in or edit one and the hub picks it up).
- Opens an OSCQuery client (HTTP + WebSocket) to every enabled device,
  fetches the namespace, and subscribes to value changes.
- Aggregates every device's namespace under a single tree (rooted at the
  device name) and re-exposes it as a standard OSCQuery server at
  `GET /`, so third parties on the LAN can read the whole rig as one source.
- Publishes itself as `_oscjson._tcp` + `_osc._udp` (Bonjour) and also
  browses for other `_oscjson._tcp` services on the LAN. Both lists feed
  the dashboard's "Discovered" section and the per-device "Announce"
  target picker.
- Pushes `PATH_CHANGED`, `DEVICE_UPDATED`, `DEVICE_NAMESPACE`, and
  `SAVE_HINT` events to the dashboard over `/ws/hub`. Accepts
  `SET_DEVICE_PARAM` (write back to a managed device) and
  `ANNOUNCE_DEVICE` (push contact info into a target's
  `/system/peer/*` parameters) on the same socket.
- Listens for UDP/OSC on `OSC_PORT` and supports `/subscribe` /
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

- the Vite dev server on http://127.0.0.1:5173
- the Node hub on http://127.0.0.1:7400 (with `--watch` reload)

Open http://127.0.0.1:5173. The header shows `helper online · N device(s)
· M msg/s` and a live counter of packets forwarded to Ableton.

Each manifest in `manifests/` becomes a card in the dashboard. From a card
you can:

- toggle the device on/off, edit its name, host, and OSCQuery port inline
- reconnect after a network change
- browse the parameter tree (grouped by parent path, collapsible per group)
- edit parameters with type-aware widgets (see below)
- save/recall **presets** scoped to that device (stored in `localStorage`)
- **announce** the device to another OSCQuery target on the LAN (writes
  `/system/peer/{peer_id, host, oscquery_port, udp_port}` and bangs
  `/system/peer/connect`)

The "Discovered" panel lists every `_oscjson._tcp` service the hub finds on
the LAN that isn't already a managed device. Click "Add" on any of them to
generate a manifest stub.

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
`FULL_PATH` is the tooltip. This works generically: a Max device exposing
`parameter_longname` as `DESCRIPTION` shows the Live-side name; a
TouchDesigner or Android server that doesn't set `DESCRIPTION` still works
unchanged.

## Notes on OSCQuery

Each instrument should expose:

- HTTP on a TCP port returning the namespace tree as JSON (and the
  `?HOST_INFO` query reporting at least `OSC_PORT` + `OSC_TRANSPORT`).
- A WebSocket on the same port for live updates and LISTEN/IGNORE.

Different implementations push value updates differently — some emit JSON
`{FULL_PATH, VALUE}`, some emit raw OSC binary. The hub decodes binary on
the way in so the dashboard only sees JSON events.

For the Max-for-Live side of the rig, the companion project under
`M4L_OSCQuery_Test/OSCQuery_Device/` contains:

- `oscquery.server.js` — Node-for-Max script wrapping the `oscquery` library.
  Supports a `service_name` message to rename the advertised server at
  runtime (stop + restart), and accepts `load_from_json <dict>` with the
  client name defaulting to `service_name` (one Node server per device).
- `presentation-scanner.js` — Max `[v8]` script that walks the active
  patcher, picks the objects annotated with `@oscquery` in their info-view
  title, and emits a JSON ready for `load_from_json`. It reads
  `_parameter_longname` (sent as `description` so it shows up as the
  human-readable label), `_parameter_range` (numeric range or menu labels),
  and `_parameter_type` (so a `live.numbox` in int mode is exposed as
  `TYPE: "i"` and a `live.menu` as `TYPE: "i"` with a `VALS` list and a
  0-based index value).

## Project layout

```
package.json
vite.config.js
index.html
manifests/                  # one JSON per managed device; live-watched
server/
  index.js                  # Node hub: mDNS, /api proxy, /ws/hub, OSCQuery
                            # aggregator, UDP listener, Ableton forwarder
  oscqueryClient.js         # per-device OSCQuery client (HTTP + WS + relays)
src/
  main.js
  App.vue
  styles.css
  components/
    HubDashboard.vue        # top-level dashboard: ordering, counters, lists
    DeviceCard.vue          # one row: header, parameters, presets, announce
    DiscoveredCard.vue      # Bonjour-only entries waiting to be added
    ParameterControl.vue    # widget picker (trigger / bool / enum / num / …)
    PresetSection.vue       # per-device preset save / recall list
  composables/
    useHub.js               # /ws/hub client + reactive devices / params
    useHubPresets.js        # localStorage-backed presets per device
    useDiscovery.js         # mirror of the hub's Bonjour discovery list
    usePeer.js              # peer_id sanitisation for the Announce flow
```

## Roadmap (what's not in yet)

- Drag-and-drop reordering of device cards (currently order is persisted
  but rearranging is from the UI's manual move controls).
- Per-parameter manual LISTEN toggles (the hub currently subscribes to
  every device's whole namespace).
- A built-in editor for `manifests/*.json` (today you edit the files
  directly; the hub reloads them on save).
- A more honest scalar-vs-enum heuristic for non-standard servers that
  put `VALS` on numeric ranges they don't mean as enums.
- Optional UDP OSC sniffer (a separate UDP port bound by the hub) for
  observing traffic that bypasses OSCQuery.
