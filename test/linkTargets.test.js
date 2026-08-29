import test from 'node:test'
import assert from 'node:assert/strict'

import {
  filterLinkTargetServices,
  isAndroidDevice,
  isCosmicUnityDevice,
  serviceMatchesDevice
} from '../src/utils/linkTargets.js'

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

test('CosmicUnity LINK targets contain Android tablets only', () => {
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
    }
  ]
  const registry = [
    androidA,
    { deviceType: 'CosmicUnity', name: 'tablet2', host: '192.168.68.58', oscQueryPort: 5002 }
  ]

  assert.deepEqual(
    filterLinkTargetServices(cosmic5001, services, registry).map((service) => service.name),
    ['Android_Tablet_A']
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

  assert.equal(filterLinkTargetServices(cosmic5001, services, [androidA, androidB]).length, 2)
})

test('service matching uses identity endpoint data rather than name alone', () => {
  assert.equal(serviceMatchesDevice({
    fqdn: 'renamed._oscjson._tcp.local',
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

test('legacy Android services remain available without admitting generic OSCQuery services', () => {
  const services = [
    { name: 'Android_Legacy_Tablet', address: '192.168.68.70', port: 9010 },
    { name: 'Generic OSCQuery', address: '192.168.68.71', port: 9010 }
  ]

  assert.deepEqual(
    filterLinkTargetServices(cosmic5001, services, []).map((service) => service.name),
    ['Android_Legacy_Tablet']
  )
})

test('non-CosmicUnity cards retain their existing target list', () => {
  const services = [
    { name: 'tablet2', address: '192.168.68.58', port: 5002 },
    { name: 'Cosmic Live Manager', address: '192.168.68.58', port: 7400 }
  ]

  assert.deepEqual(filterLinkTargetServices(androidA, services, [cosmic5001]), services)
  assert.equal(isCosmicUnityDevice(cosmic5001), true)
  assert.equal(isAndroidDevice(androidA), true)
})
