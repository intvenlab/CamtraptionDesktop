// Graphs tab: battery, signal and shutter activity over time, from live telemetry this app records
// and/or Camera Hub SD logs already downloaded in Camera Logs. Filter by Kit, Hub or device.

import { useEffect, useMemo, useRef, useState } from 'react'
import { HubLogRecord, mergeHubLogs } from '../../../shared/hubLogParser'
import { HUB_STREAM_CAMERA, HUB_STREAM_SCAN } from '../../../shared/hubProtocol'
import {
  Metric, Series, cameraLogTriggerSeries, scanLogSeries, telemetrySeries
} from '../../../shared/series'
import { BleDevice, DeviceType, TelemetrySample, deviceIcon } from '../../../shared/types'
import { api } from '../api'
import Chart, { ChartLine, SERIES_COLORS } from '../Chart'
import { Screen, Segmented } from '../components'

type Source = 'live' | 'log' | 'both'
type Range = '1h' | '24h' | '7d' | '30d' | 'all'
/** "kit:3", "hub:AA:BB:…" or "dev:AA:BB:…". */
type ScopeKey = string

const RANGE_MS: Record<Range, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: Infinity }
const LIVE_REFRESH_MS = 30_000

const CHARTS: { metric: Metric; title: string; unit: string; decimals: number; help: string }[] = [
  { metric: 'voltage', title: 'Battery voltage', unit: 'V', decimals: 2, help: 'Solid = external pack, dashed = internal cell' },
  { metric: 'percent', title: 'Battery level', unit: '%', decimals: 0, help: 'Solid = external pack, dashed = internal cell' },
  { metric: 'rssi', title: 'Signal strength', unit: 'dBm', decimals: 0, help: 'As heard by this PC (live) or by the Hub (logs)' },
  { metric: 'shutters', title: 'Shutters per hour', unit: '', decimals: 0, help: 'Shutter count increases, plus triggers in the Hub camera log' },
  { metric: 'hubHeard', title: 'Devices heard by Hub', unit: '', decimals: 0, help: 'Distinct devices in the Hub scan log per 10 minutes (logs only)' }
]

interface HubLogs { scan: HubLogRecord[]; camera: HubLogRecord[]; files: number }

