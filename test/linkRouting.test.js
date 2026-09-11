import test from 'node:test'
import assert from 'node:assert/strict'

import {
  findRegistryDeviceForTarget,
  resolveGenericTargetFromRegistry,
  resolveLinkAnnouncement,
  resolveMaxRingReceiverFromRegistry,
  resolveMaxRingTargetFromRegistry,
  resolveRingReceiverFromRegistry,
  resolveRingInstrumentSourceFromRegistry,
  resolveOscUdpPort
} from '../server/linkRouting.js'
import {
  MAX_RING_DEFAULT_UDP_PORT,
  MAX_RING_LINK_ROLE,
  MAX_RING_RUNTIME_KIND
} from '../shared/maxRingLink.js'
import {
  COSMIC_RING_LINK_ROLE,
  COSMIC_RING_RUNTIME_KIND
} from '../shared/cosmicRingLink.js'

const cosmicSource = {
  id: 1,
  canonicalId: 'cosmicunity:local-port:5001',
  deviceType: 'CosmicUnity',
  name: 'Tablet_1',
  host: '127.0.0.1',
  oscQueryPort: 5001,
  // This is the VST's OSC control port. The announce sender resolves it from
  // HOST_INFO after contacting the OSCQuery endpoint above.
  oscPort: 57989
}

const androidSelection = {
  fqdn: 'Android-Tablet-03._oscjson._tcp.local',
  name: 'Android_Tablet03',
  address: '192.168.68.53',
  port: 9010
}

const otherOscQuerySelection = {
  fqdn: 'Ring-Instrument._oscjson._tcp.local',
  name: 'Ring-Instrument',
  address: '192.168.68.63',
  port: 9011,
  deviceType: 'OSCQuery'
}

const maxRingSource = {
  id: 14,
  canonicalId: 'oscquery:legacy:192.168.68.58:8005:maxring',
  deviceType: 'OSCQuery',
  runtimeKind: MAX_RING_RUNTIME_KIND,
  linkRole: MAX_RING_LINK_ROLE,
  name: 'Max_Ring',
  serviceName: 'MaxRing',
  host: '192.168.68.58',
  oscQueryPort: 8005,
  oscPort: 8005
}

const ringSource = {
  id: 15,
  canonicalId: 'oscquery:legacy:192.168.68.63:9011:ring-instrument',
  deviceType: 'OSCQuery',
  name: 'Ring-Instrument',
  serviceName: 'Ring-Instrument',
  host: '192.168.68.63',
  oscQueryPort: 9011
}

const maxRingSelection = {
  fqdn: 'MaxRing._oscjson._tcp.local',
  name: 'Max_Ring',
  serviceName: 'MaxRing',
  address: '192.168.68.58',
  port: 8005,
  deviceType: 'OSCQuery',
  runtimeKind: MAX_RING_RUNTIME_KIND,
  linkRole: MAX_RING_LINK_ROLE,
  oscPort: 8005
}

const cosmicRingSource = {
  id: 14,
  canonicalId: 'cosmicring:uuid:ring-vst-installation',
  deviceType: 'CosmicRing',
  runtimeKind: COSMIC_RING_RUNTIME_KIND,
  linkRole: COSMIC_RING_LINK_ROLE,
  name: 'Live-Ring',
  serviceName: 'Live-Ring',
  host: '192.168.68.58',
  oscQueryPort: 8000,
  oscPort: 49713
}

const cosmicRingSelection = {
  fqdn: 'Live-Ring._oscjson._tcp.local',
  name: 'Live-Ring',
  serviceName: 'Live-Ring',
  address: '192.168.68.58',
  port: 8000,
  deviceType: 'CosmicRing',
  runtimeKind: COSMIC_RING_RUNTIME_KIND,
  linkRole: COSMIC_RING_LINK_ROLE,
  oscPort: 49713
}

test('Cosmic LINK writes the selected Android peer coordinates to the source VST', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: cosmicSource,
    selectedTarget: androidSelection,
    peerId: 'tablet_1',
    udpPortOverride: 0
  })

  assert.deepEqual(route.target, {
    address: '127.0.0.1',
    port: 5001,
    name: 'Tablet_1',
    oscPort: 57989
  })
  assert.equal(route.peerId, 'tablet_1')
  assert.equal(route.host, '192.168.68.53')
  assert.equal(route.oscQueryPort, 9010)
  assert.equal(route.udpPort, 0)
})

