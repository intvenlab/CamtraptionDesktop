// Persistence: plain JSON files under app.getPath('userData'), same file names and JSON shapes as
// the Android stores (KnownDeviceStore.kt, DeviceHistoryStore.kt, GroupNameStore.kt,
// CameraLogCatalogStore.kt) so data can be compared or copied between the two apps.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BleDevice, CachedHubLog, DeviceHistoryEntry, TelemetrySample, chemistryOf, deviceTypeOf, makeDevice
} from '../shared/types'

type Json = Record<string, any>

function readArray(file: string): Json[] {
  if (!existsSync(file)) return []
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

const safeAddr = (address: string) => address.replace(/:/g, '_')

// ─── Known devices ─────────────────────────────────────────────────────────

/**
 * Every configured device ever seen, so Kits still show (as disconnected) after leaving BLE range
 * or restarting. Android writes on every advertisement; here upserts are kept in memory and
 * flushed at most every 2 s.
 */
export class KnownDeviceStore {
  private readonly file: string
  private rows: Json[]
  private flushTimer: NodeJS.Timeout | null = null

  constructor(dir: string) {
    this.file = join(dir, 'known_devices.json')
    this.rows = readArray(this.file)
  }

  /** All persisted devices with isConnected = false. */
  loadAll(): BleDevice[] {
    return this.rows.flatMap((o) => {
      try {
        return [makeDevice({
          address: String(o.addr),
          name: o.name ?? null,
          batteryPercent: o.pct,
          voltageMillivolts: o.mv,
          rssi: o.rssi,
          lastSeen: o.lastSeen,
          isConfigured: o.configured === true,
          deviceType: deviceTypeOf(o.type),
          batteryChemistry: chemistryOf(o.chem),
          cellCount: o.cells,
          groupId: o.groupId,
          shutterCount: o.shutter,
          extBatteryPercent: o.extPct,
          extVoltageMillivolts: o.extMv,
          firmwareBuild: o.build ?? '',
          isConnected: false
        })]
      } catch {
        return []
      }
    })
  }

  /** Upserts the device by MAC address. */
  save(d: BleDevice) {
    const row = {
      addr: d.address, name: d.name, pct: d.batteryPercent, mv: d.voltageMillivolts, rssi: d.rssi,
      lastSeen: d.lastSeen, configured: d.isConfigured, type: d.deviceType, chem: d.batteryChemistry,
      cells: d.cellCount, groupId: d.groupId, shutter: d.shutterCount, extPct: d.extBatteryPercent,
      extMv: d.extVoltageMillivolts, build: d.firmwareBuild
    }
    const i = this.rows.findIndex((o) => o.addr === d.address)
    if (i >= 0) this.rows[i] = row
    else this.rows.push(row)
    this.scheduleFlush()
  }

  /** Removes all devices belonging to groupId. */
  forgetKit(groupId: number) {
    this.rows = this.rows.filter((o) => o.groupId !== groupId)
    this.flush()
  }

  /** Removes a single device by MAC address. */
  forgetDevice(address: string) {
    this.rows = this.rows.filter((o) => o.addr !== address)
    this.flush()
  }

  private scheduleFlush() {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 2_000)
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    try {
      writeFileSync(this.file, JSON.stringify(this.rows))
    } catch (e) {
      console.warn('known_devices.json write failed', e)
    }
  }
}

// ─── Per-device history ────────────────────────────────────────────────────

export class DeviceHistoryStore {
  static readonly MAX_ENTRIES = 500

  constructor(private readonly dir: string) {}

  fileFor(address: string): string {
    return join(this.dir, `device_history_${safeAddr(address)}.json`)
  }

  /** Newest first. */
  load(address: string): DeviceHistoryEntry[] {
    return readArray(this.fileFor(address)).map((o) => ({
      timestamp: o.ts,
      eventType: o.evt ?? 'Connect',
      shutterCount: o.shutter ?? 0,
      batteryPercent: o.pct,
      voltageMillivolts: o.mv,
      intBatteryPercent: o.ipct ?? -1,
      intVoltageMillivolts: o.imv ?? 0,
      rssi: o.rssi ?? 0,
      cameraState: o.camst ?? 0,
      cameraLiveFlags: o.camlf ?? 0,
      firmwareBuild: o.fw ?? ''
    }))
  }

  append(address: string, e: DeviceHistoryEntry): DeviceHistoryEntry[] {
    const all = [e, ...this.load(address)].slice(0, DeviceHistoryStore.MAX_ENTRIES)
    const rows = all.map((x) => ({
      ts: x.timestamp, evt: x.eventType, shutter: x.shutterCount, pct: x.batteryPercent, mv: x.voltageMillivolts,
      ipct: x.intBatteryPercent, imv: x.intVoltageMillivolts, rssi: x.rssi, camst: x.cameraState,
      camlf: x.cameraLiveFlags, fw: x.firmwareBuild
    }))
    try {
      writeFileSync(this.fileFor(address), JSON.stringify(rows))
    } catch (err) {
      console.warn('history write failed', err)
    }
    return all
  }
}

// ─── Kit names ─────────────────────────────────────────────────────────────

/** Kit ID -> user-assigned name. Stored on this computer only, never written to the devices. */
export class GroupNameStore {
  private readonly file: string

  constructor(dir: string) {
    this.file = join(dir, 'group_names.json')
  }

