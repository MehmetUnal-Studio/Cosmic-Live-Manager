// Auto-announce engine for persisted device links.
//
// The hub remembers one link per source device (manifest field `link`) and
// re-applies the CosmicUnity peer bootstrap whenever the world changes: the
// VST reconnects, HOST_INFO delivers a UDP port, manifests reload, or the
// registry observes the target somewhere new. The engine is strictly
// poke-driven — no wall-clock polling — with one debounced evaluation pass
// and a bounded retry ladder after a failed announce.
//
// The actual resolution + announce core is injected (`resolveAndAnnounce`)
// so this engine can never drift from the WS ANNOUNCE_DEVICE path, and so
// unit tests can drive it with fakes and fake timers.

const DEFAULT_DEBOUNCE_MS = 1000
const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 15000]

function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

export function sanitizePeerId(value) {
  return normalized(value).replace(/[^a-z0-9_-]+/g, '_')
}

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

function validOscPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}

/**
 * One canonical applied-state fingerprint. Announce again exactly when any
 * component changes: the VST connection nonce (a restarted VST forgot its
 * peers), the target endpoint, the target's resolved OSC UDP port, the peer
 * id, or the UDP port override.
 */
export function computeLinkSignature({
  nonce,
  targetAddress,
  targetPort,
  targetOscPort,
  peerId,
  udpPortOverride
}) {
  return `${Number(nonce) || 0}|${targetAddress}:${targetPort}:${targetOscPort || ''}` +
    `|${peerId}|${Number(udpPortOverride) || 0}`
}

/**
 * Resolve a persisted link's target registry record. Identity rules mirror
 * findRegistryDeviceForTarget: the Bonjour FQDN is authoritative when the
 * link carries one, and only then does the human-readable name match run.
 * The engine has no browser-supplied address, so topology is never used.
 */
export function resolveLinkTargetRecord(records, link) {
  const targetFqdn = normalized(link?.targetFqdn)
  const targetName = normalized(link?.targetName)
  const availableRecords = Array.isArray(records) ? records : []
  const candidatesFor = (record) =>
    [record?.activeEndpoint, ...(record?.endpoints || [])].filter(Boolean)

  if (targetFqdn) {
    const exact = availableRecords.find((record) =>
      candidatesFor(record).some((candidate) => normalized(candidate?.fqdn) === targetFqdn)
    )
    if (exact) return exact
  }
  if (targetName) {
    return availableRecords.find((record) =>
      normalized(record?.name) === targetName ||
      normalized(record?.serviceName) === targetName
    ) || null
  }
  return null
}

/**
 * @param {{
 *   resolveAndAnnounce: (args: { dev: any, target: any, peerId: string, udpPortOverride: number }) => Promise<any>,
 *   getDevicesWithLinks: () => any[],
 *   getRegistrySnapshot: () => any[],
 *   getManagedDevice: (manifestId: number) => any,
 *   onStatus: (deviceId: number, status: { state: string, summary?: string, error?: string, at: number }) => void,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   debounceMs?: number,
 *   retryDelaysMs?: number[]
 * }} options
 */
