import test from 'node:test'
import assert from 'node:assert/strict'

import {
  findRegistryDeviceForService,
  findLinkTargetByFqdn,
  filterLinkTargetServices,
  isAbletonRingReceiverDevice,
  isAndroidDevice,
  isCosmicRingIdentity,
  isCosmicRingReceiverDevice,
  isCosmicUnityDevice,
  isCosmicUnityOrAbletonDevice,
  isMaxRingIdentity,
  isMaxRingReceiverDevice,
  isRingInstrumentIdentity,
  knownDisallowedLinkTargetFqdns,
  serializeLinkTarget,
  serviceMatchesDevice
} from '../src/utils/linkTargets.js'
import {
  MAX_RING_LINK_ROLE,
  MAX_RING_RUNTIME_KIND
} from '../shared/maxRingLink.js'
import {
  COSMIC_RING_LINK_ROLE,
  COSMIC_RING_RUNTIME_KIND
} from '../shared/cosmicRingLink.js'

const cosmic5001 = {
  deviceType: 'CosmicUnity',
  name: 'Tablet_1',
  host: '192.168.68.58',
  oscQueryPort: 5001,
  isLocal: true
}

const androidA = {
  canonicalId: 'android:installation-a',
  deviceType: 'Android',
  name: 'Android_Tablet_A',
  endpoints: [{
    fqdn: 'Android-A._oscjson._tcp.local',
    host: '192.168.68.52',
    port: 9010
  }]
}

const cosmic5002 = {
  canonicalId: 'cosmicunity:instance-5002',
  deviceType: 'CosmicUnity',
  name: 'tablet2',
  endpoints: [{
    fqdn: 'tablet2._oscjson._tcp.local',
    host: '192.168.68.58',
    port: 5002
  }]
}

const otherOscQuery = {
  canonicalId: 'oscquery:legacy:192.168.68.63:9011:ring-instrument',
  deviceType: 'OSCQuery',
  name: 'Ring-Instrument',
  serviceName: 'Ring-Instrument',
  host: '192.168.68.63',
  oscQueryPort: 9011,
  endpoints: [{
    fqdn: 'Ring-Instrument._oscjson._tcp.local',
    host: '192.168.68.63',
    port: 9011
  }]
}

const maxRingReceiver = {
  canonicalId: 'oscquery:legacy:192.168.68.58:8005:maxring',
  deviceType: 'OSCQuery',
  runtimeKind: MAX_RING_RUNTIME_KIND,
  linkRole: MAX_RING_LINK_ROLE,
  name: 'Max_Ring',
  serviceName: 'MaxRing',
  host: '192.168.68.58',
  oscQueryPort: 8005,
  endpoints: [{
    fqdn: 'MaxRing._oscjson._tcp.local',
    host: '192.168.68.58',
    port: 8005,
    serviceName: 'MaxRing'
  }]
}

const maxRingService = {
  fqdn: 'MaxRing._oscjson._tcp.local',
  name: 'MaxRing',
  address: '192.168.68.58',
  port: 8005
}

const cosmicRingReceiver = {
  canonicalId: 'cosmicring:uuid:ring-vst-installation',
  deviceType: 'CosmicRing',
  runtimeKind: COSMIC_RING_RUNTIME_KIND,
  linkRole: COSMIC_RING_LINK_ROLE,
  name: 'Live-Ring',
  serviceName: 'Live-Ring',
  host: '192.168.68.58',
  oscQueryPort: 8000,
  endpoints: [{
    fqdn: 'Live-Ring._oscjson._tcp.local',
    host: '192.168.68.58',
    port: 8000,
    serviceName: 'Live-Ring'
  }]
}

const cosmicRingService = {
  fqdn: 'Live-Ring._oscjson._tcp.local',
  name: 'Live-Ring',
  address: '192.168.68.58',
  port: 8000,
  txt: { device_type: 'CosmicRing' }
}

