// GATT connect/read/write. Equivalent of BleGattManager.kt on top of noble: one connection at a
// time, operations serialised (like the Kotlin opMutex), notifications delivered to waiters.

import type { Characteristic, Peripheral } from '@stoprocent/noble'
import { GattUuids } from '../../shared/gattUuids'
import { GattState, GattStatus } from '../../shared/types'

const CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_OP_TIMEOUT_MS = 10_000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

export class GattManager {
  private status: GattStatus = { state: 'IDLE', errorMessage: null }
  private peripheral: Peripheral | null = null
  private address: string | null = null
  private chars = new Map<string, Characteristic>()
  private subscribed = new Set<string>()
  private notifyWaiters = new Map<string, ((b: Uint8Array) => void)[]>()
  private queue: Promise<unknown> = Promise.resolve()
  private expectingDisconnect = false

  constructor(
    private readonly findPeripheral: (address: string) => Peripheral | undefined,
    private readonly onStatus: (s: GattStatus) => void
  ) {}

  getStatus(): GattStatus {
    return this.status
  }

  private setState(state: GattState, errorMessage: string | null = null) {
    this.status = { state, errorMessage }
    this.onStatus(this.status)
  }

  /** Resolves with the final state (READY or ERROR). */
  async connect(address: string): Promise<GattState> {
    if (this.address === address && this.status.state === 'READY' && this.peripheral?.state === 'connected') return 'READY'
    await this.disconnect()
    const p = this.findPeripheral(address)
    if (!p) {
      this.setState('ERROR', 'Device not in range – wait for it to appear in the scan list')
      return 'ERROR'
    }
    this.peripheral = p
    this.address = address
    this.expectingDisconnect = false
    this.setState('CONNECTING')
    try {
      await withTimeout(p.connectAsync(), CONNECT_TIMEOUT_MS, 'Connection')
      p.once('disconnect', () => this.onDisconnected(p))
      const { characteristics } = await withTimeout(
        p.discoverSomeServicesAndCharacteristicsAsync([GattUuids.SERVICE], []),
        CONNECT_TIMEOUT_MS,
        'Service discovery'
      )
      if (this.peripheral !== p) return this.status.state  // superseded by disconnect/connect
      this.chars = new Map(characteristics.map((c) => [c.uuid.replace(/-/g, '').toLowerCase(), c]))
      if (this.chars.size === 0) {
        this.setState('ERROR', 'Service discovery failed')
        await p.disconnectAsync().catch(() => {})
        return 'ERROR'
      }
      this.setState('READY')
      return 'READY'
    } catch (e) {
      if (this.peripheral === p) {
        this.setState('ERROR', `Connection failed (${e instanceof Error ? e.message : String(e)})`)
        this.peripheral = null
        this.address = null
        p.disconnectAsync().catch(() => {})
      }
      return 'ERROR'
    }
  }

  private onDisconnected(p: Peripheral) {
    if (this.peripheral !== p) return
    this.peripheral = null
    this.address = null
    this.chars.clear()
    this.subscribed.clear()
    this.notifyWaiters.clear()
    if (this.expectingDisconnect) this.setState('IDLE')
    else this.setState('ERROR', 'Disconnected')
  }

  async disconnect(): Promise<void> {
    const p = this.peripheral
    if (!p) {
      if (this.status.state !== 'IDLE') this.setState('IDLE')
      return
    }
    this.expectingDisconnect = true
    try {
      await withTimeout(p.disconnectAsync(), 5_000, 'Disconnect')
    } catch {
      /* fall through */
    }
    if (this.peripheral === p) this.onDisconnected(p)
  }

  /** True once services are discovered and the device exposes uuid (e.g. Hub-only characteristics). */
  hasCharacteristic(uuid: string): boolean {
    return this.status.state === 'READY' && this.chars.has(uuid)
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  async read(uuid: string, timeoutMs = DEFAULT_OP_TIMEOUT_MS): Promise<Uint8Array | null> {
    return this.run(async () => {
      const c = this.chars.get(uuid)
      if (!c || this.status.state !== 'READY') return null
      try {
        return new Uint8Array(await withTimeout(c.readAsync(), timeoutMs, 'Read'))
      } catch (e) {
        console.warn(`read ${uuid} failed`, e)
        return null
      }
    })
  }

  async write(uuid: string, value: Uint8Array, timeoutMs = DEFAULT_OP_TIMEOUT_MS): Promise<boolean> {
    return this.run(async () => {
      const c = this.chars.get(uuid)
      if (!c || this.status.state !== 'READY') return false
      try {
        await withTimeout(c.writeAsync(Buffer.from(value), false), timeoutMs, 'Write')
        return true
      } catch (e) {
        console.warn(`write ${uuid} failed`, e)
        return false
      }
    })
  }

  async enableNotification(uuid: string): Promise<boolean> {
    return this.run(async () => {
      const c = this.chars.get(uuid)
      if (!c) return false
      if (this.subscribed.has(uuid)) return true
      c.on('data', (data: Buffer) => {
        const waiters = this.notifyWaiters.get(uuid) ?? []
        this.notifyWaiters.delete(uuid)
        waiters.forEach((w) => w(new Uint8Array(data)))
      })
      try {
        await withTimeout(c.subscribeAsync(), DEFAULT_OP_TIMEOUT_MS, 'Subscribe')
        this.subscribed.add(uuid)
        return true
      } catch (e) {
        console.warn(`subscribe ${uuid} failed`, e)
        return false
      }
    })
  }

  /** Next notification on uuid, or null after timeoutMs. Register before the write that triggers it. */
  waitForNotification(uuid: string, timeoutMs = 3_000): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const done = (v: Uint8Array | null) => {
        clearTimeout(t)
        const list = this.notifyWaiters.get(uuid)
        if (list) this.notifyWaiters.set(uuid, list.filter((w) => w !== waiter))
        resolve(v)
      }
      const waiter = (b: Uint8Array) => done(b)
      const t = setTimeout(() => done(null), timeoutMs)
      this.notifyWaiters.set(uuid, [...(this.notifyWaiters.get(uuid) ?? []), waiter])
    })
  }
}
