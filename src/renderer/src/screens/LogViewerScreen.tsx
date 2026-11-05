// Readable view of downloaded Camera Hub log files. Port of LogViewerScreen.kt.
//  - camera stream: the Hub's own events, newest first
//  - scan stream: one entry per nearby device; click a device for its history

import { useEffect, useMemo, useState } from 'react'
import {
  DeviceLog, LogKind, LogLine, ParsedHubLog, describeCameraRecord, describeScanRecord, formatLogTime, friendlyLogName,
  groupScanLogByDevice, int, mergeHubLogs
} from '../../../shared/hubLogParser'
import { HUB_STREAM_SCAN } from '../../../shared/hubProtocol'
import { CachedHubLog, deviceIcon, deviceTypeName } from '../../../shared/types'
import { api } from '../api'
import { Screen } from '../components'

const ACCENT: Record<LogKind, string> = {
  TRIGGER: '#1565C0',
  SETTING: '#6A1B9A',
  CONNECTION: '#00838F',
  BATTERY: '#2E7D32',
  WARNING: 'var(--error)',
  DEVICE: 'var(--primary)',
  SYSTEM: 'var(--on-variant)',
  TEST: 'var(--outline)'
}

const isTest = (ev: string) => ev === 'PC_TICK' || ev === 'M0_TICK'

export default function LogViewerScreen(props: {
  entries: CachedHubLog[]
  stream: string
  initialDevice: string | null
  nameForAddress: (addr: string) => string | null
  onBack: () => void
}) {
  const [log, setLog] = useState<ParsedHubLog | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(props.initialDevice?.toUpperCase() ?? null)
  const [showTests, setShowTests] = useState(false)
  // Opened straight onto one device: Back leaves the viewer instead of showing the list.
  const deviceOnly = props.initialDevice != null
  const isScan = props.stream === HUB_STREAM_SCAN

  useEffect(() => {
    api.readLogTexts(props.entries)
      .then((files) => setLog(mergeHubLogs(props.stream, files)))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }, [props.entries, props.stream])

  const devices = useMemo(() => (log && isScan ? groupScanLogByDevice(log.records) : []), [log, isScan])
  const device = devices.find((x) => x.address === selected)
  const filesLabel = props.entries.length === 1 ? friendlyLogName(props.entries[0].filename) : `${props.entries.length} log files combined`
  const deviceName = (x: DeviceLog) => props.nameForAddress(x.address) ?? `${deviceTypeName(x.deviceType)} …${x.address.slice(-5)}`
  const back = () => { if (selected != null && !deviceOnly) setSelected(null); else props.onBack() }

  let body: React.ReactNode
  if (loadError != null) {
    body = <div className="error">Couldn't read the file: {loadError}</div>
  } else if (log == null) {
    body = <div>Loading…</div>
  } else if (!isScan) {
    // Hub's own events
    const hasTests = log.records.some((r) => isTest(r.ev))
    const shown = log.records.filter((r) => showTests || !isTest(r.ev)).reverse()
    body = (
      <>
        <LogSummary log={log} text={`${shown.length} events, newest first`} />
        {hasTests && (
          <button className={'chip' + (showTests ? ' selected' : '')} onClick={() => setShowTests(!showTests)}>
            {showTests ? '✓ ' : ''}Show test records
          </button>
        )}
        {shown.map((r) => <LogRow key={r.lineNo} time={formatLogTime(r)} line={describeCameraRecord(r)} />)}
      </>
    )
  } else if (selected != null && device == null) {
    // Opened for a device the downloaded logs don't mention (yet).
    body = (
      <div>
        No log entries for {props.nameForAddress(selected) ?? selected} in the downloaded files. Download the Hub's latest
        Nearby devices log (Camera Logs → Connect to Hub WiFi) and try again.
      </div>
    )
  } else if (device != null) {
    // One nearby device's history
    const recs = device.records
    const lines = recs.map((r, i) => [r, describeScanRecord(r, recs[i - 1])] as const).reverse()
    body = (
      <>
        <div className="muted">
          {deviceTypeName(device.deviceType)} · {device.kit === 0 ? 'No Kit' : `Kit ${device.kit}`} · {device.address}
        </div>
        {lines.map(([r, line]) => <LogRow key={r.lineNo} time={formatLogTime(r)} line={line} />)}
      </>
    )
  } else {
    // Device list
    body = (
      <>
        <LogSummary log={log} text={`${devices.length} devices heard · click one for its history`} />
        {devices.length === 0 && <div>No devices in this file.</div>}
        {devices.map((x) => {
          const last = x.records[x.records.length - 1]
          const ext = int(last, 'extPct')
          return (
            <div key={x.address} className="card compact clickable row" style={{ gap: 10 }} onClick={() => setSelected(x.address)}>
              <span className="title-l">{deviceIcon(x.deviceType)}</span>
              <div className="col grow" style={{ gap: 0 }}>
                <span className="body-l semibold">{deviceName(x)}</span>
                <span className="body-s muted">
                  {x.kit === 0 ? 'No Kit' : `Kit ${x.kit}`} · {ext != null ? `ext ${ext}%` : 'no ext pack'} · {x.records.length} entries
                </span>
                <span className="label-s muted">
                  Last: {describeScanRecord(last, x.records[x.records.length - 2]).title} · {formatLogTime(last)}
                </span>
              </div>
              <span className="title-l">›</span>
            </div>
          )
        })}
      </>
    )
  }

  return (
    <Screen
      title={device ? deviceName(device) : isScan ? 'Devices the Hub heard' : 'Hub log'}
      subtitle={filesLabel}
      onBack={back}
    >
      {body}
    </Screen>
  )
}

function LogSummary({ log, text }: { log: ParsedHubLog; text: string }) {
  return (
    <div className="col">
      <div>{text}</div>
      {log.badLines > 0 && (
        <div className="body-s error">
          {log.badLines} unreadable line{log.badLines === 1 ? '' : 's'} skipped (usually a record cut off by a power loss)
        </div>
      )}
      {log.records.some((r) => r.epoch == null) && (
        <div className="body-s muted">
          Times marked ≈ were back-dated after the phone set the Hub's clock. "boot #N +m:ss" means no phone set the
          clock during that power-up.
        </div>
      )}
    </div>
  )
}

function LogRow({ time, line }: { time: string; line: LogLine }) {
  return (
    <div className="col" style={{ borderBottom: '1px solid var(--divider)', paddingBottom: 8 }}>
      <div className="row top" style={{ gap: 10 }}>
        <span className="label-s muted log-time">{time}</span>
        <div className="col grow" style={{ gap: 0 }}>
          <span className="semibold" style={{ color: ACCENT[line.kind] }}>{line.title}</span>
          {line.detail !== '' && <span className="body-s muted">{line.detail}</span>}
        </div>
      </div>
    </div>
  )
}
