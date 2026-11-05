// Chart series for the Graphs tab, from two sources: telemetry the desktop app recorded from live
// advertisements (TelemetryStore), and Camera Hub SD logs (scan stream = devices the Hub heard,
// camera stream = the Hub's own events). Pure functions so they're unit-tested; times are ms.

import { HubLogRecord, int, str } from './hubLogParser'
import type { TelemetrySample } from './types'

export type Metric = 'voltage' | 'percent' | 'rssi' | 'shutters' | 'hubHeard'

export interface Point { t: number; v: number }

/** One line on a chart. key is unique per chart; address ties it to a device (or a Hub). */
export interface Series {
  key: string
  address: string
  /** "ext" / "int" for battery metrics, "" otherwise. */
  part: string
  /** Which data source drew it, shown in the legend when both are on. */
  source: 'live' | 'log'
  points: Point[]
  /** Bars (counts per bucket) instead of a line. */
  bars?: boolean
}

export const HOUR_MS = 3_600_000
export const SHUTTER_BUCKET_MS = HOUR_MS
export const HUB_HEARD_BUCKET_MS = 10 * 60_000

/** Record time in ms: the Hub's clock, else the back-dated estimate; undated records are skipped. */
export function recordTimeMs(r: HubLogRecord): number | null {
  const s = r.epoch ?? r.estEpoch
  return s == null || s <= 0 ? null : s * 1000
}

/** Counts per bucket: [{t: bucket start, v: sum}], oldest first. */
export function bucketSum(points: Point[], bucketMs: number): Point[] {
  const sums = new Map<number, number>()
  for (const p of points) {
    const b = Math.floor(p.t / bucketMs) * bucketMs
    sums.set(b, (sums.get(b) ?? 0) + p.v)
  }
  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }))
}

/**
 * Shutter count readings -> shutters per bucket. Increases count; a drop means the counter was reset
 * (or a 16-bit wrap on the Hub's scan log), so that step is skipped rather than counted as negative.
 */
export function shutterDeltas(readings: Point[], bucketMs = SHUTTER_BUCKET_MS): Point[] {
  const deltas: Point[] = []
  for (let i = 1; i < readings.length; i++) {
    const d = readings[i].v - readings[i - 1].v
    if (d > 0) deltas.push({ t: readings[i].t, v: d })
  }
  return bucketSum(deltas, bucketMs)
}

const inRange = (t: number, from: number, to: number) => t >= from && t <= to

// ─── Live telemetry ────────────────────────────────────────────────────────

export function telemetrySeries(
  byAddress: Record<string, TelemetrySample[]>,
  metric: Metric,
  from = 0,
  to = Number.MAX_SAFE_INTEGER
): Series[] {
  const out: Series[] = []
  for (const [address, all] of Object.entries(byAddress)) {
    const samples = all.filter((s) => inRange(s.t, from, to)).sort((a, b) => a.t - b.t)
    if (samples.length === 0) continue
    const push = (part: string, points: Point[], bars = false) => {
      if (points.length > 0) out.push({ key: `live|${address}|${part}`, address, part, source: 'live', points, bars })
    }
    switch (metric) {
      case 'voltage':
        push('ext', samples.filter((s) => s.extPct >= 0 && s.extMv > 0).map((s) => ({ t: s.t, v: s.extMv / 1000 })))
        push('int', samples.filter((s) => s.mv > 0).map((s) => ({ t: s.t, v: s.mv / 1000 })))
        break
      case 'percent':
        push('ext', samples.filter((s) => s.extPct >= 0).map((s) => ({ t: s.t, v: s.extPct })))
        push('int', samples.map((s) => ({ t: s.t, v: s.pct })))
        break
      case 'rssi':
        push('', samples.filter((s) => s.rssi !== 0).map((s) => ({ t: s.t, v: s.rssi })))
        break
      case 'shutters':
        push('', shutterDeltas(samples.map((s) => ({ t: s.t, v: s.shutter }))), true)
        break
      case 'hubHeard':
        break
    }
  }
  return out
}

// ─── Hub logs ──────────────────────────────────────────────────────────────

