export const STORAGE_MIGRATION_KINDS = Object.freeze({
  PRESETS: 'presets',
  SCALAR: 'scalar'
})

const MARKER_VERSION = 'v1'

function identityToken(value) {
  if (value == null) return ''
  return String(value).trim()
}

function unique(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const token = identityToken(value)
    if (!token || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

function readStoredValue(values, key) {
  if (values instanceof Map) return values.has(key) ? values.get(key) : null
  if (values && Object.prototype.hasOwnProperty.call(values, key)) return values[key]
  return null
}

function parsePresetArray(raw) {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isValidScalar(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function isMeaningfulScalar(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    return [parsed.targetFqdn, parsed.peerId].some(
      (value) => typeof value === 'string' && value.trim().length > 0
    )
  } catch {
    return false
  }
}

function presetSignature(value) {
  return JSON.stringify([value?.id, value?.name, value?.path, value?.value])
}

export function storageMigrationMarkerKey(canonicalKey, legacyKey) {
  return `${canonicalKey}:legacy-consumed:${MARKER_VERSION}:${encodeURIComponent(legacyKey)}`
}

export function storageMigrationLineageKey(canonicalKey) {
  return `${canonicalKey}:legacy-consolidated:${MARKER_VERSION}`
}

/**
 * Build deterministic storage keys without reading or mutating storage.
 * Registry aliases are recorded oldest-to-newest, so reverse them here: the
 * last canonical identity is the authoritative fallback for scalar settings.
 */
export function scopedStorageMigrationKeys({
  prefix,
  canonicalId,
  manifestId,
  legacyCanonicalIds = [],
  legacyIds = []
}) {
  const canonicalIdentity = identityToken(canonicalId)
  if (!prefix || !canonicalIdentity) {
    return { canonicalKey: '', lineageKey: '', sources: [] }
  }

  const canonicalAliases = new Set(unique(Array.from(legacyCanonicalIds)))
  const identities = unique([
    ...Array.from(legacyCanonicalIds).reverse(),
    manifestId,
    ...legacyIds
  ]).filter((identity) => identity !== canonicalIdentity)
  const canonicalKey = `${prefix}${canonicalIdentity}`

  return {
    canonicalKey,
    lineageKey: storageMigrationLineageKey(canonicalKey),
    sources: identities.map((identity) => {
      const key = `${prefix}${identity}`
      return {
        identity,
        key,
        markerKey: storageMigrationMarkerKey(canonicalKey, key),
        lineageKey: storageMigrationLineageKey(key),
        isCanonicalAlias: canonicalAliases.has(identity)
      }
    })
  }
}

/**
 * Pure migration planner. `values` is a Map/object snapshot of localStorage;
 * callers apply the returned writes in order. Legacy values are never deleted.
 */
export function planScopedStorageMigration({
  prefix,
  canonicalId,
  manifestId,
  legacyCanonicalIds = [],
  legacyIds = [],
  kind = STORAGE_MIGRATION_KINDS.SCALAR,
  values = new Map()
}) {
  const { canonicalKey, lineageKey, sources } = scopedStorageMigrationKeys({
    prefix,
    canonicalId,
    manifestId,
    legacyCanonicalIds,
    legacyIds
  })
  if (!canonicalKey) {
    return { canonicalKey, value: null, sourceKeys: [], writes: [], status: 'unscoped' }
  }

  const canonicalValue = readStoredValue(values, canonicalKey)
  const canonicalIsConsolidated = readStoredValue(values, lineageKey) != null
  const existingSources = sources.filter(({ key }) => readStoredValue(values, key) != null)
  // A consumed marker without the v1 lineage marker can have been written by
  // the earlier migration implementation that incorrectly skipped an active
  // legacy value when an empty canonical key existed. Until consolidation is
  // proven, re-evaluate all sources once; the lineage marker makes subsequent
  // mounts and deletions authoritative.
  const unconsumedSources = canonicalIsConsolidated
    ? existingSources.filter(({ markerKey }) => readStoredValue(values, markerKey) == null)
    : existingSources
  const consumeWrites = unconsumedSources.map(
    ({ markerKey }) => ({ key: markerKey, value: '1' })
  )
  const lineageWrite = canonicalIsConsolidated || existingSources.length === 0
    ? []
    : [{ key: lineageKey, value: '1' }]

  // Once this canonical key has consolidated its predecessors, its current
  // value (including a deliberate empty/delete state) owns the lineage. If the
  // value itself was removed, do not reconstruct it from older aliases.
  if (canonicalIsConsolidated) {
    return {
      canonicalKey,
      value: canonicalValue,
      sourceKeys: [],
      writes: consumeWrites,
      status: canonicalValue == null ? 'consumed' : 'canonical'
    }
  }

  const consolidatedSource = existingSources.find(
    ({ isCanonicalAlias, lineageKey: sourceLineageKey }) =>
      isCanonicalAlias && readStoredValue(values, sourceLineageKey) != null
  )

  if (canonicalValue != null && existingSources.length === 0) {
    return {
      canonicalKey,
      value: canonicalValue,
      sourceKeys: [],
      writes: [],
      status: 'canonical'
    }
  }

  // A non-empty announce choice is an operator decision and therefore wins
  // immediately. Empty/default announce state is allowed to import a live
  // legacy choice once, before this canonical lineage is marked consolidated.
  if (
    kind === STORAGE_MIGRATION_KINDS.SCALAR &&
    canonicalValue != null &&
    isMeaningfulScalar(canonicalValue)
  ) {
    return {
      canonicalKey,
      value: canonicalValue,
      sourceKeys: [],
      writes: [...consumeWrites, ...lineageWrite],
      status: 'canonical'
    }
  }

  let candidateSources = unconsumedSources
  if (consolidatedSource) {
    // A previous canonical alias already represents the entire older lineage.
    // Taking only that source prevents A's deleted presets from reappearing in
    // A -> C(delete) -> D rotations.
    candidateSources = unconsumedSources.includes(consolidatedSource)
      ? [consolidatedSource]
      : []
  }

  let eligibleSources = candidateSources.filter(({ key }) => {
    const raw = readStoredValue(values, key)
    return kind === STORAGE_MIGRATION_KINDS.PRESETS
      ? parsePresetArray(raw) != null
      : isValidScalar(raw)
  })

  if (kind === STORAGE_MIGRATION_KINDS.SCALAR && !consolidatedSource) {
    const meaningfulSource = eligibleSources.find(
      ({ key }) => isMeaningfulScalar(readStoredValue(values, key))
    )
    eligibleSources = meaningfulSource
      ? [meaningfulSource]
      : eligibleSources.slice(0, 1)
  }

  let migratedValue
  if (kind === STORAGE_MIGRATION_KINDS.PRESETS) {
    const merged = []
    const seen = new Set()
    const canonicalPresets = canonicalValue == null ? null : parsePresetArray(canonicalValue)
    const presetSources = [
      ...(canonicalPresets == null ? [] : [canonicalPresets]),
      ...eligibleSources.map(({ key }) => parsePresetArray(readStoredValue(values, key)))
    ]
    if (presetSources.length === 0) {
      return { canonicalKey, value: null, sourceKeys: [], writes: [], status: 'empty' }
    }
    for (const presets of presetSources) {
      for (const preset of presets) {
        const signature = presetSignature(preset)
        if (seen.has(signature)) continue
        seen.add(signature)
        merged.push(preset)
      }
    }
    migratedValue = JSON.stringify(merged)
  } else if (eligibleSources.length > 0) {
    // Sources are already ordered with the newest canonical alias first.
    migratedValue = readStoredValue(values, eligibleSources[0].key)
  } else if (canonicalValue != null) {
    migratedValue = canonicalValue
  } else {
    return { canonicalKey, value: null, sourceKeys: [], writes: [], status: 'empty' }
  }

  return {
    canonicalKey,
    value: migratedValue,
    sourceKeys: eligibleSources.map(({ key }) => key),
    // Canonical must be written before markers. If storage quota throws, a
    // failed canonical write therefore cannot consume the only legacy copy.
    writes: [
      { key: canonicalKey, value: migratedValue },
      ...consumeWrites,
      ...lineageWrite
    ],
    status: 'migrated'
  }
}
