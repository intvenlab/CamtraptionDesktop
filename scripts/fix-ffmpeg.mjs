// Replaces Electron's ffmpeg.dll with the free-codecs build from the same Electron release.
//
// Microsoft Defender flags the stock ffmpeg.dll in Electron 45.2.3 as Trojan:Win32/Posilod.EB!cl (a cloud
// heuristic false positive) and quarantines it, after which every Electron window crashes. The app plays
// no media, so the free-codecs build (ffmpeg-v<version>-win32-x64.zip, published with every Electron
// release) loses nothing. The zip is checked against the release's SHASUMS256.txt before use.
//
// Usage: node scripts/fix-ffmpeg.mjs [targetDir]   (default node_modules/electron/dist)
// Runs from postinstall and before electron-builder; does nothing off Windows or when already swapped.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(process.argv[2] ?? join(root, 'node_modules', 'electron', 'dist'))

if (process.platform !== 'win32') process.exit(0)

const version = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const zipName = `ffmpeg-v${version}-win32-x64.zip`
const base = `https://github.com/electron/electron/releases/download/v${version}`
const cacheDir = join(root, 'node_modules', '.cache', 'electron-ffmpeg')
const zipPath = join(cacheDir, zipName)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Extracts one file from a zip (stored or deflated), enough for Electron's release zips. */
function unzipEntry(zip, wanted) {
  let eocd = zip.length - 22
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip file')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory')
    const method = zip.readUInt16LE(p + 10)
    const compSize = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === wanted) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + compSize)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return inflateRawSync(data)
      throw new Error(`unsupported zip method ${method}`)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`${wanted} not found in zip`)
}

async function main() {
  if (!existsSync(target)) {
    console.log(`[fix-ffmpeg] ${target} not found (Electron binary not installed yet), skipping`)
    return
  }
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8')
  const expected = sums.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, f]) => f === zipName)?.[0]
  if (!expected) throw new Error(`${zipName} missing from SHASUMS256.txt`)

  let zip = existsSync(zipPath) ? readFileSync(zipPath) : null
  if (!zip || sha256(zip) !== expected) {
    zip = await download(`${base}/${zipName}`)
    if (sha256(zip) !== expected) throw new Error(`${zipName} checksum mismatch`)
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(zipPath, zip)
  }

  const dll = unzipEntry(zip, 'ffmpeg.dll')
  const dest = join(target, 'ffmpeg.dll')
  if (existsSync(dest) && sha256(readFileSync(dest)) === sha256(dll)) {
    console.log(`[fix-ffmpeg] ${dest} is already the free-codecs build`)
    return
  }
  writeFileSync(dest, dll)
  console.log(`[fix-ffmpeg] installed free-codecs ffmpeg.dll (Electron ${version}) into ${target}`)
}

main().catch((e) => {
  console.error(`[fix-ffmpeg] ${e.message}`)
  process.exit(1)
})
