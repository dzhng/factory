import { cp, writeFile } from 'node:fs/promises'

// Portable fixture trees, like every test-created .factory tree, are written in Docker.
await cp('/fixture', '/prepared', { recursive: true })
await writeFile('/prepared/bundle.json', await Bun.stdin.bytes())
