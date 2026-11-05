// Device dashboard (the device panel's Overview tab). Port of DeviceScreen (DeviceScreen.kt): dual
// battery card, stats, camera card, and the connection history. useDeviceHistory logs events while
// the device's panel is open, whichever tab is showing.

import { useEffect, useRef, useState } from 'react'
import { formatTimestamp, volts } from '../../../shared/scanList'
import {
  BleDevice, DeviceHistoryEntry, DeviceType, deviceTypeName, historyEntryFor
} from '../../../shared/types'
import { api } from '../api'
import { CameraCard, Progress, StatItem, batteryColor, connectionText } from '../components'
import { resetShutterCount } from './GroupScreen'

/** Connection-aware event logger: diffs successive live updates of this device into its history file. */
export function useDeviceHistory(d: BleDevice): DeviceHistoryEntry[] {
  const [history, setHistory] = useState<DeviceHistoryEntry[]>([])
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

  return history
}

export default function DeviceOverview(props: { device: BleDevice; history: DeviceHistoryEntry[] }) {
  const d = props.device
  const history = props.history
  const [resetStatus, setResetStatus] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const hasExt = d.extBatteryPercent >= 0
  const extColor = batteryColor(Math.max(0, d.extBatteryPercent))
  const intColor = batteryColor(d.batteryPercent)

  return (
    <div className="grid-2">
      <div className="stack">
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
          <StatItem label="Signal" value={`${d.rssi} dBm`} />
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
      </div>

      <div className="card col" style={{ gap: 0, padding: '12px 16px' }}>
        <div className="title-m" style={{ marginBottom: 4 }}>Connection History</div>
        {history.length === 0 ? (
          <div className="muted">No history yet. Events are logged automatically.</div>
        ) : (
          history.map((e, i) => (
            <HistoryRow
              key={`${e.timestamp}-${i}`}
              entry={e}
              deviceType={d.deviceType}
              expanded={expanded.has(i)}
              onToggle={() => setExpanded((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })}
            />
          ))
        )}
      </div>
    </div>
  )
}

const BADGES: Record<string, [string, string]> = {
  Connect: ['Connect', '#1f5fbf'],
  Disconnect: ['Disconnect', '#3a4a63'],
  Shutter: ['Shutter', '#2b7bb9'],
  Battery: ['Battery', '#9a6b12'],
  ExtBattRemoved: ['Batt Out', '#b23a3a'],
  ExtBattAttached: ['Batt In', '#2a7f57'],
  PumpRun: ['Pump Run', '#1565c0']
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
