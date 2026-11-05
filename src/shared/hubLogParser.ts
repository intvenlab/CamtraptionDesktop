// Camera Hub SD log files (JSONL) -> readable timelines. Port of HubLogParser.kt; formats are
// documented in camtraptionAssistant2/firmware/README.md ("Log files").

import { BatteryChemistry, DeviceType, chemistryName, deviceTypeName, deviceTypeOf } from './types'

type Json = Record<string, unknown>

/**
 * One parsed log line. epoch is null until the phone has set the Hub's clock. boot is the Hub's
 * power-up number ("b"). estEpoch is a back-dated time for undated records, worked out from a
 * TIME_SYNC record later in the same power-up.
 */
export interface HubLogRecord {
  lineNo: number
  epoch: number | null
  upMs: number
  ev: string
  json: Json
  boot: number | null
  estEpoch: number | null
}

// org.json opt* semantics: numbers/numeric strings coerce, anything else falls back.
function num(v: unknown): number | null {
  if (typeof v === 'number') return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Math.trunc(Number(v))
  return null
}
const has = (r: HubLogRecord, k: string) => k in r.json && r.json[k] !== null
export const str = (r: HubLogRecord, k: string): string | null => (has(r, k) ? String(r.json[k]) : null)
export const int = (r: HubLogRecord, k: string): number | null => (has(r, k) ? (num(r.json[k]) ?? 0) : null)
const bool = (r: HubLogRecord, k: string) => r.json[k] === true || r.json[k] === 'true'

export interface ParsedHubLog {
  stream: string
  records: HubLogRecord[]
  badLines: number
}

export type LogKind = 'TRIGGER' | 'SETTING' | 'CONNECTION' | 'BATTERY' | 'SYSTEM' | 'WARNING' | 'DEVICE' | 'TEST'

/** A record rendered for display. */
export interface LogLine {
  title: string
  detail: string
  kind: LogKind
}

export function parseHubLog(stream: string, text: string): ParsedHubLog {
  const records: HubLogRecord[] = []
  let bad = 0
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (line === '') return
    let o: Json
    try {
      const parsed = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      o = parsed as Json
    } catch {
      bad++
      return
    }
    // Scan records from before the event-only format used "why" (new/change/periodic).
    let ev = typeof o.ev === 'string' ? o.ev : o.ev != null ? String(o.ev) : ''
    if (ev === '') {
      ev = ({ new: 'SEEN', change: 'CHANGE', periodic: 'HEARTBEAT' } as Record<string, string>)[String(o.why)] ?? 'UNKNOWN'
    }
    const boot = 'b' in o ? (num(o.b) ?? 0) : ev === 'BOOT' && 'boot' in o ? (num(o.boot) ?? 0) : null
    records.push({
      lineNo: i + 1,
      epoch: o.t == null ? null : (num(o.t) ?? 0),
      upMs: num(o.up) ?? 0,
      ev,
      json: o,
      boot,
      estEpoch: null
    })
  })
  // Back-date: a TIME_SYNC with a real time tells us when its power-up started.
  const bootStart = new Map<number, number>()
  for (const r of records) {
    if (r.ev === 'TIME_SYNC' && r.epoch != null && r.boot != null) bootStart.set(r.boot, r.epoch - Math.trunc(r.upMs / 1000))
  }
  const dated = records.map((r) => {
    const start = r.boot != null ? bootStart.get(r.boot) : undefined
    return r.epoch == null && start != null ? { ...r, estEpoch: start + Math.trunc(r.upMs / 1000) } : r
  })
  return { stream, records: dated, badLines: bad }
}

/**
 * Combines several files of one stream into one log, oldest first: undated files (by name), then
 * dated files (by date). Line numbers are renumbered so they stay unique across files.
 */