test('Cosmic LINK accepts an Other OSCQuery peer and writes its coordinates to the source VST', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: cosmicSource,
    selectedTarget: otherOscQuerySelection,
    peerId: ''
  })

  assert.equal(route.peerId, 'ring-instrument')
  assert.equal(route.host, '192.168.68.63')
  assert.equal(route.oscQueryPort, 9011)
  assert.equal(route.udpPort, 0)
  assert.equal(route.receiverName, 'Tablet_1')
  assert.equal(route.peerName, 'Ring-Instrument')
})

test('Max/Ring writes only Ring-Instrument:9011 coordinates to its local Ableton receiver', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: maxRingSource,
    selectedTarget: otherOscQuerySelection
  })

  assert.deepEqual(route.target, {
    address: '192.168.68.58',
    port: 8005,
    name: 'Max_Ring',
    oscPort: 8005
  })
  assert.equal(route.peerId, 'ring-instrument')
  assert.equal(route.receiverName, 'Max_Ring')
  assert.equal(route.peerName, 'Ring-Instrument')
  assert.equal(route.host, '192.168.68.63')
  assert.equal(route.oscQueryPort, 9011)
  assert.equal(route.udpPort, MAX_RING_DEFAULT_UDP_PORT)
})

test('Max/Ring keeps a positive expert UDP override', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: maxRingSource,
    selectedTarget: otherOscQuerySelection,
    udpPortOverride: 19005
  })
  assert.equal(route.udpPort, 19005)
})

test('Live-Ring writes only Ring-Instrument coordinates and keeps UDP automatic', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: cosmicRingSource,
    selectedTarget: otherOscQuerySelection
  })

  assert.deepEqual(route.target, {
    address: '192.168.68.58',
    port: 8000,
    name: 'Live-Ring',
    oscPort: 49713
  })
  assert.equal(route.peerId, 'ring-instrument')
  assert.equal(route.receiverName, 'Live-Ring')
  assert.equal(route.peerName, 'Ring-Instrument')
  assert.equal(route.host, '192.168.68.63')
  assert.equal(route.oscQueryPort, 9011)
  assert.equal(route.udpPort, 0)
})

test('Live-Ring keeps a positive expert UDP override without inheriting MaxRing 9005', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: cosmicRingSource,
    selectedTarget: otherOscQuerySelection,
    udpPortOverride: 19006
  })
  assert.equal(route.udpPort, 19006)
})

test('Ring-Instrument card resolves to the same trusted Max/Ring receiver route', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: ringSource,
    selectedTarget: maxRingSelection
  })

  assert.deepEqual(route.target, {
    address: '192.168.68.58',
    port: 8005,
    name: 'Max_Ring',
    oscPort: 8005
  })
  assert.equal(route.peerId, 'ring-instrument')
  assert.equal(route.receiverName, 'Max_Ring')
  assert.equal(route.peerName, 'Ring-Instrument')
  assert.equal(route.host, '192.168.68.63')
  assert.equal(route.oscQueryPort, 9011)
  assert.equal(route.udpPort, MAX_RING_DEFAULT_UDP_PORT)
})

test('Ring-Instrument to Max/Ring keeps a positive expert UDP override', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: ringSource,
    selectedTarget: maxRingSelection,
    udpPortOverride: 19005
  })
  assert.equal(route.udpPort, 19005)
})

test('Ring-Instrument card resolves to the trusted Live-Ring receiver with UDP zero', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: ringSource,
    selectedTarget: cosmicRingSelection
  })

  assert.deepEqual(route.target, {
    address: '192.168.68.58',
    port: 8000,
    name: 'Live-Ring',
    oscPort: 49713
  })
  assert.equal(route.peerId, 'ring-instrument')
  assert.equal(route.receiverName, 'Live-Ring')
  assert.equal(route.udpPort, 0)
})