export default function GraphsScreen(props: {
  devices: BleDevice[]
  groupNames: Record<number, string>
  nameForAddress: (addr: string) => string | null
}) {
  const [source, setSource] = useState<Source>('both')
  const [range, setRange] = useState<Range>('24h')
  const [scope, setScope] = useState<Set<ScopeKey>>(new Set())
  const [metrics, setMetrics] = useState<Set<Metric>>(new Set(CHARTS.map((c) => c.metric)))
  const [telemetry, setTelemetry] = useState<Record<string, TelemetrySample[]>>({})
  const [logs, setLogs] = useState<Record<string, HubLogs>>({})
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [logsVersion, setLogsVersion] = useState(0)

  const configured = useMemo(() => props.devices.filter((d) => d.isConfigured), [props.devices])
  const kits = useMemo(() => [...new Set(configured.map((d) => d.groupId).filter((g) => g !== 0))].sort((a, b) => a - b), [configured])
  // Hubs: anything advertising a Hub count, plus Cameras that have downloaded logs on this PC.
  const hubs = useMemo(() => configured.filter((d) => d.hubNearbyCount >= 0 || (logs[d.address]?.files ?? 0) > 0), [configured, logs])
  const name = (addr: string) => props.nameForAddress(addr) ?? `…${addr.slice(-5)}`

  // Which device addresses the scope covers (null = everything).
  const allowed = useMemo<Set<string> | null>(() => {
    if (scope.size === 0) return null
    const set = new Set<string>()
    for (const key of scope) {
      if (key.startsWith('kit:')) {
        const id = Number(key.slice(4))
        configured.filter((d) => d.groupId === id).forEach((d) => set.add(d.address))
      } else if (key.startsWith('hub:')) {
        const hub = key.slice(4)
        set.add(hub)
        for (const r of logs[hub]?.scan ?? []) {
          const a = r.json.addr
          if (typeof a === 'string') set.add(a.toUpperCase())
        }
      } else if (key.startsWith('dev:')) {
        set.add(key.slice(4))
      }
    }
    return set
  }, [scope, configured, logs])

  const from = range === 'all' ? 0 : now - RANGE_MS[range]
  const wantLive = source !== 'log'
  const wantLog = source !== 'live'

  // Live telemetry: reload on filter change and every 30 s (the recorder samples every 30 s).
  useEffect(() => {
    if (!wantLive) return
    let cancelled = false
    const load = () => {
      const t = Date.now()
      const addrs = configured.map((d) => d.address)
      void api.loadTelemetry(addrs, range === 'all' ? 0 : t - RANGE_MS[range], t).then((r) => {
        if (cancelled) return
        setTelemetry(r)
        setNow(t)
      })
    }
    load()
    const timer = window.setInterval(load, LIVE_REFRESH_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantLive, range, configured.length])

  // Hub logs: every downloaded file for every Camera, parsed once per refresh.
  const cameraAddrs = configured.filter((d) => d.deviceType === DeviceType.CAMERA).map((d) => d.address).join(',')
  useEffect(() => {
    if (!wantLog) return
    let cancelled = false
    setLoadingLogs(true)
    void (async () => {
      const out: Record<string, HubLogs> = {}
      for (const addr of cameraAddrs.split(',').filter(Boolean)) {
        const entries = await api.loadCatalog(addr)
        if (entries.length === 0) continue
        const read = async (stream: string) => {
          const files = await api.readLogTexts(entries.filter((e) => e.stream === stream))
          return mergeHubLogs(stream, files).records
        }
        out[addr] = { scan: await read(HUB_STREAM_SCAN), camera: await read(HUB_STREAM_CAMERA), files: entries.length }
      }
      if (!cancelled) {
        setLogs(out)
        setLoadingLogs(false)
        setNow(Date.now())
      }
    })()
    return () => { cancelled = true }
  }, [wantLog, cameraAddrs, logsVersion])

  const logFiles = Object.values(logs).reduce((n, l) => n + l.files, 0)

  // Stable colour per address across every chart.
  const colorOf = useMemo(() => {
    const addrs = new Set<string>(configured.map((d) => d.address))
    Object.values(logs).forEach((l) => l.scan.forEach((r) => { if (typeof r.json.addr === 'string') addrs.add(r.json.addr.toUpperCase()) }))
    const sorted = [...addrs].sort()
    return (addr: string) => SERIES_COLORS[Math.max(0, sorted.indexOf(addr)) % SERIES_COLORS.length]
  }, [configured, logs])

  const charts = useMemo(() => CHARTS.filter((c) => metrics.has(c.metric)).map((c) => {
    const series: Series[] = []
    if (wantLive) series.push(...telemetrySeries(telemetry, c.metric, from, now))
    if (wantLog) {
      for (const [hub, l] of Object.entries(logs)) {
        series.push(...scanLogSeries(l.scan, c.metric, hub, from, now))
        if (c.metric === 'shutters') series.push(...cameraLogTriggerSeries(l.camera, hub, from, now))
      }
    }
    // Hub-level series ("heard", camera triggers) are keyed by the Hub's own address, so this covers them too.
    const visible = allowed == null ? series : series.filter((s) => allowed.has(s.address))
    const lines: ChartLine[] = visible.map((s) => {
      let label = name(s.address)
      if (s.key.endsWith('|heard')) label = `${label} heard`
      else if (s.key.endsWith('|trig')) label = `${label} triggers`
      else if (s.part !== '') label = `${label} ${s.part}`
      if (source === 'both') label += s.source === 'live' ? ' · live' : ' · log'
      return { series: s, label, color: colorOf(s.address), dashed: s.part === 'int' || (source === 'both' && s.source === 'log' && !s.bars) }
    })
    return { ...c, lines }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [metrics, telemetry, logs, from, now, allowed, source, colorOf, wantLive, wantLog])

  return (
    <Screen
      title="Graphs"
      subtitle={`${wantLive ? 'Live telemetry recorded by this PC' : ''}${wantLive && wantLog ? ' + ' : ''}${wantLog ? `${logFiles} downloaded Hub log file${logFiles === 1 ? '' : 's'}` : ''}`}
      actions={wantLog && <button className="outlined small" disabled={loadingLogs} onClick={() => setLogsVersion((v) => v + 1)}>{loadingLogs ? 'Loading…' : 'Reload logs'}</button>}
    >
      <div className="card toolbar">
        <div className="group">
          <span className="label-m">Source</span>
          <Segmented<Source> value={source} onChange={setSource} options={[{ id: 'live', label: 'Live' }, { id: 'log', label: 'Hub logs' }, { id: 'both', label: 'Both' }]} />
        </div>
        <div className="group">
          <span className="label-m">Range</span>
          <Segmented<Range> value={range} onChange={setRange} options={[{ id: '1h', label: '1 h' }, { id: '24h', label: '24 h' }, { id: '7d', label: '7 d' }, { id: '30d', label: '30 d' }, { id: 'all', label: 'All' }]} />
        </div>
        <ScopePicker
          scope={scope}
          onChange={setScope}
          kits={kits}
          groupNames={props.groupNames}
          hubs={hubs}
          devices={configured}
          name={name}
        />
        <div className="group">
          <span className="label-m">Charts</span>
          {CHARTS.map((c) => (
            <button
              key={c.metric}
              className={'chip' + (metrics.has(c.metric) ? ' selected' : '')}
              onClick={() => setMetrics((m) => { const n = new Set(m); if (n.has(c.metric)) n.delete(c.metric); else n.add(c.metric); return n })}
            >
              {c.title}
            </button>
          ))}
        </div>
      </div>

      {wantLog && !loadingLogs && logFiles === 0 && (
        <div className="card body-s muted">
          No Hub logs on this PC yet. Select a Hub in Devices, open its Hub tab and download logs in Camera Logs.
        </div>
      )}

      <div className="grid-2">
        {charts.map((c) => (
          <div key={c.metric} className="card chart-card">
            <div className="row between" style={{ marginBottom: 4 }}>
              <span className="title-m">{c.title}</span>
              <span className="label-s muted">{c.help}</span>
            </div>
            {c.lines.length === 0 ? (
              <div className="empty" style={{ minHeight: 200 }}>
                {c.metric === 'hubHeard' && !wantLog ? 'Hub logs only' : 'No data for this range'}
              </div>
            ) : (
              <Chart lines={c.lines} unit={c.unit} decimals={c.decimals} />
            )}
          </div>
        ))}
      </div>
    </Screen>
  )
}

function ScopePicker(props: {
  scope: Set<ScopeKey>
  onChange: (s: Set<ScopeKey>) => void
  kits: number[]
  groupNames: Record<number, string>
  hubs: BleDevice[]
  devices: BleDevice[]
  name: (addr: string) => string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const toggle = (k: ScopeKey) => {
    const n = new Set(props.scope)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    props.onChange(n)
  }
  const kitLabel = (id: number) => `Kit ${id}${props.groupNames[id] ? ` · ${props.groupNames[id]}` : ''}`
  const labelOf = (k: ScopeKey) =>
    k.startsWith('kit:') ? kitLabel(Number(k.slice(4))) : k.startsWith('hub:') ? `Hub ${props.name(k.slice(4))}` : props.name(k.slice(4))

  return (
    <div className="group" ref={ref} style={{ position: 'relative' }}>
      <span className="label-m">Show</span>
      {props.scope.size === 0 ? (
        <span className="chip selected" style={{ cursor: 'default' }}>All devices</span>
      ) : (
        [...props.scope].map((k) => (
          <button key={k} className="chip selected" title="Remove" onClick={() => toggle(k)}>{labelOf(k)} ✕</button>
        ))
      )}
      <button className="outlined small" onClick={() => setOpen((o) => !o)}>Filter…</button>
      {props.scope.size > 0 && <button className="text small" onClick={() => props.onChange(new Set())}>Clear</button>}
      {open && (
        <div className="popover">
          {props.kits.length > 0 && <div className="section-label">Kits</div>}
          {props.kits.map((id) => (
            <label key={id}><input type="checkbox" checked={props.scope.has(`kit:${id}`)} onChange={() => toggle(`kit:${id}`)} />{kitLabel(id)}</label>
          ))}
          {props.hubs.length > 0 && <div className="section-label">Hubs (and what they heard)</div>}
          {props.hubs.map((d) => (
            <label key={d.address}><input type="checkbox" checked={props.scope.has(`hub:${d.address}`)} onChange={() => toggle(`hub:${d.address}`)} />📷 {props.name(d.address)}</label>
          ))}
          <div className="section-label">Devices</div>
          {props.devices.map((d) => (
            <label key={d.address}>
              <input type="checkbox" checked={props.scope.has(`dev:${d.address}`)} onChange={() => toggle(`dev:${d.address}`)} />
              {deviceIcon(d.deviceType)} {props.name(d.address)}
              <span className="label-s muted" style={{ marginLeft: 'auto' }}>{d.groupId === 0 ? '' : `Kit ${d.groupId}`}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
