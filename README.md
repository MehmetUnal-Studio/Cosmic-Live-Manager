# Cosmic Live Manager

Agent handoff, developer reference, and show-operator handbook for the Cosmic
Live Manager. The project is a Vue 3 dashboard, a supervised Node.js control
plane, an OSCQuery aggregator, and a routing bridge for the OSCQuery-enabled
instruments used in Cosmic Symphony: CosmicUnity VST3 instances in Ableton,
Android/XR instruments, Ring, TV, Max/Node receivers, TouchDesigner-style
servers, and the optional CosmicNoise loopback consumer.

This README is intentionally detailed. A new human or coding agent should be
able to find the authoritative source, start the rig, understand device
identity and LINK routing, diagnose a connection, and make a safe change
without first reconstructing the entire system from screenshots or chat
history.

> **Current development line:** `codex/device-registry`. Before changing code,
> run `git status --short --branch`; this checkout is used for live-show work
> and may contain intentional operator changes. Do not reset, clean, or
> bulk-stage the worktree without reviewing those changes.

The published fork branch is the source handoff. A clone still cannot recreate
the exact running workstation by itself: manifests, browser `localStorage`,
Ableton sets, installed VST3 bundles, APKs, and show-device state are deliberately
machine-local and must be captured or restored separately.

## Guide map

