// Advertisement + config blob layouts (no Kotlin test existed; built from the byte tables in
// MainActivity.parseScanResult and DeviceScreen.kt buildCamBytes / buildFeederBytes).
import { describe, expect, it } from 'vitest'
import { deviceTypeFromFlags, parseManufacturerData, stripCompanyId } from '../src/shared/advert'
import {
  CAMERA_LOGIC_DEFAULTS, FEEDER_DEFAULTS, buildCameraConfig, buildFeederConfig, calibrationBytes, describeConfigAck,
  parseCameraConfig, parseFeederConfig
} from '../src/shared/deviceConfig'
import { GattUuids } from '../src/shared/gattUuids'
import { buildScanList, formatBytes, formatLastSeen } from '../src/shared/scanList'
import { BatteryChemistry, DeviceType, makeDevice } from '../src/shared/types'

describe('advertisement', () => {
  it('parses the v2 packet with Hub tail', () => {
    // flags: configured | type CAMERA (1 -> bits1-2) | chem NIMH (2 -> bits3-4)
    const flags = 0x01 | (1 << 1) | (2 << 3)
    const d = new Uint8Array([
      80, 0xb8, 0x0b,          // int 80%, 3000 mV
      55, 0x2c, 0x2e,          // ext 55%, 11820 mV
      flags, 3, 2, 0xd2, 0x04, // kit 3, 2 cells, shutter 1234
      2, 3, 0x03,              // layout v2, state Burst Active, flags activity+HP
      0xea, 0x07, 10, 16, 9, 5, 7, // 2026-10-16 09:05:07
      12                       // hub hears 12
    ])
    const p = parseManufacturerData(d)!
    expect(p.batteryPercent).toBe(80)
    expect(p.voltageMillivolts).toBe(3000)
    expect(p.extBatteryPercent).toBe(55)
    expect(p.extVoltageMillivolts).toBe(11820)
    expect(p.isConfigured).toBe(true)
    expect(p.deviceType).toBe(DeviceType.CAMERA)
    expect(p.batteryChemistry).toBe(BatteryChemistry.NIMH)
    expect(p.groupId).toBe(3)
    expect(p.cellCount).toBe(2)
    expect(p.shutterCount).toBe(1234)
    expect(p.cameraState).toBe(3)
    expect(p.cameraLiveFlags).toBe(3)
    expect(p.firmwareBuild).toBe('2026-10-16 09:05:07')
    expect(p.hubNearbyCount).toBe(12)
  })

  it('no external pack zeroes its voltage', () => {
    const p = parseManufacturerData(new Uint8Array([50, 0, 0, 0xff, 0x10, 0x27, 1, 0, 1, 0, 0]))!
    expect(p.extBatteryPercent).toBe(-1)
    expect(p.extVoltageMillivolts).toBe(0)
    expect(p.hubNearbyCount).toBe(-1)
  })

  it('parses the legacy 8-byte packet', () => {
    const p = parseManufacturerData(new Uint8Array([70, 0x10, 0x0e, 0x01 | (2 << 1), 5, 4, 0x0a, 0x00]))!
    expect(p.deviceType).toBe(DeviceType.STROBE)
    expect(p.groupId).toBe(5)
    expect(p.cellCount).toBe(4)
    expect(p.shutterCount).toBe(10)
    expect(p.extBatteryPercent).toBe(-1)
  })

  it('decodes FEEDER from the widened type field', () => {
    expect(deviceTypeFromFlags(1 << 5)).toBe(DeviceType.FEEDER)
    expect(deviceTypeFromFlags(3 << 1)).toBe(DeviceType.FOCUS_LIGHT)
  })

  it('strips company ID 0xFFFF only', () => {
    expect(Array.from(stripCompanyId(new Uint8Array([0xff, 0xff, 1, 2]))!)).toEqual([1, 2])
    expect(stripCompanyId(new Uint8Array([0x59, 0x00, 1, 2]))).toBeNull()
  })
})

describe('config blobs', () => {
  it('camera config round-trips the defaults', () => {
    const b = buildCameraConfig(CAMERA_LOGIC_DEFAULTS)
    expect(b).toHaveLength(22)
    expect(Array.from(b)).toEqual([3, 0, 10, 5, 10, 0, 100, 0, 20, 35, 20, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 31])
    expect(parseCameraConfig(b)).toEqual(CAMERA_LOGIC_DEFAULTS)
  })

  it('camera config clamps out-of-range values', () => {
    const b = buildCameraConfig({ ...CAMERA_LOGIC_DEFAULTS, wakeHalfPressHoldSec: '99999', frameCount: '99', fullPressIgnoreGapTenths: '' })
    expect(b[2]).toBe(60)
    expect(b[11]).toBe(64)
    expect(b[21]).toBe(31)  // blank -> default 3100 ms
    expect(parseCameraConfig(new Uint8Array(22).fill(2))).toBeNull()
  })

  it('feeder config round-trips', () => {
    const f = { ...FEEDER_DEFAULTS, enabled: true, pumpOnMs: '70000' }
    const b = buildFeederConfig(f)
    expect(Array.from(b)).toEqual([1, 1, 100, 0, 0x70, 0x11, 0x01, 0, 0x10, 0x27, 0, 0])
    expect(parseFeederConfig(b)).toEqual(f)
  })

  it('acks and calibration', () => {
    expect(describeConfigAck(new Uint8Array([0]))).toBe('Saved successfully')
    expect(describeConfigAck(null)).toBe('Sent (no acknowledgment)')
    expect(describeConfigAck(new Uint8Array([0x42]))).toBe('Unknown response (0x42)')
    expect(Array.from(calibrationBytes(12.6, 30000))).toEqual([0x38, 0x31])
    expect(Array.from(calibrationBytes(9, 5000))).toEqual([0x88, 0x13])
  })

  it('UUIDs are 32 hex chars', () => {
    expect(GattUuids.DEVICE_NAME).toBe('ca500001000000000000000000000000')
    expect(Object.values(GattUuids).every((u) => /^[0-9a-f]{32}$/.test(u))).toBe(true)
  })
})

describe('scan list', () => {
  it('orders unconfigured, Kits (camera first), then individuals by RSSI', () => {
    const list = buildScanList([
      makeDevice({ address: 'A', isConfigured: true, rssi: -80 }),
      makeDevice({ address: 'B', isConfigured: true, groupId: 2, deviceType: DeviceType.STROBE, name: 'S' }),
      makeDevice({ address: 'C', isConfigured: true, groupId: 2, deviceType: DeviceType.CAMERA, name: 'Z' }),
      makeDevice({ address: 'D' }),
      makeDevice({ address: 'E', isConfigured: true, rssi: -40 })
    ], { 2: 'North' })
    expect(list.map((i) => i.kind)).toEqual(['unconfigured', 'group', 'individual', 'individual'])
    const g = list[1]
    expect(g.kind === 'group' && g.devices.map((d) => d.address)).toEqual(['C', 'B'])
    expect(g.kind === 'group' && g.groupName).toBe('North')
    expect(list.slice(2).map((i) => (i.kind === 'individual' ? i.device.address : ''))).toEqual(['E', 'A'])
  })

  it('formats last seen and bytes', () => {
    const now = 1_000_000_000_000
    expect(formatLastSeen(now - 5_000, now)).toBe('Just now')
    expect(formatLastSeen(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatLastSeen(now - 3 * 3_600_000, now)).toBe('3 hr ago')
    expect(formatLastSeen(now - 30 * 3_600_000, now)).toBe('Yesterday')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })
})
