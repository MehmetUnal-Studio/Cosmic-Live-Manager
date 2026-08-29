import assert from 'node:assert/strict'
import test from 'node:test'

import {
  planScopedStorageMigration,
  scopedStorageMigrationKeys,
  STORAGE_MIGRATION_KINDS
} from '../src/utils/storageMigration.js'

const prefix = 'clm:hub-presets:'
const canonicalId = 'cosmicunity:uuid:current'

function applyWrites(values, writes) {
  for (const { key, value } of writes) values.set(key, value)
}

test('legacy canonical aliases are considered newest-first before numeric manifest identities', () => {
  const { canonicalKey, sources } = scopedStorageMigrationKeys({
    prefix,
    canonicalId,
    manifestId: 7,
    legacyCanonicalIds: [
      'cosmicunity:uuid:oldest',
      'cosmicunity:uuid:newest'
    ],
    legacyIds: [8, 3, 7]
  })

  assert.equal(canonicalKey, `${prefix}${canonicalId}`)
  assert.deepEqual(sources.map(({ identity }) => identity), [
    'cosmicunity:uuid:newest',
    'cosmicunity:uuid:oldest',
    '7',
    '8',
    '3'
  ])
})

test('an initial empty canonical preset imports active legacy once, then a user deletion stays authoritative', () => {
  const keys = scopedStorageMigrationKeys({
    prefix,
    canonicalId,
    manifestId: 7,
    legacyCanonicalIds: ['cosmicunity:uuid:old']
  })
  const legacyKey = keys.sources[0].key
  const values = new Map([
    [keys.canonicalKey, '[]'],
    [legacyKey, JSON.stringify([{ id: 'deleted-preset', path: '/x', value: 1 }])]
  ])

  const plan = planScopedStorageMigration({
    prefix,
    canonicalId,
    manifestId: 7,
    legacyCanonicalIds: ['cosmicunity:uuid:old'],
    kind: STORAGE_MIGRATION_KINDS.PRESETS,
    values
  })

  assert.equal(plan.status, 'migrated')
  assert.deepEqual(JSON.parse(plan.value), [
    { id: 'deleted-preset', path: '/x', value: 1 }
  ])
  assert.ok(plan.writes.some(({ key }) => key === keys.canonicalKey))
  assert.ok(plan.writes.some(({ key }) => key === keys.sources[0].markerKey))
  assert.ok(plan.writes.some(({ key }) => key === keys.lineageKey))

  applyWrites(values, plan.writes)
  values.set(keys.canonicalKey, '[]')
  const retry = planScopedStorageMigration({
    prefix,
    canonicalId,
    manifestId: 7,
    legacyCanonicalIds: ['cosmicunity:uuid:old'],
    kind: STORAGE_MIGRATION_KINDS.PRESETS,
    values
  })
  assert.equal(retry.status, 'canonical')
  assert.equal(retry.value, '[]')
  assert.deepEqual(retry.writes, [])
  assert.ok(values.has(legacyKey), 'legacy data must not be deleted')
})

test('preset arrays merge once into an absent canonical key and cannot resurrect afterward', () => {
  const options = {
    prefix,
    canonicalId,
    manifestId: 7,
    legacyCanonicalIds: [
      'cosmicunity:uuid:oldest',
      'cosmicunity:uuid:newest'
    ],
    legacyIds: [8],
    kind: STORAGE_MIGRATION_KINDS.PRESETS
  }
  const keys = scopedStorageMigrationKeys(options)
  const shared = { id: 'shared', name: 'Shared', path: '/x', value: 1 }
  const newestOnly = { id: 'newest', name: 'Newest', path: '/y', value: 2 }
  const oldestOnly = { id: 'oldest', name: 'Oldest', path: '/z', value: 3 }
  const numericOnly = { id: 'numeric', name: 'Numeric', path: '/w', value: 4 }
  const values = new Map([
    [keys.canonicalKey, null],
    [keys.sources[0].key, JSON.stringify([newestOnly, shared])],
    [keys.sources[1].key, JSON.stringify([oldestOnly, shared])],
    [keys.sources[2].key, null],
    [keys.sources[3].key, JSON.stringify([numericOnly])]
  ])

  const plan = planScopedStorageMigration({ ...options, values })
  assert.equal(plan.status, 'migrated')
  assert.deepEqual(JSON.parse(plan.value), [newestOnly, shared, oldestOnly, numericOnly])
  assert.deepEqual(plan.sourceKeys, [
    keys.sources[0].key,
    keys.sources[1].key,
    keys.sources[3].key
  ])

  applyWrites(values, plan.writes)
  assert.deepEqual(
    keys.sources.filter(({ key }) => values.get(key) != null).map(({ key }) => key),
    plan.sourceKeys,
    'migration must leave every legacy value in place'
  )

  values.delete(keys.canonicalKey)
  const retry = planScopedStorageMigration({ ...options, values })
  assert.equal(retry.status, 'consumed')
  assert.deepEqual(retry.writes, [])
})

