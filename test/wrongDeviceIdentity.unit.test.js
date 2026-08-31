// Wrong-device guard for HOST_INFO (DHCP incident 2026-08-31).
//
// Android_Tablet01's manifest still resolved 192.168.68.54 after a DHCP lease
// change, but that address now belonged to SpectraTablet02. The hub connected,
// HOST_INFO announced NAME="Android_TabletSpectraTablet02", and the card showed
// "Connected" while parameters went to the wrong physical tablet.
//
// hostInfoIdentityMismatch is the pure comparison: DEVICE_ID is authoritative
// when both sides declare one. The name fallback needs mDNS-grade evidence —
// an observed fqdn on the dialed endpoint — because manifest migration
// synthesizes `serviceName` from the display label, and a hand-typed card
// label is not an identity declaration. A side that declares no identity can
// never mismatch: the guard only fires when BOTH sides make a claim.

import test from 'node:test'
import assert from 'node:assert/strict'

import { hostInfoIdentityMismatch } from '../server/deviceRegistry.js'

const OLD_HOST = '192.168.68.54'
const PORT = 8000

function tablet01(overrides = {}) {
  return {
    name: 'Android_Tablet01',
    serviceName: 'Android_Tablet01',
    host: OLD_HOST,
    oscQueryPort: PORT,
    endpoints: [{
      host: OLD_HOST,
      port: PORT,
      source: 'discovery',
      fqdn: 'Android_Tablet01._oscjson._tcp.local',
      lastSeen: 500
    }],
    ...overrides
  }
}

test('differing DEVICE_IDs are a mismatch even when the names agree', () => {
  const mismatch = hostInfoIdentityMismatch(
    tablet01({ persistentDeviceId: 'a'.repeat(32) }),
    { DEVICE_ID: 'b'.repeat(32), NAME: 'Android_Tablet01' }
  )
  assert.ok(mismatch)
  assert.equal(mismatch.basis, 'device-id')
  assert.equal(mismatch.expected, 'a'.repeat(32))
  assert.equal(mismatch.found, 'b'.repeat(32))
})

test('matching DEVICE_IDs verify the device even after a rename', () => {
  assert.equal(hostInfoIdentityMismatch(
    tablet01({ persistentDeviceId: 'a'.repeat(32) }),
    { DEVICE_ID: 'A'.repeat(32), NAME: 'Renamed Tablet' }
  ), null)
})

test('an --id token inside HOST_INFO NAME counts as the declared DEVICE_ID', () => {
  const mismatch = hostInfoIdentityMismatch(
    tablet01({ persistentDeviceId: 'a'.repeat(32) }),
    { NAME: `Android_Tablet--id-${'b'.repeat(32)}-SpectraTablet02` }
  )
  assert.ok(mismatch)
  assert.equal(mismatch.basis, 'device-id')
})

test('the 2026-08-31 incident: HOST_INFO NAME of another tablet is a name mismatch', () => {
  const mismatch = hostInfoIdentityMismatch(
    tablet01(),
    { NAME: 'Android_TabletSpectraTablet02', OSC_PORT: 9000 }
  )
  assert.ok(mismatch)
  assert.equal(mismatch.basis, 'name')
  assert.equal(mismatch.expected, 'Android_Tablet01')
  assert.equal(mismatch.found, 'Android_TabletSpectraTablet02')
})

test('a stale expected DEVICE_ID falls back to NAME when the device declares none', () => {
  assert.equal(hostInfoIdentityMismatch(
    tablet01({ persistentDeviceId: 'a'.repeat(32) }),
    { NAME: 'Android_Tablet01' }
  ), null)
  const mismatch = hostInfoIdentityMismatch(
    tablet01({ persistentDeviceId: 'a'.repeat(32) }),
    { NAME: 'Android_TabletSpectraTablet02' }
  )
  assert.ok(mismatch)
  assert.equal(mismatch.basis, 'name')
})

test('separator and case churn between label, fqdn and NAME never mismatches', () => {
  assert.equal(hostInfoIdentityMismatch(
    tablet01({
      name: 'AndroidTablet01',
      serviceName: 'android-tablet01'
    }),
    { NAME: 'Android_Tablet01' }
  ), null)
})

test('HOST_INFO NAME matching the display name or fqdn label is accepted alongside serviceName', () => {
  assert.equal(hostInfoIdentityMismatch(
    tablet01({ name: 'Sahne Tablet Sol' }),
    { NAME: 'Android_Tablet01' }
  ), null)
  assert.equal(hostInfoIdentityMismatch(
    tablet01({ name: 'Sahne Tablet Sol' }),
    { NAME: 'Sahne Tablet Sol' }
  ), null)
})

test('without an observed fqdn on the dialed endpoint the name fallback stays lenient', () => {
  // Hand-typed manifest: migration synthesized serviceName from the label,
  // no discovery ever vouched for a service name at this address.
  assert.equal(hostInfoIdentityMismatch(
    tablet01({ endpoints: [{ host: OLD_HOST, port: PORT, source: 'manifest', lastSeen: 500 }] }),
    { NAME: 'Android_TabletSpectraTablet02' }
  ), null)
  // The fqdn belongs to another endpoint, not the dialed one.
  assert.equal(hostInfoIdentityMismatch(
    tablet01({
      endpoints: [{
        host: '192.168.68.99',
        port: PORT,
        source: 'discovery',
        fqdn: 'Android_Tablet01._oscjson._tcp.local',
        lastSeen: 500
      }]
    }),
    { NAME: 'Android_TabletSpectraTablet02' }
  ), null)
})

test('a side that declares no identity can never mismatch', () => {
  assert.equal(hostInfoIdentityMismatch(
    tablet01(),
    { OSC_PORT: 9000 }
  ), null)
  assert.equal(hostInfoIdentityMismatch({}, null), null)
  assert.equal(hostInfoIdentityMismatch(null, { NAME: 'Android_Tablet01' }), null)
})
