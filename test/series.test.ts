// Graphs tab series: live telemetry and Hub logs -> chart points.
import { describe, expect, it } from 'vitest'
import { parseHubLog } from '../src/shared/hubLogParser'
import { HUB_STREAM_CAMERA, HUB_STREAM_SCAN } from '../src/shared/hubProtocol'
import {
  HOUR_MS, alignSeries, bucketSum, cameraLogTriggerSeries, scanLogSeries, shutterDeltas, telemetrySeries
} from '../src/shared/series'
import type { TelemetrySample } from '../src/shared/types'

const sample = (t: number, p: Partial<TelemetrySample> = {}): TelemetrySample =>
  ({ t, mv: 3000, pct: 80, extMv: 12000, extPct: 90, rssi: -60, shutter: 0, ...p })

describe('bucketing', () => {
  it('sums points per bucket, oldest first', () => {
    expect(bucketSum([{ t: HOUR_MS + 5, v: 2 }, { t: 10, v: 1 }, { t: HOUR_MS + 9, v: 3 }], HOUR_MS))
      .toEqual([{ t: 0, v: 1 }, { t: HOUR_MS, v: 5 }])
  })

  it('counts shutter increases and skips resets', () => {
    const readings = [{ t: 0, v: 10 }, { t: 1000, v: 13 }, { t: 2000, v: 0 }, { t: HOUR_MS, v: 2 }]
    expect(shutterDeltas(readings)).toEqual([{ t: 0, v: 3 }, { t: HOUR_MS, v: 2 }])
  })
})

describe('telemetrySeries', () => {
  const data = {
    'AA:00': [sample(2000, { extMv: 11900 }), sample(1000), sample(3000, { extPct: -1, extMv: 0 })]
  }

  it('splits voltage into ext and int, in volts, sorted, skipping missing ext', () => {
    const s = telemetrySeries(data, 'voltage')
    expect(s.map((x) => x.key)).toEqual(['live|AA:00|ext', 'live|AA:00|int'])
    expect(s[0].points).toEqual([{ t: 1000, v: 12 }, { t: 2000, v: 11.9 }])
    expect(s[1].points).toHaveLength(3)
  })

  it('applies the time range', () => {
    expect(telemetrySeries(data, 'rssi', 1500, 2500)[0].points).toEqual([{ t: 2000, v: -60 }])
  })

  it('draws shutters as bars', () => {
    const s = telemetrySeries({ X: [sample(0, { shutter: 1 }), sample(10, { shutter: 4 })] }, 'shutters')
    expect(s[0]).toMatchObject({ bars: true, points: [{ t: 0, v: 3 }] })
  })
})

describe('Hub log series', () => {
  const scan = parseHubLog(HUB_STREAM_SCAN, [
    '{"t":1792200000,"up":1000,"ev":"SEEN","addr":"aa:bb:cc:dd:ee:01","rssi":-70,"type":2,"intMv":3000,"intPct":80,"extMv":12100,"extPct":95,"shutter":0}',
    '{"t":1792200060,"up":61000,"ev":"HEARTBEAT","addr":"AA:BB:CC:DD:EE:01","rssi":-72,"rssiAvg":-68,"type":2,"intMv":2990,"intPct":79,"extMv":0,"extPct":-1,"shutter":0}',
    '{"t":1792200100,"up":101000,"ev":"SEEN","addr":"aa:bb:cc:dd:ee:02","rssi":-50,"type":1,"intMv":2900,"intPct":70,"extMv":7400,"extPct":60,"shutter":5}',
    '{"t":1792200200,"up":201000,"ev":"CHANGE","addr":"aa:bb:cc:dd:ee:02","rssi":-51,"type":1,"intMv":2900,"intPct":70,"extMv":7400,"extPct":60,"shutter":9}',
    '{"t":null,"up":5,"ev":"SEEN","addr":"aa:bb:cc:dd:ee:03","rssi":-40,"intMv":3000,"intPct":80,"extMv":0,"extPct":-1,"shutter":0}'
  ].join('\n')).records

  it('groups by upper-case address, prefers rssiAvg and skips undated records', () => {
    const s = scanLogSeries(scan, 'rssi', 'HUB')
    expect(s.map((x) => x.address)).toEqual(['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02'])
    expect(s[0].points).toEqual([{ t: 1792200000000, v: -70 }, { t: 1792200060000, v: -68 }])
  })

  it('reads ext voltage only while a pack is attached', () => {
    const ext = scanLogSeries(scan, 'voltage', 'HUB').find((x) => x.key === 'log|AA:BB:CC:DD:EE:01|ext')
    expect(ext?.points).toEqual([{ t: 1792200000000, v: 12.1 }])
  })

  it('counts shutters from the scan shutter field', () => {
    const s = scanLogSeries(scan, 'shutters', 'HUB')
    expect(s).toHaveLength(1)
    expect(s[0].points[0].v).toBe(4)
  })

  it('counts distinct devices heard per 10 minutes', () => {
    const s = scanLogSeries(scan, 'hubHeard', 'HUB')
    expect(s[0].points.reduce((a, p) => a + p.v, 0)).toBe(2)
  })

  it('counts camera-stream triggers, using the bypass count', () => {
    const cam = parseHubLog(HUB_STREAM_CAMERA, [
      '{"t":1792200000,"up":1,"ev":"TRIGGER","frames":2}',
      '{"t":1792200010,"up":2,"ev":"TRIGGER","bypass":true,"count":3}',
      '{"t":1792200020,"up":3,"ev":"SETTING","field":"kit","old":0,"new":1}'
    ].join('\n')).records
    expect(cameraLogTriggerSeries(cam, 'HUB')[0].points.map((p) => p.v)).toEqual([4])
  })
})

describe('alignSeries', () => {
  it('merges x values and fills gaps with null', () => {
    const a = { key: 'a', address: 'A', part: '', source: 'live' as const, points: [{ t: 1000, v: 1 }, { t: 3000, v: 3 }] }
    const b = { key: 'b', address: 'B', part: '', source: 'live' as const, points: [{ t: 2000, v: 2 }] }
    expect(alignSeries([a, b])).toEqual({ x: [1, 2, 3], ys: [[1, null, 3], [null, 2, null]] })
  })
})