test('a consolidated preset lineage cannot resurrect A after C is cleared and identity rotates to D', () => {
  const preset = { id: 'p', name: 'P', path: '/finger0/x', value: 0.75 }
  const identityA = 'cosmicunity:uuid:a'
  const identityC = 'cosmicunity:uuid:c'
  const identityD = 'cosmicunity:uuid:d'
  const values = new Map([[`${prefix}${identityA}`, JSON.stringify([preset])]])

  const cOptions = {
    prefix,
    canonicalId: identityC,
    manifestId: 7,
    legacyCanonicalIds: [identityA],
    kind: STORAGE_MIGRATION_KINDS.PRESETS
  }
  const cKeys = scopedStorageMigrationKeys(cOptions)
  const intoC = planScopedStorageMigration({ ...cOptions, values })
  assert.deepEqual(JSON.parse(intoC.value), [preset])
  applyWrites(values, intoC.writes)

  // The operator deletes P from C after the first migration.
  values.set(cKeys.canonicalKey, '[]')

  const dOptions = {
    prefix,
    canonicalId: identityD,
    manifestId: 7,
    // Registry history is oldest -> newest; C is the latest consolidated key.
    legacyCanonicalIds: [identityA, identityC],
    kind: STORAGE_MIGRATION_KINDS.PRESETS
  }
  const dKeys = scopedStorageMigrationKeys(dOptions)
  const intoD = planScopedStorageMigration({ ...dOptions, values })

  assert.equal(intoD.status, 'migrated')
  assert.deepEqual(JSON.parse(intoD.value), [])
  assert.deepEqual(intoD.sourceKeys, [dKeys.sources[0].key])
  assert.equal(dKeys.sources[0].identity, identityC)
  assert.equal(dKeys.sources[1].identity, identityA)

  applyWrites(values, intoD.writes)
  const remountD = planScopedStorageMigration({ ...dOptions, values })
  assert.equal(remountD.status, 'canonical')
  assert.equal(remountD.value, '[]')
  assert.deepEqual(remountD.writes, [])
})

test('scalar announce migration copies only the newest available canonical alias', () => {
  const announcePrefix = 'clm:hub-announce:'
  const options = {
    prefix: announcePrefix,
    canonicalId,
    manifestId: 7,
    legacyCanonicalIds: [
      'cosmicunity:uuid:oldest',
      'cosmicunity:uuid:newest'
    ],
    legacyIds: [8],
    kind: STORAGE_MIGRATION_KINDS.SCALAR
  }
  const keys = scopedStorageMigrationKeys(options)
  const newest = JSON.stringify({ targetFqdn: 'android-new.local', peerId: 'android_new' })
  const oldest = JSON.stringify({ targetFqdn: 'android-old.local', peerId: 'android_old' })
  const numeric = JSON.stringify({ targetFqdn: 'android-numeric.local', peerId: 'android_numeric' })
  const values = new Map([
    [keys.canonicalKey, null],
    [keys.sources[0].key, newest],
    [keys.sources[1].key, oldest],
    [keys.sources[2].key, null],
    [keys.sources[3].key, numeric]
  ])

  const plan = planScopedStorageMigration({ ...options, values })
  assert.equal(plan.status, 'migrated')
  assert.equal(plan.value, newest)
  assert.deepEqual(plan.sourceKeys, [keys.sources[0].key])
  assert.equal(plan.writes[0].key, keys.canonicalKey)
  assert.equal(plan.writes[0].value, newest)
})

test('an empty canonical announce imports an active legacy choice once, while a non-empty canonical stays authoritative', () => {
  const announcePrefix = 'clm:hub-announce:'
  const legacyCanonicalId = 'cosmicunity:uuid:legacy'
  const options = {
    prefix: announcePrefix,
    canonicalId,
    manifestId: 7,
    legacyCanonicalIds: [legacyCanonicalId],
    kind: STORAGE_MIGRATION_KINDS.SCALAR
  }
  const keys = scopedStorageMigrationKeys(options)
  const empty = JSON.stringify({ targetFqdn: '', peerId: '' })
  const activeLegacy = JSON.stringify({
    targetFqdn: 'android-live.local',
    peerId: 'android_live'
  })
  const values = new Map([
    [keys.canonicalKey, empty],
    [keys.sources[0].key, activeLegacy],
    // Compatibility with the first marker implementation: it could mark a
    // source consumed without ever consolidating it into the canonical value.
    [keys.sources[0].markerKey, '1']
  ])

  const firstDedupe = planScopedStorageMigration({ ...options, values })
  assert.equal(firstDedupe.status, 'migrated')
  assert.equal(firstDedupe.value, activeLegacy)
  applyWrites(values, firstDedupe.writes)

  values.set(keys.canonicalKey, empty)
  const afterOperatorClear = planScopedStorageMigration({ ...options, values })
  assert.equal(afterOperatorClear.status, 'canonical')
  assert.equal(afterOperatorClear.value, empty)
  assert.deepEqual(afterOperatorClear.writes, [])

  const independentCanonicalId = 'cosmicunity:uuid:operator-owned'
  const authoritativeOptions = { ...options, canonicalId: independentCanonicalId }
  const authoritativeKeys = scopedStorageMigrationKeys(authoritativeOptions)
  const operatorChoice = JSON.stringify({
    targetFqdn: 'android-operator.local',
    peerId: 'operator_choice'
  })
  const authoritativeValues = new Map([
    [authoritativeKeys.canonicalKey, operatorChoice],
    [authoritativeKeys.sources[0].key, activeLegacy]
  ])
  const authoritative = planScopedStorageMigration({
    ...authoritativeOptions,
    values: authoritativeValues
  })
  assert.equal(authoritative.status, 'canonical')
  assert.equal(authoritative.value, operatorChoice)
  assert.equal(
    authoritative.writes.some(({ key }) => key === authoritativeKeys.canonicalKey),
    false
  )
})