test('CosmicUnity LINK targets contain Android and Other OSCQuery devices', () => {
  const services = [
    {
      fqdn: 'Android-A._oscjson._tcp.local',
      name: 'Android_Tablet_A',
      address: '192.168.68.52',
      port: 9010
    },
    {
      fqdn: 'tablet2._oscjson._tcp.local',
      name: 'tablet2',
      address: '192.168.68.58',
      port: 5002
    },
    {
      fqdn: 'Cosmic-Live-Manager._oscjson._tcp.local',
      name: 'Cosmic Live Manager',
      address: '192.168.68.58',
      port: 7400
    },
    {
      fqdn: 'Ring-Instrument._oscjson._tcp.local',
      name: 'Ring-Instrument',
      address: '192.168.68.63',
      port: 9011
    },
    maxRingService
  ]
  const registry = [
    androidA,
    cosmic5002,
    otherOscQuery,
    maxRingReceiver
  ]

  assert.deepEqual(
    filterLinkTargetServices(cosmic5001, services, registry).map((service) => service.name),
    ['Android_Tablet_A', 'Ring-Instrument']
  )
})

test('Max/Ring is grouped as Ableton without pretending to be CosmicUnity', () => {
  assert.equal(isMaxRingIdentity(maxRingReceiver), true)
  assert.equal(isMaxRingReceiverDevice(maxRingReceiver), true)
  assert.equal(isCosmicUnityDevice(maxRingReceiver), false)
  assert.equal(isCosmicUnityOrAbletonDevice(maxRingReceiver), true)

  assert.equal(isMaxRingIdentity({ ...maxRingReceiver, oscQueryPort: 8006 }), false)
  assert.equal(isMaxRingIdentity({ ...maxRingReceiver, serviceName: 'MaxFoo', name: 'MaxFoo', endpoints: [] }), false)
  assert.equal(isMaxRingReceiverDevice({
    ...maxRingReceiver,
    runtimeKind: null,
    linkRole: null
  }), false)
})

test('Live-Ring is grouped as Ableton and keeps its distinct CosmicRing identity', () => {
  assert.equal(isCosmicRingIdentity(cosmicRingReceiver), true)
  assert.equal(isCosmicRingReceiverDevice(cosmicRingReceiver), true)
  assert.equal(isAbletonRingReceiverDevice(cosmicRingReceiver), true)
  assert.equal(isCosmicUnityDevice(cosmicRingReceiver), false)
  assert.equal(isCosmicUnityOrAbletonDevice(cosmicRingReceiver), true)
})

test('Live-Ring LINK offers only Ring-Instrument and Ring can select trusted Live-Ring', () => {
  const exactRing = {
    fqdn: 'Ring-Instrument._oscjson._tcp.local',
    name: 'Ring-Instrument',
    address: '192.168.68.63',
    port: 9011
  }
  const services = [
    exactRing,
    { fqdn: 'Android-A._oscjson._tcp.local', name: 'Android_Tablet_A', address: '192.168.68.52', port: 9010 },
    { fqdn: 'tablet2._oscjson._tcp.local', name: 'tablet2', address: '192.168.68.58', port: 5002 },
    maxRingService,
    cosmicRingService
  ]
  const registry = [cosmicRingReceiver, otherOscQuery, androidA, cosmic5002, maxRingReceiver]

  assert.deepEqual(
    filterLinkTargetServices(cosmicRingReceiver, services, registry)
      .map((service) => service.name),
    ['Ring-Instrument']
  )
  assert.deepEqual(
    filterLinkTargetServices(otherOscQuery, [cosmicRingService], registry)
      .map((service) => service.name),
    ['Live-Ring']
  )
  assert.deepEqual(
    filterLinkTargetServices(otherOscQuery, [cosmicRingService], [otherOscQuery]),
    []
  )
})

test('Android and generic OSCQuery devices cannot target Live-Ring', () => {
  const generic = {
    canonicalId: 'oscquery:generic-controller',
    deviceType: 'OSCQuery',
    name: 'Generic Controller',
    host: '192.168.68.70',
    oscQueryPort: 9020
  }

  for (const source of [generic, androidA]) {
    assert.deepEqual(
      filterLinkTargetServices(
        source,
        [cosmicRingService],
        [source, cosmicRingReceiver]
      ),
      []
    )
  }
})

