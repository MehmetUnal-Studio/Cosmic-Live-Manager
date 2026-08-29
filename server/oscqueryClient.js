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
    this.connectAttempt = 0
    this.fetchControllers = new Set()
    this.attemptTimer = null
    this.failedAttempt = 0
    this.listenedPaths = new Set()
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
    const controller = new AbortController()
    this.fetchControllers.add(controller)
    this._clearAttemptTimer()
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
      const tree = await res.json()
      if (!this._isCurrentAttempt(attempt)) return
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

  async _fetchHostInfo(attempt) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(2000, this.attemptTimeoutMs))
    this.fetchControllers.add(controller)
    try {
      const infoUrl = `http://${this.host}:${this.port}/?HOST_INFO`
      const infoRes = await fetch(infoUrl, { signal: controller.signal })
      if (!this._isCurrentAttempt(attempt) || !infoRes.ok) return
      const info = await infoRes.json()
      if (!this._isCurrentAttempt(attempt)) return
      if (info && (info.OSC_PORT || info.OSC_TRANSPORT || info.NAME)) {
        this.hostInfo = info
        if (info.OSC_PORT) this.oscPort = Number(info.OSC_PORT)
        this.events.onHostInfo?.(info)
      }
    } catch {
      // HOST_INFO is optional; namespace + WebSocket remain authoritative.
    } finally {
      clearTimeout(timeout)
      this.fetchControllers.delete(controller)
    }
  }

  _isCurrentAttempt(attempt) {
    return this.shouldReconnect && attempt === this.connectAttempt
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
    for (const controller of this.fetchControllers) controller.abort()
    this.fetchControllers.clear()
    const ws = this.ws
    this.ws = null
    if (ws) {
      try { ws.terminate() } catch {}
    }
    this.connected = false
    this.events.onLog(reason)
    this.events.onAttemptFailed?.(reason, { timeout })
    this._scheduleReconnect(
      this.everConnected ? this.disconnectReconnectDelayMs : this.reconnectDelayMs
    )
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
  // compact node descriptor. Keeps just the fields the UI needs.
  _collectNodes(node, out) {
    if (node.TYPE !== undefined && node.FULL_PATH) {
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
      for (const child of Object.values(node.CONTENTS)) this._collectNodes(child, out)
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

      ws.on('open', () => {
        if (this.ws !== ws || !this._isCurrentAttempt(attempt)) {
          try { ws.close() } catch {}
          return
        }
        this._clearAttemptTimer()
        this.connected = true
        this.everConnected = true
        this.events.onLog(`WebSocket open · sending LISTEN for ${paths.length} paths`)
        this.events.onConnect()
        for (const path of paths) this._listen(path)
      })

      // Critical: also catch binary frames. TouchDesigner-style servers send
      // raw OSC packets over the WS instead of JSON COMMAND/DATA envelopes.
      ws.on('message', (raw, isBinary) => {
        if (this.ws !== ws || !this._isCurrentAttempt(attempt)) return
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
        if (this.everConnected) {
          this._clearAttemptTimer()
          this.events.onDisconnect(`WS closed (code ${code})`)
          this._scheduleReconnect(this.disconnectReconnectDelayMs)
        } else {
          this._failAttempt(attempt, `WebSocket closed before connect (code ${code})`, false)
        }
      })
    } catch (err) {
      if (!this._isCurrentAttempt(attempt)) return
      this.events.onLog(`WS open error: ${err.message}`)
      this._scheduleReconnect(
        this.everConnected ? this.disconnectReconnectDelayMs : this.reconnectDelayMs
      )
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
    this.listenedPaths.add(path)
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
