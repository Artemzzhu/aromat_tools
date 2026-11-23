function normalizeMarkingScan(scan) {
  if (typeof scan !== 'string' || scan.length > 512) return null
  const payload = scan.replace(/^(?:\]d2|\[(?:FNC1|GS)\]|\{(?:FNC1|GS)\}|\x1d)+/i, '')
    .replace(/\[(?:FNC1|GS)\]|\{(?:FNC1|GS)\}/gi, '\x1d')

  // Compact 93 format: fixed 13-character serial and four verification characters.
  const compact = /^(01\d{14}21[!-~]{13})(93[!-~]{4})$/.exec(payload)
  if (compact) return compact[1] + '\x1d' + compact[2]

  const [serial, key, signature, extra] = payload.split('\x1d')
  if (!/^01\d{14}21[!-~]{1,20}$/.test(serial) || extra !== undefined) return null
  if (/^93[!-~]+$/.test(key ?? '') && signature === undefined) return payload
  if (/^91[!-~]{4}$/.test(key ?? '') && /^92[!-~]+$/.test(signature ?? '')) return payload
  return null
}

if (typeof module !== 'undefined') module.exports = { normalizeMarkingScan }
