// OSCQuery client for talking to a single remote OSCQuery device.
//
// Ported from the OSCQuery Hub project (originally TypeScript, in Turkish).
// Used by the Cosmic Live Manager helper to maintain a persistent connection
// to every manifest-declared device:
//
//   1. HTTP GET host:port/  → fetch the device's namespace JSON
//   2. WebSocket ws://host:port/ → open a streaming channel
//   3. For every path in the namespace, send {"COMMAND":"LISTEN","DATA":"/path"}
//   4. Inbound frames may be JSON (OSCQuery commands) or binary OSC packets
//      (TouchDesigner-style devices push raw OSC over the WS). Both are
//      decoded and reported via onValue(path, value, metadata).
//   5. If an established WS drops, retry quickly; ordinary connection failures
//      keep the slower retry interval.

import WebSocket from 'ws'
import osc from 'osc'

// Defensive caps applied to a remote device's namespace JSON. A buggy or
// hostile OSCQuery server on the LAN must not be able to balloon hub memory
// or blow the stack with a pathological tree.
export const MAX_NAMESPACE_BYTES = 2 * 1024 * 1024 // 2 MB
export const MAX_HOSTINFO_BYTES = 64 * 1024 // 64 KB

// Read a fetch response body with a hard byte cap enforced WHILE streaming —
// a hostile or buggy LAN server must not balloon hub memory before a
// post-hoc size check ever runs. Throwing mid-iteration cancels the stream.
async function readBodyCapped(res, maxBytes, label) {
  if (!res.body) {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
      throw new Error(`${label} too large (> ${maxBytes} bytes)`)
    }
    return text
  }
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) throw new Error(`${label} too large (> ${maxBytes} bytes)`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf-8')
}
export const MAX_NAMESPACE_DEPTH = 12
export const MAX_NAMESPACE_NODES = 10_000