test('Ring-Instrument rejects an unverified MaxRing identity and other sources cannot target Max/Ring', () => {
  assert.throws(() => resolveLinkAnnouncement({
    sourceDevice: ringSource,
    selectedTarget: {
      ...maxRingSelection,
      runtimeKind: null,
      linkRole: null
    }
  }), /verified local Ableton Ring receiver/)

  for (const sourceDevice of [
    { ...ringSource, name: 'Generic OSCQuery', serviceName: 'Generic OSCQuery' },
    { ...ringSource, name: 'Android_Tablet_A', serviceName: 'Android_Tablet_A', deviceType: 'Android' }
  ]) {
    assert.throws(() => resolveLinkAnnouncement({
      sourceDevice,
      selectedTarget: maxRingSelection
    }), /must be a CosmicUnity device/)
  }
})

test('Max/Ring rejects Android, generic OSCQuery and wrong-port Ring targets server-side', () => {
  for (const target of [
    androidSelection,
    {
      name: 'Generic OSCQuery',
      address: '192.168.68.70',
      port: 9020,
      deviceType: 'OSCQuery'
    },
    {
      ...otherOscQuerySelection,
      port: 9012
    }
  ]) {
    assert.throws(() => resolveLinkAnnouncement({
      sourceDevice: maxRingSource,
      selectedTarget: target
    }), /must be Ring-Instrument on port 9011/)
  }
})

test('an unverified MaxRing identity cannot gain receiver authority from its name alone', () => {
  assert.throws(() => resolveLinkAnnouncement({
    sourceDevice: {
      ...maxRingSource,
      runtimeKind: null,
      linkRole: null
    },
    selectedTarget: otherOscQuerySelection
  }), /not verified on this computer/)
})

test('Max/Ring target resolution replaces a spoofed browser address with the trusted registry endpoint', () => {
  const record = {
    ...otherOscQuerySelection,
    name: 'Ring-Instrument',
    serviceName: 'Ring-Instrument',
    host: '192.168.68.63',
    port: 9011,
    connectionState: 'Connected',
    discoveryState: 'Discovered',
    activeEndpoint: {
      fqdn: otherOscQuerySelection.fqdn,
      host: '192.168.68.63',
      port: 9011,
      serviceName: 'Ring-Instrument',
      available: true
    },
    endpoints: [{
      fqdn: otherOscQuerySelection.fqdn,
      host: '192.168.68.63',
      port: 9011,
      serviceName: 'Ring-Instrument',
      available: true
    }]
  }
  const resolved = resolveMaxRingTargetFromRegistry([record], {
    fqdn: otherOscQuerySelection.fqdn,
    name: 'Ring-Instrument',
    address: '203.0.113.77',
    port: 9011
  })

  assert.equal(resolved.record, record)
  assert.deepEqual(resolved.target, {
    address: '192.168.68.63',
    port: 9011,
    fqdn: otherOscQuerySelection.fqdn,
    name: 'Ring-Instrument',
    serviceName: 'Ring-Instrument',
    deviceType: 'OSCQuery',
    runtimeKind: undefined,
    linkRole: undefined
  })
})

test('Max/Ring refuses a name-and-port-only target absent from trusted registry state', () => {
  assert.throws(() => resolveMaxRingTargetFromRegistry([], {
    name: 'Ring-Instrument',
    address: '203.0.113.77',
    port: 9011
  }), /must be present in the Device Registry/)
})

test('Ring-Instrument target resolution replaces a spoofed MaxRing address with the trusted local receiver', () => {
  const record = {
    ...maxRingSource,
    manifestId: 14,
    connectionState: 'Connected',
    discoveryState: 'Discovered',
    activeEndpoint: {
      fqdn: maxRingSelection.fqdn,
      host: '192.168.68.58',
      port: 8005,
      serviceName: 'MaxRing',
      verifiedLocal: true,
      available: true
    },
    endpoints: [{
      fqdn: maxRingSelection.fqdn,
      host: '192.168.68.58',
      port: 8005,
      serviceName: 'MaxRing',
      verifiedLocal: true,
      available: true
    }]
  }
  const resolved = resolveMaxRingReceiverFromRegistry([record], {
    fqdn: maxRingSelection.fqdn,
    name: 'MaxRing',
    address: '203.0.113.88',
    port: 8005
  })

  assert.equal(resolved.record, record)
  assert.deepEqual(resolved.target, {
    address: '192.168.68.58',
    port: 8005,
    fqdn: maxRingSelection.fqdn,
    name: 'Max_Ring',
    serviceName: 'MaxRing',
    deviceType: 'OSCQuery',
    runtimeKind: MAX_RING_RUNTIME_KIND,
    linkRole: MAX_RING_LINK_ROLE
  })
})

