// Kit dashboard. Port of GroupScreen.kt.

import { useState } from 'react'
import { GattUuids } from '../../../shared/gattUuids'
import { byKitOrder, formatThousands } from '../../../shared/scanList'
import { BleDevice, DeviceType } from '../../../shared/types'
import { api } from '../api'
import { ConfirmDialog, IndividualDeviceCard, Screen, StatusText, TextField } from '../components'

/** Connect to the camera, write RESET_SHUTTER, disconnect. Shared with the device dashboard. */
export async function resetShutterCount(address: string): Promise<string> {
  const state = await Promise.race([
    api.gattConnect(address),
    new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), 8_000))
  ])
  let result: string
  if (state === 'READY') {
    const ok = await api.gattWrite(GattUuids.RESET_SHUTTER, new Uint8Array([0x01]))
    result = ok ? 'Shutter count reset to 0' : 'Write failed'
  } else {
    result = 'Could not connect to camera'
  }
  await api.gattDisconnect()
  return result
}

export default function GroupScreen(props: {
  groupId: number
  groupName: string | null
  allDevices: BleDevice[]
  onGroupNameChange: (groupId: number, name: string) => void
  onOpenDevice: (d: BleDevice) => void
  onForgetDevice: (d: BleDevice) => void
}) {
  const devices = props.allDevices.filter((d) => d.groupId === props.groupId).sort(byKitOrder)
  const [nameInput, setNameInput] = useState(props.groupName ?? '')
  const camera = devices.find((d) => d.deviceType === DeviceType.CAMERA)
  const [confirm, setConfirm] = useState(false)
  const [resetStatus, setResetStatus] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  const doReset = async () => {
    setConfirm(false)
    if (!camera) return
    setResetting(true)
    setResetStatus('Connecting…')
    setResetStatus(await resetShutterCount(camera.address))
    setResetting(false)
  }

  return (
    <Screen
      title={nameInput.trim() !== '' ? `Kit ${props.groupId} · ${nameInput}` : `Kit ${props.groupId}`}
      subtitle={`${devices.length} device${devices.length === 1 ? '' : 's'} · ${devices.filter((d) => d.isConnected).length} in range`}
    >
      {devices.length === 0 ? (
        <div className="empty">No devices in this group</div>
      ) : (
        <>
          <div className="card col gap12">
          <TextField
            label="Kit Description - (Optional)"
            placeholder={`Kit ${props.groupId}`}
            value={nameInput}
            maxLength={20}
            onChange={(v) => { setNameInput(v); props.onGroupNameChange(props.groupId, v) }}
          />
          {camera && (
            <div className="row">
              <span>📷</span>
              <span className="muted">Shutter Count:</span>
              <span className="title-m semibold grow">{formatThousands(camera.shutterCount)}</span>
              <button className="outlined danger" disabled={resetting} onClick={() => setConfirm(true)}>
                {resetting ? 'Resetting…' : 'Reset'}
              </button>
            </div>
          )}
          {camera && <StatusText text={resetStatus} ok={!!resetStatus?.startsWith('Shutter')} />}
          </div>
          <div className="grid-2">
            {devices.map((d) => (
              <IndividualDeviceCard key={d.address} device={d} onClick={() => props.onOpenDevice(d)} onForget={() => props.onForgetDevice(d)} />
            ))}
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title="Reset Shutter Count?"
          text={`This will reset the shutter count to 0 on ${camera?.name ?? camera?.address ?? 'the camera'}. This cannot be undone.`}
          confirmLabel="Reset"
          onConfirm={() => void doReset()}
          onDismiss={() => setConfirm(false)}
        />
      )}
    </Screen>
  )
}
