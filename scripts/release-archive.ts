type ArchiveEntry = { name: string; bytes: Uint8Array; mode: 0o644 | 0o755 }

const blockBytes = 512
const encoder = new TextEncoder()

function field(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value)
  if (bytes.byteLength > length) throw new TypeError('tar field exceeds its bound')
  header.set(bytes, offset)
}

function octal(value: number, length: number): string {
  const encoded = value.toString(8)
  if (encoded.length > length - 1) throw new TypeError('tar number exceeds its bound')
  return `${encoded.padStart(length - 1, '0')}\0`
}

function header(entry: ArchiveEntry): Uint8Array {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(entry.name)) throw new TypeError('unsafe archive entry name')
  const value = new Uint8Array(blockBytes)
  field(value, 0, 100, entry.name)
  field(value, 100, 8, octal(entry.mode, 8))
  field(value, 108, 8, octal(0, 8))
  field(value, 116, 8, octal(0, 8))
  field(value, 124, 12, octal(entry.bytes.byteLength, 12))
  field(value, 136, 12, octal(0, 12))
  value.fill(0x20, 148, 156)
  value[156] = 0x30
  field(value, 257, 6, 'ustar\0')
  field(value, 263, 2, '00')
  const checksum = value.reduce((sum, byte) => sum + byte, 0)
  field(value, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return value
}

/** Creates one path-safe deterministic gzip-compressed ustar archive. */
export function createReleaseArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  const names = new Set<string>()
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    if (names.has(entry.name)) throw new TypeError('duplicate archive entry')
    names.add(entry.name)
    chunks.push(header(entry), entry.bytes)
    const padding = (blockBytes - (entry.bytes.byteLength % blockBytes)) % blockBytes
    if (padding > 0) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(blockBytes * 2))
  return Bun.gzipSync(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), { level: 9 })
}
