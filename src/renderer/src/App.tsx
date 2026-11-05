// Top-level state + layout. Equivalent of MainActivity: owns the live device map and Kit names.
// Desktop layout: an app bar with the Devices / Graphs tabs; Devices is a scan-list sidebar plus a
// detail pane whose stack starts at the sidebar's selection (see nav.tsx).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { STALE_TIMEOUT_MS } from '../../shared/advert'
import { HUB_STREAM_SCAN } from '../../shared/hubProtocol'
import { AdapterState, BleDevice, DeviceType, GattStatus, makeDevice } from '../../shared/types'
import { api } from './api'
import logoUrl from './assets/logo.png'
import { EmptyState, Tabs } from './components'
import { GattContext, ToastContext } from './context'
import { BackContext, MainTab, PaneActiveContext, PaneRoot, PaneView } from './nav'
import CameraLogsScreen from './screens/CameraLogsScreen'
import DevicePanel from './screens/DevicePanel'
import GraphsScreen from './screens/GraphsScreen'
import GroupScreen from './screens/GroupScreen'
import LogViewerScreen from './screens/LogViewerScreen'
import ScanList from './screens/ScanList'
import SetupScreen from './screens/SetupScreen'

const SIDEBAR_KEY = 'sidebarWidth'
const SIDEBAR_MIN = 260
const SIDEBAR_MAX = 560

function savedSidebarWidth(): number {
  try {
    const v = Number(localStorage.getItem(SIDEBAR_KEY))
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 340
  } catch {
    return 340
  }
}