test('Ring-Instrument refuses a MaxRing receiver absent from trusted registry state', () => {
  assert.throws(() => resolveMaxRingReceiverFromRegistry([], {
    name: 'MaxRing',
    address: '203.0.113.88',
    port: 8005
  }), /must be present in the Device Registry/)
})

test('Ring-Instrument target resolution canonicalizes Live-Ring to its registry endpoint', () => {
  const record = {
    ...cosmicRingSource,
    manifestId: 14,
    connectionState: 'Connected',
    discoveryState: 'Discovered',
    activeEndpoint: {
      fqdn: cosmicRingSelection.fqdn,
      host: '192.168.68.58',
      port: 8000,
      serviceName: 'Live-Ring',
      verifiedLocal: true,
      available: true
    },
    endpoints: [{
      fqdn: cosmicRingSelection.fqdn,
      host: '192.168.68.58',
      port: 8000,
      serviceName: 'Live-Ring',
      verifiedLocal: true,
      available: true
    }]
  }
  const resolved = resolveRingReceiverFromRegistry([record], {
    fqdn: cosmicRingSelection.fqdn,
    name: 'Live-Ring',
    address: '203.0.113.99',
    port: 8000
  })

  assert.equal(resolved.record, record)
  assert.deepEqual(resolved.target, {
    address: '192.168.68.58',
    port: 8000,
    fqdn: cosmicRingSelection.fqdn,
    name: 'Live-Ring',
    serviceName: 'Live-Ring',
    deviceType: 'CosmicRing',
    runtimeKind: COSMIC_RING_RUNTIME_KIND,
    linkRole: COSMIC_RING_LINK_ROLE
  })
})

test('Ring-Instrument cannot select a remote alias inside a trusted Live-Ring record', () => {
  const record = {
    ...cosmicRingSource,
    manifestId: 14,
    connectionState: 'Connected',
    discoveryState: 'Discovered',
    activeEndpoint: {
      fqdn: cosmicRingSelection.fqdn,
      host: '192.168.68.58',
      port: 8000,
      serviceName: 'Live-Ring',
      verifiedLocal: true,
      available: true
    },
    endpoints: [{
      fqdn: cosmicRingSelection.fqdn,
      host: '192.168.68.58',
      port: 8000,
      serviceName: 'Live-Ring',
      verifiedLocal: true,
      available: true
    }, {
      fqdn: 'Remote-Live-Ring._oscjson._tcp.local',
      host: '192.168.68.63',
      port: 8000,
      serviceName: 'Live-Ring',
      verifiedLocal: false,
      available: true
    }]
  }

  assert.throws(() => resolveRingReceiverFromRegistry([record], {
    fqdn: 'Remote-Live-Ring._oscjson._tcp.local',
    name: 'Live-Ring',
    address: '192.168.68.63',
    port: 8000
  }), /verified local endpoint/)
})

test('remote or unverified Live-Ring cannot become the Ableton receiver', () => {
  assert.throws(() => resolveRingReceiverFromRegistry([{
    ...cosmicRingSource,
    runtimeKind: null,
    linkRole: null,
    connectionState: 'Connected',
    discoveryState: 'Discovered',
    activeEndpoint: {
      fqdn: cosmicRingSelection.fqdn,
      host: '192.168.68.63',
      port: 8000,
      serviceName: 'Live-Ring',
      verifiedLocal: false,
      available: true
    },
    endpoints: [{
      fqdn: cosmicRingSelection.fqdn,
      host: '192.168.68.63',
      port: 8000,
      serviceName: 'Live-Ring',
      verifiedLocal: false,
      available: true
    }]
  }], {
    fqdn: cosmicRingSelection.fqdn,
    name: 'Live-Ring',
    address: '192.168.68.63',
    port: 8000
  }), /verified local endpoint/)
})

test('Ring-Instrument source resolution prefers its current registry endpoint over a stale manifest host', () => {
  const source = resolveRingInstrumentSourceFromRegistry({
    ...ringSource,
    host: '192.168.68.99',
    connectionState: 'Connected',
    discoveryState: 'Discovered',
    activeEndpoint: {
      fqdn: otherOscQuerySelection.fqdn,
      host: '192.168.68.63',
      port: 9011,
      serviceName: 'Ring-Instrument',
      available: true
    }
  })
  const route = resolveLinkAnnouncement({
    sourceDevice: source,
    selectedTarget: maxRingSelection
  })

  assert.equal(source.host, '192.168.68.63')
  assert.equal(route.host, '192.168.68.63')
  assert.equal(route.oscQueryPort, 9011)
})