export class OscQueryClient {
  /**
   * @param {string} host
   * @param {number} port
   * @param {{
   *   onConnect: () => void,
   *   onDisconnect: (reason: string) => void,
   *   onAttemptFailed?: (reason: string, details: { timeout: boolean }) => void,
   *   onValue: (path: string, value: any, metadata: {
   *     oscQueryType?: string,
   *     wireArgs?: Array<{type: string, value?: any}>
   *   }) => void,
   *   onLog: (msg: string) => void,
   * }} events
   * @param {{
   *   reconnectDelayMs?: number,
   *   disconnectReconnectDelayMs?: number,
   *   attemptTimeoutMs?: number
   * }} options
   */
  constructor(host, port, events, options = {}) {
    this.host = host
    this.port = port
    this.events = events
    this.ws = null
    this.connected = false
    this.everConnected = false
    this.reconnectTimer = null
    this.shouldReconnect = true
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000
    this.disconnectReconnectDelayMs = options.disconnectReconnectDelayMs ?? 500
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 3000
    // Exponential backoff cap for post-`everConnected` retries. Without it a
    // venue-wide power cut turns the hub into a 2 Hz HTTP hammer per device.
    this.reconnectBackoffMaxMs = options.reconnectBackoffMaxMs ?? 5000
    // WS keepalive: ping every keepaliveIntervalMs; after keepaliveMaxMissed
    // unanswered pings the socket is considered half-open and terminated so
    // the normal reconnect path takes over. Devices only need to answer
    // standard WS pings (the ws library and our VSTs do this automatically).
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? 5000
    // Validated: a 0/NaN here would make the tick never ping (every device
    // recycled every few ticks) or silently disable half-open detection.
    const maxMissed = Number(options.keepaliveMaxMissed)
    this.keepaliveMaxMissed = Number.isInteger(maxMissed) && maxMissed >= 1 ? maxMissed : 2
    // Not every OSCQuery server answers WS control pings. TouchDesigner's Web
    // Server DAT, for one, never sends a pong yet is fully alive — its HTTP
    // answers instantly and it streams OSC as binary WS frames. So before we
    // call a pong-silent socket dead, we (a) treat ANY inbound WS frame as
    // proof of life and (b) probe HTTP ?HOST_INFO; only a socket that neither
    // ponged, sent a frame, nor answers HTTP is a genuine half-open and torn
    // down. This keeps the half-open detection honest without cycling TD.
    this.keepaliveHttpFallback = options.keepaliveHttpFallback ?? true
    // HTTP reachability is not WS liveness: a server whose HTTP answers while
    // its WS push path is wedged (no pong AND no data) must still be recycled,
    // or the instrument goes dark forever. So the HTTP rescue is bounded — after
    // this many consecutive rescues with zero intervening inbound WS frames, the
    // socket is treated as wedged and torn down for a fresh dial. A server that
    // actually streams (or pongs) resets the count long before it is reached.
    const maxRescues = Number(options.keepaliveHttpMaxRescues)
    this.keepaliveHttpMaxRescues = Number.isInteger(maxRescues) && maxRescues >= 0 ? maxRescues : 3
    this.hostInfoRetryBaseMs = options.hostInfoRetryBaseMs ?? 1000
    this.hostInfoRetryMaxMs = options.hostInfoRetryMaxMs ?? 10_000
    this.random = options.random ?? Math.random
    this.keepaliveTimer = null
    this.missedPongs = 0
    // Set by both the 'pong' and 'message' handlers: any inbound frame within a
    // keepalive window proves the socket is live, so the missed-pong counter is
    // cleared on the next tick instead of climbing toward termination.
    this.sawInboundSinceTick = false
    // Guards against overlapping HTTP liveness probes when a tick fires again
    // before the previous probe resolved.
    this.keepaliveProbing = false
    // One-shot log so a pong-silent-but-alive server is noted once, not every
    // probe cycle.
    this.pongLessNoted = false
    // Consecutive HTTP rescues with no intervening inbound WS frame. Bounds how
    // long a pong-and-data-silent-but-HTTP-alive socket is tolerated before it
    // is recycled as wedged. Reset by any real inbound frame.
    this.httpRescuesWithoutInbound = 0
    this.hostInfoRetryTimer = null
    this.consecutiveRetryFailures = 0
    this.connectAttempt = 0
    this.fetchControllers = new Set()
    this.attemptTimer = null
    this.failedAttempt = 0
    this.debugCount = 0
    this.lastNamespace = null
    // Flat node table built from lastNamespace. One entry per writable/readable
    // path, with full OSCQuery metadata (TYPE, RANGE, ACCESS, …). Consumed by
    // the hub to render proper ParameterControl widgets on the UI.
    this.flatNodes = []
    // Fast lookup used when a value update only carries path + value. Keeping
    // the OSCQuery TYPE beside the path prevents JavaScript number inference
    // from changing f to i and preserves multi-argument nodes such as fff.
    this.nodeTypes = new Map()
    // The device's OSC UDP port, fetched via ?HOST_INFO. Falls back to the
    // OSCQuery HTTP port if HOST_INFO is unavailable or doesn't expose it.
    this.oscPort = port
    this.hostInfo = null
  }

