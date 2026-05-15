# Cosmic Live Manager

Web dashboard to monitor and control the OSCQuery-enabled instruments used in
the Cosmic Live performance (touchscreen TV, Ring + Kinect, tablets, …).
Replaces the previous Max + Node.js patch with a maintainable Vite + Vue 3
front-end and a thin Node helper for what the browser can't do alone (mDNS
discovery and UDP OSC writes).

## Architecture

```
┌────────────────────┐    HTTP /api  + WS /ws       ┌────────────────────┐
│  Browser (Vue 3)   │ ───────────────────────────▶ │  Node helper       │
│  - ConnectionRow   │ ◀─────────────────────────── │  - Bonjour mDNS    │
│  - ParameterTree   │   live discovery, tree,      │  - HTTP proxy      │
│  - presets         │   value updates              │  - WS proxy        │
└────────────────────┘                              │  - UDP OSC sender  │
                                                    └─────────┬──────────┘
                                                              │ TCP / UDP
                                                              ▼
                                                  Tablet / Ring / TV / …
                                                  (each running its own
                                                  OSCQuery server)
```

The browser never talks to the instruments directly. All HTTP and WS calls
go through the helper at `127.0.0.1:7400`, which:
- Browses `_oscjson._tcp` services on the LAN with Bonjour and pushes the live
  list to the UI via `/ws/discovery`.
- Proxies OSCQuery HTTP requests (`GET /api/oscquery?host=…&port=…&path=/`).
- Proxies the OSCQuery WebSocket (`/ws/oscquery?host=…&port=…&oscPort=…`),
  so LISTEN / IGNORE messages and value updates flow as if direct.
- Accepts an extra `{type:"osc-send", address, args}` command on that WS and
  emits a UDP OSC packet to `host:oscPort`. This is how the UI writes values.

## Run

```bash
npm install
npm run dev
```

This starts:
- the Vite dev server on http://127.0.0.1:5173
- the Node helper on http://127.0.0.1:7400

Open http://127.0.0.1:5173. The "helper online · N service(s)" line in the
header confirms discovery is working. Pick the tablet from the dropdown (or
type its IP and OSCQuery port manually), click **Connect**.

You should see:
- connection state badge (idle / connecting / connected / error)
- the IP/port that was contacted, plus the OSC UDP port reported by HOST_INFO
- the parameter tree, grouped by parent path, with type-aware widgets
  (toggle / slider / numeric / text)
- a yellow blink dot every time a value changes (someone touching the device)
- a "Recent activity" panel listing the last 50 path → value updates

## Notes on OSCQuery

Each instrument should expose:
- HTTP on a TCP port (e.g. 5005) returning the namespace tree as JSON.
- A WebSocket on the same port for live updates and LISTEN/IGNORE commands.
- A `?HOST_INFO` query returning `OSC_PORT` and `OSC_TRANSPORT` (UDP).

Different OSCQuery implementations push value updates differently — some send
JSON `{FULL_PATH, VALUE}`, some send raw OSC binary. The helper decodes binary
into a `{type:"osc", packet}` JSON wrapper so the browser only deals with
JSON. The `OSCQueryClient` class normalises both shapes into a single
`'value'` event.

## Project layout

```
package.json
vite.config.js
index.html
server/
  index.js              # Node helper: mDNS + HTTP/WS proxy + UDP OSC sender
src/
  main.js
  App.vue
  styles.css
  components/
    ConnectionRow.vue   # one row of the dashboard
    ParameterControl.vue
  composables/
    useDiscovery.js     # reactive list of mDNS-discovered services
  lib/
    oscquery.js         # OSCQueryClient: HTTP + WS + value events
```

## Roadmap (what's not in yet)

- Multiple connection rows + persistence of saved targets.
- Preset save/recall for parameters whose VALUE is a long string or list.
- Per-parameter manual LISTEN toggles (currently we LISTEN to everything).
- Optional UDP OSC sniffer (separate UDP port bound by the helper) if you
  ever want to see traffic that bypasses OSCQuery.
