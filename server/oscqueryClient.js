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
//      decoded and reported via onValue(path, value).
//   5. If the WS drops, auto-reconnect every 3 seconds.

import WebSocket from 'ws'
import osc from 'osc'

export class OscQueryClient {
  /**
   * @param {string} host
   * @param {number} port
   * @param {{
   *   onConnect: () => void,
   *   onDisconnect: (reason: string) => void,
   *   onValue: (path: string, value: any) => void,
   *   onLog: (msg: string) => void,
   * }} events
   */
  constructor(host, port, events) {
    this.host = host
    this.port = port
    this.events = events
    this.ws = null
    this.connected = false
    this.reconnectTimer = null
    this.shouldReconnect = true
    this.listenedPaths = new Set()
    this.debugCount = 0
    this.lastNamespace = null
    // Flat node table built from lastNamespace. One entry per writable/readable
    // path, with full OSCQuery metadata (TYPE, RANGE, ACCESS, …). Consumed by
    // the hub to render proper ParameterControl widgets on the UI.
    this.flatNodes = []
    // The device's OSC UDP port, fetched via ?HOST_INFO. Falls back to the
    // OSCQuery HTTP port if HOST_INFO is unavailable or doesn't expose it.
    this.oscPort = port
    this.hostInfo = null
  }

  async connect() {
    this.shouldReconnect = true

    try {
      const url = `http://${this.host}:${this.port}/`
      this.events.onLog(`HTTP GET ${url}`)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)

      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const tree = await res.json()
      this.lastNamespace = tree

      // Build the flat metadata table the hub broadcasts to the UI.
      this.flatNodes = []
      this._collectNodes(tree, this.flatNodes)
      const paths = this.flatNodes.map((n) => n.FULL_PATH)
      this.events.onLog(`Namespace received: ${paths.length} parameters`)

      // Fetch HOST_INFO to find the device's OSC UDP port (separate from the
      // OSCQuery HTTP port). Optional — we keep going even if it fails.
      try {
        const infoUrl = `http://${this.host}:${this.port}/?HOST_INFO`
        const infoCtl = new AbortController()
        const infoTo = setTimeout(() => infoCtl.abort(), 2000)
        const infoRes = await fetch(infoUrl, { signal: infoCtl.signal })
        clearTimeout(infoTo)
        if (infoRes.ok) {
          const info = await infoRes.json()
          // Heuristic — a HOST_INFO response has OSC_PORT/OSC_TRANSPORT/NAME.
          // If we got the tree back instead, ignore.
          if (info && (info.OSC_PORT || info.OSC_TRANSPORT || info.NAME)) {
            this.hostInfo = info
            if (info.OSC_PORT) this.oscPort = Number(info.OSC_PORT)
          }
        }
      } catch {
        // HOST_INFO not supported — fall back to oscQueryPort already set
      }

      this._openWebSocket(paths)
    } catch (err) {
      this.events.onLog(`Connection error: ${err.message}`)
      this._scheduleReconnect()
    }
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

  _openWebSocket(paths) {
    try {
      const wsUrl = `ws://${this.host}:${this.port}`
      this.ws = new WebSocket(wsUrl)

      this.ws.on('open', () => {
        this.connected = true
        this.events.onLog(`WebSocket open · sending LISTEN for ${paths.length} paths`)
        this.events.onConnect()
        for (const path of paths) this._listen(path)
      })

      // Critical: also catch binary frames. TouchDesigner-style servers send
      // raw OSC packets over the WS instead of JSON COMMAND/DATA envelopes.
      this.ws.on('message', (raw, isBinary) => {
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

      this.ws.on('error', (err) => {
        this.events.onLog(`WS error: ${err.message}`)
      })

      this.ws.on('close', (code) => {
        this.connected = false
        this.events.onDisconnect(`WS closed (code ${code})`)
        this._scheduleReconnect()
      })
    } catch (err) {
      this.events.onLog(`WS open error: ${err.message}`)
      this._scheduleReconnect()
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
      const packet = osc.readPacket(buf, { metadata: true })
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
    if (packet.address && packet.args) {
      const values = packet.args.map((a) => a.value)
      const value = values.length === 1 ? values[0] : values
      this.events.onValue(packet.address, value)
    }
  }

  _handleJsonMessage(data) {
    // OSCQuery push commands (PATH_CHANGED, PATH_ADDED, …) — ignore for now,
    // we get values via the dedicated VALUE / FULL_PATH shape below.
    if (data.COMMAND) return

    if (data.PATH && data.VALUE !== undefined) {
      this.events.onValue(data.PATH, data.VALUE)
      return
    }
    if (data.FULL_PATH && data.VALUE !== undefined) {
      this.events.onValue(data.FULL_PATH, data.VALUE)
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

  _scheduleReconnect() {
    if (!this.shouldReconnect) return
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.events.onLog('Reconnecting…')
      this.connect()
    }, 3000)
  }

  isConnected() {
    return this.connected
  }

  disconnect() {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.connected = false
  }
}