export function createAutoLinkEngine({
  resolveAndAnnounce,
  getDevicesWithLinks,
  getRegistrySnapshot,
  getManagedDevice = () => null,
  onStatus = () => {},
  log = () => {},
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS
}) {
  let closed = false
  let debounceTimer = null
  /** @type {Map<number, any>} per-device runtime state, keyed by manifest id */
  const states = new Map()

  function stateFor(deviceId) {
    let state = states.get(deviceId)
    if (!state) {
      state = {
        nonce: 0,
        lastApplied: null,
        lastSummary: '',
        retryIndex: 0,
        retryTimer: null,
        inFlight: false,
        reevaluate: false,
        // Bumped whenever lastApplied is rewritten out-of-band (recordApplied,
        // noteDeviceConnected) so an in-flight announce that resolves late
        // cannot clobber the newer applied signature.
        appliedGen: 0
      }
      states.set(deviceId, state)
    }
    return state
  }

  function cancelRetry(state) {
    if (state.retryTimer) {
      clearTimeoutFn(state.retryTimer)
      state.retryTimer = null
    }
  }

  // Status writes are deduplicated against the CURRENT device object so a
  // manifest reload (which replaces device objects and drops runtime fields)
  // self-heals on the next pass instead of leaving dashboards blank.
  function emitStatus(deviceId, status) {
    const dev = getManagedDevice(deviceId)
    if (!dev) return false
    const current = dev.autoLink
    if (
      current &&
      current.state === status.state &&
      (current.summary || '') === (status.summary || '') &&
      (current.error || '') === (status.error || '')
    ) return false
    onStatus(deviceId, { ...status, at: now() })
    return true
  }

  function scheduleRetry(deviceId) {
    if (closed) return
    const state = stateFor(deviceId)
    if (state.retryIndex >= retryDelaysMs.length) {
      log(`device ${deviceId}: retries exhausted, waiting for next poke`)
      return
    }
    const delay = retryDelaysMs[state.retryIndex]
    state.retryIndex += 1
    cancelRetry(state)
    state.retryTimer = unrefTimer(setTimeoutFn(() => {
      state.retryTimer = null
      // A retry belongs to ONE device's ladder: evaluating everyone here
      // would grant parked siblings extra attempts outside any poke.
      evaluate('retry', deviceId)
    }, delay))
  }

  function attemptAnnounce(dev, state, { record, endpoint, peerId, signature, trigger }) {
    // A fresh poke restarts the retry ladder; a firing retry timer continues it.
    if (trigger !== 'retry') state.retryIndex = 0
    state.inFlight = true
    const genAtStart = state.appliedGen
    // The completion callbacks may run long after CLEAR_DEVICE_LINK or a
    // device removal: only the state object still registered in the map may
    // be mutated, otherwise a forgotten device would be resurrected with a
    // stale status and a stray retry timer.
    const stillCurrent = () => !closed && states.get(dev.id) === state
    const target = {
      address: endpoint.host,
      port: endpoint.port,
      fqdn: endpoint.fqdn || dev.link?.targetFqdn || '',
      name: record.name || record.serviceName || dev.link?.targetName || ''
    }
    const udpPortOverride = Number(dev.link?.udpPortOverride) || 0
    Promise.resolve()
      .then(() => resolveAndAnnounce({ dev, target, peerId, udpPortOverride }))
      .then((result) => {
        if (!stillCurrent()) return
        const announcement = result?.announcement || result
        const summary = announcement?.peerName && announcement?.receiverName
          ? `${announcement.peerName} → ${announcement.receiverName}`
          : `${peerId || target.name || target.address} → ${target.name || target.address}`
        if (state.appliedGen === genAtStart) {
          // A concurrent WS ANNOUNCE recorded newer coordinates mid-flight;
          // keep those instead of clobbering them with this older attempt.
          state.lastApplied = signature
          state.lastSummary = summary
        }
        state.retryIndex = 0
        cancelRetry(state)
        log(`applied device ${dev.id}: ${summary}`)
        emitStatus(dev.id, { state: 'ok', summary: state.lastSummary || summary })
      })
      .catch((err) => {
        if (!stillCurrent()) return
        const message = err?.message || String(err)
        if (emitStatus(dev.id, { state: 'failed', error: message })) {
          log(`failed device ${dev.id}: ${message}`)
        }
        scheduleRetry(dev.id)
      })
      .finally(() => {
        state.inFlight = false
        if (stillCurrent() && state.reevaluate) {
          state.reevaluate = false
          poke('reevaluate')
        }
      })
  }

  function evaluateDevice(dev, snapshot, trigger) {
    const state = stateFor(dev.id)
    const record = resolveLinkTargetRecord(snapshot, dev.link)
    const online = record && (
      record.discoveryState === 'Discovered' ||
      record.connectionState === 'Connected'
    )
    if (!online) {
      // No error spam for an absent/offline target — one pending status,
      // then wait for the next poke to observe it again.
      cancelRetry(state)
      emitStatus(dev.id, {
        state: 'pending',
        summary: `Waiting for ${dev.link.targetName || dev.link.targetFqdn}`
      })
      return
    }

    const managedTarget = record.manifestId != null
      ? getManagedDevice(record.manifestId)
      : null
    const active = record.activeEndpoint
    const endpoint = active?.host && validPort(active?.port)
      ? { host: active.host, port: validPort(active.port), fqdn: active.fqdn || '' }
      : managedTarget?.host && validPort(managedTarget?.oscQueryPort)
        ? { host: managedTarget.host, port: validPort(managedTarget.oscQueryPort), fqdn: '' }
        : null
    if (!endpoint) {
      cancelRetry(state)
      emitStatus(dev.id, {
        state: 'pending',
        summary: `Waiting for ${dev.link.targetName || dev.link.targetFqdn}`
      })
      return
    }

    // Mirror the WS path exactly: pass the stored peer id through (possibly
    // empty) and let resolveLinkAnnouncement apply its direction-aware
    // fallback. Deriving a peer id from the resolved TARGET here would be
    // wrong for external-source cards, whose target is the VST itself.
    const peerId = sanitizePeerId(dev.link.peerId || '')
    const signature = computeLinkSignature({
      nonce: state.nonce,
      targetAddress: endpoint.host,
      targetPort: endpoint.port,
      targetOscPort: validOscPort(managedTarget?.oscPort) || '',
      peerId,
      udpPortOverride: dev.link.udpPortOverride
    })

    if (signature === state.lastApplied) {
      emitStatus(dev.id, { state: 'ok', summary: state.lastSummary })
      return
    }
    if (state.inFlight) {
      state.reevaluate = true
      return
    }
    attemptAnnounce(dev, state, { record, endpoint, peerId, signature, trigger })
  }

  function evaluate(trigger, onlyDeviceId = null) {
    if (closed) return
    let snapshot = null
    for (const dev of getDevicesWithLinks() || []) {
      if (!dev || !dev.link || typeof dev.link !== 'object') continue
      if (onlyDeviceId != null && dev.id !== onlyDeviceId) continue
      const eligible = dev.enabled &&
        dev.connectionState === 'Connected' &&
        validOscPort(dev.oscPort)
      if (!eligible) {
        // A disconnected/announce-unready source keeps no pending retry;
        // its reconnect poke restarts everything with a fresh nonce. The
        // status must not keep claiming 'ok' for a source that is gone.
        const state = states.get(dev.id)
        if (state) cancelRetry(state)
        emitStatus(dev.id, { state: 'pending', summary: 'Source not connected' })
        continue
      }
      if (!snapshot) snapshot = getRegistrySnapshot() || []
      try {
        evaluateDevice(dev, snapshot, trigger)
      } catch (err) {
        // One broken device/link must never stop the pass for the others.
        log(`evaluation error device ${dev.id}: ${err?.message || err}`)
      }
    }
  }

  function poke(reason) {
    if (closed || debounceTimer) return
    debounceTimer = unrefTimer(setTimeoutFn(() => {
      debounceTimer = null
      evaluate('poke')
    }, debounceMs))
    void reason
  }

  return {
    poke,

    // Test seam: run one synchronous evaluation pass without the debounce.
    evaluateNow(trigger = 'poke', onlyDeviceId = null) {
      evaluate(trigger, onlyDeviceId)
    },

    // The VST (re)connected and forgot its peers: invalidate the applied
    // signature via the nonce so the next pass always re-announces.
    noteDeviceConnected(deviceId) {
      if (closed) return
      const state = stateFor(Number(deviceId))
      state.nonce += 1
      state.lastApplied = null
      state.appliedGen += 1
      state.retryIndex = 0
      cancelRetry(state)
      poke('device-connected')
    },

    // A successful WS ANNOUNCE already applied these exact coordinates.
    // Recording them prevents a duplicate engine announce one poke later.
    recordApplied(deviceId, {
      targetAddress,
      targetPort,
      targetOscPort,
      peerId,
      udpPortOverride,
      summary
    }) {
      if (closed) return
      const state = stateFor(Number(deviceId))
      state.appliedGen += 1
      state.lastApplied = computeLinkSignature({
        nonce: state.nonce,
        targetAddress,
        targetPort,
        targetOscPort: targetOscPort || '',
        peerId,
        udpPortOverride
      })
      state.lastSummary = summary || state.lastSummary
      state.retryIndex = 0
      cancelRetry(state)
      emitStatus(Number(deviceId), { state: 'ok', summary: state.lastSummary })
    },

    // Link removed (CLEAR_DEVICE_LINK) or device deleted.
    forgetDevice(deviceId) {
      const state = states.get(Number(deviceId))
      if (state) cancelRetry(state)
      states.delete(Number(deviceId))
    },

    close() {
      closed = true
      if (debounceTimer) {
        clearTimeoutFn(debounceTimer)
        debounceTimer = null
      }
      for (const state of states.values()) cancelRetry(state)
    }
  }
}