test('remote or untrusted CosmicRing sources fail closed instead of offering CosmicUnity targets', () => {
  const remoteCosmicRing = {
    ...cosmicRingReceiver,
    canonicalId: 'cosmicring:uuid:remote-ring',
    runtimeKind: null,
    linkRole: null,
    host: '192.168.68.63',
    oscQueryPort: 8000,
    endpoints: [{
      fqdn: 'Remote-Live-Ring._oscjson._tcp.local',
      host: '192.168.68.63',
      port: 8000,
      serviceName: 'Live-Ring'
    }]
  }
  const cosmicService = {
    fqdn: 'tablet2._oscjson._tcp.local',
    name: 'tablet2',
    address: '192.168.68.58',
    port: 5002
  }

  assert.deepEqual(
    filterLinkTargetServices(
      remoteCosmicRing,
      [cosmicService],
      [remoteCosmicRing, cosmic5002]
    ),
    []
  )
})

test('Max/Ring LINK offers only the exact Ring-Instrument service on port 9011', () => {
  const exactRing = {
    fqdn: 'Ring-Instrument._oscjson._tcp.local',
    name: 'Ring-Instrument',
    address: '192.168.68.63',
    port: 9011
  }
  const services = [
    exactRing,
    { ...exactRing, fqdn: 'Ring-Wrong-Port._oscjson._tcp.local', port: 9012 },
    { fqdn: 'Android-A._oscjson._tcp.local', name: 'Android_Tablet_A', address: '192.168.68.52', port: 9010 },
    { fqdn: 'Generic._oscjson._tcp.local', name: 'Generic OSCQuery', address: '192.168.68.70', port: 9020 },
    { fqdn: 'tablet2._oscjson._tcp.local', name: 'tablet2', address: '192.168.68.58', port: 5002 },
    { fqdn: 'Cosmic-Live-Manager._oscjson._tcp.local', name: 'Cosmic Live Manager', address: '192.168.68.58', port: 7400 },
    maxRingService
  ]

  assert.equal(isRingInstrumentIdentity(exactRing), true)
  assert.deepEqual(
    filterLinkTargetServices(
      maxRingReceiver,
      services,
      [maxRingReceiver, otherOscQuery, androidA, cosmic5002]
    ),
    [exactRing]
  )
  assert.deepEqual(
    knownDisallowedLinkTargetFqdns(
      maxRingReceiver,
      services,
      [maxRingReceiver, otherOscQuery, androidA, cosmic5002]
    ),
    [
      'Ring-Wrong-Port._oscjson._tcp.local',
      'Android-A._oscjson._tcp.local',
      'Generic._oscjson._tcp.local',
      'tablet2._oscjson._tcp.local',
      'Cosmic-Live-Manager._oscjson._tcp.local',
      'MaxRing._oscjson._tcp.local'
    ]
  )
})

test('Ring-Instrument LINK offers CosmicUnity plus the trusted local Max_Ring receiver', () => {
  const services = [
    {
      fqdn: 'tablet2._oscjson._tcp.local',
      name: 'tablet2',
      address: '192.168.68.58',
      port: 5002
    },
    maxRingService,
    {
      fqdn: 'Android-A._oscjson._tcp.local',
      name: 'Android_Tablet_A',
      address: '192.168.68.52',
      port: 9010
    }
  ]

  assert.deepEqual(
    filterLinkTargetServices(
      otherOscQuery,
      services,
      [otherOscQuery, cosmic5002, maxRingReceiver, androidA]
    ).map((service) => service.name),
    ['tablet2', 'Max_Ring']
  )
  assert.equal(
    knownDisallowedLinkTargetFqdns(
      otherOscQuery,
      services,
      [otherOscQuery, cosmic5002, maxRingReceiver, androidA]
    ).includes(maxRingService.fqdn),
    false
  )

  assert.deepEqual(
    filterLinkTargetServices(
      otherOscQuery,
      [maxRingService],
      [otherOscQuery]
    ),
    []
  )
})

