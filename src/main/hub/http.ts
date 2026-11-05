// Minimal client for the Camera Hub HTTP log API (firmware wifi_http.cpp / tools/mock_hub.py).
// Port of HubHttpClient.kt. Runs in the main process (Node fetch).

import { mkdir, rename, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname } from 'node:path'
import {
  HubHttpStatus, NearbyDevice, RemoteLogFile, errorSummary, parseHubHttpStatus, parseNearbyDevicesJson,
  parseRemoteLogList
} from '../../shared/hubProtocol'

export class HubHttpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

const REQUEST_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 30_000

export class HubHttpClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string) {
    return this.baseUrl.replace(/\/+$/, '') + path
  }

  private filePath(stream: string, filename: string) {
    return `/logs/${encodeURIComponent(stream)}/${encodeURIComponent(filename)}`
  }

  private async getText(path: string): Promise<string> {
    const res = await fetch(this.url(path), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const body = await res.text()
    if (!res.ok) throw new HubHttpError(res.status, errorSummary(res.status, body))
    return body
  }

  async status(): Promise<HubHttpStatus> {
    return parseHubHttpStatus(await this.getText('/status'))
  }

  /** Devices the Hub hears right now (`GET /nearby`). */
  async nearby(): Promise<NearbyDevice[]> {
    return parseNearbyDevicesJson(await this.getText('/nearby'))
  }

  async listLogs(): Promise<RemoteLogFile[]> {
    return parseRemoteLogList(await this.getText('/logs'))
  }

  /**
   * Downloads to [dest] via a temp file + rename, so an interrupted transfer never leaves a
   * truncated file looking complete. Returns bytes written.
   */
  async download(
    stream: string,
    filename: string,
    dest: string,
    onProgress: (bytes: number, total: number) => void = () => {}
  ): Promise<number> {
    const abort = new AbortController()
    let idle = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS)
    const tmp = dest + '.part'
    try {
      const res = await fetch(this.url(this.filePath(stream, filename)), { signal: abort.signal })
      if (!res.ok || !res.body) {
        await res.body?.cancel()
        throw new HubHttpError(res.status, `HTTP ${res.status} downloading ${stream}/${filename}`)
      }
      const lenHeader = res.headers.get('content-length')
      const total = lenHeader != null ? Number(lenHeader) : -1
      await mkdir(dirname(dest), { recursive: true })
      const out = createWriteStream(tmp)
      let written = 0
      try {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          clearTimeout(idle)
          idle = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS)
          if (!out.write(value)) await new Promise((r) => out.once('drain', r))
          written += value.byteLength
          onProgress(written, total)
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
      }
      if (total >= 0 && written !== total) throw new Error(`Short download: ${written} of ${total} bytes`)
      await rm(dest, { force: true })
      await rename(tmp, dest)
      return written
    } finally {
      clearTimeout(idle)
      await rm(tmp, { force: true })
    }
  }

  /** Returns normally on 204/200; throws HubHttpError (409 = file is still open on the Hub). */
  async delete(stream: string, filename: string): Promise<void> {
    const res = await fetch(this.url(this.filePath(stream, filename)), {
      method: 'DELETE',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    await res.body?.cancel()
    if (res.status !== 204 && res.status !== 200) {
      throw new HubHttpError(res.status, `HTTP ${res.status} deleting ${stream}/${filename}`)
    }
  }
}