export default function App() {
  const [devices, setDevices] = useState<Record<string, BleDevice>>({})
  const [groupNames, setGroupNames] = useState<Record<number, string>>({})
  const [adapter, setAdapter] = useState<{ state: AdapterState; error: string | null }>({ state: 'unknown', error: null })
  const [gatt, setGatt] = useState<GattStatus>({ state: 'IDLE', errorMessage: null })
  const [tab, setTab] = useState<MainTab>('devices')
  const [pane, setPane] = useState<PaneView[]>([{ kind: 'empty' }])
  const [toast, setToast] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth)
  const [dragging, setDragging] = useState(false)
  const backRef = useRef<(() => void) | undefined>(undefined)

  const root = pane[0] as PaneRoot
  const select = useCallback((r: PaneRoot) => setPane([r]), [])
  const push = useCallback((v: PaneView) => setPane((st) => [...st, v]), [])
  const pop = useCallback(() => setPane((st) => (st.length > 1 ? st.slice(0, -1) : st)), [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500)
  }, [])

  // Load remembered devices + Kit names, then follow live advertisements.
  useEffect(() => {
    api.loadKnownDevices().then((saved) =>
      setDevices((cur) => {
        const next = { ...cur }
        for (const d of saved) if (!next[d.address]) next[d.address] = d
        return next
      }))
    api.loadGroupNames().then(setGroupNames)
    api.getAdapterState().then(setAdapter)
    api.getGattStatus().then(setGatt)
    const offDevices = api.onDevices((batch) =>
      setDevices((cur) => {
        const next = { ...cur }
        for (const d of batch) next[d.address] = d
        return next
      }))
    const offAdapter = api.onAdapterState((state, error) => setAdapter({ state, error }))
    const offGatt = api.onGattStatus(setGatt)
    return () => { offDevices(); offAdapter(); offGatt() }
  }, [])

  // Mark devices stale/disconnected after 10 s without an advertisement.
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now()
      setDevices((cur) => {
        let changed = false
        const next = { ...cur }
        for (const [addr, d] of Object.entries(cur)) {
          if (d.isConnected && now - d.lastSeen > STALE_TIMEOUT_MS) {
            next[addr] = { ...d, isConnected: false }
            changed = true
          }
        }
        return changed ? next : cur
      })
    }, 1_000)
    return () => window.clearInterval(t)
  }, [])

  // Esc / mouse back button = Android Back (pops the detail pane).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement && e.target.value !== '' && e.target.type === 'search')) backRef.current?.()
    }
    const onMouse = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); backRef.current?.() } }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onMouse) }
  }, [])

  // Sidebar resize.
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent) => setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX)))
    const up = () => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [dragging])
  useEffect(() => {
    if (dragging) return
    try { localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth)) } catch { /* per-viewer convenience only */ }
  }, [dragging, sidebarWidth])

  const deviceList = useMemo(() => Object.values(devices), [devices])
  const nameForAddress = useCallback((addr: string) => devices[addr.toUpperCase()]?.name ?? null, [devices])

  const forgetDevice = (address: string) => {
    setDevices((cur) => { const next = { ...cur }; delete next[address]; return next })
    void api.forgetDevice(address)
    if ((root.kind === 'device' || root.kind === 'setup') && root.address === address) select({ kind: 'empty' })
  }

  const forgetKit = (groupId: number) => {
    setDevices((cur) => Object.fromEntries(Object.entries(cur).filter(([, d]) => d.groupId !== groupId)))
    void api.forgetKit(groupId)
    if (root.kind === 'group' && root.groupId === groupId) select({ kind: 'empty' })
  }

  const injectTestDevices = () => {
    const now = Date.now()
    const test = [
      // Unconfigured device (pinned at top)
      makeDevice({ address: 'AA:BB:CC:DD:EE:01', batteryPercent: 72, voltageMillivolts: 3840, rssi: -61, lastSeen: now }),
      // Kit 1: camera → feeder → strobes → battery (sort order applied automatically)
      makeDevice({ address: 'AA:BB:CC:DD:EE:02', name: 'Hummingbird1', batteryPercent: 85, voltageMillivolts: 4100, rssi: -55, lastSeen: now, isConfigured: true, deviceType: DeviceType.CAMERA, groupId: 1, shutterCount: 1_247 }),
      makeDevice({ address: 'AA:BB:CC:DD:EE:03', name: 'Strobe A', batteryPercent: 54, voltageMillivolts: 3900, rssi: -68, lastSeen: now, isConfigured: true, deviceType: DeviceType.STROBE, groupId: 1 }),
      makeDevice({ address: 'AA:BB:CC:DD:EE:04', name: 'Strobe B', batteryPercent: 18, voltageMillivolts: 3620, rssi: -72, lastSeen: now, isConfigured: true, deviceType: DeviceType.STROBE, groupId: 1 }),
      makeDevice({ address: 'AA:BB:CC:DD:EE:05', name: 'Base Station', batteryPercent: 91, voltageMillivolts: 4180, rssi: -48, lastSeen: now, isConfigured: true, deviceType: DeviceType.BATTERY_MONITOR, groupId: 1 }),
      makeDevice({ address: 'AA:BB:CC:DD:EE:06', name: 'Feeder A', batteryPercent: 63, voltageMillivolts: 3980, rssi: -59, lastSeen: now, isConfigured: true, deviceType: DeviceType.FEEDER, groupId: 1 })
    ]
    setDevices((cur) => ({ ...cur, ...Object.fromEntries(test.map((d) => [d.address, d])) }))
  }

  /** Opens a nearby device's history from every downloaded nearby-devices log of hubAddress. */
  const openHubDeviceHistory = async (hubAddress: string, deviceAddress: string) => {
    const scanLogs = (await api.loadCatalog(hubAddress)).filter((e) => e.stream === HUB_STREAM_SCAN)
    if (scanLogs.length === 0) showToast('No Hub logs on this computer yet. Download them in Camera Logs first.')
    else push({ kind: 'logViewer', entries: scanLogs, stream: HUB_STREAM_SCAN, initialDevice: deviceAddress })
  }

  const renderView = (v: PaneView): React.ReactNode => {
    switch (v.kind) {
      case 'empty':
        return <EmptyState image={logoUrl} text="Select a Kit or device on the left" />
      case 'group':
        return (
          <GroupScreen
            key={'group' + v.groupId}
            groupId={v.groupId}
            groupName={groupNames[v.groupId] ?? null}
            allDevices={deviceList}
            onGroupNameChange={(id, name) => {
              setGroupNames((g) => ({ ...g, [id]: name }))
              void api.saveGroupName(id, name)
            }}
            onOpenDevice={(device) => select({ kind: 'device', address: device.address })}
            onForgetDevice={(d) => forgetDevice(d.address)}
          />
        )
      case 'device': {
        const live = devices[v.address]
        if (!live) return <EmptyState glyph="📷" text="This device is no longer known" />
        return (
          <DevicePanel
            key={live.address}
            device={live}
            nameForAddress={nameForAddress}
            onOpenCameraLogs={() => push({ kind: 'cameraLogs', address: live.address })}
            onOpenDeviceHistory={(addr) => void openHubDeviceHistory(live.address, addr)}
            onFactoryReset={() => select({ kind: 'empty' })}
          />
        )
      }
      case 'setup': {
        const d = devices[v.address]
        if (!d) return <EmptyState glyph="⚙" text="This device is no longer in range" />
        return <SetupScreen key={d.address} device={d} onFinish={() => select({ kind: 'empty' })} />
      }
      case 'cameraLogs': {
        const d = devices[v.address]
        if (!d) return null
        return (
          <CameraLogsScreen
            device={d}
            nameForAddress={nameForAddress}
            onOpenLogs={(entries, stream, initialDevice) => push({ kind: 'logViewer', entries, stream, initialDevice })}
            onBack={pop}
          />
        )
      }
      case 'logViewer':
        return (
          <LogViewerScreen
            entries={v.entries}
            stream={v.stream}
            initialDevice={v.initialDevice ?? null}
            nameForAddress={nameForAddress}
            onBack={pop}
          />
        )
    }
  }

  const scanning = adapter.state === 'poweredOn'

  return (
    <ToastContext.Provider value={showToast}>
      <GattContext.Provider value={gatt}>
        <BackContext.Provider value={backRef}>
          <div className="shell">
            <div className="appbar">
              <span className="brand"><img src={logoUrl} alt="" />Camtraption Desktop</span>
              <Tabs<MainTab>
                tabs={[{ id: 'devices', label: 'Devices' }, { id: 'graphs', label: 'Graphs' }]}
                value={tab}
                onChange={setTab}
              />
              <span className="spacer" />
              {scanning ? (
                <span className="label-m muted"><span className="accent">●</span> Scanning · {deviceList.filter((d) => d.isConnected).length} in range</span>
              ) : (
                <span className="label-m error">⚠ {adapterMessage(adapter.state)}{adapter.error ? ` (${adapter.error})` : ''}</span>
              )}
              {api.isDebug && (
                <button className="fab-inline" title="Inject test devices (debug)" onClick={injectTestDevices}>T</button>
              )}
            </div>

            {/* Devices stays mounted while Graphs shows, so the selection, tab and connection survive the switch. */}
            <div className="body" style={{ display: tab === 'devices' ? 'flex' : 'none' }}>
              <div className="sidebar" style={{ width: sidebarWidth }}>
                <ScanList
                  devices={deviceList}
                  groupNames={groupNames}
                  selected={root}
                  onSelect={select}
                  onForgetKit={forgetKit}
                  onForgetDevice={(d) => forgetDevice(d.address)}
                />
              </div>
              <div className={'resizer' + (dragging ? ' dragging' : '')} onMouseDown={(e) => { e.preventDefault(); setDragging(true) }} />
              <div className="detail">
                {pane.map((v, i) => {
                  const top = i === pane.length - 1
                  return (
                    <PaneActiveContext.Provider key={i} value={top && tab === 'devices'}>
                      <div className={'pane-layer' + (top ? '' : ' hidden')}>{renderView(v)}</div>
                    </PaneActiveContext.Provider>
                  )
                })}
              </div>
            </div>
            {tab === 'graphs' && (
              <div className="body">
                <div className="detail">
                  <PaneActiveContext.Provider value={false}>
                    <GraphsScreen devices={deviceList} groupNames={groupNames} nameForAddress={nameForAddress} />
                  </PaneActiveContext.Provider>
                </div>
              </div>
            )}
          </div>
          {toast && <div className="toast">{toast}</div>}
        </BackContext.Provider>
      </GattContext.Provider>
    </ToastContext.Provider>
  )
}

function adapterMessage(s: AdapterState): string {
  switch (s) {
    case 'poweredOff': return 'Bluetooth is off'
    case 'unsupported': return 'No usable Bluetooth adapter'
    case 'unauthorized': return 'Bluetooth access denied'
    default: return 'Waiting for Bluetooth…'
  }
}