- [Scope and source of truth](#read-this-first-scope-and-source-of-truth)
- [Repositories, evidence, and companion documents](#repository-and-evidence-map)
- [Runtime architecture and ports](#architecture)
- [Install, scripts, status, and lifecycle](#install-and-run)
- [Device identity, state machine, manifests, and configuration](#identity-and-reconnect-state)
- [LINK target matrix and wire contract](#link-routing-contract)
- [CosmicNoise v1 mirror](#cosmicnoise-v1-loopback-protocol)
- [Manager HTTP/WebSocket API and security](#manager-http-and-websocket-contracts)
- [Frontend state, recordings, and Performance Mode](#frontend-state-and-persistence)
- [Repository layout and automated validation](#project-layout)
- [End-to-end show smoke test](#end-to-end-show-smoke-test)
- [Troubleshooting](#troubleshooting)
- [Known limitations and licensing](#known-limitations-and-next-work)

## Read this first: scope and source of truth

The Manager controls the **Manager Bridge** process. It does not own Ableton,
load or unload a VST3, start an Android APK, or prove that a synthesizer made
sound. The UI's `Connected` state proves an OSCQuery HTTP + WebSocket session;
`Push` proves only that the Manager invoked five local peer-bootstrap UDP send
attempts; individual send errors are logged but do not turn the result into a
remote acknowledgement.
Neither is end-to-end MIDI/audio certification.

When sources disagree, use this order:

1. The checked-out runtime code and automated tests in this repository.
2. Captured wire behavior and the pinned companion-source commits listed
   below.
3. Companion architecture/protocol documents.
4. This README.
5. Screenshots and historical UI labels. Screenshots are observations, not
   executable instructions or protocol specifications.

The exact Max for Live patch/runtime asset is **not** stored in this
repository. The root-level `oscquery.server.js` and `ws_register.js` are
companion/legacy Node-for-Max scripts, not the Vue/Node Manager entrypoints.
Do not assume a missing `../M4L/` checkout exists; locate the actual Ableton/Max
runtime asset before editing it.

## Repository and evidence map

| System | Authoritative source | Role in this project |
| --- | --- | --- |
| Current Manager development | [MehmetUnal-Studio/Cosmic-Live-Manager · `codex/device-registry`](https://github.com/MehmetUnal-Studio/Cosmic-Live-Manager/tree/codex/device-registry) | Active implementation and handoff line for the registry, lifecycle, LINK topology, CosmicNoise mirror, tests, UI, and this handbook. |
| Original Manager upstream | [CosmicSymphonyCreative/Cosmic-Live-Manager](https://github.com/CosmicSymphonyCreative/Cosmic-Live-Manager) | Original upstream/baseline. It may lag the active development branch. |
| CosmicUnity and CosmicRing VST3 | [MehmetUnal-Studio/CosmicUnityVST3 · `ring-port`](https://github.com/MehmetUnal-Studio/CosmicUnityVST3/tree/ring-port) | JUCE network-to-MPE plugin, OSCQuery server, persistent UUID, port fallback, virtual MIDI, and the `CosmicRing`/`Live-Ring` target. At the time of this handoff `ring-port` and remote `main` point to `e9b2421`. |
| VST/Manager contract | [CosmicUnityVST3 `docs/live-manager-contract.md`](https://github.com/MehmetUnal-Studio/CosmicUnityVST3/blob/ring-port/docs/live-manager-contract.md) | Extracted device-registry contract and compatibility rules. |
| VST reverse-engineering documents | [CosmicUnityVST3 `docs/analysis/`](https://github.com/MehmetUnal-Studio/CosmicUnityVST3/tree/ring-port/docs/analysis) | OSCQuery, Unity app, Max device, MPE, show-state, and protocol evidence. Read `hub.md`, `nodeosc.md`, `unity_oscquery_lib.md`, `unity_app_protocol.md`, and `drone_play_protocol.md` first. |
| Original Max for Live sources | [CosmicSymphonyCreative/M4L](https://github.com/CosmicSymphonyCreative/M4L) | Historical/source Max devices and scripts used for behavioral comparison. This is a companion repository, not started by Manager npm scripts. |
| Android/XR application | [NevaXR-Media/neva-unity-cosmicsymphony · `xr`](https://github.com/NevaXR-Media/neva-unity-cosmicsymphony/tree/xr) | Unity application used by tablets/XR. Port `9010`, finger/gesture/drone producers, and the OSCQuery scene configuration originate here. |
| Android persistent identity addition | [NevaXR-Media/neva-unity-cosmicsymphony · `codex/device-registry`](https://github.com/NevaXR-Media/neva-unity-cosmicsymphony/tree/codex/device-registry) | Adds an installation UUID in the backward-compatible `--id-<32 hex>` service-name token. Checked-out evidence commit: `ae615a8`. |
| OSCQuery-Unity dependency | [egemenertugrul/OSCQuery-Unity · `0a81882`](https://github.com/egemenertugrul/OSCQuery-Unity/tree/0a81882219e3a993399802937dd79385a5283161) | Unity OSCQuery HTTP/WS/UDP + Zeroconf implementation pinned by the app submodule. The reviewed ZIP is package `com.benkuper.oscquery` `1.2.2`, GPL v3. |
| SpektraSynth | [MehmetUnal-Studio/SpektraSynth](https://github.com/MehmetUnal-Studio/SpektraSynth) | MPE/virtual-MIDI and Ableton host-behavior reference; not a Manager runtime dependency. |
| CosmicNoise | Local `../CosmicNoise/` checkout; no standalone Git remote was found during this audit | Optional loopback-only consumer of `/cosmicnoise/v1/input`. Its `README.md`, `docs/ARCHITECTURE.md`, `docs/PROTOCOL_EVIDENCE.md`, `docs/COSMIC_UNITY_PARITY.md`, `docs/LIVE_TEST_TR.md`, and `protocol/cosmicnoise-v1.manifest.json` are the detailed consumer-side contract. |

The configured Git remotes/branches above resolved from the show workstation's
Git credentials. Most repository web pages return `404` to an unauthenticated
HTTP client, so sign in to the authorized GitHub account before treating a
browser `404` as a missing repository.

Local source locations used on the show workstation:

```text
~/Documents/ChatGPT/CosmicProducts/Cosmic-Live-Manager
~/Documents/ChatGPT/CosmicProducts/neva-unity-cosmicsymphony
~/Documents/CluadeCodeFiles/cosmic-unity-port/CosmicUnityVST3-alignment
~/Documents/ChatGPT/CosmicProducts/SpektraSynth
~/Documents/ChatGPT/CosmicProducts/CosmicNoise
~/Documents/Max 9/Max for Live Devices/Cosmic Unity Project
~/Documents/Max 9/Max for Live Devices/CosmicRing Project
~/Downloads/OSCQuery-Unity-0a81882219e3a993399802937dd79385a5283161.zip
```

The reviewed OSCQuery-Unity archive has SHA-256
`3c1c96a5829f48f7da98abfd0789322f0f9b414e64e3aa0104a32330792f1fd3`.
The Unity app declares the same repository as an `Assets/OSCQuery-Unity`
submodule at commit `0a81882219e3a993399802937dd79385a5283161`.

Show/runtime evidence that is intentionally outside this repository includes:

```text
~/Desktop/ClaudeUnity Project/ClaudeUnity.als
~/Downloads/Cosmic_Live_Test Project/Cosmic_Live_Test.als
~/Desktop/CSO ExpressionMaps/CosmicMax/CosmicRing.amxd
~/Library/Audio/Plug-Ins/VST3/Cosmic Unity.vst3
~/Library/Audio/Plug-Ins/VST3/Cosmic Ring.vst3
```

The TouchDesigner/Ring analyses also reference deleted temporary scratchpads;
no reproducible source repository was found for those paths. The retained
artifact `~/Downloads/THE_RING_SY.18.toe` is runtime evidence, not a source
checkout. Do not claim those missing scratchpads are recoverable from GitHub.

### Companion checkout and build notes

**CosmicUnityVST3/CosmicRing:** use the clean
`CosmicUnityVST3-alignment` checkout on `ring-port`/tag `v1.4.0`, not the older
sibling `CosmicUnityVST3` checkout on `v1.2.0`. The current repository builds
both `CosmicUnityPlugin` and `CosmicRingPlugin`. It requires CMake `>=3.24`,
C++20, Ninja presets, Xcode/codesign on macOS, and JUCE `8.0.15`. Its current
presets contain a workstation-specific JUCE path, so inspect
`CMakePresets.json` before building on another machine.
[JUCE](https://github.com/juce-framework/JUCE) `8.0.15`,
[Catch2](https://github.com/catchorg/Catch2) `3.7.1`, and
[nlohmann/json](https://github.com/nlohmann/json) `3.11.3` are companion build
dependencies. The VST README has
some stale version wording; prefer `CMakeLists.txt`, tag `v1.4.0`, tests, and
current source when they disagree.

**Unity Android/XR:** use Unity Editor `6000.4.0f1` with Android Build Support,
SDK, NDK, and JDK, then initialize the pinned package:

```bash
git submodule update --init --recursive
```

The default repository branch is not the show integration line. The published
`codex/device-registry` identity commit `ae615a8` is based on an older XR
snapshot, while remote `xr` has continued to move. Reconcile those branches
explicitly before producing a new APK; never assume a repository-root clone is
the correct tablet build. Private Neva package credentials may be required.
The currently pinned `marijnzwemmer/unity-toolbar-extender` Git dependency was
not reachable during this audit and can block a clean Package Manager restore.

**Original Max for Live:** the companion repo expects Ableton Live 11+ with Max
for Live, Max 8.5+, and a shared LAN; Windows hosts need Bonjour support. Always
compare against the actual `.amxd`/Ableton project used in the show, not only
the extracted JavaScript copies.

### Companion document index

The VST repository's `docs/analysis/` directory is the deepest retained
cross-system specification:

| Document | Subject |
| --- | --- |
| `hub.md`, `nodeosc.md`, `maxmgr.md` | Manager/OSCQuery hub and original Max network behavior. |
| `unity_oscquery_lib.md` | OSCQuery-Unity HTTP, WebSocket, UDP registration, and Zeroconf behavior. |
| `unity_app_architecture.md`, `unity_app_protocol.md`, `unity_app_visualpipeline.md` | Unity app topology, exact producer/consumer messages, and visual/data pipeline. |
| `drone_play_protocol.md` | Finger, play, drone framing, index bases, and stop behavior. |
| `toplevel.md`, `control.md`, `synths.md`, `ui.md` | Original Max device structure, control surface, signal flow, and UI. |
| `js.md`, `dataext.md`, `gendsp.md` | Max JavaScript algorithms, element data, and generated DSP evidence. |
| `ablmap.md` | Ableton mapping behavior and portability boundary. |
| `liveset_state.md`, `versions.md`, `errata_reconciliation.md` | Show-set state, source/version reconciliation, and known historical contradictions. |
| `audience_system.md` | Separate audience-system grammar; not a current Manager input. |
| `critic.md` | Review/critique notes; evidence, not runtime authority. |
| `docs/live-manager-contract.md` | Frozen Manager/VST contract. It predates current Ring and registry work; use it with current code/tests. |

CosmicNoise's local `docs/` and machine-readable protocol manifest are the
authoritative consumer-side references for its optional mirror. The Android
repository README is currently only a minimal project landing page; build and
deployment facts must be taken from `ProjectVersion.txt`, package locks, build
profiles, scenes, and the source itself.

## Product surfaces

The app has two pages, switchable from the top tab bar:

- **Dashboard** — the main control surface: live device cards with
  parameters, presets, peer-link (Announce) and per-device recording /
  playback.
- **Performance Mode** — a blank canvas of resizable, draggable preset
  shortcuts. Click to fire. Designed for live use, kept separate from the
  more diagnostic Dashboard.

## Architecture

```
Browser / Vue 3 at :5173
├─ /ws/hub and /ws/discovery ── Vite proxy ──▶ Node hub at :7400
│                                                ├─ Bonjour publish/browse
│                                                ├─ Device Registry + manifests
│                                                ├─ per-device OSCQuery HTTP/WS clients
│                                                ├─ observed OSCQuery tree at GET /
│                                                ├─ OSC UDP input/relay at :9001
│                                                └─ LINK, Ableton and CosmicNoise sends
└─ /api/manager/* ──────── Vite proxy ──▶ Supervisor at :7399
                                                  └─ starts/stops/restarts hub child

LAN OSCQuery consumers ── HTTP/WS ──▶ Node hub at :7400
Node hub ── HTTP/WS + OSC UDP ──▶ Tablet / Ring / TV / VR /
                                  TouchDesigner / Android devices
```

The browser never talks to the instruments directly. In development it talks
to Vite on `:5173`; Vite proxies `/ws/*` to the hub and
`/api/manager/*` to the loopback supervisor. The Node hub itself listens on
`0.0.0.0:7400`, so OSCQuery consumers on the rehearsal LAN can reach it.

### Process ownership and lifecycle

| Process | Bind | Started by | Owns | Does not own |
| --- | --- | --- | --- | --- |
| Vite dev server | `0.0.0.0:5173` | `npm run dev` | Vue assets and dev proxies | Hub sockets, VSTs, APKs |
| Manager supervisor | `127.0.0.1:7399` | `npm run dev` or `npm run start:supervisor` | One serialized hub child lifecycle and real `Running/Stopped/Restarting/Error` state | Ableton or any device process |
| Manager hub (`server/index.js`) | HTTP/WS `0.0.0.0:7400`, OSC UDP `0.0.0.0:9001` | Supervisor, or directly with `npm run start:server` for debugging | Bonjour, registry, manifests, per-device clients, OSC aggregation, LINK dispatch, UDP mirrors | VST/APK launch and audio production |
| CosmicUnity/CosmicRing VST3 | Ableton process; normally OSCQuery `5001..5016` or an operator-selected/fallback port | Ableton Live/plugin instance | Device OSCQuery server, peer dial, UDP stream receive, network-to-MPE conversion | Manager Bridge lifecycle |
| Android/XR app | Device-local; normally OSCQuery `9010` | Android/Unity app lifecycle | Touch/gesture/drone producer and OSCQuery service | Manager lifecycle |
| Ring-Instrument | Remote OSCQuery `9011` in the current show topology | Its host application | Ring performance source | Manager lifecycle |

Supervisor Start/Stop/Restart affects only the hub child. Restart sends
`SIGTERM`, waits for the child to close clients, timers, watchers, WebSockets,
Bonjour, HTTP and UDP sockets, escalates to `SIGKILL` only after the configured
grace period, and uses a bounded exit wait before starting the replacement.
The normal path observes the old child's exit before rebinding. The current
wait helper can nevertheless time out and forget a child whose exit event was
never observed, so this is not an absolute no-orphan/no-port-race guarantee.
Manifests and browser state are not deleted by restart.

### Network and port map

| Port/range | Transport | Owner | Purpose |
| --- | --- | --- | --- |
| `5173` | HTTP + proxied WS | Vite | Dashboard during development; LAN-bound. |
| `7399` | HTTP | Supervisor | Loopback lifecycle API: status/start/stop/restart. |
| `7400` | HTTP + WS | Manager hub | Aggregated OSCQuery, `/_status`, `/_devices`, `/ws/hub`, `/ws/discovery`; LAN-bound. |
| `9001` | OSC/UDP | Manager hub | Hub inbound/relay port and advertised `_osc._udp` endpoint. |
| `5001..5016` | HTTP + WS + device-specific OSC UDP | CosmicUnity VST3 instances | Default base `5001`, then `+1..+15` fallback. Each bound port is a separate Ableton instance/channel. The OSC control port must be read from `?HOST_INFO`; it need not equal HTTP. |
| operator-selected, currently `8000` | HTTP + WS | `Live-Ring` CosmicRing VST3 | Current show setting, not a hard protocol constant; the plugin can fall back if occupied. |
| `8005` | HTTP + WS | legacy `MaxRing` Node-for-Max receiver | Exact trusted local Max/Ring service identity. |
| `9005` | UDP | legacy Max/Ring receiver | Fixed peer-stream receive port used by the legacy bridge. |
| `9010` | HTTP + WS and app OSC UDP | Android/XR app | Default OSCQuery service port in `PreloadScene`. Different tablets may share this port because host/UUID distinguishes them. |
| `9011` | HTTP + WS | Ring-Instrument | Exact Ring peer accepted by trusted Ring receivers. |
| `10000` | OSC/UDP | existing Ableton/M4L consumer | Legacy Manager mirror, configurable with `ABLETON_PORT`. |
| `10001` | OSC/UDP loopback | CosmicNoise | Optional typed `/cosmicnoise/v1/input` mirror. |

Ports describe listeners, not physical identity. `5001`, `5002`, and `5003` on
this computer are three VST instances; `9010` on two different tablets is two
devices.

### Hub responsibilities

The hub:

- Loads device declarations from `manifests/*.json` (live-watched — drop a
  file in or edit one and the hub picks it up). Startup migration assigns
  canonical IDs and safely merges verified local-interface duplicates.
- Opens an OSCQuery client (HTTP + WebSocket) to every enabled device,
  fetches the namespace, and subscribes to value changes. One connection
  attempt owns a hard 3,000 ms deadline; timeout closes its HTTP/WS resources,
  reports `Unavailable`, and keeps the same manifest/card for retry.
- Keeps the complete fetched metadata tree for each device in the dashboard,
  while the hub's aggregated `GET /` tree contains values the hub has actually
  observed or written. A quiet, never-observed parameter can appear in
  `DEVICE_NAMESPACE` without appearing in `GET /`; disconnected paths are not
  automatically purged.
- Publishes itself as `_oscjson._tcp` + `_osc._udp` (Bonjour) and also
  browses for other `_oscjson._tcp` services on the LAN. Discovery and saved
  manifests atomically upsert the same canonical registry record, while the
  raw service list still feeds the per-device LINK target picker.
- Pushes registry/device/namespace/value/discovery/lifecycle results to the
  dashboard over `/ws/hub` and accepts validated control commands on the same
  socket. The complete message table is documented below.
- Listens for direct UDP/OSC on `OSC_LISTEN_PORT` and supports `/subscribe` /
  `/unsubscribe` for that direct relay path. Managed OSCQuery client values
  are not forwarded to `/subscribe` destinations.
- Mirrors enabled managed-device values to Ableton on `ABLETON_PORT` with the
  legacy `device<id> <path> <first numeric value>` packet shape. Only the first
  source argument survives and non-numeric values become `0`. Disable with
  `ABLETON_FORWARD=0`.
- Separately mirrors enabled managed-device values to CosmicNoise using the
  versioned, type-preserving `/cosmicnoise/v1/input` envelope. Direct hub UDP
  input does not enter either mirror.

### Data-plane boundaries

Do not collapse these paths into one mental model:

1. **Discovery:** Bonjour `_oscjson._tcp` service observations become Device
   Registry upserts and LINK candidates.
2. **Managed OSCQuery:** the hub fetches each saved device's HTTP namespace,
   opens its WebSocket, LISTENs to every typed node, and receives JSON or
   binary OSC updates.
3. **Device control and LINK:** dashboard commands arrive over `/ws/hub`, then
   the hub sends OSC/UDP to the device control port. It does not write through
   the device WebSocket.
4. **Performance forwarding:** enabled managed updates can go to the legacy
   Ableton mirror and the independent CosmicNoise mirror. The actual
   tablet-to-VST high-rate peer stream is established by the VST after LINK;
   it is not relayed through the Manager.

### Real-time/audio boundary

The Manager is an external Node process; none of its discovery, JSON,
WebSocket, file, restart, or retry work belongs on an audio thread. In the
current VST, `NetworkManager` owns sockets and lifecycle, network callbacks feed
a dedicated engine worker, and a fixed-capacity SPSC queue crosses into
`processBlock()`. The audio callback only drains bounded MIDI events; it must
not gain locks, allocation, parsing, logging, socket/file I/O, or thread joins.
Plugin stop/removal must signal, close, and join network owners before their
state is destroyed. CosmicNoise follows the same separation with a loopback
network worker and bounded queues. Re-run each companion plugin's own tests and
Ableton instantiation/teardown checks after touching those boundaries.

## Install and run

### Prerequisites

- macOS is the currently exercised show environment. The Node/Vue Manager is
  portable in principle, but Bonjour, firewall, interface, and Ableton behavior
  must be revalidated on another OS.
- Node.js and npm. `package.json` does not currently pin an `engines` range or
  a version-manager file. This handoff was exercised with Node `22.14.0` and
  npm `10.9.2`; that is evidence, not a declared minimum.
- All devices on the same trusted multicast-capable LAN for Bonjour discovery.
- Ableton Live only for the VST/MPE portion; the dashboard and tests run
  without Ableton.

For a clean clone:

```bash
npm ci
npm run dev
```

This starts:

- the Vite dev server on every interface, port `5173` (bound to `0.0.0.0`
  so tablets / phones / other Macs on the same LAN can open the dashboard)
- the loopback-only Manager supervisor on port `7399`
- the supervised Node hub on every interface, port `7400`

Open `http://localhost:5173` locally, or `http://<this-machine-LAN-IP>:5173`
from another device on the same network. The startup logs print every LAN
address the server is reachable on.

Use one browser origin consistently. Browser persistence is origin-scoped, so
`http://localhost:5173` and `http://192.168.x.x:5173` do not share presets,
scenes, LINK selections, card order, or Performance Mode layout.

### npm scripts

| Command | Behavior |
| --- | --- |
| `npm run dev` | Supported integrated workflow: supervisor + auto-started hub + Vite. |
| `npm run dev:supervisor` | Supervisor on `7399`; it auto-starts one hub child. |
| `npm run dev:server` | Direct watched hub, with no lifecycle supervisor. Use only for backend debugging. |
| `npm run dev:web` | Vite only; a hub/supervisor must already be running. |
| `npm run start:supervisor` | Non-watched supervisor + hub child. |
| `npm run start:server` | Direct non-watched hub, bypassing supervisor controls. |
| `npm test` | Node unit/integration suite. |
| `npm run build` | Build static Vue assets into `dist/`. |
| `npm run preview` | Preview static assets only. `vite.config.js` defines dev-server proxies, not preview/production proxies, so preview is not by itself a functioning full stack. |

There is no production reverse-proxy/service definition in this repository.
A deployed static frontend must preserve both development routes: proxy
`/ws/*` with WebSocket upgrade to hub `:7400`, and proxy
`/api/manager/*` to supervisor `127.0.0.1:7399`. Do not expose the latter to an
untrusted network.

### Direct status and lifecycle checks

With `npm run dev` running:

```bash
curl -s http://127.0.0.1:7399/api/manager/status
curl -s http://127.0.0.1:7400/_status
curl -s http://127.0.0.1:7400/_devices
```

Lifecycle commands, equivalent to the Manager Bridge panel:

```bash
curl -s -X POST http://127.0.0.1:7399/api/manager/stop
curl -s -X POST http://127.0.0.1:7399/api/manager/start
curl -s -X POST http://127.0.0.1:7399/api/manager/restart
```

These requests are serialized. `Running` means the child reported its HTTP
bind; it does not mean devices connected. If the hub crashes unexpectedly, the
supervisor reports `Error` and does not auto-restart it.

The compact **Manager Bridge** panel reports the real supervised process state
(`Running`, `Stopped`, `Restarting`, `Error`), active ports, and provides
Start/Stop/Restart. Restart asks the hub to close sockets, timers, discovery,
watchers and clients, escalates after its grace period, and starts a replacement
after the bounded wait described above; manifests, presets and links are not
erased. Ableton owns the VST processes, so the panel does not pretend to start
or stop a plug-in instance.

Each canonical registry entity becomes one card in the dashboard. Discovery,
saved/manifest state and connection state are facets of that card, not separate
cards. From a card
you can:

- toggle the device on/off, edit its name, host, and OSCQuery port inline
- reconnect after a network change, or **remove** the device via the `×`
  in the top-right of the card (deletes its manifest file)
- browse the parameter tree (grouped by parent path, collapsible per group)
- edit parameters with type-aware widgets (see below)
- save/recall **presets** scoped to that device (stored in `localStorage`)
- **LINK** a CosmicUnity/Ableton instance to one Android or Other OSCQuery
  instrument on the LAN. The Manager writes the selected external device's
  host and OSCQuery port to the CosmicUnity instance, uses `udp_port=0` by
  default so every VST gets a unique ephemeral receive port, then bangs
  `/system/peer/connect`. Manual push only. CosmicUnity peers and the Manager
  itself are never offered as targets on a CosmicUnity card.
- The exact verified-local `MaxRing:8005` Node-for-Max service is presented in
  the **CosmicUnity / Ableton** group while remaining an OSCQuery device.
  Loopback and active local-interface announcements for this exact receiver
  share one record (`oscquery:local-maxring:8005` when no persistent UUID is
  advertised; persistent identity has priority). Same-name remote devices are
  never folded into it. Its LINK picker is intentionally locked to
  the exact `Ring-Instrument:9011` service. The same trusted `Max_Ring` receiver also
  appears in the Ring-Instrument card alongside regular CosmicUnity targets;
  choosing it resolves to the identical receiver/peer route. The backend
  enforces the pair in either UI direction and uses UDP receive port `9005`,
  because the current Max bridge cannot publish an ephemeral bind from
  `udp_port=0` and port `9001` belongs to the Manager.
  Connected registry peers remain selectable while Bonjour reconverges after
  a Manager restart; raw and registry candidates deduplicate by real FQDN.
- A verified-local Cosmic Ring VST3 advertising `DEVICE_TYPE=CosmicRing`
  (normally named `Live-Ring`) is also presented in **CosmicUnity / Ableton**.
  Its OSCQuery port is operator-configurable and may use the plug-in's port
  fallback, so identity is based on the persistent UUID plus verified-local
  runtime role rather than one hard-coded port. Its picker is fixed to the
  exact `Ring-Instrument:9011` peer and the backend re-resolves that endpoint
  from the Device Registry before every Push. Live-Ring keeps `udp_port=0`,
  allowing the VST3 to bind a unique ephemeral receive port and publish it via
  `/udp/register`; this is intentionally different from the legacy MaxRing
  bridge's fixed `9005` receive port.
- **Record / play back** the live PATH_CHANGED stream for that device
  (see *Recording* below).

Unsaved discoveries appear in the correct `CosmicUnity / Ableton`,
`Android Tablets`, or `Other OSCQuery Devices` section with a Save action.
Local CosmicUnity aliases are shown as `Bu Bilgisayar · Port N`; raw endpoint
aliases live under Details.

Press-and-hold a manifest card to drag-and-drop it into a new position;
the order is persisted in `localStorage`.

### Discovery lifecycle

1. The hub publishes itself as `_oscjson._tcp:7400` and `_osc._udp:9001`, and
   browses `_oscjson._tcp` on the LAN.
2. Every Bonjour service-up observation is normalized per IPv4 address and
   upserted into the registry. Multiple interface aliases become endpoints of
   one record only when canonical identity rules prove that merge is safe.
3. Raw service/FQDN data remains available to `/ws/discovery` because LINK
   needs the actual current endpoint, but the dashboard card list comes from
   the canonical registry.
4. Service-down marks matching endpoints unavailable and the record stale. It
   does not immediately delete a card or manifest.
5. Once per second the registry removes only stale **unsaved** records older
   than the configured TTL. Saved records keep retrying their existing entity.
6. **Rediscover** stops/recreates the Bonjour browser and clears the raw cache;
   it is not a manifest reset and does not restart Ableton/APKs.

### Identity and reconnect state

Discovery never directly creates a second UI entity. `DeviceRegistry` performs
an atomic upsert, indexes endpoints and FQDNs, and exposes one canonical record
whose discovery, saved, enabled, and connection states are independent facets.
The public record carries `canonicalId`, numeric `manifestId`, `deviceType`,
display/service names, `persistentDeviceId`, identity source, all endpoint
aliases, active endpoint, verified-local/runtime role, discovery/connection
state, saved/enabled flags, `lastSeen`, error, parameter count, runtime
generation, and legacy ID/canonical lineage.

Canonical identity priority:

1. A persistent ID from manifest, OSCQuery `HOST_INFO`, DNS-SD TXT, or another
   accepted UUID key becomes `<device-type>:uuid:<normalized-id>`.
2. New Android builds persist a 32-hex installation UUID in PlayerPrefs and
   append `--id-<uuid>` to the existing service name. The Manager strips the
   token from the display name but uses it for identity. Uninstall/app-data
   reset can intentionally create a new identity.
3. A UUID-less local CosmicUnity instance is `cosmicunity:local-port:<port>`,
   but only when the endpoint is loopback or one of this computer's currently
   active interface addresses.
4. The exact verified-local legacy MaxRing role can use
   `oscquery:local-maxring:8005`; UUID still has higher priority.
5. A verified-local UUID-less CosmicRing uses
   `cosmicring:local-port:<port>`. A remote CosmicRing that copies the local
   UUID is endpoint-scoped and never inherits local receiver authority.
6. Other legacy devices use a conservative
   `<type>:legacy:<host>:<port>:<service>` key.

Consequences:

- `127.0.0.1:5001` and this Mac's real LAN aliases for port `5001` can merge;
  an arbitrary remote `192.168.x.x:5001` cannot.
- Local ports `5001`, `5002`, and `5003` always remain separate VST entities.
- Two Android tablets on `9010` remain separate by UUID, or by legacy
  host/port/service fallback.
- A persistent UUID surviving DHCP change keeps one card. Historical endpoint
  and canonical aliases are retained for migration.
- A saved manifest endpoint without an observed fqdn gets one derived from the
  manifest `serviceName` (`<serviceName>._oscjson._tcp.local`, marked
  `fqdnSource: "derived"`). Exact-fqdn folding and the host-follow heal use it,
  so a hub that starts fresh after a DHCP move still folds the new address into
  the saved card and migrates the manifest (incident 2026-09-03: hub and
  TouchDesigner machine rebooted together, cards stuck on the dead address).
  A derived fqdn is not mDNS-grade evidence: the HOST_INFO wrong-device name
  guard and persisted LINK target identity only honour observed fqdns, and a
  display label without `serviceName` derives nothing.
- A card that connects successfully persists the fqdn mDNS announces at the
  address it reached as the manifest's `serviceFqdn` — its service identity,
  observed rather than guessed, so a card an operator named "TV" is still
  identified as `Windows_TVNEVA40902._oscjson._tcp.local`. It outranks the
  derived fqdn everywhere, survives hub restarts, and is what host-follow heal
  follows once a hand-edited HOST has replaced the endpoints with a single
  identity-less `manual-update` entry. The first proof wins: a card that
  already holds a `serviceFqdn` never adopts a different one from a later
  connection, so an address handed to another device by DHCP cannot rewrite
  who the card is. A hand-edited HOST/PORT now also copies the fqdn mDNS
  announces at the typed address onto the new endpoint, unless it contradicts
  the card's `serviceFqdn`.
- If an Ableton track/set duplication makes two simultaneously live local
  ports claim the same CosmicUnity UUID, the registry creates a port-scoped
  collision identity. Repair the clone explicitly with the VST's **Yeni ID**
  action; never auto-regenerate IDs during load.

The current VST creates a persistent `deviceId` in plugin state and publishes
it as `HOST_INFO.DEVICE_ID` plus DNS-SD TXT `device_id`; it publishes
`DEVICE_TYPE=CosmicUnity` or `CosmicRing`, its service name, and the actual
bound fallback port. Fresh regular instances are Passive until activated;
Passive means no listener and no Bonjour announcement, not a special registry
packet. Saved Ableton sets restore their state. The Android identity component
runs before its OSCQuery orchestrator and persists its installation ID in
PlayerPrefs before constructing the advertised name.

### Connection state machine

| State | Meaning and transition behavior |
| --- | --- |
| `Discovered` | Known by Bonjour or saved configuration, no active device WebSocket yet. |
| `Connecting` | One HTTP namespace + WebSocket-open attempt is in flight. |
| `Connected` | Namespace fetched and device WebSocket opened; it is not proof of peer/MIDI/audio flow. |
| `Unavailable` | A three-second attempt deadline expired or an established WebSocket was lost. |
| `Error` | A non-timeout connection/protocol failure occurred. |
| `Disabled` | Saved device is intentionally disabled; no client should run. |

One attempt owns a hard `3000 ms` deadline. Its fetch controllers, WebSocket,
and timer are cleaned when it fails or is replaced. Initial failures retry
after `3000 ms`; a previously established connection retries after `500 ms`.
The same saved entity/card is retained, so retries never create a new manifest.
Only unsaved Bonjour records marked stale are pruned, once per second, using
`DISCOVERY_STALE_TTL_MS` (default `15000 ms`). Saved devices do not expire.

### Manifest persistence and startup migration

`manifests/*.json` is machine-local runtime configuration and is intentionally
gitignored. A normal record contains at least:

```json
{
  "id": 8,
  "name": "LiveTablet-1",
  "type": "oscquery-device",
  "deviceType": "CosmicUnity",
  "canonicalId": "cosmicunity:uuid:<persistent-id>",
  "persistentDeviceId": "<persistent-id>",
  "serviceName": "LiveTablet-1",
  "serviceFqdn": "LiveTablet-1._oscjson._tcp.local",
  "host": "127.0.0.1",
  "oscQueryPort": 5001,
  "enabled": true,
  "endpoints": [],
  "legacyIds": [],
  "legacyCanonicalIds": []
}
```

Runtime-only fields such as connection/error state, active endpoint,
`oscPort`, parameter count, counters, and runtime generation are not persisted.
Unknown extension fields are preserved by ordinary edits.

At startup the migration groups only identities that are safe to merge. For a
duplicate group it keeps the lowest numeric manifest ID, prefers the freshest
persistent identity/endpoint, merges endpoint and legacy lineage, atomically
rewrites the kept file through a temporary rename, and moves duplicate files
to `manifests/.deduplicated/<timestamp>/`. That migration archive is distinct
from Remove: clicking a card's `×` permanently unlinks its manifest and makes
no backup, Trash copy, tombstone, or restore record.

Use **Export** before **Import**. Import is a destructive full replacement: it
disconnects clients, removes every current manifest JSON, validates/writes the
accepted input records, and reloads. It is currently non-transactional: files
are deleted before every incoming record has been validated and written, and a
mid-import error can leave a partially replaced manifest set. A manifest
export does **not** include browser presets, scenes, LINK choices, card order,
Performance Mode layout, or recordings.

### Environment variables

All variables are optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7400` | Hub HTTP/WS port. |
| `SUPERVISOR_PORT` | `7399` | Loopback lifecycle API. |
| `OSC_LISTEN_PORT` | `9001` | Hub direct OSC UDP input/relay port. |
| `OSC_LISTEN_DISABLED` | unset | Set to `1` to skip the direct UDP bind and boot manifests immediately. The current code still publishes `_osc._udp` at the configured port, so consumers can see an unusable advertisement. |
| `OSC_VERBOSE` | unset | Set to `1` for per-message direct-UDP logs. Avoid during high-rate shows unless diagnosing. |
| `DISCOVERY_STALE_TTL_MS` | `15000` | TTL for stale, unsaved registry observations only. |
| `HUB_NAME` | `Cosmic Live Manager` | Bonjour and OSCQuery host name. |
| `MANIFESTS_DIR` | `./manifests` | Watched machine-local manifest directory. |
| `HUB_START_TIMEOUT_MS` | `7000` | Supervisor child ready deadline. |
| `HUB_STOP_TIMEOUT_MS` | `3500` | Grace before supervisor escalates to `SIGKILL`. |
| `ABLETON_HOST` | `127.0.0.1` | Legacy Ableton/M4L mirror target. |
| `ABLETON_PORT` | `10000` | Legacy Ableton/M4L mirror UDP port. |
| `ABLETON_FORWARD` | enabled | Set to `0` to disable the legacy mirror. |
| `COSMICNOISE_HOST` | `127.0.0.1` | CosmicNoise v1 target. |
| `COSMICNOISE_PORT` | `10001` | CosmicNoise v1 UDP port. |
| `COSMICNOISE_FORWARD` | enabled | Set to `0` to disable the CosmicNoise mirror. |
| `COSMICNOISE_SNAPSHOT_MS` | `250` | Lifecycle replay interval; `0` disables replay. Valid range `0..60000`. |

The Vite proxy targets `7399` and `7400` are hard-coded. If either port is
changed through the environment, update `vite.config.js` or supply an external
proxy as well.

## LINK routing contract

The picker looks symmetric, but the wire protocol is deliberately
asymmetric. The external instrument's coordinates are always written **to the
receiving CosmicUnity/Ableton device**, regardless of whether the operator
started from the receiver card or from the external-device card.

| Source card | Allowed picker targets | Actual receiver of `/system/peer/*` | Default `udp_port` |
| --- | --- | --- | --- |
| Regular CosmicUnity | Android or generic Other OSCQuery, including Ring-Instrument | Source CosmicUnity | `0` |
| Android tablet | Regular CosmicUnity only | Selected CosmicUnity | `0` |
| Generic Other OSCQuery | Regular CosmicUnity only | Selected CosmicUnity | `0` |
| Exact Ring-Instrument on `9011` | Regular CosmicUnity plus a trusted local MaxRing or Live-Ring | Selected Ableton receiver | Receiver-specific |
| Trusted local MaxRing on `8005` | Exact Ring-Instrument on `9011` only | MaxRing | `9005` |
| Trusted local `Live-Ring` / `CosmicRing` | Exact Ring-Instrument on `9011` only | Live-Ring | `0` |

Therefore:

- CosmicUnity devices never appear as targets for another regular
  CosmicUnity device.
- Android devices do not target each other.
- Android and Other OSCQuery devices remain visible from regular CosmicUnity
  cards.
- `Live-Ring` is the one fixed CosmicRing/Ableton receiver for
  `Ring-Instrument`; it is not offered to unrelated external devices.
- The Manager itself, the current source, same-category links, remote/untrusted
  Ring receivers, and wrong-port special Ring identities are filtered in the
  UI and rejected by backend topology checks.

On Push, the backend resolves the receiving device's OSC UDP control port from
cached `HOST_INFO` or one bounded refresh. LINK fails closed if the receiver
does not provide a valid `OSC_PORT`; the HTTP port is not guessed. It then
dispatches these five OSC/UDP messages in order:

```text
/system/peer/peer_id        <sanitized external peer id>
/system/peer/host           <external instrument host>
/system/peer/oscquery_port  <external instrument OSCQuery port>
/system/peer/udp_port       <receiver's requested local stream port>
/system/peer/connect        true
```

`udp_port=0` is intentional for the VST3: it means “bind a unique ephemeral
receive port and register the actual result with the external instrument,” not
“use the tablet's OSC port.” The legacy MaxRing bridge cannot publish an
ephemeral bind and therefore uses fixed receive port `9005`.

`peer_id` is lowercased, unsupported characters become `_`, and a blank value
defaults to the external instrument's name. A positive expert override in
`1..65535` wins for the current Push; the UI does not persist the override.

`ANNOUNCE_RESULT { ok: true }` means validation/port resolution completed and
the Manager invoked its five local UDP sends. UDP has no acknowledgement here;
success does not prove the peer connected, tablet frames arrived, MPE was
generated, a virtual MIDI route was selected, or a synthesizer produced sound.

## CosmicNoise v1 loopback protocol

The default target is the local machine at `127.0.0.1:10001`. For each live
value received from an enabled managed device's OSCQuery connection, the hub
sends one standard OSC/UDP message:

```text
address: /cosmicnoise/v1/input
args:    int32 deviceId, string sourcePath, ...all original payload values
```

The first two type tags are therefore always `is`. Every following payload
type is taken from the source node's OSCQuery `TYPE` metadata. Supported source
tags are `f` (float32), `i` (int32), `s` (string), `T`/`F` (boolean), and `d`
(float64). Multi-value declarations remain multi-value: a node with `TYPE=fff`
produces `,isfff`, not a packet containing only its first component. A string
is forwarded as `s`, even if it looks numeric.

Examples:

```text
/cosmicnoise/v1/input ,isfff  3 "/touch/xyz" 0.1 0.2 0.3
/cosmicnoise/v1/input ,iss    8 "/preset/name" "Cosmic Unity"
/cosmicnoise/v1/input ,isF    8 "/enabled" false
```

When the namespace provides no `TYPE` for a dynamic path, binary OSC wire
metadata is the second choice; conservative JavaScript inference is the final
fallback so a managed-device value is not silently truncated. Malformed or
unsupported values are dropped as a whole packet and rate-limited in the log.
The `/_status` endpoint reports `sent`, `dropped`, asynchronous UDP `errors`,
and the snapshot configuration/cache/replay counters described below.
If a declared node type cannot represent the received value (for example, a
server advertises `T` but actually transmits int32 `0/1`), the binary wire tag
wins so the original payload is preserved without coercion.

Input is bounded before transmission:

| limit | value |
| ----- | ----- |
| source payload arguments | 30 (32 total including device id + path) |
| UTF-8 source path | 1024 bytes |
| each UTF-8 payload string | 1024 bytes |
| complete UDP packet | 4096 bytes |

### Loss-tolerant lifecycle snapshots

UDP remains best-effort, so the Manager periodically repeats only the latest
complete CosmicNoise lifecycle states. The interval is controlled by
`COSMICNOISE_SNAPSHOT_MS` (default `250` ms; `0` disables replay). Exact cached
paths and required effective types are:

| source path | type | replay order |
| ----------- | ---- | ------------ |
| `/0` … `/9` | `ffff` | numeric finger order |
| `/PerformanceController/finger0` … `finger9` | `fff` | position before its Playing state |
| `/PerformanceController/finger0Playing` … `finger9Playing` | `i`, `T`, or `F` | after its position |
| `/PerformanceController/droneWavelengthsString` | `s` | after finger state |

Each replay is the exact encoded v1 packet last received, so a full stop
(`0`), a `Playing=0`, and a drone-removal string such as `"0"` are repeated
without reinterpretation. Caller-owned payload/type arrays are copied before
caching. Similar-looking paths, partial/wrong-arity values, and heartbeats are
never cached.

Replay is scoped to the current managed-device session: the current device
must still be enabled and `connected`, with `lastMessageAt` at most `1000` ms
old. Individual lifecycle entries do not expire while that session remains
fresh, so a quiet sustained drone can still be restored after a receiver-side
panic/reset. If the device becomes stale or disconnects, the whole device cache
is cleared; a later heartbeat alone cannot recreate that removed state. Disable,
remove, manual reconnect, manifest import, and Manager shutdown also clear the
applicable cache. The cache is bounded to 31 lifecycle entries per device and
256 devices.

`/_status.cosmicNoise` exposes `snapshotMs`, `snapshotFreshnessMs`,
`snapshotDevices`, `snapshotEntries`, `snapshotReplayed`, and
`snapshotDropped`. Snapshot packets go only to CosmicNoise; the legacy Ableton
mirror still receives each managed-device value once and never receives these
periodic repeats.

“Type-preserving” means that payload order, arity, and OSC type tags survive
the mirror. UDP itself is best-effort and does not guarantee delivery. The
legacy Ableton output remains independently controlled by `ABLETON_FORWARD`
and retains its existing packet shape.

## Manager HTTP and WebSocket contracts

### Hub HTTP on `:7400`

| Route | Response |
| --- | --- |
| `GET /_devices` | Canonical registry snapshot, per-manifest message counts, and Manager self ports. |
| `GET /_status` | Namespace/WS/subscriber/device counters, registry state, Ableton mirror count, and CosmicNoise diagnostics. |
| `GET /?HOST_INFO` | Manager OSCQuery host information, including UDP port `9001`. |
| `GET /` | OSCQuery-shaped tree of values observed or written by the hub. |
| `GET /<path>` | One observed parameter/subtree, or `404`. |

### WebSockets

- `/ws/discovery` sends `{ type: "services", services: [...] }` snapshots of
  the raw Bonjour cache used by LINK pickers.
- `/ws/hub` is the dashboard protocol. `/` is a compatibility alias. Messages
  are capped at 65,536 bytes.
- The hub's HTTP output is OSCQuery-shaped, but its own WebSocket is not a
  general path-filtered OSCQuery `LISTEN` service. It sends custom Manager
  state/events immediately.

Dashboard-to-hub commands:

| Type | Purpose |
| --- | --- |
| `SET` | Write directly into the Manager's own observed namespace. |
| `UPDATE_DEVICE` | Persist validated name/host/port/enabled changes. |
| `RECONNECT_DEVICE` | Dispose the current client attempt/session and reconnect the same entity. |
| `SET_DEVICE_PARAM` | Send a parameter value by OSC/UDP to the managed device's advertised OSC port, falling back to its OSCQuery HTTP port if absent. This fallback is less strict than LINK. |
| `ANNOUNCE_DEVICE` | Validate and invoke five local LINK UDP send attempts. |
| `RELOAD_MANIFESTS` | Reload and reconcile the watched manifest set. |
| `REDISCOVER` | Recreate the Bonjour browser and clear raw discovery caches. |
| `EXPORT_MANIFESTS` | Request the durable manifest subset. |
| `IMPORT_MANIFESTS` | Destructively replace the complete manifest JSON set. |
| `REMOVE_DEVICE` | Permanently delete one manifest without backup. |
| `ADD_DISCOVERED` | Create a saved device from a manually supplied host/port. |
| `SAVE_DEVICE` | Persist one canonical discovery. |

Manual Add has a current frontend/backend validation mismatch. The form accepts
any non-empty host and a port in `1..65535`; the hub accepts only its restricted
hostname/IP grammar and ports in `1024..65535`. Values such as privileged ports
can therefore pass the form and then return `ADD_DEVICE_RESULT` with an error.

Hub-to-dashboard events/results:

```text
INITIAL_STATE        PATH_CHANGED          DEVICE_NAMESPACE
DEVICES_RELOADED     REGISTRY_UPDATED      DEVICE_UPDATED
DEVICE_REMOVED       DISCOVERED_DEVICES    SUBSCRIBERS_CHANGED
DEVICE_MSG_COUNTS    UPDATE_DEVICE_RESULT  ANNOUNCE_RESULT
ADD_DEVICE_RESULT    MANIFESTS_EXPORT      ERROR
```

There is no wire-level `SAVE_HINT`; save/reconnect hints are browser-local UI
state.

## Security boundary

This is a **trusted rehearsal/show LAN tool**, not an Internet-facing service:

- Hub HTTP, WebSockets, and OSC UDP bind all interfaces.
- There is no authentication, authorization, TLS, WebSocket Origin check, or
  per-command rate limit. CORS is effectively `*` for remote origins.
- Both frontend sockets currently construct `ws://` URLs explicitly. Adding an
  HTTPS reverse proxy without changing them to protocol-aware `wss://` URLs
  causes mixed-content failures.
- During development the LAN-bound Vite server proxies the loopback supervisor,
  so a client that can reach port `5173` can also request Start/Stop/Restart.
- A hub WebSocket client can update/delete/import manifests and send device
  controls. Keep untrusted clients and browser content off this network.
- `verifiedLocal`/Ring trust means an endpoint matched this machine's active
  interface list plus the exact expected identity. It is anti-confusion logic,
  not cryptographic authentication.

Current defensive bounds include 50 UDP subscribers, 10,000 observed namespace
entries, a 64 KiB hub-WebSocket payload cap, validated paths/hosts/ports on
selected commands, and strict CosmicNoise packet/cache limits. Put the show
machine behind a firewall/VLAN and never port-forward `5173`, `7400`, or
`9001` to the public Internet.

## Parameter widgets

`ParameterControl.vue` picks the widget by inspecting the OSCQuery node
metadata. The rules are applied **in this order**:

1. **Trigger** — `TYPE = "N"` or `"I"` → a button that sends the address with
   no args (OSC impulse). Used for actions like `ResetSpectrum`.
2. **Boolean** — `TYPE` is `"T"`, `"F"`, `"TF"`, `"FT"`, or `"B"` → toggle.
3. **Enum / menu** — any `RANGE[0].VALS` array present → dropdown.
   After trigger and boolean types have been ruled out, this branch wins over
   numeric/string/fallback rendering. The dropdown shows labels from `VALS`;
   for `TYPE = "i"` (the Max scanner emits menus this way), the
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
   - `RANGE.MIN`/`MAX` is exposed as HTML `min`/`max` and clamps drag changes.
     The current typed-value commit path sends the typed number without an
     explicit clamp, so the device must still validate out-of-range input.
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

- **Presets** — per-device single-parameter `(path, value)` shortcuts; click a
  chip to fire.
- **Parameters** — the namespace tree with widgets (see above).
- **LINK** — on a CosmicUnity card, pick an Android tablet or Other OSCQuery
  device that instance should receive performance data from. Android and Other
  OSCQuery cards show only CosmicUnity targets. Optionally set `peer_id` or a
  unique expert UDP override, then click **Push**. Zero is the safe default and
  lets the VST choose its own ephemeral UDP receive port. The `↺` button next
  to Peer ID resets it to the sanitized device name (useful when localStorage
  has a stale entry). The two trusted Ring receivers are narrow exceptions:
  both Max_Ring and Live-Ring offer only `Ring-Instrument:9011`, while the
  Ring-Instrument card can select either verified-local receiver as well as
  regular CosmicUnity instances. Max_Ring defaults to receive port `9005`;
  Live-Ring defaults to `0` so its VST3 can allocate an ephemeral port.
- **Recordings** — live capture / playback of PATH_CHANGED events (see
  next section).

## Frontend state and persistence

The Vue app has no router or external state library. `useHub()` owns one
singleton `/ws/hub` connection for the page, `useDiscovery()` owns the separate
raw-discovery socket, and `useServerControl()` polls supervisor state every
second. Both WebSockets retry after `1500 ms`. While the top badge says
`Reconnecting…`, `useHub.send()` drops commands because there is no open
socket; wait for `Connected` before editing, importing, removing, or pushing.

| Storage | Contents | Scope/backup |
| --- | --- | --- |
| `manifests/*.json` | Saved device identities/endpoints/enabled state | Server filesystem; included by Manifest Export. |
| `clm:active-page` | Dashboard vs Performance Mode tab | Browser origin only. |
| `clm:hub-device-order` | Canonical card order | Browser origin only. |
| `clm:hub-presets:<canonical-id>` | Per-device single `(path, value)` shortcuts | Browser origin only; not Manifest Export. |
| `clm:hub-announce:<canonical-id>` | Sticky LINK target FQDN and peer ID | Browser origin only; UDP override is intentionally session-only. |
| `clm:hub-scenes` | Whole-rig cached writable-parameter snapshots | Browser origin only; no JSON export UI. |
| `clm:performance-presets` | Performance Mode parameter shortcuts and layout | Browser origin plus its own JSON export/import. |
| Recording buffer | Exact timed PATH_CHANGED events | Memory only until explicitly downloaded as recording JSON. |

When canonical/numeric identity changes, `storageMigration.js` performs a
one-time lineage migration. Presets merge and deduplicate; scalar LINK state
uses the newest meaningful source. `:legacy-consumed:` and
`:legacy-consolidated:` markers prevent an intentionally deleted setting from
being resurrected by an older alias. Legacy values are retained rather than
deleted so a failed storage write cannot destroy the only copy. Scenes and
Performance Mode separately remap historical numeric manifest IDs.

All `localStorage` keys are origin-specific. Export browser state separately
before changing hostname, protocol, port, browser profile, or show computer.

### Global scenes

A Scene is a best-effort browser snapshot, not an acknowledged show cue. Save
captures only nodes that are currently cached, writable, and have a defined
`VALUE`. Recall emits one unacknowledged `SET_DEVICE_PARAM` command per captured
value; if the hub socket or destination device is disconnected, those writes
can be dropped. Confirm the Manager badge and required device cards are
`Connected` before saving or firing a Scene. Scenes are origin-local and are
not included in Manifest Export.

## Recording

Every saved device card has its own recording engine; the card can be offline,
but only incoming events can be captured. The
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
    { "t": 91,   "path": "/dial", "value": [0.72] }
  ]
}
```

### Playing a recording back

The browser sends each event to the hub as `SET_DEVICE_PARAM` over `/ws/hub`.
The hub then sends OSC/UDP to the managed device's advertised `HOST_INFO`
`OSC_PORT`, falling back to its OSCQuery HTTP port if no OSC port is known. It
also emits an optimistic dashboard `PATH_CHANGED`; that visual update is not
proof the device received the datagram. Playback does **not** write through the
device's OSCQuery WebSocket.

If the UI moves but the device does not respond, check `?HOST_INFO`, the actual
OSC control listener, firewall, parameter path/type, and the device's own
receive log. Then verify MIDI/MPE/instrument response separately.

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

For the Max-for-Live source side, use the explicit
[CosmicSymphonyCreative/M4L](https://github.com/CosmicSymphonyCreative/M4L)
repository and the actual workstation projects listed near the top of this
README. There is no verified `../M4L/` sibling in this checkout. The local
root scripts `oscquery.server.js` and `ws_register.js` are not imported by the
Manager server.

## Frontend layout and responsive behavior

The dashboard groups cards in this order: Manager controls/statistics/scenes,
manual add, **CosmicUnity / Ableton**, **Android Tablets**, then optional
**Other OSCQuery Devices**. A saved and discovered device is one card, not two.
`Active` means saved + enabled; `Connected` is a separate metric.

- The device grid auto-fills with cards from `300 px` upward.
- At `<=900 px`, top controls wrap, stats use three columns, manual add fills
  the row, and server controls become one column.
- At `<=600 px`, stats use two columns, card actions stack, parameter metadata
  is reduced, and LINK fields fill the width.
- Status is always conveyed by text as well as color.

Known touch/responsive gaps still requiring real-device verification:
Performance preset move/resize uses mouse events rather than pointer/touch
events; device wrappers use `touch-action: none`; and Add Preset has a
`380 px` minimum width that may overflow a very narrow viewport.

## Project layout

```
package.json
vite.config.js              # LAN Vite server; dev WS and lifecycle proxies
index.html
manifests/                  # gitignored machine-local device JSON; live-watched
oscquery.server.js          # companion Node-for-Max OSCQuery server, not hub entry
ws_register.js              # companion Node-for-Max UDP registration client
shared/
  maxRingLink.js            # exact MaxRing/Ring-Instrument identities and role
  cosmicRingLink.js         # exact CosmicRing/Live-Ring identity and role
server/
  index.js                  # hub: Bonjour, WS/HTTP, UDP, manifests, routing
  supervisor.js             # serialized child start/stop/restart API
  deviceRegistry.js         # canonical identity, atomic upsert, migration/TTL
  linkRouting.js            # server-authoritative asymmetric LINK resolution
  cosmicNoiseForwarder.js   # bounded CosmicNoise v1 OSC encoder, UDP sender,
                            # and session-scoped lifecycle snapshot replay
  oscqueryClient.js         # per-device HTTP + WS, JSON/binary OSC, 3s deadline
test/
  cosmicNoiseForwarder.test.js # protocol/type/guard/UDP sender unit tests
  deviceRegistry.test.js       # canonical identity/races/migration/TTL
  linkRouting.test.js          # backend target matrix and Ring trust
  linkTargets.test.js          # frontend target classification/dedup/stickiness
  managerConnectionLifecycle.integration.test.js # unavailable/reconnect/same id
  managerForwarding.integration.test.js # real hub/device/UDP routing matrix +
                                        # lifecycle replay/stale/disable proof
  managerLinkRouting.integration.test.js # live hub LINK dispatch/resolution
  oscqueryClient.test.js       # OSCQuery TYPE + binary metadata propagation
  storageMigration.test.js     # one-time canonical browser-state lineage
  supervisor.integration.test.js # repeated lifecycle + port/manifest proof
src/
  main.js
  App.vue                   # 2-tab switch: Dashboard / Performance Mode
  styles.css
  components/
    HubDashboard.vue        # server control, grouped canonical registry,
                            #   stats, scenes and drag-reorder
    PerformanceMode.vue     # Blank canvas of preset shortcuts
    DeviceCard.vue          # Header + host/port + Presets + Parameters
                            #   + LINK + Recordings
    ServerControl.vue       # real Manager Bridge state + lifecycle actions
    ParameterControl.vue    # Widget picker (trigger / bool / enum / num / …)
    PresetSection.vue       # Per-device preset save / recall list
    RecordingPanel.vue      # Per-device recording + playback UI
    PerformancePreset.vue   # Draggable/resizable rectangle (PM)
    AddPresetModal.vue      # New PM preset dialog
    SceneBar.vue            # Global scene chips above the device grid
    DiscoveredCard.vue      # retained component; currently not mounted
  composables/
    useHub.js               # /ws/hub client (singleton), devices,
                            #   deviceParams, onPathChange subscribe API
    useServerControl.js     # supervisor state polling and commands
    useHubPresets.js        # localStorage-backed presets per device
    useDiscovery.js         # mirror of the hub's Bonjour discovery list
    usePeer.js              # peer_id sanitisation for the LINK flow
    useRecording.js         # per-device record buffer + JSON export +
                            #   real-time playback engine
    usePerformancePresets.js# global PM preset store (localStorage + JSON
                            #   export/import)
    useScenes.js            # global scenes (whole-rig snapshots)
  utils/
    linkTargets.js          # UI target matrix, identity matching, dedup
    storageMigration.js     # pure canonical/legacy localStorage migration
```

## Automated validation

Run from the Manager repository root:

```bash
npm test
npm run build
git diff --check
```

Handoff verification on 2026-08-29 (macOS, Node `22.14.0`): `124/124`
Node tests passed, Vite production build completed, and `git diff --check`
reported no whitespace errors. Re-verified on 2026-09-03 after the derived-fqdn
host-follow fix: `214/214`, and again after the observed `serviceFqdn`
identity work: `233/233`. These are timestamped results, not a substitute
for rerunning the commands after later edits.

The Node suite covers canonical identity and simultaneous discovery races,
manifest migration, frontend and backend LINK matrices, Ring trust and
resolution, localStorage lineage, OSCQuery timeouts/cleanup/type metadata,
managed/direct forwarding boundaries, CosmicNoise packet/snapshot behavior,
and repeated supervisor lifecycle/port rebinding. Integration tests bind real
loopback HTTP, WebSocket, and UDP sockets; do not run them in a sandbox that
forbids local networking.

The repository does not currently provide lint, TypeScript/typecheck, Vue
component tests, browser E2E, visual regression, responsive-layout automation,
or a pinned Node toolchain. A passing Node suite/build is not Ableton/Android
certification.

## End-to-end show smoke test

Use this after network, registry, LINK, VST, APK, or lifecycle changes:

1. Start `npm run dev`. Require **Manager Bridge: Running** and the top
   WebSocket badge **Connected**.
2. Confirm expected device groups, canonical IDs, names, and ports. Loopback
   and this Mac's LAN aliases for one local VST port must be one card;
   `5001/5002/5003` must remain separate.
3. Confirm two tablets sharing `9010` have different persistent IDs/hosts and
   separate cards. If an old APK has no persistent token, record that fallback
   identity risk explicitly.
4. From one regular CosmicUnity card, select the intended Android/Other
   instrument, keep UDP `0`, confirm/reset the peer ID, and Push. Optionally
   exercise the reverse card UI and confirm it resolves to the same receiver.
5. In Ableton, match the VST service/OSCQuery port. Confirm the per-instance
   virtual MIDI output (`Cosmic Unity Out (<service>)`), route it to the
   destination synth track on **All Channels**, enable MPE with the expected
   pitch-bend range, and use **Test Nota**.
6. Use real tablet fingers. Require observable incoming device data, VST peer
   state, virtual MIDI activity, note/pitch/pressure response, and actual
   instrument sound. A dashboard counter alone is insufficient.
7. For Ring, require trusted local Live-Ring/MaxRing pickers to show only exact
   `Ring-Instrument:9011`; Live-Ring uses UDP `0`, legacy MaxRing `9005`.
8. Restart Manager several times. Require one listener per port, the same
   canonical cards, retained manifests/browser LINK choices, and normal
   reconnection. Push remains manual after restart.
9. Disconnect/reconnect a tablet and a VST. Require no new card and no
   `Connecting` attempt longer than three seconds.
10. Finish with the receiver/plugin **Panic** action. Record exact commits,
    APK/VST versions, identities, endpoints, and what was actually heard.

Long tablet/XR endurance, Ableton set save/restore, plugin removal/teardown,
MPE pitch behavior, and live instrument output remain manual acceptance tests.

## Troubleshooting

### UI loads but Manager control is unavailable

- Confirm `npm run dev` started both named processes.
- Check `curl http://127.0.0.1:7399/api/manager/status`.
- If environment ports changed, remember Vite's proxy targets are still
  hard-coded in `vite.config.js`.

### Manager says Running but manifests/devices never appear

Normal boot loads manifests only after UDP `9001` reports ready. A UDP bind
failure can therefore coexist with an HTTP child that reported `Running`.
Inspect the terminal and explicit listeners:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:7399 -sTCP:LISTEN
lsof -nP -iTCP:7400 -sTCP:LISTEN
lsof -nP -iUDP:9001
```

Stop the known owning process cleanly. Do not “free every UDP port,” use
`killall node`, or kill unrelated show software. If direct hub UDP is not
needed, `OSC_LISTEN_DISABLED=1 npm run dev` boots without binding `9001`, but
the current hub still advertises that UDP service and should be treated as a
temporary diagnostic mode.

### Duplicate local VST card

- Compare canonical ID, persistent UUID, endpoint aliases, and actual bound
  port under Details.
- Verify the alleged LAN address belongs to this Mac; remote addresses must not
  be folded into local identity.
- If two live ports share one cloned UUID after Ableton duplication, use the
  duplicated VST instance's **Yeni ID** action.
- Do not fix duplicate UI by deleting arbitrary cards before understanding the
  identity collision.

### Duplicate or unstable tablet card

Use an APK built from the persistent-identity integration. Old builds fall
back to host/port/service and can appear new after DHCP/name changes. App-data
reset or reinstall intentionally generates another installation UUID.

### Push is green but finger data does not reach CosmicUnity

Green only confirms local dispatch. Verify, in order: selected external
identity and current endpoint; receiving VST `HOST_INFO.OSC_PORT`; five
`/system/peer/*` values; receiver peer/WebSocket state; `/udp/register` and the
actual VST receive port; firewall; virtual MIDI output; Ableton routing/MPE;
then synth response. Re-Push after changing target/receiver state.

### Resetting state safely

- **Rediscover** recreates only the Bonjour browser/cache.
- **Restart** recreates the hub process and volatile network state but keeps
  manifests and browser storage; its old-child exit wait is bounded rather
  than a hard proof that no orphan survived.
- Card **Remove** permanently deletes one manifest with no backup.
- **Import** non-transactionally replaces all manifests; Export first and keep
  that file until the replacement set is verified.
- To deliberately clear only Manager browser state for the current origin,
  export what you need and run this in that dashboard's DevTools:

  ```js
  Object.keys(localStorage)
    .filter((key) => key.startsWith('clm:'))
    .forEach((key) => localStorage.removeItem(key))
  ```

## Known limitations and next work

- No authenticated/TLS deployment or production reverse-proxy configuration;
  frontend WebSocket URLs are hard-coded to `ws://` rather than deriving
  `ws://`/`wss://` from the page protocol.
- No automatic crash restart after an unexpected hub exit.
- Supervisor stop/restart uses a bounded exit wait and cannot absolutely prove
  that a non-responsive child exited before its reference is cleared.
- No per-parameter LISTEN selection; every typed device node is subscribed.
- No first-class raw manifest/extension-field editor; the UI edits the common
  device fields only.
- Manifest Import and Remove have no automatic backup/undo; Import is also
  non-transactional and can leave a partial replacement after a write error.
- `OSC_LISTEN_DISABLED=1` still publishes `_osc._udp`.
- Recording playback speed is fixed to real time and scheduling uses many
  `setTimeout` calls.
- Performance Mode lacks touch/pointer move/resize, alignment guides, layout
  lock, and fullscreen show controls.
- Narrow-screen modal/card touch behavior still needs physical tablet QA.
- Ordinary LAN device identity/routing is not cryptographically authenticated.
- CosmicNoise v0.1 has one loopback listener/virtual-MIDI owner; multi-instance
  routing requires a future broker/session design.

## Licensing and redistribution

No top-level first-party LICENSE was found in the Manager, CosmicUnityVST3,
Unity app, or M4L repositories during this audit. Do not infer public
redistribution rights from GitHub visibility. The pinned OSCQuery-Unity package
declares GPL v3, and JUCE requires a license compatible with the VST product's
distribution. Review all first- and third-party terms before distributing the
dashboard, APK, VST3 bundles, Max devices, or source derivatives.