test('generic OSCQuery and Android sources cannot select Max_Ring', () => {
  const generic = {
    canonicalId: 'oscquery:generic-controller',
    deviceType: 'OSCQuery',
    name: 'Generic Controller',
    host: '192.168.68.70',
    oscQueryPort: 9020
  }

  for (const source of [generic, androidA]) {
    assert.deepEqual(
      filterLinkTargetServices(
        source,
        [maxRingService],
        [source, maxRingReceiver]
      ),
      []
    )
  }
})

test('connected registry peers remain LINK targets while Bonjour reconverges after restart', () => {
  const connectedRing = {
    ...otherOscQuery,
    serviceName: 'Ring-Instrument',
    connectionState: 'Connected',
    discoveryState: 'Absent',
    activeEndpoint: otherOscQuery.endpoints[0]
  }
  const connectedAndroid = {
    ...androidA,
    serviceName: 'Android_Tablet_A',
    connectionState: 'Connected',
    discoveryState: 'Absent',
    activeEndpoint: androidA.endpoints[0]
  }
  const unavailableRing = {
    ...connectedRing,
    connectionState: 'Unavailable'
  }
  const unavailableMaxRing = {
    ...maxRingReceiver,
    connectionState: 'Unavailable',
    discoveryState: 'Absent',
    activeEndpoint: maxRingReceiver.endpoints[0]
  }

  assert.deepEqual(
    filterLinkTargetServices(maxRingReceiver, [], [connectedRing])
      .map((service) => `${service.name}:${service.port}`),
    ['Ring-Instrument:9011']
  )
  assert.deepEqual(
    filterLinkTargetServices(otherOscQuery, [], [{
      ...maxRingReceiver,
      connectionState: 'Connected',
      discoveryState: 'Absent',
      activeEndpoint: maxRingReceiver.endpoints[0]
    }]).map((service) => `${service.name}:${service.port}`),
    ['Max_Ring:8005']
  )
  assert.deepEqual(
    filterLinkTargetServices(cosmic5001, [], [connectedAndroid, connectedRing])
      .map((service) => service.name),
    ['Android_Tablet_A', 'Ring-Instrument']
  )
  assert.deepEqual(
    filterLinkTargetServices(maxRingReceiver, [], [unavailableRing]),
    []
  )
  assert.deepEqual(
    filterLinkTargetServices(otherOscQuery, [], [unavailableMaxRing]),
    []
  )
})

test('two Android tablets on the same port remain separate LINK targets', () => {
  const androidB = {
    canonicalId: 'android:installation-b',
    deviceType: 'Android',
    name: 'Android_Tablet_B',
    endpoints: [{
      fqdn: 'Android-B._oscjson._tcp.local',
      host: '192.168.68.53',
      port: 9010
    }]
  }
  const services = [
    { fqdn: 'Android-A._oscjson._tcp.local', name: 'Android_Tablet_A', address: '192.168.68.52', port: 9010 },
    { fqdn: 'Android-B._oscjson._tcp.local', name: 'Android_Tablet_B', address: '192.168.68.53', port: 9010 }
  ]

  assert.deepEqual(
    filterLinkTargetServices(cosmic5001, services, [androidA, androidB])
      .map((service) => service.fqdn),
    [
      'Android-A._oscjson._tcp.local',
      'Android-B._oscjson._tcp.local'
    ]
  )
})

test('service matching uses identity endpoint data rather than name alone', () => {
  assert.equal(serviceMatchesDevice({
    fqdn: 'Android-A._oscjson._tcp.local',
    name: 'unrelated-name',
    address: '192.168.68.52',
    port: 9010
  }, androidA), true)
  assert.equal(serviceMatchesDevice({
    name: 'Android_Tablet_A',
    address: '192.168.68.99',
    port: 9010
  }, androidA), false)
})

test('different FQDNs do not collide through a reused host and port', () => {
  assert.equal(serviceMatchesDevice({
    fqdn: 'new-cosmic._oscjson._tcp.local',
    name: 'new-cosmic',
    address: '192.168.68.52',
    port: 9010,
    txt: { device_type: 'CosmicUnity' }
  }, androidA), false)
})

