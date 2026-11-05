// ESP32 Camera Hub wire formats. Port of HubProtocol.kt; must match
// firmware/camera_hub/src/hub_protocol.h (GATT, little-endian packed structs) and wifi_http.cpp (HTTP JSON).

import { BatteryChemistry, DeviceType, chemistryOf, deviceTypeOf } from './types'

export type HubApState = 'OFF' | 'STARTING' | 'UP' | 'ERROR'
export type HubSdState = 'NONE' | 'MOUNTED' | 'ERROR' | 'FULL'

const AP_STATES: HubApState[] = ['OFF', 'STARTING', 'UP', 'ERROR']
const SD_STATES: HubSdState[] = ['NONE', 'MOUNTED', 'ERROR', 'FULL']

export const HUB_STREAM_CAMERA = 'camera'
export const HUB_STREAM_SCAN = 'scan'

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const utf8 = (b: Uint8Array, start: number, len: number) => new TextDecoder().decode(b.subarray(start, start + len))

/** CAMERA_LOG_STATUS (ca500012), 32 bytes, version 1. */
export interface CameraLogStatus {
  apState: HubApState
  sdState: HubSdState
  timeSynced: boolean
  cameraFileCount: number
  scanFileCount: number
  cameraBytes: number
  scanBytes: number
  sdTotalMB: number
  sdUsedMB: number
  droppedRecords: number
  epochNow: number
}

export function parseCameraLogStatus(b: Uint8Array | null | undefined): CameraLogStatus | null {
  if (!b || b.length < 32 || b[0] !== 1) return null
  return {
    apState: AP_STATES[b[1]] ?? 'ERROR',
    sdState: SD_STATES[b[2]] ?? 'ERROR',
    timeSynced: b[3] !== 0,
    cameraFileCount: u16(b, 4),
    scanFileCount: u16(b, 6),
    cameraBytes: u32(b, 8),
    scanBytes: u32(b, 12),
    sdTotalMB: u32(b, 16),
    sdUsedMB: u32(b, 20),
    droppedRecords: u32(b, 24),
    epochNow: u32(b, 28)
  }
}

/** CAMERA_WIFI_AP_INFO (ca500014), 106 bytes, version 1. */
export interface HubWifiApInfo {
  apState: HubApState
  ip: string
  port: number
  ssid: string
  password: string
}

export function parseHubWifiApInfo(b: Uint8Array | null | undefined): HubWifiApInfo | null {
  if (!b || b.length < 106 || b[0] !== 1) return null
  return {
    apState: AP_STATES[b[1]] ?? 'ERROR',
    ip: `${b[2]}.${b[3]}.${b[4]}.${b[5]}`,
    port: u16(b, 6),
    ssid: utf8(b, 9, Math.min(b[8], 32)),
    password: utf8(b, 42, Math.min(b[41], 64))
  }
}

export function apBaseUrl(info: HubWifiApInfo): string {
  return info.port === 80 ? `http://${info.ip}` : `http://${info.ip}:${info.port}`
}

export const HubCommands = {
  AP_START: new Uint8Array([0x01]),
  AP_STOP: new Uint8Array([0x00]),
  /** CAMERA_TIME_SYNC (ca500015): uint32 little-endian unix epoch seconds. */
  timeSync(epochSeconds: number): Uint8Array {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, epochSeconds >>> 0, true)
    return b
  },
  nowTimeSync(): Uint8Array {
    return HubCommands.timeSync(Math.floor(Date.now() / 1000))
  }
}

/** One entry from `GET /logs`. rotatedAt is epoch seconds, null for the open / unsynced file. */
export interface RemoteLogFile {
  stream: string
  filename: string
  sizeBytes: number
  rotatedAt: number | null
  isCurrentlyOpen: boolean
}

export function parseRemoteLogList(json: string): RemoteLogFile[] {
  const arr = JSON.parse(json) as Record<string, unknown>[]
  return arr.map((o) => ({
    stream: String(o.stream),
    filename: String(o.filename),
    sizeBytes: Number(o.sizeBytes),
    rotatedAt: o.rotatedAt == null ? null : Number(o.rotatedAt),
    isCurrentlyOpen: o.isCurrentlyOpen === true
  }))
}

/** Subset of `GET /status` the app relies on. */
export interface HubHttpStatus {
  bleMac: string
  name: string
  firmwareBuild: string
  timeSynced: boolean
}

export function parseHubHttpStatus(json: string): HubHttpStatus {
  const o = JSON.parse(json) as Record<string, unknown>
  return {
    bleMac: typeof o.bleMac === 'string' ? o.bleMac : '',
    name: typeof o.name === 'string' ? o.name : '',
    firmwareBuild: typeof o.firmwareBuild === 'string' ? o.firmwareBuild : '',
    timeSynced: o.timeSynced === true
  }
}