test('default LINK UDP receive port stays zero instead of reusing Android port 9010', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: {
      ...cosmicSource,
      id: 2,
      name: 'Tablet_2',
      host: '192.168.68.58',
      oscQueryPort: 5002,
      oscPort: 53171
    },
    selectedTarget: {
      ...androidSelection,
      name: 'Android_Tablet02',
      address: '192.168.68.52'
    },
    peerId: 'tablet_2'
  })

  assert.equal(route.udpPort, 0)
  assert.notEqual(route.udpPort, route.oscQueryPort)
  assert.deepEqual(route.target, {
    address: '192.168.68.58',
    port: 5002,
    name: 'Tablet_2',
    oscPort: 53171
  })
})

test('an intentional positive UDP override remains available for a unique VST receive port', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: cosmicSource,
    selectedTarget: androidSelection,
    peerId: 'tablet_1',
    udpPortOverride: 61001
  })

  assert.equal(route.udpPort, 61001)
})

test('the legacy Android-card direction resolves to the same asymmetric VST bootstrap', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: {
      id: 3,
      deviceType: 'Android',
      name: 'Android_Tablet03',
      host: '192.168.68.53',
      oscQueryPort: 9010
    },
    selectedTarget: {
      ...cosmicSource,
      address: cosmicSource.host,
      port: cosmicSource.oscQueryPort
    },
    peerId: 'android_tablet03'
  })

  assert.deepEqual(route.target, {
    address: cosmicSource.host,
    port: cosmicSource.oscQueryPort,
    name: cosmicSource.name,
    oscPort: cosmicSource.oscPort
  })
  assert.equal(route.host, '192.168.68.53')
  assert.equal(route.oscQueryPort, 9010)
  assert.equal(route.udpPort, 0)
})

test('an Other OSCQuery card can select only a CosmicUnity receiver', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: {
      id: 4,
      deviceType: 'OSCQuery',
      name: 'Generic OSCQuery',
      host: '192.168.68.70',
      oscQueryPort: 9020
    },
    selectedTarget: {
      ...cosmicSource,
      address: cosmicSource.host,
      port: cosmicSource.oscQueryPort
    }
  })

  assert.equal(route.peerId, 'generic_oscquery')
  assert.equal(route.host, '192.168.68.70')
  assert.equal(route.oscQueryPort, 9020)
  assert.equal(route.target.port, 5001)
})

test('missing peer id defaults to the Android identity in both UI directions', () => {
  const cosmicCardRoute = resolveLinkAnnouncement({
    sourceDevice: cosmicSource,
    selectedTarget: { ...androidSelection, name: 'Android Tablet 03' }
  })
  assert.equal(cosmicCardRoute.peerId, 'android_tablet_03')

  const androidCardRoute = resolveLinkAnnouncement({
    sourceDevice: {
      id: 3,
      deviceType: 'Android',
      name: 'Android Tablet 03',
      host: '192.168.68.53',
      oscQueryPort: 9010
    },
    selectedTarget: {
      ...cosmicSource,
      address: cosmicSource.host,
      port: cosmicSource.oscQueryPort
    }
  })
  assert.equal(androidCardRoute.peerId, 'android_tablet_03')
})

test('same-type and Manager targets are rejected server-side', () => {
  assert.throws(() => resolveLinkAnnouncement({
    sourceDevice: cosmicSource,
    selectedTarget: {
      name: 'Another CosmicUnity',
      address: '127.0.0.1',
      port: 5002,
      deviceType: 'CosmicUnity'
    }
  }), /must be an Android or OSCQuery device/)

  assert.throws(() => resolveLinkAnnouncement({
    sourceDevice: cosmicSource,
    selectedTarget: {
      name: 'Cosmic Live Manager',
      address: '127.0.0.1',
      port: 7400,
      deviceType: 'Manager'
    }
  }), /must be an Android or OSCQuery device/)

  assert.throws(() => resolveLinkAnnouncement({
    sourceDevice: cosmicSource,
    selectedTarget: {
      ...maxRingSource,
      address: maxRingSource.host,
      port: maxRingSource.oscQueryPort
    }
  }), /must be an Android or OSCQuery device/)
})

