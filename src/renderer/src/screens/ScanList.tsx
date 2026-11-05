// Sidebar scan list. Port of BleMonitorScreen + its cards (MainActivity.kt), compacted for a
// desktop sidebar: same buildScanList sections, plus search, collapsible Kits and selection.

import { useState } from 'react'
import { ScanListItem, buildScanList, formatThousands, volts } from '../../../shared/scanList'
import { BleDevice, DeviceType, deviceIcon } from '../../../shared/types'
import { ConfirmDialog, Progress, batteryColor, connectionText } from '../components'
import { PaneRoot } from '../nav'

export default function ScanList(props: {
  devices: BleDevice[]
  groupNames: Record<number, string>
  selected: PaneRoot
  onSelect: (root: PaneRoot) => void
  onForgetKit: (groupId: number) => void
  onForgetDevice: (d: BleDevice) => void
}) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [forget, setForget] = useState<{ kind: 'kit'; groupId: number; count: number } | { kind: 'device'; device: BleDevice } | null>(null)

  const q = query.trim().toLowerCase()
  const matches = (d: BleDevice) => q === '' || (d.name ?? '').toLowerCase().includes(q) || d.address.toLowerCase().includes(q)
  const items = buildScanList(props.devices, props.groupNames).flatMap((item): ScanListItem[] => {
    if (item.kind !== 'group') return matches(item.device) ? [item] : []
    const kitMatch = q !== '' && (`kit ${item.groupId}`.includes(q) || (item.groupName ?? '').toLowerCase().includes(q))
    const devices = kitMatch ? item.devices : item.devices.filter(matches)
    return devices.length > 0 ? [{ ...item, devices }] : []
  })

  const sel = props.selected
  const isSelectedDevice = (d: BleDevice) => (sel.kind === 'device' || sel.kind === 'setup') && sel.address === d.address
  const toggle = (id: number) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const unconfigured = items.filter((i) => i.kind === 'unconfigured')
  const kits = items.filter((i) => i.kind === 'group')
  const individual = items.filter((i) => i.kind === 'individual')

  return (
    <>
      <div className="sidebar-head">
        <input className="search" type="search" placeholder="Search name or MAC" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="sidebar-list">
        {items.length === 0 && (
          <div className="muted center" style={{ padding: '32px 8px' }}>{q === '' ? 'No devices found yet…' : 'No matches'}</div>
        )}

        {unconfigured.length > 0 && <div className="section-label">Needs setup</div>}
        {unconfigured.map((item) => item.kind === 'unconfigured' && (
          <div
            key={'unc_' + item.device.address}
            className={'list-item setup' + (isSelectedDevice(item.device) ? ' selected' : '')}
            onClick={() => props.onSelect({ kind: 'setup', address: item.device.address })}
            onContextMenu={(e) => { e.preventDefault(); setForget({ kind: 'device', device: item.device }) }}
          >
            <div className="row between">
              <span className="semibold primary">⚙ Unconfigured Device</span>
              <span className="label-s muted">{item.device.rssi} dBm</span>
            </div>
            <div className="label-s muted mono">{item.device.address}</div>
          </div>
        ))}

        {kits.length > 0 && <div className="section-label">Kits</div>}
        {kits.map((item) => {
          if (item.kind !== 'group') return null
          const open = !collapsed.has(item.groupId) || q !== ''
          const camera = item.devices.find((d) => d.deviceType === DeviceType.CAMERA)
          const online = item.devices.filter((d) => d.isConnected).length
          const kitSelected = sel.kind === 'group' && sel.groupId === item.groupId
          return (
            <div
              key={'group_' + item.groupId}
              className={'list-item' + (kitSelected ? ' selected' : '')}
              onClick={() => props.onSelect({ kind: 'group', groupId: item.groupId })}
              onContextMenu={(e) => { e.preventDefault(); setForget({ kind: 'kit', groupId: item.groupId, count: item.devices.length }) }}
            >
              <div className="row">
                <button
                  className="chevron"
                  title={open ? 'Collapse' : 'Expand'}
                  onClick={(e) => { e.stopPropagation(); toggle(item.groupId) }}
                >
                  {open ? '▼' : '▶'}
                </button>
                <div className="col grow" style={{ gap: 0 }}>
                  <span className="semibold primary ellipsis">
                    Kit {item.groupId}
                    {item.groupName && item.groupName.trim() !== '' && <span className="muted" style={{ fontWeight: 400 }}> · {item.groupName}</span>}
                  </span>
                  <span className="label-s muted">
                    {online}/{item.devices.length} online{camera ? ` · 📷 ${formatThousands(camera.shutterCount)}` : ''}
                  </span>
                </div>
              </div>
              {open && (
                <div className="col" style={{ gap: 2, marginTop: 6 }}>
                  {item.devices.map((d) => (
                    <SidebarDevice
                      key={d.address}
                      device={d}
                      compact
                      selected={isSelectedDevice(d)}
                      onClick={() => props.onSelect({ kind: 'device', address: d.address })}
                      onForget={() => setForget({ kind: 'device', device: d })}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {individual.length > 0 && <div className="section-label">Devices</div>}
        {individual.map((item) => item.kind === 'individual' && (
          <div key={'ind_' + item.device.address} className={'list-item' + (isSelectedDevice(item.device) ? ' selected' : '')}>
            <SidebarDevice
              device={item.device}
              selected={false}
              onClick={() => props.onSelect({ kind: 'device', address: item.device.address })}
              onForget={() => setForget({ kind: 'device', device: item.device })}
            />
          </div>
        ))}
      </div>

      {forget?.kind === 'kit' && (
        <ConfirmDialog
          title={`Forget Kit ${forget.groupId}?`}
          text={`Removes ${forget.count} device(s) from memory. If they are still nearby they will reappear automatically.`}
          confirmLabel="Forget"
          onConfirm={() => { setForget(null); props.onForgetKit(forget.groupId) }}
          onDismiss={() => setForget(null)}
        />
      )}
      {forget?.kind === 'device' && (
        <ConfirmDialog
          title={forget.device.isConfigured ? `Forget ${forget.device.name ?? forget.device.address}?` : 'Forget this device?'}
          text="Removes this device from memory. If it is still nearby it will reappear automatically."
          confirmLabel="Forget"
          onConfirm={() => { setForget(null); props.onForgetDevice(forget.device) }}
          onDismiss={() => setForget(null)}
        />
      )}
    </>
  )
}

/** One device line: icon, name, Hub badge, ext battery bar and connection state. Right-click to forget. */
function SidebarDevice(props: { device: BleDevice; compact?: boolean; selected: boolean; onClick: () => void; onForget: () => void }) {
  const d = props.device
  const pct = d.extBatteryPercent
  const color = batteryColor(Math.max(0, pct))
  return (
    <div
      className={props.compact ? 'sub-item' + (props.selected ? ' selected' : '') : ''}
      onClick={(e) => { e.stopPropagation(); props.onClick() }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); props.onForget() }}
    >
      <div className="row">
        <span>{deviceIcon(d.deviceType)}</span>
        <span className="ellipsis grow">{d.name ?? d.address}</span>
        {d.hubNearbyCount >= 0 && <span className="badge hub" title={`Camera Hub · hears ${d.hubNearbyCount}`}>HUB</span>}
        <span className="body-s semibold" style={{ color, minWidth: 34, textAlign: 'right' }}>{pct >= 0 ? `${pct}%` : '--'}</span>
      </div>
      <div className="row" style={{ marginTop: 3 }}>
        <div style={{ width: 22, flex: 'none' }} />
        <div className="grow"><Progress value={d.isConnected ? Math.max(0, pct) / 100 : 0} color={color} /></div>
        <span className={'label-s ' + (d.isConnected ? 'green' : 'muted')} style={{ minWidth: 70, textAlign: 'right' }}>
          {d.isConnected ? (props.compact ? `${d.rssi} dBm` : `${d.extVoltageMillivolts > 0 ? volts(d.extVoltageMillivolts) + 'V · ' : ''}${d.rssi} dBm`) : connectionText(d, 'Disconnected')}
        </span>
      </div>
    </div>
  )
}
