// Advertisement parsing. Port of MainActivity.parseScanResult (camtraptionAssistant2); byte
// offsets are into the manufacturer data after the 2-byte company ID has been stripped.

import { BatteryChemistry, BleDevice, DeviceType } from './types'

export const COMPANY_ID = 0xffff
export const STALE_TIMEOUT_MS = 10_000

// Flags byte: bits1-2 hold the low 2 bits of device type, bit5 holds the MSB
// (widened from a 2-bit to a 3-bit field to make room for FEEDER; bits3-4 remain chemistry).
export function deviceTypeFromFlags(flags: number): DeviceType {
  const raw = ((flags >> 1) & 0x03) | (((flags >> 5) & 0x01) << 2)
  return raw >= 1 && raw <= 4 ? (raw as DeviceType) : DeviceType.BATTERY_MONITOR
}

function chemistryFromFlags(flags: number): BatteryChemistry {
  return ((flags >> 3) & 0x03) as BatteryChemistry
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Telemetry fields from one advertisement; null if it's too short to be one of ours. */
export function parseManufacturerData(data: Uint8Array): Omit<BleDevice, 'address' | 'name' | 'rssi' | 'lastSeen' | 'isConnected'> | null {
  if (data.length < 3) return null
  const u16 = (i: number) => data[i] | (data[i + 1] << 8)

  const out = {
    batteryPercent: data[0],
    voltageMillivolts: u16(1),
    isConfigured: false,
    deviceType: DeviceType.BATTERY_MONITOR,
    batteryChemistry: BatteryChemistry.LIPO,
    cellCount: 1,
    groupId: 0,
    shutterCount: 0,
    extBatteryPercent: -1,
    extVoltageMillivolts: 0,
    cameraState: 0,
    cameraLiveFlags: 0,
    firmwareBuild: '',
    hubNearbyCount: -1
  }

  if (data.length >= 11) {
    // New 13-byte packet (11 bytes after company ID strip):
    // [0]=intPct [1-2]=intMv [3]=extPct [4-5]=extMv [6]=flags [7]=group [8]=cells [9-10]=shutter
    const rawExtPct = data[3]
    out.extBatteryPercent = rawExtPct === 0xff ? -1 : rawExtPct
    out.extVoltageMillivolts = out.extBatteryPercent < 0 ? 0 : u16(4)
    const flags = data[6]
    out.isConfigured = (flags & 0x01) !== 0
    out.deviceType = deviceTypeFromFlags(flags)
    out.batteryChemistry = chemistryFromFlags(flags)
    out.groupId = data[7]
    out.cellCount = data[8]
    out.shutterCount = u16(9)
    if (data.length >= 21 && data[11] === 2) {
      out.cameraState = data[12]
      out.cameraLiveFlags = data[13]
      // ESP32 Camera Hub appends the count of nearby devices it hears.
      if (data.length >= 22) out.hubNearbyCount = data[21]
      const year = u16(14)
      out.firmwareBuild = year >= 2024
        ? `${pad(year, 4)}-${pad(data[16])}-${pad(data[17])} ${pad(data[18])}:${pad(data[19])}:${pad(data[20])}`
        : ''
    }
  } else if (data.length >= 8) {
    // Old 10-byte packet (8 bytes after company ID strip) – backward compat:
    // [0]=pct [1-2]=mv [3]=flags [4]=group [5]=cells [6-7]=shutter
    const flags = data[3]
    out.isConfigured = (flags & 0x01) !== 0
    out.deviceType = deviceTypeFromFlags(flags)
    out.batteryChemistry = chemistryFromFlags(flags)
    out.groupId = data[4]
    out.cellCount = data[5]
    out.shutterCount = u16(6)
  }
  return out
}

/**
 * Full manufacturer-specific AD payload (company ID first, little-endian) -> payload after the
 * company ID, or null if it isn't ours.
 */
export function stripCompanyId(raw: Uint8Array | undefined | null): Uint8Array | null {
  if (!raw || raw.length < 2) return null
  if ((raw[0] | (raw[1] << 8)) !== COMPANY_ID) return null
  return raw.subarray(2)
}
