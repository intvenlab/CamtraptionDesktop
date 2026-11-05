// A device in the detail pane: Overview (live dashboard, no connection) plus the settings tabs.
// Opening any tab other than Overview connects over GATT; going back to Overview or leaving the
// device disconnects, so a connection is still only open while configuring (as on Android).

import { useEffect, useRef, useState } from 'react'
import { BleDevice, DeviceType, deviceIcon, deviceTypeName } from '../../../shared/types'
import { api } from '../api'
import { useGattStatus } from '../context'
import { GattStatusBanner, Screen, TabDef, Tabs } from '../components'
import DeviceOverview, { useDeviceHistory } from './DeviceScreen'
import { CalibrationTab, CameraLogicTab, FeederTab, HubTab, SettingsTab, useDeviceConfig } from './SettingsScreen'

export type DeviceTab = 'overview' | 'settings' | 'cameraLogic' | 'feeder' | 'calibration' | 'hub'

export default function DevicePanel(props: {
  device: BleDevice
  nameForAddress: (addr: string) => string | null
  onOpenCameraLogs: () => void
  onOpenDeviceHistory: (addr: string) => void
  onFactoryReset: () => void
}) {
  const d = props.device
  const gatt = useGattStatus()
  const [tab, setTab] = useState<DeviceTab>('overview')
  const history = useDeviceHistory(d)
  const config = useDeviceConfig(d)

  // Connect while a BLE tab is showing; disconnect on Overview and when the panel goes away.
  const needsGatt = tab !== 'overview'
  const connected = useRef(false)
  useEffect(() => {
    if (needsGatt) {
      connected.current = true
      void api.gattConnect(d.address)
    } else if (connected.current) {
      connected.current = false
      void api.gattDisconnect()
    }
  }, [needsGatt, d.address])
  useEffect(() => () => { if (connected.current) void api.gattDisconnect() }, [])

  const isCamera = d.deviceType === DeviceType.CAMERA
  const isHub = d.hubNearbyCount >= 0 || config.isCameraHub
  const tabs: TabDef<DeviceTab>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'settings', label: 'Settings' },
    ...(isCamera ? [{ id: 'cameraLogic' as const, label: 'Camera Logic' }] : []),
    ...(d.deviceType === DeviceType.FEEDER ? [{ id: 'feeder' as const, label: 'Feeder' }] : []),
    { id: 'calibration', label: 'Calibration' },
    ...(isHub || (isCamera && api.isDebug) ? [{ id: 'hub' as const, label: 'Hub' }] : [])
  ]
  const current = tabs.some((t) => t.id === tab) ? tab : 'overview'

  const subtitle = [
    deviceTypeName(d.deviceType),
    d.groupId === 0 ? 'No Kit' : `Kit ${d.groupId}`,
    d.address,
    d.firmwareBuild !== '' ? `FW ${d.firmwareBuild}` : null
  ].filter(Boolean).join('  ·  ')

  return (
    <Screen
      title={<>{deviceIcon(d.deviceType)} {d.name ?? d.address}{isHub && <span className="badge hub" style={{ marginLeft: 10, verticalAlign: 3 }}>HUB</span>}</>}
      subtitle={subtitle}
      actions={
        needsGatt ? (
          <div className="row">
            <GattStatusBanner status={gatt} />
            {gatt.state === 'ERROR' && <button className="outlined small" onClick={() => void api.gattConnect(d.address)}>Retry</button>}
          </div>
        ) : (
          <span className={'label-m ' + (d.isConnected ? 'green' : 'muted')}>{d.isConnected ? '● In range' : '○ Out of range'}</span>
        )
      }
      tabs={<Tabs tabs={tabs} value={current} onChange={setTab} />}
    >
      {current === 'overview' && <DeviceOverview device={d} history={history} />}
      {current === 'settings' && <SettingsTab c={config} onFactoryReset={props.onFactoryReset} />}
      {current === 'cameraLogic' && <CameraLogicTab c={config} />}
      {current === 'feeder' && <FeederTab c={config} />}
      {current === 'calibration' && <CalibrationTab c={config} />}
      {current === 'hub' && (
        <HubTab
          c={config}
          nameForAddress={props.nameForAddress}
          onOpenCameraLogs={props.onOpenCameraLogs}
          onOpenDeviceHistory={props.onOpenDeviceHistory}
        />
      )}
    </Screen>
  )
}