/** Scan-stream records -> per-device series. hubAddress names the "devices heard" series. */
export function scanLogSeries(
  records: HubLogRecord[],
  metric: Metric,
  hubAddress: string,
  from = 0,
  to = Number.MAX_SAFE_INTEGER
): Series[] {
  const timed = records
    .map((r) => ({ r, t: recordTimeMs(r) }))
    .filter((x): x is { r: HubLogRecord; t: number } => x.t != null && inRange(x.t, from, to))
    .sort((a, b) => a.t - b.t)

  if (metric === 'hubHeard') {
    const buckets = new Map<number, Set<string>>()
    for (const { r, t } of timed) {
      const addr = str(r, 'addr')
      if (addr == null) continue
      const b = Math.floor(t / HUB_HEARD_BUCKET_MS) * HUB_HEARD_BUCKET_MS
      const set = buckets.get(b) ?? new Set<string>()
      set.add(addr.toUpperCase())
      buckets.set(b, set)
    }
    const points = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, s]) => ({ t, v: s.size }))
    return points.length > 0 ? [{ key: `log|${hubAddress}|heard`, address: hubAddress, part: '', source: 'log', points, bars: true }] : []
  }

  const byAddr = new Map<string, { r: HubLogRecord; t: number }[]>()
  for (const x of timed) {
    const addr = str(x.r, 'addr')
    if (addr == null) continue
    const key = addr.toUpperCase()
    const list = byAddr.get(key)
    if (list) list.push(x)
    else byAddr.set(key, [x])
  }

  const out: Series[] = []
  for (const [address, recs] of byAddr) {
    const push = (part: string, points: Point[], bars = false) => {
      if (points.length > 0) out.push({ key: `log|${address}|${part}`, address, part, source: 'log', points, bars })
    }
    const pick = (field: string, keep: (v: number, r: HubLogRecord) => boolean, scale = 1): Point[] =>
      recs.flatMap(({ r, t }) => {
        const v = int(r, field)
        return v != null && keep(v, r) ? [{ t, v: v * scale }] : []
      })
    const hasExt = (r: HubLogRecord) => (int(r, 'extPct') ?? -1) >= 0
    switch (metric) {
      case 'voltage':
        push('ext', pick('extMv', (v, r) => v > 0 && hasExt(r), 0.001))
        push('int', pick('intMv', (v) => v > 0, 0.001))
        break
      case 'percent':
        push('ext', pick('extPct', (v) => v >= 0))
        push('int', pick('intPct', (v) => v >= 0))
        break
      case 'rssi':
        push('', recs.flatMap(({ r, t }) => {
          const v = int(r, 'rssiAvg') ?? int(r, 'rssi')
          return v != null && v !== 0 ? [{ t, v }] : []
        }))
        break
      case 'shutters':
        push('', shutterDeltas(pick('shutter', () => true)), true)
        break
    }
  }
  return out
}

/** Camera-stream TRIGGER records -> the Hub camera's shutters per bucket (bypass records carry a count). */
export function cameraLogTriggerSeries(
  records: HubLogRecord[],
  hubAddress: string,
  from = 0,
  to = Number.MAX_SAFE_INTEGER
): Series[] {
  const hits = records.flatMap((r) => {
    const t = recordTimeMs(r)
    return r.ev === 'TRIGGER' && t != null && inRange(t, from, to) ? [{ t, v: Math.max(1, int(r, 'count') ?? 1) }] : []
  })
  const points = bucketSum(hits, SHUTTER_BUCKET_MS)
  return points.length > 0 ? [{ key: `log|${hubAddress}|trig`, address: hubAddress, part: '', source: 'log', points, bars: true }] : []
}

// ─── uPlot data ────────────────────────────────────────────────────────────

/** Aligns series on one shared x axis (seconds, as uPlot wants) with nulls where a series has no point. */
export function alignSeries(series: Series[]): { x: number[]; ys: (number | null)[][] } {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b)
  const index = new Map(xs.map((t, i) => [t, i]))
  const ys = series.map((s) => {
    const col: (number | null)[] = new Array(xs.length).fill(null)
    for (const p of s.points) col[index.get(p.t)!] = p.v
    return col
  })
  return { x: xs.map((t) => t / 1000), ys }
}