test('uppercase OSCQuery TXT device type remains compatible with Android discovery', () => {
  const route = resolveLinkAnnouncement({
    sourceDevice: cosmicSource,
    selectedTarget: {
      ...androidSelection,
      name: 'Renamed Instrument',
      deviceType: undefined,
      txt: { DEVICE_TYPE: 'Android' }
    }
  })
  assert.equal(route.peerId, 'renamed_instrument')
  assert.equal(route.host, androidSelection.address)
})

test('registry target matching gives FQDN identity precedence over reused host and port', () => {
  const records = [{
    deviceType: 'Android',
    endpoints: [{
      fqdn: 'Android-Current._oscjson._tcp.local',
      host: '192.168.68.53',
      port: 9010
    }]
  }]

  assert.equal(findRegistryDeviceForTarget(records, {
    fqdn: 'Android-Stale._oscjson._tcp.local',
    address: '192.168.68.53',
    port: 9010
  }), null)
  assert.equal(findRegistryDeviceForTarget(records, {
    fqdn: 'Android-Current._oscjson._tcp.local',
    address: '192.168.68.53',
    port: 9010
  }), records[0])
})

test('registry target matching searches every exact FQDN before stale endpoint fallback', () => {
  const stale = {
    deviceType: 'CosmicUnity',
    endpoints: [{ host: '192.168.68.53', port: 9010 }]
  }
  const current = {
    deviceType: 'Android',
    endpoints: [{
      fqdn: 'Android-Current._oscjson._tcp.local',
      host: '192.168.68.53',
      port: 9010
    }]
  }

  assert.equal(findRegistryDeviceForTarget([stale, current], {
    fqdn: 'Android-Current._oscjson._tcp.local',
    address: '192.168.68.53',
    port: 9010
  }), current)
})

test('cached OSC UDP port is used without a second HOST_INFO request', async () => {
  let fetchCalls = 0
  const port = await resolveOscUdpPort({ oscPort: 57989 }, {
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('must not fetch')
    }
  })
  assert.equal(port, 57989)
  assert.equal(fetchCalls, 0)
})

test('OSC UDP resolution fails closed when HOST_INFO does not provide a port', async () => {
  await assert.rejects(
    resolveOscUdpPort({ address: '127.0.0.1', port: 5001 }, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ NAME: 'Cosmic without UDP metadata' })
      })
    }),
    /OSC UDP port is unavailable.*did not advertise OSC_PORT/
  )
})

// ─── Incident 2026-09-11: stale fqdn alias shadowed the live TV card ──────
// Android_Tablet02's manifest still carried a DHCP-era endpoint announcing
// the Windows TV's fqdn. That saved-but-offline card sorted before the real
// TV record, and the resolvers took the FIRST fqdn match — so the online,
// connected TV counted as 'LINK target is unavailable' and the auto-link
// engine parked on "Waiting for TV" after every VST restart.
const tvFqdn = 'Windows_TVNEVA40902._oscjson._tcp.local'

function staleAliasHolder() {
  return {
    manifestId: 2,
    name: 'Android_Tablet02',
    serviceName: 'Android_TabletSpectraTablet02',
    deviceType: 'Android',
    saved: true,
    discoveryState: 'Absent',
    connectionState: 'Disabled',
    activeEndpoint: {
      host: '192.168.68.71', port: 9010, available: true, lastSeen: 1_788_868_023_810,
      fqdn: 'Android_TabletSpectraTablet02._oscjson._tcp.local'
    },
    endpoints: [
      { host: '169.254.83.107', port: 9010, fqdn: tvFqdn, available: true, lastSeen: 1_788_868_023_810 },
      {
        host: '192.168.68.71', port: 9010, available: true, lastSeen: 1_788_868_023_810,
        fqdn: 'Android_TabletSpectraTablet02._oscjson._tcp.local'
      }
    ]
  }
}

function liveTvOwner() {
  const endpoint = {
    host: '192.168.68.75', port: 9010, fqdn: tvFqdn, source: 'discovery',
    available: true, lastSeen: 1_789_130_865_279
  }
  return {
    manifestId: 10,
    name: 'TV',
    serviceName: 'Windows_TVNEVA40902',
    deviceType: 'OSCQuery',
    saved: true,
    discoveryState: 'Discovered',
    connectionState: 'Connected',
    activeEndpoint: endpoint,
    endpoints: [endpoint]
  }
}