test('registry classification is exact-FQDN-first regardless of record or endpoint ordering', () => {
  const service = {
    fqdn: 'Android-A._oscjson._tcp.local',
    name: 'renamed-without-android-token',
    address: '192.168.68.52',
    port: 9010
  }
  const staleCosmicAlias = {
    canonicalId: 'cosmicunity:stale-shared-endpoint',
    deviceType: 'CosmicUnity',
    endpoints: [{
      fqdn: 'stale-cosmic._oscjson._tcp.local',
      host: '192.168.68.52',
      port: 9010
    }],
    // The legacy alias has no FQDN and would match host:port if evaluated
    // before the Android record's exact discovery identity.
    activeEndpoint: { host: '192.168.68.52', port: 9010 }
  }

  for (const registry of [
    [staleCosmicAlias, androidA],
    [androidA, staleCosmicAlias]
  ]) {
    assert.equal(findRegistryDeviceForService(service, registry), androidA)
    assert.deepEqual(
      filterLinkTargetServices(cosmic5001, [service], registry),
      [service]
    )
  }
})

test('historical local FQDN aliases produce one LINK option for one canonical VST', () => {
  const registryDevice = {
    canonicalId: 'cosmicunity:uuid:local-vst-5003',
    deviceType: 'CosmicUnity',
    name: 'LiveTablet_3',
    connectionState: 'Connected',
    discoveryState: 'Discovered',
    activeEndpoint: {
      fqdn: 'tablet2._oscjson._tcp.local',
      host: '127.0.0.1',
      port: 5003,
      available: true,
      lastSeen: 100
    },
    endpoints: [
      {
        fqdn: 'tablet2._oscjson._tcp.local',
        host: '127.0.0.1',
        port: 5003,
        available: true,
        lastSeen: 100
      },
      {
        fqdn: 'LiveTablet-3._oscjson._tcp.local',
        host: '192.168.68.58',
        port: 5003,
        available: true,
        lastSeen: 200
      }
    ]
  }
  const services = [
    {
      fqdn: 'tablet2._oscjson._tcp.local',
      name: 'tablet2',
      address: '127.0.0.1',
      port: 5003
    },
    {
      fqdn: 'LiveTablet-3._oscjson._tcp.local',
      name: 'LiveTablet-3',
      address: '192.168.68.58',
      port: 5003
    }
  ]

  const targets = filterLinkTargetServices(otherOscQuery, services, [registryDevice])
  assert.equal(targets.length, 1)
  assert.equal(targets[0].fqdn, 'LiveTablet-3._oscjson._tcp.local')
  assert.equal(targets[0].address, '192.168.68.58')
  assert.deepEqual(
    targets[0].aliasFqdns.sort(),
    ['tablet2._oscjson._tcp.local']
  )
  assert.equal(
    findLinkTargetByFqdn(targets, 'tablet2._oscjson._tcp.local'),
    targets[0]
  )
  assert.equal(
    findLinkTargetByFqdn(targets, 'LiveTablet-3._oscjson._tcp.local'),
    targets[0]
  )
})

test('LINK target serialization preserves discovery identity without mutating it', () => {
  const target = {
    fqdn: 'Android-A._oscjson._tcp.local',
    name: 'renamed-tablet',
    address: '192.168.68.52',
    addresses: ['192.168.68.52', 'fe80::1234'],
    port: 9010,
    deviceType: 'Android',
    txt: {
      device_type: 'Android',
      device_id: 'installation-a'
    }
  }

  const serialized = serializeLinkTarget(target)

  assert.deepEqual(serialized, target)
  assert.notEqual(serialized, target)
  assert.notEqual(serialized.txt, target.txt)
  assert.notEqual(serialized.addresses, target.addresses)
})

test('legacy Android and generic OSCQuery services remain available to CosmicUnity', () => {
  const services = [
    { name: 'Android_Legacy_Tablet', address: '192.168.68.70', port: 9010 },
    { name: 'Generic OSCQuery', address: '192.168.68.71', port: 9010 }
  ]

  assert.deepEqual(
    filterLinkTargetServices(cosmic5001, services, []).map((service) => service.name),
    ['Android_Legacy_Tablet', 'Generic OSCQuery']
  )
})