  loadAll(): Record<number, string> {
    try {
      const o = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      const out: Record<number, string> = {}
      for (const [k, v] of Object.entries(o)) {
        const id = parseInt(k.slice(1), 10)
        if (k.startsWith('g') && !Number.isNaN(id) && typeof v === 'string') out[id] = v
      }
      return out
    } catch {
      return {}
    }
  }

  save(groupId: number, name: string) {
    const all: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.loadAll())) all[`g${k}`] = v
    all[`g${groupId}`] = name
    writeFileSync(this.file, JSON.stringify(all))
  }
}

// ─── Downloaded Camera Hub logs ────────────────────────────────────────────

export class CameraLogCatalogStore {
  private readonly file: string

  constructor(private readonly dir: string) {
    this.file = join(dir, 'camera_log_catalog.json')
  }

  localFileFor(cameraAddress: string, stream: string, filename: string): string {
    return join(this.dir, 'hub_logs', safeAddr(cameraAddress), stream, filename)
  }

  /** Entries for one Camera whose cached file still exists, newest filename first. */
  loadFor(cameraAddress: string): CachedHubLog[] {
    return readArray(this.file)
      .map((o) => ({
        cameraAddress: String(o.addr), stream: String(o.stream), filename: String(o.filename),
        localCachePath: String(o.path), downloadedAt: Number(o.downloadedAt), sizeBytes: Number(o.size)
      }))
      .filter((e) => e.cameraAddress === cameraAddress && existsSync(e.localCachePath))
      .sort((a, b) => (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0))
  }

  private sameKey = (o: Json, e: CachedHubLog) =>
    o.addr === e.cameraAddress && o.stream === e.stream && o.filename === e.filename

  /** Upserts by (cameraAddress, stream, filename). */
  upsert(e: CachedHubLog) {
    const rows = readArray(this.file).filter((o) => !this.sameKey(o, e))
    rows.push({ addr: e.cameraAddress, stream: e.stream, filename: e.filename, path: e.localCachePath, downloadedAt: e.downloadedAt, size: e.sizeBytes })
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file, JSON.stringify(rows))
  }

  /** Removes the catalog row and deletes the cached file. */
  remove(e: CachedHubLog) {
    writeFileSync(this.file, JSON.stringify(readArray(this.file).filter((o) => !this.sameKey(o, e))))
    rmSync(e.localCachePath, { force: true })
  }
}

// ─── Live telemetry (desktop only) ─────────────────────────────────────────

/**
 * Readings from live advertisements, kept for the Graphs tab: one JSONL file per device under
 * telemetry/. A device is sampled at most every 30 s, or at once when its shutter count or a battery
 * percentage changes. Lines are buffered and appended every 5 s; anything older than 30 days is
 * pruned at startup.
 */
export class TelemetryStore {
  static readonly MIN_INTERVAL_MS = 30_000
  static readonly KEEP_MS = 30 * 24 * 3_600_000
  private readonly dir: string
  private readonly last = new Map<string, TelemetrySample>()
  private readonly pending = new Map<string, string[]>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(dir: string) {
    this.dir = join(dir, 'telemetry')
    mkdirSync(this.dir, { recursive: true })
    this.prune()
  }

  private fileFor(address: string) {
    return join(this.dir, `${safeAddr(address)}.jsonl`)
  }

  record(d: BleDevice) {
    if (!d.isConfigured || !d.isConnected) return
    const s: TelemetrySample = {
      t: d.lastSeen, mv: d.voltageMillivolts, pct: d.batteryPercent, extMv: d.extVoltageMillivolts,
      extPct: d.extBatteryPercent, rssi: d.rssi, shutter: d.shutterCount
    }
    const prev = this.last.get(d.address)
    if (prev) {
      if (s.t <= prev.t) return
      const changed = s.shutter !== prev.shutter || s.pct !== prev.pct || s.extPct !== prev.extPct
      if (!changed && s.t - prev.t < TelemetryStore.MIN_INTERVAL_MS) return
    }
    this.last.set(d.address, s)
    const lines = this.pending.get(d.address) ?? []
    lines.push(JSON.stringify(s))
    this.pending.set(d.address, lines)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 5_000)
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const [address, lines] of this.pending) {
      try {
        appendFileSync(this.fileFor(address), lines.join('\n') + '\n')
      } catch (e) {
        console.warn('telemetry write failed', e)
      }
    }
    this.pending.clear()
  }

  load(addresses: string[], fromMs: number, toMs: number): Record<string, TelemetrySample[]> {
    this.flush()
    const out: Record<string, TelemetrySample[]> = {}
    for (const address of addresses) {
      const rows = this.readFile(this.fileFor(address)).filter((s) => s.t >= fromMs && s.t <= toMs)
      if (rows.length > 0) out[address] = rows
    }
    return out
  }

  private readFile(file: string): TelemetrySample[] {
    if (!existsSync(file)) return []
    const out: TelemetrySample[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const o = JSON.parse(line)
        if (typeof o?.t === 'number') out.push(o as TelemetrySample)
      } catch {
        /* skip a torn line */
      }
    }
    return out
  }

  private prune() {
    const cutoff = Date.now() - TelemetryStore.KEEP_MS
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(this.dir, name)
      const rows = this.readFile(file)
      const kept = rows.filter((s) => s.t >= cutoff)
      if (kept.length === rows.length) continue
      if (kept.length === 0) rmSync(file, { force: true })
      else writeFileSync(file, kept.map((s) => JSON.stringify(s)).join('\n') + '\n')
    }
  }
}
