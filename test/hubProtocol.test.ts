// Port of HubProtocolTest.kt. Byte layouts must match firmware/camera_hub/src/hub_protocol.h.
import { describe, expect, it } from 'vitest'
import {
  HubCommands, apBaseUrl, errorSummary, parseCameraLogStatus, parseHubHttpStatus, parseHubWifiApInfo,
  parseNearbyDevicesJson, parseNearbyDevicesPage, parseRemoteLogList, statusMatches
} from '../src/shared/hubProtocol'
import { BatteryChemistry, DeviceType } from '../src/shared/types'

/** Little-endian builder, like ByteBuffer.order(LITTLE_ENDIAN). */
class LE {
  readonly b: Uint8Array
  private dv: DataView
  pos = 0
  constructor(size: number) {
    this.b = new Uint8Array(size)
    this.dv = new DataView(this.b.buffer)
  }
  put(...v: number[]) { for (const x of v) this.b[this.pos++] = x & 0xff; return this }
  bytes(a: ArrayLike<number>) { for (const x of Array.from(a)) this.b[this.pos++] = x; return this }
  short(v: number) { this.dv.setUint16(this.pos, v & 0xffff, true); this.pos += 2; return this }
  int(v: number) { this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this }
}

describe('HubProtocol', () => {
  it('parses log status', () => {
    const b = new LE(32).put(1, 2, 1, 1).short(3).short(4).int(1000).int(70000).int(30436).int(12).int(5).int(-100).b
    const s = parseCameraLogStatus(b)!
    expect(s.apState).toBe('UP')
    expect(s.sdState).toBe('MOUNTED')
    expect(s.timeSynced).toBe(true)
    expect(s.cameraFileCount).toBe(3)
    expect(s.scanFileCount).toBe(4)
    expect(s.cameraBytes).toBe(1000)
    expect(s.scanBytes).toBe(70000)
    expect(s.sdTotalMB).toBe(30436)
    expect(s.sdUsedMB).toBe(12)
    expect(s.droppedRecords).toBe(5)
    expect(s.epochNow).toBe(0xffffff9c)  // must read as unsigned
  })

  it('rejects short or wrong-version log status', () => {
    expect(parseCameraLogStatus(null)).toBeNull()
    expect(parseCameraLogStatus(new Uint8Array(31).fill(1))).toBeNull()
    const wrong = new Uint8Array(32)
    wrong[0] = 2
    expect(parseCameraLogStatus(wrong)).toBeNull()
  })

  it('parses AP info', () => {
    const ssid = new TextEncoder().encode('Camtraption-A1B2C3')
    const pass = new TextEncoder().encode('abcdefgh2345')
    const buf = new LE(106).put(1, 2, 192, 168, 4, 1).short(80).put(ssid.length).bytes(ssid)
    buf.pos = 41
    buf.put(pass.length).bytes(pass)
    const info = parseHubWifiApInfo(buf.b)!
    expect(info.apState).toBe('UP')
    expect(info.ip).toBe('192.168.4.1')
    expect(info.port).toBe(80)
    expect(info.ssid).toBe('Camtraption-A1B2C3')
    expect(info.password).toBe('abcdefgh2345')
    expect(apBaseUrl(info)).toBe('http://192.168.4.1')
  })

  it('AP info when off has empty credentials', () => {
    const b = new Uint8Array(106)
    b[0] = 1
    const info = parseHubWifiApInfo(b)!
    expect(info.apState).toBe('OFF')
    expect(info.ssid).toBe('')
    expect(info.password).toBe('')
  })

  it('time sync is little-endian uint32', () => {
    expect(Array.from(HubCommands.timeSync(0x12345678))).toEqual([0x78, 0x56, 0x34, 0x12])
  })

  it('parses the log list', () => {
    const list = parseRemoteLogList(`[
      {"stream":"camera","filename":"2026-09-30.jsonl","sizeBytes":6380,"rotatedAt":1790883310,"isCurrentlyOpen":false},
      {"stream":"scan","filename":"session_00007.jsonl","sizeBytes":12,"rotatedAt":null,"isCurrentlyOpen":true}
    ]`)
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ stream: 'camera', filename: '2026-09-30.jsonl', sizeBytes: 6380, rotatedAt: 1790883310, isCurrentlyOpen: false })
    expect(list[1].rotatedAt).toBeNull()
    expect(list[1].isCurrentlyOpen).toBe(true)
  })

  it('parses a nearby devices page', () => {
    const b = new LE(4 + 2 * 21)
      .put(1, 5, 0, 2)
      // entry 0: Strobe, configured, NiMH, Kit 3, ext battery present
      .put(0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03)
      .put(-67, 2, 0x01 | (2 << 1), 3, 4)
      .put(90).short(2950).put(77).short(15800).short(0).short(12)
      // entry 1: Camera, unconfigured, no external pack
      .put(0x10, 0x20, 0x30, 0x40, 0x50, 0x60)
      .put(-90, 1, 0x08, 0, 1)
      .put(50).short(2800).put(0xff).short(0xffff).short(1234).short(0).b
    const page = parseNearbyDevicesPage(b)!
    expect(page.total).toBe(5)
    expect(page.page).toBe(0)
    expect(page.devices).toHaveLength(2)
    const strobe = page.devices[0]
    expect(strobe.address).toBe('AA:BB:CC:01:02:03')
    expect(strobe.rssi).toBe(-67)
    expect(strobe.deviceType).toBe(DeviceType.STROBE)
    expect(strobe.isConfigured).toBe(true)
    expect(strobe.chemistry).toBe(BatteryChemistry.NIMH)
    expect(strobe.kit).toBe(3)
    expect(strobe.extBatteryPercent).toBe(77)
    expect(strobe.extVoltageMillivolts).toBe(15800)
    expect(strobe.ageSeconds).toBe(12)
    const cam = page.devices[1]
    expect(cam.deviceType).toBe(DeviceType.CAMERA)
    expect(cam.isConfigured).toBe(false)
    expect(cam.extBatteryPercent).toBe(-1)
    expect(cam.extVoltageMillivolts).toBe(0)
    expect(cam.shutterCount).toBe(1234)
  })

  it('parses nearby JSON', () => {
    const list = parseNearbyDevicesJson(`[
      {"addr":"c2:33:51:fb:5e:1a","rssi":-61,"type":0,"cfg":1,"chem":0,"kit":1,"cells":3,
       "intPct":0,"intMv":251,"extPct":null,"extMv":null,"shutter":0,"ageSec":2},
      {"addr":"AA:BB:CC:DD:EE:04","rssi":-80,"type":1,"cfg":0,"chem":2,"kit":0,"cells":1,
       "intPct":95,"intMv":3010,"extPct":51,"extMv":7400,"shutter":1287,"ageSec":11}
    ]`)
    expect(list).toHaveLength(2)
    expect(list[0].address).toBe('C2:33:51:FB:5E:1A')
    expect(list[0].deviceType).toBe(DeviceType.BATTERY_MONITOR)
    expect(list[0].extBatteryPercent).toBe(-1)
    expect(list[1].deviceType).toBe(DeviceType.CAMERA)
    expect(list[1].isConfigured).toBe(false)
    expect(list[1].chemistry).toBe(BatteryChemistry.NIMH)
    expect(list[1].extBatteryPercent).toBe(51)
    expect(list[1].shutterCount).toBe(1287)
  })

  it('rejects a truncated nearby page', () => {
    expect(parseNearbyDevicesPage(new Uint8Array([1, 3, 0, 2, ...new Array(21).fill(0)]))).toBeNull()  // claims 2, has 1
    expect(parseNearbyDevicesPage(new Uint8Array([2, 0, 0, 0]))).toBeNull()                             // wrong version
  })

  it('HTTP error summary never echoes HTML', () => {
    const html = '<!DOCTYPE html><html><head><title>Not Found</title></head><body>…</body></html>'
    expect(errorSummary(404, html)).toBe('HTTP 404: not found (is this a Camera Hub?)')
    expect(errorSummary(409, '{"error":"file is currently open"}')).toBe('HTTP 409: file is currently open')
    expect(errorSummary(500, '<html>boom</html>')).toBe('HTTP 500')
  })

  it('status matches the BLE address case-insensitively', () => {
    const s = parseHubHttpStatus('{"bleMac":"aa:bb:cc:dd:ee:01","name":"Cam","firmwareBuild":"x","timeSynced":true}')
    expect(statusMatches(s, 'AA:BB:CC:DD:EE:01')).toBe(true)
    expect(statusMatches(s, 'AA:BB:CC:DD:EE:02')).toBe(false)
  })
})