test('an offline record holding a stale fqdn alias never shadows the online owner of that fqdn', () => {
  const alias = staleAliasHolder()
  const owner = liveTvOwner()
  const selection = { fqdn: tvFqdn, name: 'TV', address: '192.168.68.75', port: 9010 }

  assert.equal(findRegistryDeviceForTarget([alias, owner], selection), owner,
    'snapshot order must not decide which record owns a fqdn')
  assert.equal(findRegistryDeviceForTarget([owner, alias], selection), owner)

  const resolved = resolveGenericTargetFromRegistry([alias, owner], selection)
  assert.equal(resolved.record, owner, 'a Discovered+Connected registry record is available for LINK')
  assert.equal(resolved.target.address, '192.168.68.75')
  assert.equal(resolved.target.port, 9010)
  assert.equal(resolved.target.deviceType, 'OSCQuery')
})

test('fqdn ownership prefers the online record, then the available endpoint, then the freshest sighting', () => {
  const offlineOwner = { ...liveTvOwner(), discoveryState: 'Stale', connectionState: 'Unavailable' }
  const alias = staleAliasHolder()
  const selection = { fqdn: tvFqdn, name: 'TV', address: '192.168.68.75', port: 9010 }

  // Both offline: the record whose ACTIVE endpoint carries the fqdn and was
  // seen last still owns it; a genuine tie keeps snapshot order.
  assert.equal(findRegistryDeviceForTarget([alias, offlineOwner], selection), offlineOwner)
  const twin = { ...offlineOwner, manifestId: 11, name: 'TV twin' }
  assert.equal(findRegistryDeviceForTarget([offlineOwner, twin], selection), offlineOwner)
  assert.equal(findRegistryDeviceForTarget([twin, offlineOwner], selection), twin)

  // DHCP move before host-follow heal ran: the saved card is offline with a
  // derived fqdn while an unsaved discovery record answers at the new host.
  const savedOffline = {
    ...offlineOwner,
    activeEndpoint: { ...offlineOwner.activeEndpoint, fqdnSource: 'derived', available: false },
    endpoints: [{ ...offlineOwner.activeEndpoint, fqdnSource: 'derived', available: false }]
  }
  const discoveredElsewhere = {
    ...liveTvOwner(),
    manifestId: null,
    saved: false,
    connectionState: 'Discovered',
    activeEndpoint: { ...liveTvOwner().activeEndpoint, host: '192.168.68.90' },
    endpoints: [{ ...liveTvOwner().activeEndpoint, host: '192.168.68.90' }]
  }
  assert.equal(
    findRegistryDeviceForTarget([savedOffline, discoveredElsewhere], selection),
    discoveredElsewhere
  )
  assert.throws(
    () => resolveGenericTargetFromRegistry([alias, offlineOwner], selection),
    /LINK target is unavailable/,
    'when nobody owning the fqdn is online the LINK still fails closed'
  )
})

// ─── Announce must never trust a cached OSC UDP port blindly ─────────────
test('refresh re-reads HOST_INFO and prefers the live OSC UDP port over the cache', async () => {
  const requested = []
  const port = await resolveOscUdpPort(
    { address: '127.0.0.1', port: 5004, oscPort: 61389 },
    {
      refresh: true,
      fetchImpl: async (url) => {
        requested.push(url)
        return { ok: true, status: 200, json: async () => ({ NAME: 'Live_TV', OSC_PORT: 61317 }) }
      }
    }
  )
  assert.equal(port, 61317, 'the port HOST_INFO advertises now wins over yesterday\'s cache')
  assert.deepEqual(requested, ['http://127.0.0.1:5004/?HOST_INFO'])
})

test('refresh fails closed when HOST_INFO is unreachable, even with a cached port', async () => {
  await assert.rejects(
    resolveOscUdpPort(
      { address: '127.0.0.1', port: 5004, oscPort: 61389 },
      { refresh: true, fetchImpl: async () => { throw new Error('ECONNREFUSED') } }
    ),
    /OSC UDP port is unavailable.*ECONNREFUSED/,
    'a port the device no longer confirms is not a port to announce to'
  )
})
