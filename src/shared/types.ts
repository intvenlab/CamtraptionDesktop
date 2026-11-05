// Domain model. Mirrors MainActivity.kt (BleDevice, DeviceType, BatteryChemistry) and
// AppScreen.kt (enum display helpers) in camtraptionAssistant2.

export enum DeviceType { BATTERY_MONITOR, CAMERA, STROBE, FOCUS_LIGHT, FEEDER }
export enum BatteryChemistry { LIPO, LIFEPO4, NIMH, ALKALINE }

export const DEVICE_TYPES = [
  DeviceType.BATTERY_MONITOR, DeviceType.CAMERA, DeviceType.STROBE, DeviceType.FOCUS_LIGHT, DeviceType.FEEDER
]
export const CHEMISTRIES = [BatteryChemistry.LIPO, BatteryChemistry.LIFEPO4, BatteryChemistry.NIMH, BatteryChemistry.ALKALINE]

export interface BleDevice {
  address: string            // "AA:BB:CC:DD:EE:FF" (upper case, like Android's BluetoothDevice.address)
  name: string | null
  batteryPercent: number
  voltageMillivolts: number
  rssi: number
  lastSeen: number
  isConfigured: boolean
  deviceType: DeviceType
  batteryChemistry: BatteryChemistry
  cellCount: number
  groupId: number
  shutterCount: number
  extBatteryPercent: number  // -1 = not present
  extVoltageMillivolts: number
  isConnected: boolean
  cameraState: number        // adv byte [12]; only meaningful for CAMERA type
  cameraLiveFlags: number    // adv byte [13]; bit0=activityActive bit1=hpOutAsserted
  firmwareBuild: string      // formatted from bytes [14-20]; "" = not present
  hubNearbyCount: number     // byte [21], ESP32 Camera Hub only; -1 = not a Hub
}

export function makeDevice(p: Partial<BleDevice> & Pick<BleDevice, 'address'>): BleDevice {
  return {
    name: null, batteryPercent: 0, voltageMillivolts: 0, rssi: 0, lastSeen: Date.now(),
    isConfigured: false, deviceType: DeviceType.BATTERY_MONITOR, batteryChemistry: BatteryChemistry.LIPO,
    cellCount: 1, groupId: 0, shutterCount: 0, extBatteryPercent: -1, extVoltageMillivolts: 0,
    isConnected: true, cameraState: 0, cameraLiveFlags: 0, firmwareBuild: '', hubNearbyCount: -1,
    ...p
  }
}

/** Sort order within a Kit: cameras first, battery monitors last. */
export function sortOrder(t: DeviceType): number {
  switch (t) {
    case DeviceType.CAMERA: return 0
    case DeviceType.FEEDER: return 1
    case DeviceType.STROBE: return 2
    case DeviceType.FOCUS_LIGHT: return 3
    default: return 4
  }
}

export function deviceIcon(t: DeviceType): string {
  switch (t) {
    case DeviceType.CAMERA: return '📷'
    case DeviceType.STROBE: return '💡'
    case DeviceType.FOCUS_LIGHT: return '🔦'
    case DeviceType.FEEDER: return '💧'
    default: return '🔋'
  }
}

export function deviceTypeName(t: DeviceType): string {
  switch (t) {
    case DeviceType.CAMERA: return 'Camera'
    case DeviceType.STROBE: return 'Strobe'
    case DeviceType.FOCUS_LIGHT: return 'Focus Light'
    case DeviceType.FEEDER: return 'Feeder'
    default: return 'Battery Monitor'
  }
}

export function chemistryName(c: BatteryChemistry): string {
  switch (c) {
    case BatteryChemistry.LIFEPO4: return 'LiFePO4'
    case BatteryChemistry.NIMH: return 'NiMH'
    case BatteryChemistry.ALKALINE: return 'Alkaline'
    default: return 'LiPo'
  }
}

/** DeviceType.values().getOrElse(i) { fallback } */
export function deviceTypeOf(i: number | null | undefined, fallback = DeviceType.BATTERY_MONITOR): DeviceType {
  return i != null && i >= 0 && i <= 4 ? (i as DeviceType) : fallback
}

export function chemistryOf(i: number | null | undefined, fallback = BatteryChemistry.LIPO): BatteryChemistry {
  return i != null && i >= 0 && i <= 3 ? (i as BatteryChemistry) : fallback
}

export function cameraStateLabel(s: number): string {
  return ['Idle', 'Wake AF', 'Cold FP Wait', 'Burst Active', 'Post-Shutter'][s] ?? 'Unknown'
}

// ─── Per-device event log (DeviceHistoryStore.kt) ──────────────────────────

export interface DeviceHistoryEntry {
  timestamp: number
  eventType: string           // Connect | Disconnect | Shutter | Battery | ExtBattRemoved | ExtBattAttached | PumpRun
  shutterCount: number
  batteryPercent: number      // ext battery % (-1 = absent)
  voltageMillivolts: number   // ext voltage mV
  intBatteryPercent: number
  intVoltageMillivolts: number
  rssi: number
  cameraState: number
  cameraLiveFlags: number
  firmwareBuild: string
}

export function historyEntryFor(eventType: string, d: BleDevice): DeviceHistoryEntry {
  return {
    timestamp: Date.now(),
    eventType,
    shutterCount: d.shutterCount,
    batteryPercent: d.extBatteryPercent,
    voltageMillivolts: d.extVoltageMillivolts,
    intBatteryPercent: d.batteryPercent,
    intVoltageMillivolts: d.voltageMillivolts,
    rssi: d.rssi,
    cameraState: d.cameraState,
    cameraLiveFlags: d.cameraLiveFlags,
    firmwareBuild: d.firmwareBuild
  }
}

// ─── Downloaded Hub logs (CameraLogCatalogStore.kt) ────────────────────────

export interface CachedHubLog {
  cameraAddress: string
  stream: string
  filename: string
  localCachePath: string
  downloadedAt: number
  sizeBytes: number
}

// ─── GATT connection state (BleGattManager.kt) ─────────────────────────────

export type GattState = 'IDLE' | 'CONNECTING' | 'READY' | 'ERROR'

export interface GattStatus {
  state: GattState
  errorMessage: string | null
}

export type AdapterState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown' | 'resetting'

/** One live reading recorded by the desktop app for the Graphs tab (TelemetryStore). */
export interface TelemetrySample {
  t: number         // ms
  mv: number        // internal battery
  pct: number
  extMv: number
  extPct: number    // -1 = no external battery
  rssi: number
  shutter: number
}