  async connect() {
    if (!this.shouldReconnect) return
    const attempt = ++this.connectAttempt
    // Every attempt learns its own HOST_INFO. A restarted device rebinds a new
    // ephemeral OSC UDP port, so anything learned by an earlier attempt or
    // session describes a process that may no longer exist.
    this.hostInfo = null
    const controller = new AbortController()
    this.fetchControllers.add(controller)
    this._clearAttemptTimer()
    this._clearHostInfoRetry()
    this.attemptTimer = setTimeout(() => {
      this._failAttempt(attempt, `Connection timed out after ${this.attemptTimeoutMs} ms`, true)
    }, this.attemptTimeoutMs)

    try {
      const url = `http://${this.host}:${this.port}/`
      this.events.onLog(`HTTP GET ${url}`)

      // HOST_INFO is optional and must not extend the connection deadline.
      // Fetch it in parallel with the namespace; the WebSocket can open as
      // soon as the namespace is ready.
      this._fetchHostInfo(attempt)
      const res = await fetch(url, { signal: controller.signal })
      if (!this._isCurrentAttempt(attempt)) return

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Enforce the byte cap BEFORE parsing. Content-Length lets us reject
      // early; the streaming reader below is the authoritative check.
      const contentLength = Number(res.headers?.get?.('content-length'))
      if (Number.isFinite(contentLength) && contentLength > MAX_NAMESPACE_BYTES) {
        throw new Error(`Namespace JSON too large (${contentLength} bytes > ${MAX_NAMESPACE_BYTES})`)
      }
      const text = await readBodyCapped(res, MAX_NAMESPACE_BYTES, 'Namespace JSON')
      if (!this._isCurrentAttempt(attempt)) return
      const tree = JSON.parse(text)
      this.lastNamespace = tree

      // Build the flat metadata table the hub broadcasts to the UI.
      this.flatNodes = []
      this._collectNodes(tree, this.flatNodes)
      this._rebuildNodeTypes()
      const paths = this.flatNodes.map((n) => n.FULL_PATH)
      this.events.onLog(`Namespace received: ${paths.length} parameters`)

      if (!this._isCurrentAttempt(attempt)) return
      this._openWebSocket(paths, attempt)
    } catch (err) {
      if (!this._isCurrentAttempt(attempt)) return
      this._failAttempt(attempt, `Connection error: ${err.message}`, false)
    } finally {
      this.fetchControllers.delete(controller)
    }
  }

