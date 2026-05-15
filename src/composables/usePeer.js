// Peer announce utility.
//
// Normalises a free-form name (typed by the user) into something safe for an
// OSC path segment: lowercase, non-alphanumerics → underscore, collapsed
// runs, trimmed. Used by DeviceCard's Announce section before sending the
// peer_id to the target.

export function sanitizePeerId(name) {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  return cleaned || 'peer'
}
