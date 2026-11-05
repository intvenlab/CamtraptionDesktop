// Port of HubLogParserTest.kt. Log formats: firmware/README.md "Log files".
import { describe, expect, it } from 'vitest'
import {
  describeCameraRecord, describeScanRecord, formatLogTime, friendlyLogName, groupScanLogByDevice, mergeHubLogs,
  parseHubLog
} from '../src/shared/hubLogParser'
import { HUB_STREAM_CAMERA, HUB_STREAM_SCAN } from '../src/shared/hubProtocol'
import { DeviceType } from '../src/shared/types'

const cameraLog = `{"t":null,"up":357,"ev":"BOOT","shutter":0,"state":0,"intMv":2950,"intPct":75,"extMv":11800,"extPct":80,"boot":41,"session":41,"reset":1}
{"t":1792200000,"up":5000,"ev":"PHONE_CONNECTED","shutter":0,"state":0,"intMv":2950,"intPct":75,"extMv":11800,"extPct":80,"phone":"aa:bb"}
{"t":1792200001,"up":6000,"ev":"SETTING","shutter":0,"state":0,"intMv":2950,"intPct":75,"extMv":11800,"extPct":80,"field":"kit","old":0,"new":1}
{"t":1792200002,"up":7000,"ev":"CAMERA_SETTING","shutter":0,"state":0,"intMv":2950,"intPct":75,"extMv":11800,"extPct":80,"field":"shutterPulseDuration","old":20,"new":35}
{"t":1792200010,"up":15000,"ev":"TRIGGER","shutter":4,"state":4,"intMv":2950,"intPct":75,"extMv":11800,"extPct":80,"frames":4,"burst":1,"cold":true,"ms":3250}
{"t":1792200011,"up":16000,"ev":"TRIGGER_REJECTED","shutter":4,"state":3,"intMv":2950,"intPct":75,"extMv":11800,"extPct":80,"reason":"ignore_gap","suppressed":2}
{"t":1792200400,"up":
{"t":1792200500,"up":400000,"ev":"BATTERY","shutter":4,"state":0,"intMv":2950,"intPct":75,"extMv":10800,"extPct":15,"prevPct":20,"level":"low"}
{"t":1792200600,"up":500000,"ev":"WIFI_OFF","shutter":4,"state":0,"intMv":2950,"intPct":75,"extMv":10800,"extPct":15,"reason":"station_left"}`

