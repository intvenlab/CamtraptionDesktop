// Scan screen. Port of BleMonitorScreen + its cards (MainActivity.kt).

import { useState } from 'react'
import { buildScanList, formatThousands } from '../../../shared/scanList'
import { AdapterState, BleDevice, DeviceType } from '../../../shared/types'
import { Card, ConfirmDialog, DeviceRow, Divider, IndividualDeviceCard, Screen } from '../components'

export default function ScanScreen(props: {
  devices: BleDevice[]
  groupNames: Record<number, string>
  adapter: { state: AdapterState; error: string | null }
  onOpenGroup: (groupId: number) => void
  onOpenDevice: (d: BleDevice) => void
  onOpenSetup: (d: BleDevice) => void
  onForgetKit: (groupId: number) => void
  onForgetDevice: (d: BleDevice) => void
  onInjectTestDevices?: () => void
}) {
  const items = buildScanList(props.devices, props.groupNames)
  const on = props.adapter.state === 'poweredOn'

  return (
    <Screen title="Camtraption Desktop">
      <div className="watermark">📷</div>
      <div className="row label-s" style={{ zIndex: 1 }}>
        {on ? (
          <><span className="primary">●</span><span className="muted">Scanning</span></>
        ) : (
          <span className="error">
            ⚠ {adapterMessage(props.adapter.state)}
            {props.adapter.error ? ` (${props.adapter.error})` : ''}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="empty">No devices found yet…</div>
      ) : (
        items.map((item) => {
          switch (item.kind) {
            case 'unconfigured':
              return (
                <UnconfiguredDeviceCard
                  key={'unc_' + item.device.address}
                  device={item.device}
                  onClick={() => props.onOpenSetup(item.device)}
                  onForget={() => props.onForgetDevice(item.device)}
                />
              )
            case 'group':
              return (
                <GroupCard
                  key={'group_' + item.groupId}
                  groupId={item.groupId}
                  groupName={item.groupName}
                  devices={item.devices}
                  onClick={() => props.onOpenGroup(item.groupId)}
                  onForgetKit={() => props.onForgetKit(item.groupId)}
                />
              )
            case 'individual':
              return (
                <IndividualDeviceCard
                  key={'ind_' + item.device.address}
                  device={item.device}
                  onClick={() => props.onOpenDevice(item.device)}
                  onForget={() => props.onForgetDevice(item.device)}
                />
              )
          }
        })
      )}
      {props.onInjectTestDevices && (
        <button className="fab" title="Inject test devices (debug)" onClick={props.onInjectTestDevices}>T</button>
      )}
    </Screen>
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

function UnconfiguredDeviceCard(props: { device: BleDevice; onClick: () => void; onForget: () => void }) {
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <Card className="tertiary" onClick={props.onClick} onLongPress={() => setConfirm(true)}>
        <div className="row between">
          <div className="col">
            <div className="row title-m semibold"><span>⚙</span><span>Unconfigured Device</span></div>
            <div className="body-s">Signal: {props.device.rssi} dBm</div>
          </div>
          <span className="bold">Setup →</span>
        </div>
      </Card>
      {confirm && (
        <ConfirmDialog
          title="Forget this device?"
          text="Removes this unconfigured device from memory. If it is still nearby it will reappear automatically."
          confirmLabel="Forget"
          onConfirm={() => { setConfirm(false); props.onForget() }}
          onDismiss={() => setConfirm(false)}
        />
      )}
    </>
  )
}

function GroupCard(props: {
  groupId: number
  groupName: string | null
  devices: BleDevice[]
  onClick: () => void
  onForgetKit: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const camera = props.devices.find((d) => d.deviceType === DeviceType.CAMERA)
  return (
    <>
      <Card onClick={props.onClick} onLongPress={() => setConfirm(true)}>
        <div className="title-m semibold">Kit {props.groupId}</div>
        {props.groupName && props.groupName.trim() !== '' && <div className="body-s muted">{props.groupName}</div>}
        {camera && <div className="body-s muted">📷 Shutters: {formatThousands(camera.shutterCount)}</div>}
        <Divider />
        <div className="col" style={{ gap: 6 }}>
          {props.devices.map((d) => <DeviceRow key={d.address} device={d} />)}
        </div>
      </Card>
      {confirm && (
        <ConfirmDialog
          title={`Forget Kit ${props.groupId}?`}
          text={`Removes ${props.devices.length} device(s) from memory. If they are still nearby they will reappear automatically.`}
          confirmLabel="Forget"
          onConfirm={() => { setConfirm(false); props.onForgetKit() }}
          onDismiss={() => setConfirm(false)}
        />
      )}
    </>
  )
}