test('Android LINK targets contain CosmicUnity devices only', () => {
  const services = [
    {
      fqdn: 'tablet2._oscjson._tcp.local',
      name: 'tablet2',
      address: '192.168.68.58',
      port: 5002
    },
    {
      fqdn: 'Android-A._oscjson._tcp.local',
      name: 'Android_Tablet_A',
      address: '192.168.68.52',
      port: 9010
    },
    {
      fqdn: 'Ring-Instrument._oscjson._tcp.local',
      name: 'Ring-Instrument',
      address: '192.168.68.63',
      port: 9011
    },
    { name: 'Cosmic Live Manager', address: '192.168.68.58', port: 7400 }
  ]

  assert.deepEqual(
    filterLinkTargetServices(androidA, services, [cosmic5002, androidA, otherOscQuery])
      .map((service) => service.name),
    ['tablet2']
  )
  assert.equal(isCosmicUnityDevice(cosmic5001), true)
  assert.equal(isAndroidDevice(androidA), true)
})

test('Other OSCQuery LINK targets contain CosmicUnity devices only', () => {
  const services = [
    {
      fqdn: 'tablet2._oscjson._tcp.local',
      name: 'tablet2',
      address: '192.168.68.58',
      port: 5002
    },
    {
      fqdn: 'Android-A._oscjson._tcp.local',
      name: 'Android_Tablet_A',
      address: '192.168.68.52',
      port: 9010
    },
    {
      fqdn: 'Other-B._oscjson._tcp.local',
      name: 'Other-B',
      address: '192.168.68.64',
      port: 9012
    },
    {
      fqdn: 'Cosmic-Live-Manager._oscjson._tcp.local',
      name: 'Cosmic Live Manager',
      address: '192.168.68.58',
      port: 7400
    }
  ]

  assert.deepEqual(
    filterLinkTargetServices(otherOscQuery, services, [cosmic5002, androidA, otherOscQuery])
      .map((service) => service.name),
    ['tablet2']
  )
})

test('known incompatible persisted targets are identified without deleting unknown targets', () => {
  const services = [
    {
      fqdn: 'tablet2._oscjson._tcp.local',
      name: 'tablet2',
      address: '192.168.68.58',
      port: 5002
    },
    {
      fqdn: 'Android-A._oscjson._tcp.local',
      name: 'Android_Tablet_A',
      address: '192.168.68.52',
      port: 9010
    },
    {
      fqdn: 'Cosmic-Live-Manager._oscjson._tcp.local',
      name: 'Cosmic Live Manager',
      address: '192.168.68.58',
      port: 7400
    },
    {
      fqdn: 'unknown._oscjson._tcp.local',
      name: 'Unknown OSCQuery',
      address: '192.168.68.99',
      port: 9999
    },
    {
      fqdn: 'Ring-Instrument._oscjson._tcp.local',
      name: 'Ring-Instrument',
      address: '192.168.68.63',
      port: 9011
    }
  ]

  assert.deepEqual(
    knownDisallowedLinkTargetFqdns(androidA, services, [cosmic5002, androidA, otherOscQuery]),
    [
      'Android-A._oscjson._tcp.local',
      'Ring-Instrument._oscjson._tcp.local'
    ]
  )
})

test('name-only Manager detection hides the target without destructively clearing storage', () => {
  const manager = {
    fqdn: 'Cosmic-Live-Manager._oscjson._tcp.local',
    name: 'Cosmic Live Manager',
    address: '192.168.68.58',
    port: 7400
  }

  assert.deepEqual(filterLinkTargetServices(androidA, [manager], [androidA]), [])
  assert.deepEqual(knownDisallowedLinkTargetFqdns(androidA, [manager], [androidA]), [])
})

test('legacy name heuristic does not destructively clear a sticky target before registry resolves it', () => {
  const legacyAndroid = {
    fqdn: 'Android-Legacy._oscjson._tcp.local',
    name: 'Android_Legacy_Tablet',
    address: '192.168.68.70',
    port: 9010
  }

  assert.deepEqual(
    knownDisallowedLinkTargetFqdns(androidA, [legacyAndroid], []),
    []
  )
})
