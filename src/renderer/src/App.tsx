// Top-level state + routing. Equivalent of MainActivity: owns the live device map, Kit names and
// the screen stack, and renders the screen on top.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { STALE_TIMEOUT_MS } from '../../shared/advert'
import { HUB_STREAM_SCAN } from '../../shared/hubProtocol'
import { AdapterState, BleDevice, DeviceType, GattStatus, makeDevice } from '../../shared/types'
import { api } from './api'
import { GattContext, ToastContext } from './context'
import { AppScreen, BackContext } from './nav'
import CameraLogsScreen from './screens/CameraLogsScreen'
import DeviceScreen from './screens/DeviceScreen'
import GroupScreen from './screens/GroupScreen'
import LogViewerScreen from './screens/LogViewerScreen'
import ScanScreen from './screens/ScanScreen'
import SettingsScreen from './screens/SettingsScreen'
import SetupScreen from './screens/SetupScreen'

export default function App() {
  const [devices, setDevices] = useState<Record<string, BleDevice>>({})
  const [groupNames, setGroupNames] = useState<Record<number, string>>({})
  const [adapter, setAdapter] = useState<{ state: AdapterState; error: string | null }>({ state: 'unknown', error: null })
  const [gatt, setGatt] = useState<GattStatus>({ state: 'IDLE', errorMessage: null })
  const [stack, setStack] = useState<AppScreen[]>([{ kind: 'scan' }])
  const [toast, setToast] = useState<string | null>(null)
  const backRef = useRef<(() => void) | undefined>(undefined)

  const push = useCallback((s: AppScreen) => setStack((st) => [...st, s]), [])
  const pop = useCallback((n = 1) => setStack((st) => (st.length > n ? st.slice(0, st.length - n) : st.slice(0, 1))), [])

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

  // Esc / mouse back button = Android Back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement && e.target.value !== '' && e.target.type === 'search')) backRef.current?.()
    }
    const onMouse = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); backRef.current?.() } }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onMouse) }
  }, [])

  const deviceList = useMemo(() => Object.values(devices), [devices])
  const nameForAddress = useCallback((addr: string) => devices[addr.toUpperCase()]?.name ?? null, [devices])

  const forgetDevice = (address: string) => {
    setDevices((cur) => { const next = { ...cur }; delete next[address]; return next })
    void api.forgetDevice(address)
  }

  const forgetKit = (groupId: number) => {
    setDevices((cur) => Object.fromEntries(Object.entries(cur).filter(([, d]) => d.groupId !== groupId)))
    void api.forgetKit(groupId)
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

  const screen = stack[stack.length - 1]
  let view: React.ReactNode
  switch (screen.kind) {
    case 'scan':
      view = (
        <ScanScreen
          devices={deviceList}
          groupNames={groupNames}
          adapter={adapter}
          onOpenGroup={(groupId) => push({ kind: 'group', groupId })}
          onOpenDevice={(device) => push({ kind: 'device', device })}
          onOpenSetup={(device) => { push({ kind: 'setup', device }); void api.gattConnect(device.address) }}
          onForgetKit={forgetKit}
          onForgetDevice={(d) => forgetDevice(d.address)}
          onInjectTestDevices={api.isDebug ? injectTestDevices : undefined}
        />
      )
      break
    case 'group':
      view = (
        <GroupScreen
          groupId={screen.groupId}
          groupName={groupNames[screen.groupId] ?? null}
          allDevices={deviceList}
          onGroupNameChange={(id, name) => {
            setGroupNames((g) => ({ ...g, [id]: name }))
            void api.saveGroupName(id, name)
          }}
          onOpenDevice={(device) => push({ kind: 'device', device })}
          onForgetDevice={(d) => forgetDevice(d.address)}
          onBack={() => pop()}
        />
      )
      break
    case 'device': {
      // Always use the live advertised data.
      const live = devices[screen.device.address] ?? screen.device
      view = (
        <DeviceScreen
          key={live.address}
          device={live}
          onOpenSettings={() => {
            void api.gattConnect(live.address)
            push({ kind: 'settings', device: live })
          }}
          onBack={() => pop()}
        />
      )
      break
    }
    case 'settings':
      view = (
        <SettingsScreen
          device={screen.device}
          nameForAddress={nameForAddress}
          onBack={() => { void api.gattDisconnect(); pop() }}
          onFactoryReset={() => pop(2)}
          onOpenDeviceHistory={(addr) => void openHubDeviceHistory(screen.device.address, addr)}
          onOpenCameraLogs={() => push({ kind: 'cameraLogs', device: screen.device })}
        />
      )
      break
    case 'cameraLogs':
      view = (
        <CameraLogsScreen
          device={devices[screen.device.address] ?? screen.device}
          nameForAddress={nameForAddress}
          onOpenLogs={(entries, stream, initialDevice) => push({ kind: 'logViewer', entries, stream, initialDevice })}
          onBack={() => pop()}
        />
      )
      break
    case 'logViewer':
      view = (
        <LogViewerScreen
          entries={screen.entries}
          stream={screen.stream}
          initialDevice={screen.initialDevice ?? null}
          nameForAddress={nameForAddress}
          onBack={() => pop()}
        />
      )
      break
    case 'setup':
      view = <SetupScreen device={screen.device} onFinish={() => pop()} />
      break
  }

  return (
    <ToastContext.Provider value={showToast}>
      <GattContext.Provider value={gatt}>
        <BackContext.Provider value={backRef}>
          {view}
          {toast && <div className="toast">{toast}</div>}
        </BackContext.Provider>
      </GattContext.Provider>
    </ToastContext.Provider>
  )
}
