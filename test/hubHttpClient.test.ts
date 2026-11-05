// Port of HubHttpClientTest.kt: the client against an in-process server implementing the same
// API as the firmware (wifi_http.cpp) and firmware/tools/mock_hub.py.
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubHttpClient, HubHttpError } from '../src/main/hub/http'

const openFile = 'camera/2026-10-01.jsonl'
let files: Map<string, string>
let server: Server
let client: HubHttpClient
let tmp: string

/** Same semantics as firmware wifi_http.cpp / mock_hub.py. Returns [code, body]. */
function handle(method: string, path: string): [number, string] {
  if (path === '/status') {
    return [200, '{"bleMac":"AA:BB:CC:DD:EE:01","name":"Hub","firmwareBuild":"2026-10-01 00:00:00","timeSynced":true}']
  }
  if (path === '/nearby') {
    return [200, '[{"addr":"AA:BB:CC:DD:EE:02","rssi":-58,"type":0,"cfg":1,"chem":0,"kit":1,"cells":3,"intPct":82,"intMv":2960,"extPct":74,"extMv":11650,"shutter":0,"ageSec":1}]']
  }
  if (path === '/logs') {
    const rows = [...files.entries()].map(([k, v]) => {
      const [stream, name] = k.split('/')
      return `{"stream":"${stream}","filename":"${name}","sizeBytes":${v.length},"rotatedAt":null,"isCurrentlyOpen":${k === openFile}}`
    })
    return [200, `[${rows.join(',')}]`]
  }
  const key = decodeURIComponent(path.replace(/^\/logs\//, ''))
  const content = files.get(key)
  if (content == null) return [404, '']
  if (method === 'DELETE' && key === openFile) return [409, '']
  if (method === 'DELETE') { files.delete(key); return [204, ''] }
  return [200, content]
}

beforeEach(async () => {
  files = new Map([
    ['camera/2026-09-30.jsonl', '{"t":1,"ev":"BOOT"}\n{"t":2,"ev":"HP_WAKE"}\n'],
    ['camera/2026-10-01.jsonl', '{"t":3,"ev":"BATTERY"}\n']
  ])
  tmp = mkdtempSync(join(tmpdir(), 'hubhttp-'))
  server = createServer((req, res) => {
    const [code, body] = handle(req.method ?? 'GET', req.url ?? '/')
    if (code === 204) res.writeHead(204).end()
    else res.writeHead(code, { 'Content-Length': Buffer.byteLength(body) }).end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  client = new HubHttpClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

describe('HubHttpClient', () => {
  it('status and list', async () => {
    const status = await client.status()
    expect(status.bleMac.toUpperCase()).toBe('AA:BB:CC:DD:EE:01')
    const list = await client.listLogs()
    expect(list).toHaveLength(2)
    expect(list.find((f) => f.filename === '2026-10-01.jsonl')!.isCurrentlyOpen).toBe(true)
  })

  it('nearby devices', async () => {
    const list = await client.nearby()
    expect(list).toHaveLength(1)
    expect(list[0].address).toBe('AA:BB:CC:DD:EE:02')
    expect(list[0].extBatteryPercent).toBe(74)
  })

  it('download writes the complete file and reports progress', async () => {
    const dest = join(tmp, 'hub_logs', 'AA_BB', 'camera', '2026-09-30.jsonl')
    let lastProgress = 0
    const n = await client.download('camera', '2026-09-30.jsonl', dest, (done) => { lastProgress = done })
    const expected = files.get('camera/2026-09-30.jsonl')!
    expect(n).toBe(expected.length)
    expect(lastProgress).toBe(n)
    expect(readFileSync(dest, 'utf8')).toBe(expected)
    expect(existsSync(dest + '.part')).toBe(false)
  })

  it('download of a missing file throws 404 and leaves no file', async () => {
    const dest = join(tmp, 'missing.jsonl')
    await expect(client.download('camera', '1999-01-01.jsonl', dest)).rejects.toMatchObject({ code: 404 })
    expect(existsSync(dest)).toBe(false)
  })

  it('delete of a closed file succeeds and the open file is refused', async () => {
    await client.delete('camera', '2026-09-30.jsonl')
    expect(await client.listLogs()).toHaveLength(1)
    const err = await client.delete('camera', '2026-10-01.jsonl').catch((e) => e)
    expect(err).toBeInstanceOf(HubHttpError)
    expect(err.code).toBe(409)
  })
})