describe('HubLogParser', () => {
  it('parses a camera log and skips a torn line', () => {
    const log = parseHubLog(HUB_STREAM_CAMERA, cameraLog)
    expect(log.records).toHaveLength(8)
    expect(log.badLines).toBe(1)
    expect(log.records[0].epoch).toBeNull()
    expect(log.records[1].epoch).toBe(1792200000)
  })

  it('describes camera events', () => {
    const r = Object.fromEntries(parseHubLog(HUB_STREAM_CAMERA, cameraLog).records.map((x) => [x.ev, x]))
    expect(describeCameraRecord(r.BOOT).title).toBe('Hub started')
    expect(describeCameraRecord(r.BOOT).detail).toContain('power on')

    const kit = describeCameraRecord(r.SETTING)
    expect(kit.title).toBe('Setting changed: Kit')
    expect(kit.detail).toBe('none → Kit 1')

    const pulse = describeCameraRecord(r.CAMERA_SETTING)
    expect(pulse.title).toBe('Camera logic: Shutter pulse duration')
    expect(pulse.detail).toBe('200 ms → 350 ms')  // wire units x10 ms

    const trig = describeCameraRecord(r.TRIGGER)
    expect(trig.title).toBe('Trigger: 4 frames')
    expect(trig.detail).toBe('shutter #4 · cold full-press · 3.3 s')
    expect(trig.kind).toBe('TRIGGER')

    expect(describeCameraRecord(r.TRIGGER_REJECTED).detail).toBe('inside the full-press ignore gap · +2 more')

    const batt = describeCameraRecord(r.BATTERY)
    expect(batt.title).toBe('Battery 15%')
    expect(batt.detail).toBe('was 20% · LOW')
    expect(batt.kind).toBe('WARNING')

    expect(describeCameraRecord(r.WIFI_OFF).detail).toBe('the phone left the network')
  })

  it('back-dates undated records from a TIME_SYNC anchor', () => {
    const log = parseHubLog(HUB_STREAM_CAMERA, `{"t":null,"up":300,"b":42,"ev":"BOOT","boot":42,"reset":1}
{"t":null,"up":60000,"b":42,"ev":"TRIGGER","frames":4,"shutter":4}
{"t":1792200100,"up":100000,"b":42,"ev":"TIME_SYNC","anchor":true}
{"t":null,"up":5000,"b":43,"ev":"BOOT","boot":43,"reset":1}`)
    const [boot42, trig, sync, boot43] = log.records
    expect(boot42.estEpoch).toBe(1792200000)  // 1792200100 - 100 s + 0 s
    expect(trig.estEpoch).toBe(1792200060)
    expect(sync.epoch).toBe(1792200100)
    expect(boot43.estEpoch).toBeNull()        // never synced during boot 43
    expect(formatLogTime(trig).startsWith('≈ ')).toBe(true)
    expect(formatLogTime(boot43)).toBe('boot #43 +0:05')
  })

  it('merges files oldest first with unique line numbers', () => {
    const day2 = '{"t":1792286400,"up":1000,"b":5,"ev":"HEARTBEAT","addr":"AA:00:00:00:00:01","kit":1}'
    const day1 = '{"t":1792200000,"up":1000,"b":4,"ev":"SEEN","addr":"AA:00:00:00:00:01","kit":1}'
    const undated = `{"t":null,"up":2000,"b":3,"ev":"SEEN","addr":"AA:00:00:00:00:01","kit":1}
{"t":null,"up":3000,"b":3,"ev":"LOST","addr":"AA:00:00:00:00:01","kit":1}`
    const log = mergeHubLogs(HUB_STREAM_SCAN, [['2026-10-17.jsonl', day2], ['undated.jsonl', undated], ['2026-10-16.jsonl', day1]])
    expect(log.records.map((r) => r.ev)).toEqual(['SEEN', 'LOST', 'SEEN', 'HEARTBEAT'])
    expect(log.records.map((r) => r.lineNo)).toEqual([1, 2, 3, 4])
    const devs = groupScanLogByDevice(log.records)
    expect(devs).toHaveLength(1)
    expect(devs[0].records).toHaveLength(4)
  })

  it('friendly file names', () => {
    expect(friendlyLogName('2026-10-16.jsonl')).toBe('Oct 16, 2026')
    expect(friendlyLogName('undated.jsonl')).toBe('Undated (clock not set)')
    expect(friendlyLogName('undated-0003.jsonl')).toBe('Undated, part 3')
    expect(friendlyLogName('session_00041.jsonl')).toBe('Power-up #41 (old format)')
  })

  it('groups the scan log by device and describes changes', () => {
    const scan = `{"t":null,"up":1000,"ev":"SEEN","addr":"C2:33:51:FB:5E:1A","rssi":-60,"type":0,"cfg":1,"chem":0,"kit":1,"cells":3,"intMv":2900,"intPct":70,"extMv":12000,"extPct":85,"shutter":0}
{"t":null,"up":1500,"ev":"SEEN","addr":"aa:bb:cc:dd:ee:04","rssi":-80,"type":1,"cfg":1,"chem":0,"kit":2,"cells":1,"intMv":3000,"intPct":95,"extMv":7400,"extPct":51,"shutter":120}
{"t":null,"up":9000,"ev":"CHANGE","changed":"kit,battery","addr":"C2:33:51:FB:5E:1A","rssi":-61,"type":0,"cfg":1,"chem":0,"kit":2,"cells":3,"intMv":2900,"intPct":70,"extMv":11700,"extPct":80,"shutter":0}
{"t":null,"up":9500,"ev":"CHANGE","changed":"shutter","addr":"AA:BB:CC:DD:EE:04","rssi":-79,"type":1,"cfg":1,"chem":0,"kit":2,"cells":1,"intMv":3000,"intPct":95,"extMv":7400,"extPct":51,"shutter":124}
{"t":null,"up":30000,"ev":"LOST","addr":"C2:33:51:FB:5E:1A","rssi":-61,"type":0,"cfg":1,"chem":0,"kit":2,"cells":3,"intMv":2900,"intPct":70,"extMv":null,"extPct":null,"shutter":0,"silentSec":20}
{"t":null,"up":40000,"why":"periodic","addr":"AA:BB:CC:DD:EE:04","rssi":-79,"type":1,"cfg":1,"chem":0,"kit":2,"cells":1,"intMv":3000,"intPct":95,"extMv":7400,"extPct":51,"shutter":124}`
    const devices = groupScanLogByDevice(parseHubLog(HUB_STREAM_SCAN, scan).records)
    expect(devices).toHaveLength(2)
    const bm = devices.find((d) => d.address === 'C2:33:51:FB:5E:1A')!
    expect(bm.deviceType).toBe(DeviceType.BATTERY_MONITOR)
    expect(bm.records).toHaveLength(3)
    expect(describeScanRecord(bm.records[1], bm.records[0]).detail).toBe('Kit 1 → 2 · battery 85% → 80%')
    expect(describeScanRecord(bm.records[2], bm.records[1]).title).toBe('Lost')

    const cam = devices.find((d) => d.address === 'AA:BB:CC:DD:EE:04')!  // case-insensitive grouping
    expect(cam.records).toHaveLength(3)
    const shot = describeScanRecord(cam.records[1], cam.records[0])
    expect(shot.title).toBe('Shutter fired')
    expect(shot.detail).toBe('shutter 120 → 124')
    expect(cam.records[2].ev).toBe('HEARTBEAT')  // legacy "why":"periodic"
  })
})