  async _fetchHostInfo(attempt, retryCount = 0) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(2000, this.attemptTimeoutMs))
    this.fetchControllers.add(controller)
    let received = false
    try {
      const infoUrl = `http://${this.host}:${this.port}/?HOST_INFO`
      const infoRes = await fetch(infoUrl, { signal: controller.signal })
      if (!this._isCurrentAttempt(attempt)) return
      if (infoRes.ok) {
        const info = JSON.parse(await readBodyCapped(infoRes, MAX_HOSTINFO_BYTES, 'HOST_INFO JSON'))
        if (!this._isCurrentAttempt(attempt)) return
        if (info && (info.OSC_PORT || info.OSC_TRANSPORT || info.NAME)) {
          received = true
          this.hostInfo = info
          if (info.OSC_PORT) this.oscPort = Number(info.OSC_PORT)
          this.events.onHostInfo?.(info)
        }
      }
    } catch {
      // HOST_INFO is optional; namespace + WebSocket remain authoritative.
    } finally {
      clearTimeout(timeout)
      this.fetchControllers.delete(controller)
    }
    // A single failed HOST_INFO fetch must not leave the device without an
    // OSC UDP port for the whole WS session (writes would have nowhere safe
    // to go). Keep retrying with backoff while this attempt stays current.
    if (!received && this._isCurrentAttempt(attempt)) {
      this._scheduleHostInfoRetry(attempt, retryCount + 1)
    }
  }

  _scheduleHostInfoRetry(attempt, retryCount) {
    if (this.hostInfoRetryTimer) return
    const delay = Math.min(
      this.hostInfoRetryBaseMs * 2 ** Math.max(0, retryCount - 1),
      this.hostInfoRetryMaxMs
    )
    this.hostInfoRetryTimer = setTimeout(() => {
      this.hostInfoRetryTimer = null
      if (!this._isCurrentAttempt(attempt)) return
      this._fetchHostInfo(attempt, retryCount)
    }, delay)
  }

  _clearHostInfoRetry() {
    if (!this.hostInfoRetryTimer) return
    clearTimeout(this.hostInfoRetryTimer)
    this.hostInfoRetryTimer = null
  }

  _isCurrentAttempt(attempt) {
    // A failed attempt is dead even before the next one starts: its late
    // HOST_INFO response or retry must not repopulate the cache.
    return this.shouldReconnect && attempt === this.connectAttempt && attempt !== this.failedAttempt
  }

  _clearAttemptTimer() {
    if (!this.attemptTimer) return
    clearTimeout(this.attemptTimer)
    this.attemptTimer = null
  }

  _failAttempt(attempt, reason, timeout) {
    if (!this._isCurrentAttempt(attempt) || this.failedAttempt === attempt) return
    this.failedAttempt = attempt
    this._clearAttemptTimer()
    this._clearHostInfoRetry()
    this._stopKeepalive()
    for (const controller of this.fetchControllers) controller.abort()
    this.fetchControllers.clear()
    // HOST_INFO delivered by a dead attempt (a VST still booting answers
    // ?HOST_INFO before its namespace) belongs to no live session.
    this.hostInfo = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      try { ws.terminate() } catch {}
    }
    this.connected = false
    this.consecutiveRetryFailures++
    this.events.onLog(reason)
    this.events.onAttemptFailed?.(reason, { timeout })
    this._scheduleReconnect(this._nextReconnectDelay())
  }

  /**
   * Drop the in-flight attempt — or the live connection — because the far end
   * proved to be a different physical device (e.g. HOST_INFO declared another
   * identity after a DHCP lease handed its address over). Routes through the
   * normal failure path so onAttemptFailed bookkeeping (status, error,
   * consecutive-failure counters) stays consistent and a retry is scheduled,
   * then invalidates the attempt so a racing namespace fetch of the rejected
   * attempt cannot resurrect the connection.
   */
  rejectCurrentAttempt(reason) {
    const attempt = this.connectAttempt
    this._failAttempt(attempt, reason, false)
    if (this.shouldReconnect && this.connectAttempt === attempt) this.connectAttempt++
  }

  /**
   * Reconnect delay for the current failure streak. Before the first
   * successful connection the slower `reconnectDelayMs` applies unchanged.
   * After `everConnected`, retries start at `disconnectReconnectDelayMs`
   * (fast recovery from a blip) and back off exponentially with jitter up to
   * `reconnectBackoffMaxMs` so an extended outage does not hammer the device.
   */
  _nextReconnectDelay() {
    if (!this.everConnected) return this.reconnectDelayMs
    return this._reconnectDelayForFailureCount(this.consecutiveRetryFailures)
  }

  _reconnectDelayForFailureCount(failures) {
    const exponent = Math.max(0, Math.min(failures - 1, 10))
    const base = Math.min(
      this.disconnectReconnectDelayMs * 2 ** exponent,
      this.reconnectBackoffMaxMs
    )
    const jitter = Math.floor(base * 0.2 * this.random())
    return Math.min(base + jitter, this.reconnectBackoffMaxMs)
  }

  _startKeepalive(ws) {
    this._stopKeepalive()
    this.missedPongs = 0
    this.sawInboundSinceTick = false
    this.keepaliveProbing = false
    this.httpRescuesWithoutInbound = 0
    if (!(this.keepaliveIntervalMs > 0)) return
    this.keepaliveTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this._stopKeepalive()
        return
      }
      // Don't stack probes: if an HTTP liveness check from a previous tick is
      // still outstanding, let it settle before doing anything else.
      if (this.keepaliveProbing) return
      // Any inbound frame (pong OR data) since the last tick means the socket
      // is unambiguously alive — reset and keep going.
      if (this.sawInboundSinceTick) {
        this.missedPongs = 0
        this.sawInboundSinceTick = false
        this.httpRescuesWithoutInbound = 0
      }
      if (this.missedPongs >= this.keepaliveMaxMissed) {
        if (this.keepaliveHttpFallback) {
          // A pong-silent socket might still be a live server that just doesn't
          // implement WS ping/pong (TouchDesigner). Probe HTTP before killing
          // it; only a device that also fails HTTP is truly gone.
          this.keepaliveProbing = true
          this._probeHttpAlive(ws)
            .then((alive) => {
              // Clear the probe guard only for the socket that owns it — a stale
              // probe from a torn-down socket must not unlock a successor's tick.
              if (this.ws === ws) this.keepaliveProbing = false
              if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
              // A real inbound frame (data or pong) arrived while the probe was
              // in flight: definitive proof of life that overrides the probe
              // outcome (a transient HTTP hiccup must not kill a streaming WS).
              if (this.sawInboundSinceTick) {
                this.missedPongs = 0
                this.sawInboundSinceTick = false
                this.httpRescuesWithoutInbound = 0
                return
              }
              if (alive) {
                // HTTP answers but the WS delivered nothing this window. Tolerate
                // a pong-silent server, but bound it: a WS that stays silent
                // across several rescues while HTTP stays up is wedged, not idle
                // — recycle it so the instrument can recover.
                this.httpRescuesWithoutInbound++
                if (this.httpRescuesWithoutInbound > this.keepaliveHttpMaxRescues) {
                  const silentSec = Math.round(
                    this.httpRescuesWithoutInbound * (this.keepaliveMaxMissed + 1) * this.keepaliveIntervalMs / 1000
                  )
                  this.events.onLog(
                    `Keepalive: WS silent ~${silentSec}s while HTTP alive (idle or wedged) — recycling wedged socket`
                  )
                  this._stopKeepalive()
                  try { ws.terminate() } catch {}
                  return
                }
                this.missedPongs = 0
                if (!this.pongLessNoted) {
                  this.pongLessNoted = true
                  this.events.onLog(
                    'Keepalive: WS pings unanswered but HTTP alive — treating as live (server does not pong)'
                  )
                }
              } else {
                this.events.onLog(
                  `Keepalive: ${this.missedPongs} pings unanswered and HTTP unreachable — terminating half-open WS`
                )
                this._stopKeepalive()
                try { ws.terminate() } catch {}
              }
            })
            .catch(() => { if (this.ws === ws) this.keepaliveProbing = false })
          return
        }
        this.events.onLog(
          `Keepalive: ${this.missedPongs} pings unanswered — terminating half-open WS`
        )
        this._stopKeepalive()
        // terminate() emits 'close', which drives the normal disconnect and
        // reconnect path.
        try { ws.terminate() } catch {}
        return
      }
      this.missedPongs++
      this.sawInboundSinceTick = false
      try { ws.ping() } catch {}
    }, this.keepaliveIntervalMs)
    if (typeof this.keepaliveTimer.unref === 'function') this.keepaliveTimer.unref()
  }

  // Quick HTTP liveness probe used by the keepalive before it declares a
  // pong-silent WebSocket dead. Returns true iff the device answers ?HOST_INFO
  // (or at least completes an HTTP response) within a bounded window. Never
  // throws — a failed probe resolves false.
  async _probeHttpAlive(ws) {
    const controller = new AbortController()
    const budget = Math.max(500, Math.min(2000, this.keepaliveIntervalMs))
    const timer = setTimeout(() => controller.abort(), budget)
    this.fetchControllers.add(controller)
    try {
      const res = await fetch(`http://${this.host}:${this.port}/?HOST_INFO`, {
        signal: controller.signal
      })
      // Any COMPLETED HTTP response proves the device's HTTP stack is alive —
      // connect() already treats ?HOST_INFO as optional (a 404 there is still a
      // healthy device), so status is deliberately ignored. The body is never
      // read (the abort in finally cancels the unread stream), so a hostile or
      // huge response can't balloon hub memory.
      void res
      return this.ws === ws
    } catch {
      return false
    } finally {
      clearTimeout(timer)
      // Abort on every path (idempotent after success/timeout) so the unread
      // body stream is torn down and the undici socket released promptly.
      controller.abort()
      this.fetchControllers.delete(controller)
    }
  }

  _stopKeepalive() {
    if (!this.keepaliveTimer) return
    clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
    this.missedPongs = 0
    this.sawInboundSinceTick = false
    this.keepaliveProbing = false
    this.httpRescuesWithoutInbound = 0
  }

  _collectPaths(node) {
    const paths = []
    if (node.TYPE !== undefined && node.FULL_PATH) paths.push(node.FULL_PATH)
    if (node.CONTENTS) {
      for (const child of Object.values(node.CONTENTS)) {
        paths.push(...this._collectPaths(child))
      }
    }
    return paths
  }

  // Walk the tree and push every leaf (any node with a TYPE) into out[] as a
  // compact node descriptor. Keeps just the fields the UI needs. Depth and
  // node-count caps bound recursion against pathological remote trees.
  _collectNodes(node, out, depth = 0) {
    if (depth > MAX_NAMESPACE_DEPTH) {
      throw new Error(`Namespace tree exceeds max depth ${MAX_NAMESPACE_DEPTH}`)
    }
    if (node.TYPE !== undefined && node.FULL_PATH) {
      if (out.length >= MAX_NAMESPACE_NODES) {
        throw new Error(`Namespace tree exceeds max node count ${MAX_NAMESPACE_NODES}`)
      }
      out.push({
        FULL_PATH: node.FULL_PATH,
        TYPE: node.TYPE,
        VALUE: node.VALUE,
        RANGE: node.RANGE,
        ACCESS: node.ACCESS,
        DESCRIPTION: node.DESCRIPTION,
        UNIT: node.UNIT
      })
    }
    if (node.CONTENTS) {
      for (const child of Object.values(node.CONTENTS)) {
        this._collectNodes(child, out, depth + 1)
      }
    }
  }

  _rebuildNodeTypes() {
    // Replace, rather than append to, the map on every reconnect. A path that
    // disappeared from the refreshed namespace must not keep stale TYPE data.
    this.nodeTypes = new Map(
      this.flatNodes
        .filter((node) => typeof node.TYPE === 'string')
        .map((node) => [node.FULL_PATH, node.TYPE])
    )
  }

  _openWebSocket(paths, attempt) {
    try {
      if (!this._isCurrentAttempt(attempt)) return
      const wsUrl = `ws://${this.host}:${this.port}`
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      // Per-attempt flag: 'close' must distinguish "this socket was open and
      // dropped" from "the handshake never completed". Branching on
      // everConnected alone turns a dead-but-mDNS-visible device into a ~2 Hz
      // no-backoff reconnect loop that spams onDisconnect.
      let opened = false

      ws.on('open', () => {
        if (this.ws !== ws || !this._isCurrentAttempt(attempt)) {
          try { ws.close() } catch {}
          return
        }
        this._clearAttemptTimer()
        opened = true
        this.connected = true
        this.everConnected = true
        this.consecutiveRetryFailures = 0
        this._startKeepalive(ws)
        this.events.onLog(`WebSocket open · sending LISTEN for ${paths.length} paths`)
        this.events.onConnect()
        for (const path of paths) this._listen(path)
      })

      ws.on('pong', () => {
        if (this.ws !== ws) return
        this.missedPongs = 0
        this.sawInboundSinceTick = true
      })

      // Critical: also catch binary frames. TouchDesigner-style servers send
      // raw OSC packets over the WS instead of JSON COMMAND/DATA envelopes.
      ws.on('message', (raw, isBinary) => {
        if (this.ws !== ws || !this._isCurrentAttempt(attempt)) return
        // Inbound data is proof the socket is alive even from a server that
        // never answers WS pings (e.g. TouchDesigner streaming OSC binary).
        this.sawInboundSinceTick = true
        const buf = this._toBuffer(raw)
        if (isBinary || this._looksLikeOscPacket(buf)) {
          this._handleOscBinary(buf)
        } else {
          try {
            const text = buf.toString('utf-8')
            const data = JSON.parse(text)
            this._handleJsonMessage(data)
          } catch {
            // Not JSON — try OSC anyway, some servers omit the binary flag.
            this._handleOscBinary(buf)
          }
        }
      })

      ws.on('error', (err) => {
        if (this.ws !== ws || !this._isCurrentAttempt(attempt)) return
        this.events.onLog(`WS error: ${err.message}`)
      })

      ws.on('close', (code) => {
        if (this.ws !== ws || !this._isCurrentAttempt(attempt)) return
        this.ws = null
        this.connected = false
        this._stopKeepalive()
        this._clearHostInfoRetry()
        // A dropped connection invalidates any cached HOST_INFO: a restarted
        // device usually rebinds a new ephemeral OSC UDP port, and writing to
        // the old one would silently vanish.
        this.hostInfo = null
        if (opened) {
          this._clearAttemptTimer()
          this.events.onDisconnect(`WS closed (code ${code})`)
          this._scheduleReconnect(this._nextReconnectDelay())
        } else {
          this._failAttempt(attempt, `WebSocket closed before connect (code ${code})`, false)
        }
      })
    } catch (err) {
      if (!this._isCurrentAttempt(attempt)) return
      this.events.onLog(`WS open error: ${err.message}`)
      this._scheduleReconnect(this._nextReconnectDelay())
    }
  }

  _toBuffer(raw) {
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof ArrayBuffer) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.concat(raw.map((r) => this._toBuffer(r)))
    if (typeof raw === 'string') return Buffer.from(raw, 'utf-8')
    return Buffer.from(raw)
  }

  // Heuristic: an OSC packet starts with either '/' (address) or '#' (bundle).
  _looksLikeOscPacket(buf) {
    if (buf.length < 4) return false
    const first = buf[0]
    return first === 0x2f /* / */ || first === 0x23 /* # */
  }

  _handleOscBinary(buf) {
    try {
      const packet = osc.readPacket(buf, { metadata: true, unpackSingleArgs: false })
      this._processOscPacket(packet)
    } catch (err) {
      // Don't spam: log at most a few parse errors per session.
      if (this.debugCount < 3) {
        this.events.onLog(`OSC parse error: ${err.message}`)
        this.debugCount++
      }
    }
  }

  _processOscPacket(packet) {
    // Bundle → recurse.
    if (packet.packets && Array.isArray(packet.packets)) {
      for (const sub of packet.packets) this._processOscPacket(sub)
      return
    }
    // Single message.
    if (packet.address && packet.args !== undefined) {
      const args = Array.isArray(packet.args) ? packet.args : [packet.args]
      // Zero-argument frame: old Android builds emit an empty typetag for a
      // TRUE toggle (bang/impulse semantics). Map it onto the declared node
      // TYPE when that node is boolean-typed; drop it otherwise instead of
      // fabricating a `value: []` string parameter that renders as false.
      if (args.length === 0) {
        const declaredType = this.nodeTypes.get(packet.address)
        if (typeof declaredType === 'string' && /^[TF]$/.test(declaredType)) {
          this._emitValue(packet.address, true, [{ type: 'T' }], 'T')
        }
        return
      }
      const hasWireMetadata = args.every(
        (arg) => arg && typeof arg === 'object' && typeof arg.type === 'string' && 'value' in arg
      )
      const values = args.map((arg) => (
        arg && typeof arg === 'object' && 'value' in arg ? arg.value : arg
      ))
      const value = values.length === 1 ? values[0] : values
      this._emitValue(packet.address, value, hasWireMetadata ? args : undefined)
    }
  }

  _emitValue(path, value, wireArgs, inlineType) {
    // Inline TYPE applies to this update only. Do not cache arbitrary dynamic
    // paths here: the authoritative, reconnect-replaced namespace map is
    // bounded by the fetched namespace instead of an untrusted event stream.
    const oscQueryType = inlineType || this.nodeTypes.get(path)
    this.events.onValue(path, value, { oscQueryType, wireArgs })
  }

  _handleJsonMessage(data) {
    // OSCQuery push commands (PATH_CHANGED, PATH_ADDED, …) — ignore for now,
    // we get values via the dedicated VALUE / FULL_PATH shape below.
    if (data.COMMAND) return

    if (data.PATH && data.VALUE !== undefined) {
      this._emitValue(data.PATH, data.VALUE, undefined, data.TYPE)
      return
    }
    if (data.FULL_PATH && data.VALUE !== undefined) {
      this._emitValue(data.FULL_PATH, data.VALUE, undefined, data.TYPE)
    }
  }

  _listen(path) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify({ COMMAND: 'LISTEN', DATA: path }))
    } catch {
      // ignore
    }
  }

  _scheduleReconnect(delayMs = this.reconnectDelayMs) {
    if (!this.shouldReconnect) return
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.events.onLog('Reconnecting…')
      this.connect()
    }, delayMs)
  }

  isConnected() {
    return this.connected
  }

  disconnect() {
    this.shouldReconnect = false
    this.connectAttempt++
    this._clearAttemptTimer()
    this._clearHostInfoRetry()
    this._stopKeepalive()
    this.hostInfo = null
    for (const controller of this.fetchControllers) controller.abort()
    this.fetchControllers.clear()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
    this.connected = false
  }
}