/** True if this HTTP endpoint is the same Camera we're connected to over BLE. */
export function statusMatches(s: HubHttpStatus, bleAddress: string): boolean {
  return s.bleMac.toUpperCase() === bleAddress.toUpperCase()
}

/**
 * Short, user-facing error text. The Hub answers errors with `{"error":"..."}`. Anything else
 * (e.g. an HTML 404 page from some other server on that address) is reduced to the status code.
 */
export function errorSummary(code: number, body: string): string {
  let hubError: string | null = null
  try {
    const o = JSON.parse(body)
    if (o && typeof o.error === 'string' && o.error.trim() !== '') hubError = o.error
  } catch {
    hubError = null
  }
  if (hubError != null) return `HTTP ${code}: ${hubError}`
  if (code === 404) return 'HTTP 404: not found (is this a Camera Hub?)'
  return `HTTP ${code}`
}

/** One device the Hub hears (CAMERA_NEARBY_DEVICES entry, 21 bytes, see hub_protocol.h). */
export interface NearbyDevice {
  address: string
  rssi: number
  deviceType: DeviceType
  isConfigured: boolean
  chemistry: BatteryChemistry
  kit: number
  cellCount: number
  batteryPercent: number
  voltageMillivolts: number
  extBatteryPercent: number   // -1 = no external pack
  extVoltageMillivolts: number
  shutterCount: number
  ageSeconds: number
}

const optInt = (v: unknown, dflt = 0) => (typeof v === 'number' ? Math.trunc(v) : dflt)

/** Parses `GET /nearby` (firmware wifi_http.cpp handleNearby / mock_hub.py). */
export function parseNearbyDevicesJson(json: string): NearbyDevice[] {
  const arr = JSON.parse(json) as Record<string, unknown>[]
  return arr.map((o) => {
    const hasExt = o.extPct != null
    return {
      address: String(o.addr).toUpperCase(),
      rssi: optInt(o.rssi),
      deviceType: deviceTypeOf(optInt(o.type)),
      isConfigured: optInt(o.cfg) !== 0,
      chemistry: chemistryOf(optInt(o.chem)),
      kit: optInt(o.kit),
      cellCount: optInt(o.cells, 1),
      batteryPercent: optInt(o.intPct),
      voltageMillivolts: optInt(o.intMv),
      extBatteryPercent: hasExt ? optInt(o.extPct) : -1,
      extVoltageMillivolts: hasExt ? optInt(o.extMv) : 0,
      shutterCount: optInt(o.shutter),
      ageSeconds: optInt(o.ageSec)
    }
  })
}

/** One page of CAMERA_NEARBY_DEVICES: write the page index (1 byte), then read. */
export interface NearbyDevicesPage {
  total: number
  page: number
  devices: NearbyDevice[]
}

export function parseNearbyDevicesPage(b: Uint8Array | null | undefined): NearbyDevicesPage | null {
  const HEADER = 4
  const ENTRY = 21
  if (!b || b.length < HEADER || b[0] !== 1) return null
  const entries = b[3]
  if (b.length < HEADER + entries * ENTRY) return null
  const devices: NearbyDevice[] = []
  for (let i = 0; i < entries; i++) {
    const o = HEADER + i * ENTRY
    const flags = b[o + 8]
    const extPct = b[o + 14]
    devices.push({
      address: Array.from(b.subarray(o, o + 6), (x) => x.toString(16).toUpperCase().padStart(2, '0')).join(':'),
      rssi: (b[o + 6] << 24) >> 24,
      deviceType: deviceTypeOf(b[o + 7]),
      isConfigured: (flags & 0x01) !== 0,
      chemistry: chemistryOf((flags >> 1) & 0x03),
      kit: b[o + 9],
      cellCount: b[o + 10],
      batteryPercent: b[o + 11],
      voltageMillivolts: u16(b, o + 12),
      extBatteryPercent: extPct === 0xff ? -1 : extPct,
      extVoltageMillivolts: extPct === 0xff ? 0 : u16(b, o + 15),
      shutterCount: u16(b, o + 17),
      ageSeconds: u16(b, o + 19)
    })
  }
  return { total: b[1], page: b[2], devices }
}

/** Kit devices first (by Kit), then unassigned; strongest signal first within a group. */
export function sortNearbyForDisplay(list: NearbyDevice[]): NearbyDevice[] {
  return [...list].sort((a, b) =>
    Number(a.kit === 0) - Number(b.kit === 0) || a.kit - b.kit || b.rssi - a.rssi)
}
