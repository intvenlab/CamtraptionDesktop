// First-time configuration of an unconfigured device. Port of SetupScreen.kt.

import { useEffect, useState } from 'react'
import { volts } from '../../../shared/scanList'
import {
  BatteryChemistry, BleDevice, CHEMISTRIES, DEVICE_TYPES, DeviceType, chemistryName, deviceTypeName
} from '../../../shared/types'
import { api } from '../api'
import { useGattStatus } from '../context'
import {
  CellCountSelect, GattStatusBanner, KitSelect, Progress, Screen, Select, StatusText, TextField, batteryColor
} from '../components'
import { writeDeviceSettings } from './SettingsScreen'

export default function SetupScreen(props: { device: BleDevice; onFinish: () => void }) {
  const gatt = useGattStatus()
  const [name, setName] = useState('')
  const [type, setType] = useState(DeviceType.BATTERY_MONITOR)
  const [chem, setChem] = useState(BatteryChemistry.LIPO)
  const [cells, setCells] = useState(1)
  const [kit, setKit] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const d = props.device

  // Setup is configuration, so it holds a GATT connection for as long as it's showing.
  useEffect(() => {
    void api.gattConnect(d.address)
    return () => { void api.gattDisconnect() }
  }, [d.address])

  const leave = () => props.onFinish()

  return (
    <Screen
      title="Setup Device"
      subtitle={d.address}
      narrow
      actions={<>
        <GattStatusBanner status={gatt} />
        {gatt.state === 'ERROR' && <button className="outlined small" onClick={() => void api.gattConnect(d.address)}>Retry</button>}
      </>}
    >
      <div className="card col gap8">
        <div className="title-m">Battery</div>
        <div className="row between">
          <span>{volts(d.voltageMillivolts)} V</span>
          <span className="title-l" style={{ color: batteryColor(d.batteryPercent) }}>{d.batteryPercent}%</span>
        </div>
        <Progress value={d.batteryPercent / 100} color={batteryColor(d.batteryPercent)} />
        <span className="body-s muted">{d.rssi} dBm  •  {d.cellCount} cell  •  {chemistryName(d.batteryChemistry)}</span>
      </div>

      <div className="card col gap12">
        <div className="title-m">Device Settings</div>
        <TextField label="Device Name" value={name} maxLength={20} onChange={setName} />
        <Select label="Device Type" value={type} options={DEVICE_TYPES} display={deviceTypeName} onChange={setType} />
        <Select label="Battery Chemistry" value={chem} options={CHEMISTRIES} display={chemistryName} onChange={setChem} />
        <CellCountSelect value={cells} onChange={setCells} />
        <KitSelect value={kit} onChange={setKit} />
      </div>

      <StatusText text={status} ok={false} />
      <button
        style={{ alignSelf: 'flex-start' }}
        disabled={name.trim() === ''}
        onClick={async () => {
          if (gatt.state === 'READY' && (await writeDeviceSettings(name, type, chem, cells, kit))) leave()
          else setStatus('Save failed – not connected')
        }}
      >
        Save &amp; Finish
      </button>
    </Screen>
  )
}