export function mergeHubLogs(stream: string, files: [filename: string, text: string][]): ParsedHubLog {
  const isDated = (n: string) => /^[0-9]/.test(n)
  const ordered = [...files].sort(([a], [b]) => Number(isDated(a)) - Number(isDated(b)) || (a < b ? -1 : a > b ? 1 : 0))
  let bad = 0
  let n = 0
  const records = ordered.flatMap(([, text]) => {
    const p = parseHubLog(stream, text)
    bad += p.badLines
    return p.records.map((r) => ({ ...r, lineNo: ++n }))
  })
  return { stream, records, badLines: bad }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10-16.jsonl" -> "Oct 16, 2026"; "undated.jsonl" -> "Undated (clock not set)"; etc. */
export function friendlyLogName(filename: string): string {
  const base = filename.endsWith('.jsonl') ? filename.slice(0, -6) : filename
  let m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(base)
  if (m) return `${MONTHS[parseInt(m[2], 10) - 1] ?? m[2]} ${parseInt(m[3], 10)}, ${m[1]}`
  if (base === 'undated') return 'Undated (clock not set)'
  m = /^undated-([0-9]+)$/.exec(base)
  if (m) return `Undated, part ${parseInt(m[1], 10)}`
  m = /^session_([0-9]+)$/.exec(base)
  if (m) return `Power-up #${parseInt(m[1], 10)} (old format)`
  return filename
}

// ─── Time ──────────────────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, '0')

/** SimpleDateFormat("MMM d HH:mm:ss") in local time. */
function fmtEpoch(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

export function formatLogTime(r: HubLogRecord): string {
  if (r.epoch != null) return fmtEpoch(r.epoch)
  if (r.estEpoch != null) return '≈ ' + fmtEpoch(r.estEpoch)
  if (r.boot != null) return `boot #${r.boot} +` + formatDuration(Math.trunc(r.upMs / 1000))
  return '+' + formatDuration(Math.trunc(r.upMs / 1000)) + ' after boot'
}

export function formatDuration(totalSec: number): string {
  const h = Math.trunc(totalSec / 3600)
  const m = Math.trunc((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`
}

// ─── Labels ────────────────────────────────────────────────────────────────

const chemistryLabel = (i: number | null) =>
  i != null && i >= 0 && i <= 3 ? chemistryName(i as BatteryChemistry) : '?'

const typeLabel = (i: number | null) =>
  i != null && i >= 0 && i <= 4 ? deviceTypeName(i as DeviceType) : 'Device'

const RESET_REASONS: Record<number, string> = {
  1: 'power on', 2: 'reset pin', 3: 'software restart', 4: 'crash', 5: 'interrupt watchdog',
  6: 'task watchdog', 7: 'watchdog', 8: 'deep sleep wake', 9: 'brownout (low power)', 10: 'SDIO'
}

const WIFI_OFF_REASONS: Record<string, string> = {
  requested: 'stopped by the phone',
  station_left: 'the phone left the network',
  no_station: 'no phone joined',
  idle: 'idle timeout',
  max_session: '30-minute limit'
}

/** Camera Logic field -> [label, formatter for the raw wire value]. Matches the Settings UI. */
const CAMERA_FIELDS: Record<string, [string, (v: number) => string]> = {
  enabled: ['Logic bypass', (v) => (v === 0 ? 'on' : 'off')],
  wakeHalfPressHoldSec: ['Wake HP hold', (v) => `${v * 1000} ms`],
  minHalfPressBeforeShutter: ['Min HP before shutter', (v) => `${v * 100} ms`],
  shutterPulseDuration: ['Shutter pulse duration', (v) => `${v * 10} ms`],
  startFrameSpacingTicks: ['Frame spacing', (v) => `${v * 10} ms`],
  postShutterHpHoldTenths: ['Post-shutter HP hold', (v) => `${v * 100} ms`],
  hpDebounceMs: ['HP debounce', (v) => `${v} ms`],
  fpDebounceMs: ['FP debounce', (v) => `${v} ms`],
  frameCount: ['Frame count', (v) => `${v}`],
  maxSequenceCount: ['Max sequence count', (v) => `${v}`],
  fullPressIgnoreGapTenths: ['Full-press ignore gap', (v) => `${v * 100} ms`],
  powerSaveIdleMode: ['Power save idle', (v) => (v !== 0 ? 'on' : 'off')],
  wakeHoldRefreshPolicy: ['Wake hold refresh policy', (v) => `${v}`],
  fullPressWithoutHpPolicy: ['Full press without HP policy', (v) => `${v}`],
  fpAfterMaxSeqCountPolicy: ['FP after max sequences policy', (v) => `${v}`]
}

function batterySummary(r: HubLogRecord): string {
  const ext = int(r, 'extPct')
  let s = ext != null ? `ext ${ext}% (${((int(r, 'extMv') ?? 0) / 1000).toFixed(2)} V)` : 'no ext pack'
  const ip = int(r, 'intPct')
  if (ip != null) s += ` · int ${ip}%`
  return s
}

const q = (v: unknown) => (v == null ? '?' : String(v))

// ─── Hub (camera stream) ───────────────────────────────────────────────────

export function describeCameraRecord(r: HubLogRecord): LogLine {
  switch (r.ev) {
    case 'BOOT':
      return {
        title: 'Hub started',
        detail: `boot #${q(int(r, 'boot'))} · ` + (RESET_REASONS[int(r, 'reset') ?? -1] ?? `reset ${int(r, 'reset')}`) +
          ' · ' + batterySummary(r),
        kind: 'SYSTEM'
      }
    case 'TIME_SYNC':
      return {
        title: 'Clock set by phone',
        detail: bool(r, 'anchor') ? 'earlier entries from this power-up are back-dated (≈)' : '',
        kind: 'SYSTEM'
      }
    case 'PHONE_CONNECTED': return { title: 'Phone connected', detail: 'Bluetooth', kind: 'CONNECTION' }
    case 'PHONE_DISCONNECTED': return { title: 'Phone disconnected', detail: 'Bluetooth', kind: 'CONNECTION' }
    case 'WIFI_ON': case 'WIFI_AP_START': return { title: 'WiFi on', detail: 'log sync', kind: 'CONNECTION' }
    case 'WIFI_OFF': case 'WIFI_AP_STOP': {
      const reason = str(r, 'reason')
      return { title: 'WiFi off', detail: (reason != null ? WIFI_OFF_REASONS[reason] : undefined) ?? reason ?? '', kind: 'CONNECTION' }
    }
    case 'WIFI_ERROR': case 'WIFI_AP_ERROR': return { title: 'WiFi failed to start', detail: '', kind: 'WARNING' }
    case 'WIFI_CLIENT_JOINED': return { title: 'Phone joined Hub WiFi', detail: '', kind: 'CONNECTION' }
    case 'WIFI_CLIENT_LEFT': return { title: 'Phone left Hub WiFi', detail: '', kind: 'CONNECTION' }
    case 'TRIGGER': {
      if (str(r, 'mode') === 'bypass') {
        return { title: 'Shutter (logic bypass)', detail: `×${int(r, 'count') ?? 1} · shutter #${q(int(r, 'shutter'))}`, kind: 'TRIGGER' }
      }
      const frames = int(r, 'frames') ?? 0
      const parts = [`shutter #${q(int(r, 'shutter'))}`]
      const burst = int(r, 'burst')
      if (burst != null && burst > 1) parts.push(`burst ${burst} in this activity`)
      if (bool(r, 'cold')) parts.push('cold full-press')
      const ms = int(r, 'ms')
      if (ms != null) parts.push(`${(ms / 1000).toFixed(1)} s`)
      return { title: `Trigger: ${frames} frame${frames === 1 ? '' : 's'}`, detail: parts.join(' · '), kind: 'TRIGGER' }
    }
    case 'TRIGGER_REJECTED': {
      const reason = str(r, 'reason')
      const text = ({
        ignore_gap: 'inside the full-press ignore gap',
        during_burst: 'a burst was already running',
        max_sequences: 'max sequence count reached'
      } as Record<string, string>)[reason ?? ''] ?? reason ?? ''
      const suppressed = int(r, 'suppressed') ?? 0
      return { title: 'Trigger ignored', detail: text + (suppressed > 0 ? ` · +${suppressed} more` : ''), kind: 'WARNING' }
    }
    case 'SETTING': {
      const field = str(r, 'field')
      let label: string
      let fmt: (v: string | null) => string
      switch (field) {
        case 'name': label = 'Name'; fmt = (v) => `"${v}"`; break
        case 'kit': label = 'Kit'; fmt = (v) => (v === '0' ? 'none' : `Kit ${v}`); break
        case 'kitName': label = 'Kit name'; fmt = (v) => `"${v}"`; break
        case 'chemistry': label = 'Battery chemistry'; fmt = (v) => chemistryLabel(v != null && /^-?\d+$/.test(v) ? parseInt(v, 10) : null); break
        case 'cells': label = 'Cell count'; fmt = (v) => `${v}`; break
        default: label = field ?? '?'; fmt = (v) => `${v}`
      }
      return { title: `Setting changed: ${label}`, detail: `${fmt(str(r, 'old'))} → ${fmt(str(r, 'new'))}`, kind: 'SETTING' }
    }
    case 'CAMERA_SETTING': {
      const field = str(r, 'field') ?? '?'
      const [label, fmt] = CAMERA_FIELDS[field] ?? [field, (v: number) => `${v}`]
      return { title: `Camera logic: ${label}`, detail: `${fmt(int(r, 'old') ?? 0)} → ${fmt(int(r, 'new') ?? 0)}`, kind: 'SETTING' }
    }
    case 'CAMERA_SETTING_REJECTED': {
      const reason = str(r, 'reason')
      return {
        title: 'Camera logic change rejected',
        detail: reason === 'busy' ? 'camera was mid-sequence' : reason === 'out_of_range' ? 'a value was out of range' : 'bad format',
        kind: 'WARNING'
      }
    }
    case 'SHUTTER_RESET': return { title: 'Shutter count reset', detail: `was ${q(int(r, 'old'))}`, kind: 'SETTING' }
    case 'FACTORY_RESET': return { title: 'Factory reset', detail: 'camera logic back to defaults', kind: 'SETTING' }
    case 'CALIBRATION': return { title: 'Battery calibrated', detail: `${str(r, 'battery')} → ${int(r, 'targetMv')} mV`, kind: 'SETTING' }
    case 'CALIBRATION_RESET': return { title: 'Battery calibration reset', detail: str(r, 'battery') ?? '', kind: 'SETTING' }
    case 'BATTERY': {
      const level = str(r, 'level')
      return {
        title: `Battery ${q(int(r, 'extPct'))}%`,
        detail: `was ${q(int(r, 'prevPct'))}%` + (level === 'low' ? ' · LOW' : level === 'critical' ? ' · CRITICAL' : ''),
        kind: level === 'ok' ? 'BATTERY' : 'WARNING'
      }
    }
    case 'EXT_BATT_ATTACHED': return { title: 'Battery pack attached', detail: batterySummary(r), kind: 'BATTERY' }
    case 'EXT_BATT_REMOVED': return { title: 'Battery pack removed', detail: batterySummary(r), kind: 'WARNING' }
    case 'INT_BATT_LOW': return { title: 'Internal battery low', detail: `${q(int(r, 'intPct'))}% · ${str(r, 'level')}`, kind: 'WARNING' }
    case 'PC_TICK': case 'M0_TICK':
      return { title: `Test record #${q(int(r, 'seq') ?? int(r, 'tick'))}`, detail: 'bench test build', kind: 'TEST' }
    default:
      return { title: r.ev, detail: '', kind: 'SYSTEM' }  // older/internal events, shown as-is
  }
}

// ─── Nearby devices (scan stream) ──────────────────────────────────────────

/** Everything the Hub logged about one nearby device, oldest first. */
export interface DeviceLog {
  address: string
  deviceType: DeviceType
  kit: number
  records: HubLogRecord[]
}

export function groupScanLogByDevice(records: HubLogRecord[]): DeviceLog[] {
  const groups = new Map<string, HubLogRecord[]>()
  for (const r of records) {
    const addr = str(r, 'addr')
    if (addr == null) continue
    const key = addr.toUpperCase()
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  return [...groups.entries()]
    .map(([address, recs]) => {
      const last = recs[recs.length - 1]
      return { address, deviceType: deviceTypeOf(int(last, 'type') ?? 0), kit: int(last, 'kit') ?? 0, records: recs }
    })
    .sort((a, b) =>
      Number(a.kit === 0) - Number(b.kit === 0) || a.kit - b.kit || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
}

/** prev = this device's previous record, used to show what a CHANGE changed from. */
export function describeScanRecord(r: HubLogRecord, prev: HubLogRecord | null | undefined): LogLine {
  const p = (k: string) => (prev ? int(prev, k) : null)
  switch (r.ev) {
    case 'SEEN': return { title: 'Seen', detail: batterySummary(r) + ` · ${int(r, 'rssi')} dBm`, kind: 'DEVICE' }
    case 'LOST': return { title: 'Lost', detail: `not heard for ${int(r, 'silentSec') ?? 20} s`, kind: 'WARNING' }
    case 'HEARTBEAT':
      return { title: 'Still here', detail: batterySummary(r) + ` · ${int(r, 'rssiAvg') ?? int(r, 'rssi')} dBm avg`, kind: 'DEVICE' }
    case 'CHANGE': {
      const what = (str(r, 'changed') ?? '').split(',').filter((w) => w.trim() !== '')
      const parts = what.map((w) => {
        switch (w) {
          case 'kit': return `Kit ${q(p('kit'))} → ${int(r, 'kit')}`
          case 'shutter': return `shutter ${q(p('shutter'))} → ${int(r, 'shutter')}`
          case 'ext': return int(r, 'extPct') != null ? `pack attached (${int(r, 'extPct')}%)` : 'pack removed'
          case 'battery': return `battery ${q(p('extPct'))}% → ${int(r, 'extPct')}%`
          case 'type': return `type ${typeLabel(p('type'))} → ${typeLabel(int(r, 'type'))}`
          case 'cells': return `cells ${q(p('cells'))} → ${int(r, 'cells')}`
          case 'chem': return `chemistry ${chemistryLabel(p('chem'))} → ${chemistryLabel(int(r, 'chem'))}`
          case 'configured': return int(r, 'cfg') === 1 ? 'configured' : 'reset to unconfigured'
          default: return w
        }
      })
      const title = what.length === 1 && what[0] === 'shutter'
        ? 'Shutter fired'
        : what.every((w) => w === 'battery' || w === 'ext') ? 'Battery' : 'Changed'
      return {
        title,
        detail: parts.join(' · ') || batterySummary(r),
        kind: what.includes('ext') && int(r, 'extPct') == null ? 'WARNING' : 'DEVICE'
      }
    }
    default:
      return { title: r.ev, detail: batterySummary(r), kind: 'DEVICE' }
  }
}
