// Device dashboard. Port of DeviceScreen (DeviceScreen.kt): dual battery card, stats, camera
// card, and the connection history that's logged while this screen is open.

import { useEffect, useRef, useState } from 'react'
import { formatTimestamp, volts } from '../../../shared/scanList'
import {
  BleDevice, DeviceHistoryEntry, DeviceType, deviceTypeName, historyEntryFor
} from '../../../shared/types'
import { api } from '../api'
import { CameraCard, Progress, Screen, StatItem, batteryColor, connectionText } from '../components'
import { resetShutterCount } from './GroupScreen'

export default function DeviceScreen(props: { device: BleDevice; onOpenSettings: () => void; onBack: () => void }) {
  const d = props.device
  const [history, setHistory] = useState<DeviceHistoryEntry[]>([])
  const [resetStatus, setResetStatus] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Connection-aware event logger: diff successive live updates of this device.
  const prev = useRef<{ connected: boolean; lastVolt: number; shutter: number; extPresent: boolean } | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const log = (evt: string, dev: BleDevice) => {
    const entry = historyEntryFor(evt, dev)
    queue.current = queue.current.then(() => api.appendHistory(dev.address, entry).then(setHistory))
  }

  useEffect(() => {
    // Always load existing history so logs are visible even when not connected.
    queue.current = queue.current.then(() => api.loadHistory(d.address).then(setHistory))
    prev.current = { connected: d.isConnected, lastVolt: d.extVoltageMillivolts, shutter: d.shutterCount, extPresent: d.extBatteryPercent >= 0 }
    // Log Connect on entry only if already in range.
    if (d.isConnected) log('Connect', d)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.address])

  useEffect(() => {
    const p = prev.current
    if (!p) return
    if (!p.connected && d.isConnected) {
      // Device came back into range
      log('Connect', d)
      p.lastVolt = d.extVoltageMillivolts
      p.shutter = d.shutterCount
      p.extPresent = d.extBatteryPercent >= 0
    } else if (p.connected && !d.isConnected) {
      // Device went out of range
      log('Disconnect', d)
    }
    p.connected = d.isConnected
    if (d.isConnected) {
      if (d.shutterCount !== p.shutter) {
        log('Shutter', d)
        p.shutter = d.shutterCount
      }
      if (Math.abs(d.extVoltageMillivolts - p.lastVolt) >= 1000 && d.extVoltageMillivolts > 0) {
        log('Battery', d)
        p.lastVolt = d.extVoltageMillivolts
      }
      const present = d.extBatteryPercent >= 0
      if (p.extPresent && !present) log('ExtBattRemoved', d)
      if (!p.extPresent && present) log('ExtBattAttached', d)
      p.extPresent = present
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d])

  const hasExt = d.extBatteryPercent >= 0
  const extColor = batteryColor(Math.max(0, d.extBatteryPercent))
  const intColor = batteryColor(d.batteryPercent)

  return (
    <Screen
      title={d.name ?? d.address}
      onBack={() => { void api.gattDisconnect(); props.onBack() }}
      actions={<button className="icon" title="Settings" onClick={props.onOpenSettings}>⚙</button>}
    >
      <div className="card col gap8">
        <div className="row between">
          <span className="body-l">External Battery</span>
          {hasExt && <span className="body-l semibold" style={{ color: extColor }}>{d.extBatteryPercent}%</span>}
        </div>
        {hasExt ? (
          <>
            <Progress value={d.extBatteryPercent / 100} color={extColor} />
            <span className="body-s muted">{volts(d.extVoltageMillivolts)} V</span>
          </>
        ) : (
          <span className="error">No Battery Connected</span>
        )}
        <div className="row between" style={{ marginTop: 4 }}>
          <span className="body-l">Internal Battery</span>
          <span className="body-l semibold" style={{ color: intColor }}>{d.batteryPercent}%</span>
        </div>
        <Progress value={d.batteryPercent / 100} color={intColor} />
        <span className="body-s muted">{volts(d.voltageMillivolts)} V</span>
      </div>

      <div className="card row evenly">
        <StatItem label="Type" value={deviceTypeName(d.deviceType)} />
        <StatItem label="Kit" value={d.groupId === 0 ? 'None' : `${d.groupId}`} />
        {d.hubNearbyCount >= 0 && <StatItem label="Hub Hears" value={`${d.hubNearbyCount}`} />}
        <StatItem
          label={d.isConnected ? 'Connection' : 'Last Seen'}
          value={connectionText(d, '--')}
          color={d.isConnected ? 'var(--green)' : undefined}
        />
      </div>

      {d.deviceType === DeviceType.CAMERA && (
        <CameraCard
          device={d}
          resetStatus={resetStatus}
          onReset={async () => {
            setResetStatus('Connecting…')
            setResetStatus(await resetShutterCount(d.address))
          }}
        />
      )}

      <div className="title-m semibold">Connection History</div>
      {history.length === 0 ? (
        <div className="muted">No history yet. Events are logged automatically.</div>
      ) : (
        <div className="card" style={{ padding: '0 16px' }}>
          {history.map((e, i) => (
            <HistoryRow
              key={`${e.timestamp}-${i}`}
              entry={e}
              deviceType={d.deviceType}
              expanded={expanded.has(i)}
              onToggle={() => setExpanded((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })}
            />
          ))}
        </div>
      )}
    </Screen>
  )
}

const BADGES: Record<string, [string, string]> = {
  Connect: ['Connect', 'var(--primary)'],
  Disconnect: ['Disconnect', 'var(--on-variant)'],
  Shutter: ['Shutter', 'var(--secondary)'],
  Battery: ['Battery', 'var(--tertiary)'],
  ExtBattRemoved: ['Batt Out', 'var(--error)'],
  ExtBattAttached: ['Batt In', '#2E7D32'],
  PumpRun: ['Pump Run', '#1565C0']
}

const hex2 = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0')

function HistoryRow(props: { entry: DeviceHistoryEntry; deviceType: DeviceType; expanded: boolean; onToggle: () => void }) {
  const e = props.entry
  const [label, color] = BADGES[e.eventType] ?? [e.eventType, 'var(--outline)']
  const isCam = props.deviceType === DeviceType.CAMERA
  return (
    <div className="list-row" onClick={props.onToggle}>
      <div className="row">
        <span className="body-s muted">{formatTimestamp(e.timestamp)}</span>
        <span className="badge" style={{ background: color }}>{label}</span>
        {isCam && <span className="body-s muted">S: {e.shutterCount}</span>}
        <span className="grow" />
        <span className="semibold" style={{ color: batteryColor(Math.max(0, e.batteryPercent)) }}>
          {e.batteryPercent >= 0 ? `${e.batteryPercent}%` : '--'}
        </span>
        <span className="body-s" style={{ minWidth: 64, textAlign: 'right' }}>
          {e.voltageMillivolts > 0 ? `${volts(e.voltageMillivolts)} V` : '--'}
        </span>
      </div>
      {props.expanded && (
        <div className="col body-s muted" style={{ padding: '4px 8px 4px', gap: 2 }}>
          <span>Int: {e.intBatteryPercent}% / {volts(e.intVoltageMillivolts)} V</span>
          <span>RSSI: {e.rssi} dBm</span>
          {isCam && <span>Camera: state={hex2(e.cameraState)} flags={hex2(e.cameraLiveFlags)}</span>}
          {e.firmwareBuild !== '' && <span>FW: {e.firmwareBuild}</span>}
        </div>
      )}
    </div>
  )
}
