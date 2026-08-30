// Saved-device host-follow auto-heal planner (DHCP address moves).
//
// A device whose mDNS fqdn stays stable can move to a new address on a DHCP
// lease change. The saved manifest keeps pointing at the dead address; once
// the manifest endpoint fails repeatedly while discovery vouches for the same
// fqdn on a fresher endpoint, the planner proposes migrating the manifest.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HOST_FOLLOW_MIN_FAILURES,
  planHostFollowHeals
} from '../server/hostFollowHeal.js'

const FQDN = 'Windows_TVNEVA40902._oscjson._tcp.local'
const OLD_HOST = '192.168.68.63'
const NEW_HOST = '192.168.68.51'
const PORT = 9000

function fixture({
  failures = HOST_FOLLOW_MIN_FAILURES,
  status = 'error',
  enabled = true,
  lastMessageAt = 1_000,
  manifestEndpoint = {},
  discoveryEndpoint = {},
  extraEndpoints = []
} = {}) {
  const dev = {
    id: 61,
    enabled,
    status,
    host: OLD_HOST,
    oscQueryPort: PORT,
    lastMessageAt,
    consecutiveConnectFailures: failures
  }
  const snapshot = [{
    canonicalId: `oscquery:legacy:${OLD_HOST}:${PORT}:windows-tvneva40902`,
    saved: true,
    manifestId: 61,
    endpoints: [
      {
        host: OLD_HOST,
        port: PORT,
        source: 'discovery',
        fqdn: FQDN,
        available: true,
        lastSeen: 1_000,
        ...manifestEndpoint
      },
      {
        host: NEW_HOST,
        port: PORT,
        source: 'discovery',
        fqdn: FQDN,
        available: true,
        lastSeen: 5_000,
        ...discoveryEndpoint
      },
      ...extraEndpoints
    ]
  }]
  return {
    snapshot,
    getManagedDevice: (manifestId) => (manifestId === 61 ? dev : undefined)
  }
}

test('host follow migrates a failing saved manifest to the fresher same-fqdn endpoint', () => {
  const plans = planHostFollowHeals(fixture())
  assert.equal(plans.length, 1)
  assert.deepEqual(plans[0], {
    manifestId: 61,
    fqdn: FQDN,
    fromHost: OLD_HOST,
    fromPort: PORT,
    host: NEW_HOST,
    oscQueryPort: PORT
  })
})

test('one connect failure is not enough evidence to move a manifest', () => {
  assert.deepEqual(planHostFollowHeals(fixture({ failures: 1 })), [])
})

test('a connected or disabled device never migrates', () => {
  assert.deepEqual(planHostFollowHeals(fixture({ status: 'connected' })), [])
  assert.deepEqual(planHostFollowHeals(fixture({ enabled: false })), [])
})

test('without an fqdn on the manifest endpoint there is no identity proof', () => {
  assert.deepEqual(planHostFollowHeals(fixture({ manifestEndpoint: { fqdn: '' } })), [])
})

test('a different fqdn is a different device, never a migration target', () => {
  assert.deepEqual(planHostFollowHeals(fixture({
    discoveryEndpoint: { fqdn: 'Ring-Instrument._oscjson._tcp.local' }
  })), [])
})

test('a stale or unavailable discovery endpoint is not fresh evidence', () => {
  // Announced before the manifest endpoint was last seen → stale.
  assert.deepEqual(planHostFollowHeals(fixture({
    manifestEndpoint: { lastSeen: 6_000 }
  })), [])
  // mDNS goodbye already marked it gone.
  assert.deepEqual(planHostFollowHeals(fixture({
    discoveryEndpoint: { available: false }
  })), [])
  // Announced before the device last answered on the manifest endpoint.
  assert.deepEqual(planHostFollowHeals(fixture({ lastMessageAt: 9_000 })), [])
})

test('a manifest-sourced alias or the same host is never a migration target', () => {
  assert.deepEqual(planHostFollowHeals(fixture({
    discoveryEndpoint: { source: 'manifest' }
  })), [])
  assert.deepEqual(planHostFollowHeals(fixture({
    discoveryEndpoint: { host: OLD_HOST }
  })), [])
})

test('the freshest same-fqdn discovery endpoint wins', () => {
  const plans = planHostFollowHeals(fixture({
    extraEndpoints: [{
      host: '192.168.68.77',
      port: PORT + 1,
      source: 'discovery',
      fqdn: FQDN,
      available: true,
      lastSeen: 7_000
    }]
  }))
  assert.equal(plans.length, 1)
  assert.equal(plans[0].host, '192.168.68.77')
  assert.equal(plans[0].oscQueryPort, PORT + 1)
})
