// Device settings. Port of DeviceSettingsScreen (DeviceScreen.kt): Camera Logic, Feeder, device
// settings, calibration, Hub nearby list, factory reset and Send Log.

import { useEffect, useRef, useState } from 'react'
import {
  CAMERA_LOGIC_DEFAULTS, CameraLogicForm, FEEDER_DEFAULTS, FeederForm, buildCameraConfig, buildFeederConfig,
  calibrationBytes, describeConfigAck, parseCameraConfig, parseFeederConfig
} from '../../../shared/deviceConfig'
import { GattUuids } from '../../../shared/gattUuids'
import { HubCommands, NearbyDevice, parseNearbyDevicesPage, sortNearbyForDisplay } from '../../../shared/hubProtocol'
import { volts } from '../../../shared/scanList'
import {
  BatteryChemistry, BleDevice, CHEMISTRIES, DEVICE_TYPES, DeviceType, chemistryName, chemistryOf, deviceTypeName,
  deviceTypeOf, historyEntryFor
} from '../../../shared/types'
import { api, sleep } from '../api'
import { useGattStatus, useToast } from '../context'
import {
  CellCountSelect, Divider, GattStatusBanner, HoldButton, KitSelect, NearbyDeviceRow, NumberField, Screen, Select,
  StatItem, StatusText, SwitchCard, TextField
} from '../components'

/** Writes name/type/chemistry/cells/Kit in order; false at the first failed write (writeAllSettings). */
export async function writeDeviceSettings(
  name: string, type: DeviceType, chem: BatteryChemistry, cells: number, kit: number
): Promise<boolean> {
  return (await api.gattWrite(GattUuids.DEVICE_NAME, new TextEncoder().encode(name))) &&
    (await api.gattWrite(GattUuids.DEVICE_TYPE, new Uint8Array([type]))) &&
    (await api.gattWrite(GattUuids.CHEMISTRY, new Uint8Array([chem]))) &&
    (await api.gattWrite(GattUuids.CELL_COUNT, new Uint8Array([cells]))) &&
    (await api.gattWrite(GattUuids.GROUP_ID, new Uint8Array([kit])))
}

/** Reads every page of CAMERA_NEARBY_DEVICES; null if the Hub didn't answer. */
async function readNearbyDevices(): Promise<NearbyDevice[] | null> {
  const all: NearbyDevice[] = []
  for (let page = 0; page < 24; page++) {
    if (!(await api.gattWrite(GattUuids.CAMERA_NEARBY_DEVICES, new Uint8Array([page]), 3_000))) return null
    const p = parseNearbyDevicesPage(await api.gattRead(GattUuids.CAMERA_NEARBY_DEVICES, 3_000))
    if (!p) return null
    all.push(...p.devices)
    if (p.devices.length === 0 || all.length >= p.total) break
  }
  return all
}

export default function SettingsScreen(props: {
  device: BleDevice
  nameForAddress: (addr: string) => string | null
  onBack: () => void
  onFactoryReset: () => void
  onOpenDeviceHistory: (addr: string) => void
  onOpenCameraLogs: () => void
}) {
  const d = props.device
  const gatt = useGattStatus()
  const toast = useToast()
  const ready = gatt.state === 'READY'
  const isCamera = d.deviceType === DeviceType.CAMERA
  const isFeeder = d.deviceType === DeviceType.FEEDER

  const [isCameraHub, setIsCameraHub] = useState(false)
  const [name, setName] = useState(d.name ?? '')
  const [type, setType] = useState(d.deviceType)
  const [chem, setChem] = useState(d.batteryChemistry)
  const [cells, setCells] = useState(Math.min(4, Math.max(1, d.cellCount)))
  const [kit, setKit] = useState(d.groupId)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [cal, setCal] = useState('')
  const [calStatus, setCalStatus] = useState<string | null>(null)
  const [intCal, setIntCal] = useState('')
  const [intCalStatus, setIntCalStatus] = useState<string | null>(null)

  const [cam, setCam] = useState<CameraLogicForm>(CAMERA_LOGIC_DEFAULTS)
  const [camLoaded, setCamLoaded] = useState(false)
  const [camStatus, setCamStatus] = useState<string | null>(null)
  const [feeder, setFeeder] = useState<FeederForm>(FEEDER_DEFAULTS)
  const [feederLoaded, setFeederLoaded] = useState(false)
  const [feederStatus, setFeederStatus] = useState<string | null>(null)
  const setCamField = <K extends keyof CameraLogicForm>(k: K, v: CameraLogicForm[K]) => setCam((c) => ({ ...c, [k]: v }))
  const setFeederField = <K extends keyof FeederForm>(k: K, v: FeederForm[K]) => setFeeder((f) => ({ ...f, [k]: v }))

  // Read settings from the device when GATT is ready.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void (async () => {
      const nameBytes = await api.gattRead(GattUuids.DEVICE_NAME)
      if (cancelled) return
      if (nameBytes) setName(new TextDecoder().decode(nameBytes))
      const t = await api.gattRead(GattUuids.DEVICE_TYPE)
      if (t && t.length > 0) setType(deviceTypeOf(t[0]))
      const c = await api.gattRead(GattUuids.CHEMISTRY)
      if (c && c.length > 0) setChem(chemistryOf(c[0]))
      const n = await api.gattRead(GattUuids.CELL_COUNT)
      if (n && n.length > 0) setCells(Math.min(4, Math.max(1, n[0])))
      const g = await api.gattRead(GattUuids.GROUP_ID)
      if (g && g.length > 0) setKit(g[0])
      if (cancelled) return

      if (isCamera) {
        // ESP32 Camera Hub: set its clock on every connect (log file dating); no-op on nRF52.
        const hub = await api.gattHas(GattUuids.CAMERA_LOG_STATUS)
        setIsCameraHub(hub)
        if (hub) await api.gattWrite(GattUuids.CAMERA_TIME_SYNC, HubCommands.nowTimeSync(), 3_000)
        const bytes = await api.gattRead(GattUuids.CAMERA_CONFIG, 5_000)
        await api.gattEnableNotification(GattUuids.CAMERA_CONFIG_STATUS)
        if (cancelled) return
        const parsed = bytes ? parseCameraConfig(bytes) : null
        if (parsed) {
          setCam(parsed)
          setCamLoaded(true)
        } else if (bytes) {
          setCamStatus('Unexpected format – reflash firmware')
        }
      }

      if (isFeeder) {
        const bytes = await api.gattRead(GattUuids.FEEDER_CONFIG, 5_000)
        await api.gattEnableNotification(GattUuids.FEEDER_CONFIG_STATUS)
        if (cancelled) return
        const parsed = bytes ? parseFeederConfig(bytes) : null
        if (parsed) {
          setFeeder(parsed)
          setFeederLoaded(true)
        } else if (bytes) {
          setFeederStatus('Unexpected format – reflash firmware')
        }
      }
    })()
    return () => { cancelled = true }
  }, [ready, isCamera, isFeeder])

  /** Write a config blob and wait for its status notification (registered before the write). */
  const saveWithAck = async (uuid: string, statusUuid: string, packet: Uint8Array): Promise<string> => {
    const ack = api.gattWaitForNotification(statusUuid, 3_000)
    if (!(await api.gattWrite(uuid, packet))) return 'Save failed – not connected'
    return describeConfigAck(await ack)
  }

  // Run Pump (Hold): write 0x01 every 400 ms while held, 0x00 on release.
  const pumpLoop = useRef<{ active: boolean } | null>(null)
  const startPump = () => {
    if (pumpLoop.current) pumpLoop.current.active = false
    const loop = { active: true }
    pumpLoop.current = loop
    void api.appendHistory(d.address, historyEntryFor('PumpRun', d))
    void (async () => {
      while (loop.active) {
        await api.gattWrite(GattUuids.FEEDER_PUMP_OVERRIDE, new Uint8Array([0x01]))
        await sleep(400)
      }
    })()
  }
  const stopPump = () => {
    if (pumpLoop.current) pumpLoop.current.active = false
    pumpLoop.current = null
    void api.gattWrite(GattUuids.FEEDER_PUMP_OVERRIDE, new Uint8Array([0x00]))
  }

  const sendLog = async () => {
    const file = await api.historyFilePath(d.address)
    if (!file) {
      toast('No log for this device yet')
      return
    }
    const label = `${kit !== 0 ? `Kit ${kit} - ` : ''}${d.name ?? d.address}`
    const saved = await api.saveCopies([file], `Device Log - ${label.replace(/[\\/:*?"<>|]/g, '_')}.json`)
    if (saved) {
      toast(`Saved ${saved}`)
      void api.showInFolder(saved)
      void api.composeEmail(`Device Log: ${label}`, `MAC: ${d.address}\n\nSent from Camtraption Desktop\n\n(Attach the saved file: ${saved})`)
    }
  }

  return (
    <Screen title="Settings" onBack={props.onBack}>
      <GattStatusBanner status={gatt} />

      {/* Debug builds show it for every Camera so the mock-server path is reachable without Hub hardware. */}
      {isCamera && (isCameraHub || api.isDebug) && (
        <button className="full" disabled={!(ready || api.isDebug)} onClick={props.onOpenCameraLogs}>Camera Logs (SD card)</button>
      )}

      {isCamera && isCameraHub && (
        <NearbyDevicesCard nameForAddress={props.nameForAddress} onOpen={props.onOpenDeviceHistory} />
      )}

      {isCamera && (
        <>
          <SwitchCard label="Logic Bypass" checked={!cam.enabled} onChange={(v) => setCamField('enabled', !v)} />
          <div className="card col gap12">
            <div className="title-m">Sequence</div>
            <NumberField label="Frame Count (0–64)" value={cam.frameCount} onChange={(v) => setCamField('frameCount', v)} maxDigits={2} />
            <NumberField label="Max Sequence Count (0–64)" value={cam.maxSequenceCount} onChange={(v) => setCamField('maxSequenceCount', v)} maxDigits={2} />
          </div>
          <div className="card col gap12">
            <div className="title-m">Timing</div>
            <NumberField label="Wake HP Hold (ms)" value={cam.wakeHalfPressHoldSec} onChange={(v) => setCamField('wakeHalfPressHoldSec', v)} maxDigits={5} />
            <NumberField label="Min HP Before Shutter (ms)" value={cam.minHalfPressBeforeShutter} onChange={(v) => setCamField('minHalfPressBeforeShutter', v)} maxDigits={5} />
            <NumberField label="Shutter Pulse Duration (ms)" value={cam.shutterPulseDuration} onChange={(v) => setCamField('shutterPulseDuration', v)} maxDigits={5} />
            <NumberField label="Frame Spacing (ms)" value={cam.startFrameSpacingTicks} onChange={(v) => setCamField('startFrameSpacingTicks', v)} maxDigits={5} />
            <NumberField label="Post-Shutter HP Hold (ms)" value={cam.postShutterHpHoldTenths} onChange={(v) => setCamField('postShutterHpHoldTenths', v)} maxDigits={5} />
            <NumberField label="HP Debounce (ms)" value={cam.hpDebounceMs} onChange={(v) => setCamField('hpDebounceMs', v)} />
            <NumberField label="FP Debounce (ms)" value={cam.fpDebounceMs} onChange={(v) => setCamField('fpDebounceMs', v)} />
            <NumberField label="FP Ignore Gap (ms)" value={cam.fullPressIgnoreGapTenths} onChange={(v) => setCamField('fullPressIgnoreGapTenths', v)} maxDigits={5} />
          </div>
          <div className="card col gap12">
            <div className="title-m">Policies</div>
            <Policy label="Wake Hold Refresh" options={['Extend', 'Restart', 'Ignore While Active']} value={cam.wakeHoldRefreshPolicy} onChange={(v) => setCamField('wakeHoldRefreshPolicy', v)} />
            <Policy label="FP Without Prior HP" options={['Assert HP Then Wait', 'Ignore FP']} value={cam.fullPressWithoutHpPolicy} onChange={(v) => setCamField('fullPressWithoutHpPolicy', v)} />
            <Policy label="FP After Max Sequences" options={['Ignore Until Activity End']} value={cam.fpAfterMaxSeqCountPolicy} onChange={(v) => setCamField('fpAfterMaxSeqCountPolicy', v)} />
          </div>
          <SwitchCard label="Power Save Idle Mode" checked={cam.powerSaveIdleMode} onChange={(v) => setCamField('powerSaveIdleMode', v)} />
          <StatusText text={camStatus} ok={!!camStatus?.startsWith('Saved')} />
          <button
            className="full"
            disabled={!camLoaded}
            onClick={async () => setCamStatus(await saveWithAck(GattUuids.CAMERA_CONFIG, GattUuids.CAMERA_CONFIG_STATUS, buildCameraConfig(cam)))}
          >
            Save Camera Logic
          </button>
        </>
      )}

      {isFeeder && (
        <>
          <SwitchCard label="Feeder Enabled" checked={feeder.enabled} onChange={(v) => setFeederField('enabled', v)} />
          <HoldButton label="Run Pump (Hold)" disabled={!ready} onPress={startPump} onRelease={stopPump} />
          <div className="card col gap12">
            <div className="title-m">Pump Timer</div>
            <NumberField label="Pump On Time (ms)" value={feeder.pumpOnMs} onChange={(v) => setFeederField('pumpOnMs', v)} maxDigits={7} />
            <NumberField label="Pump Off Time (ms)" value={feeder.pumpOffMs} onChange={(v) => setFeederField('pumpOffMs', v)} maxDigits={7} />
          </div>
          <div className="card col gap12">
            <div className="title-m">Pulse Stretch</div>
            <NumberField label="Minimum Pulse Width (ms)" value={feeder.pulseStretchMinMs} onChange={(v) => setFeederField('pulseStretchMinMs', v)} maxDigits={5} />
          </div>
          <StatusText text={feederStatus} ok={!!feederStatus?.startsWith('Saved')} />
          <button
            className="full"
            disabled={!feederLoaded}
            onClick={async () => setFeederStatus(await saveWithAck(GattUuids.FEEDER_CONFIG, GattUuids.FEEDER_CONFIG_STATUS, buildFeederConfig(feeder)))}
          >
            Save Feeder Settings
          </button>
        </>
      )}

      <div className="card col gap12">
        <div className="title-m">Device Settings</div>
        <TextField label="Device Name" value={name} maxLength={20} onChange={setName} />
        <Select label="Device Type" value={type} options={DEVICE_TYPES} display={deviceTypeName} onChange={setType} />
        <Select label="Battery Chemistry" value={chem} options={CHEMISTRIES} display={chemistryName} onChange={setChem} />
        <CellCountSelect value={cells} onChange={setCells} />
        <KitSelect value={kit} onChange={setKit} />
      </div>
      <StatusText text={saveStatus} ok={!!saveStatus?.startsWith('Saved')} />
      <button
        className="full"
        onClick={async () => {
          const ok = ready && (await writeDeviceSettings(name, type, chem, cells, kit))
          setSaveStatus(ok ? 'Saved successfully' : 'Save failed – not connected')
        }}
      >
        Save
      </button>

      <CalibrationCard
        title="External Battery Calibration"
        help="Connect battery and enter the actual pack voltage measured with a multimeter, then click Set Cal."
        value={cal}
        onChange={setCal}
        status={calStatus}
        ready={ready}
        onSet={async () => setCalStatus((await api.gattWrite(GattUuids.CAL_SET, calibrationBytes(parseFloat(cal) || 0, 30000))) ? 'Calibration set' : 'Write failed')}
        onReset={async () => setCalStatus((await api.gattWrite(GattUuids.CAL_SET, new Uint8Array([0, 0]))) ? 'Reset to default' : 'Write failed')}
      />
      <CalibrationCard
        title="Internal CR2032 Calibration"
        help="Enter the actual CR2032 coin cell voltage measured with a multimeter, then click Set Cal."
        value={intCal}
        onChange={setIntCal}
        status={intCalStatus}
        ready={ready}
        onSet={async () => setIntCalStatus((await api.gattWrite(GattUuids.INT_CAL_SET, calibrationBytes(parseFloat(intCal) || 0, 5000))) ? 'Calibration set' : 'Write failed')}
        onReset={async () => setIntCalStatus((await api.gattWrite(GattUuids.INT_CAL_SET, new Uint8Array([0, 0]))) ? 'Reset to default' : 'Write failed')}
      />

      <div className="card col gap12">
        <div className="title-m">Device Info</div>
        <div className="row evenly">
          <StatItem label="Chemistry" value={chemistryName(d.batteryChemistry)} />
          <StatItem label="Cells" value={`${d.cellCount}`} />
          <StatItem label="Signal" value={`${d.rssi} dBm`} />
        </div>
        <Divider />
        <div className="row evenly">
          <StatItem label="Internal Battery" value={`${d.batteryPercent}%`} />
          <StatItem label="Internal Voltage" value={`${volts(d.voltageMillivolts)} V`} />
        </div>
        <Divider />
        <div className="row evenly"><StatItem label="MAC Address" value={d.address} /></div>
        {d.firmwareBuild !== '' && (
          <>
            <Divider />
            <div className="row evenly"><StatItem label="Built" value={d.firmwareBuild} /></div>
          </>
        )}
      </div>

      <button
        className="outlined danger full"
        disabled={!ready}
        onClick={async () => {
          await api.gattWrite(GattUuids.FACTORY_RESET, new Uint8Array([0x01]))
          await api.gattDisconnect()
          props.onFactoryReset()
        }}
      >
        Factory Reset
      </button>
      <button className="outlined full" onClick={() => void sendLog()}>Send Log</button>
    </Screen>
  )
}

function Policy(props: { label: string; options: string[]; value: number; onChange: (v: number) => void }) {
  return (
    <Select
      label={props.label}
      value={props.value}
      options={props.options.map((_, i) => i)}
      display={(i) => props.options[i] ?? `Unknown (${i})`}
      onChange={props.onChange}
    />
  )
}

function CalibrationCard(props: {
  title: string
  help: string
  value: string
  onChange: (v: string) => void
  status: string | null
  ready: boolean
  onSet: () => void
  onReset: () => void
}) {
  const v = parseFloat(props.value)
  return (
    <div className="card col gap12">
      <div className="title-m">{props.title}</div>
      <div className="body-s muted">{props.help}</div>
      <TextField label="Actual Voltage (V)" value={props.value} inputMode="decimal" onChange={props.onChange} />
      <div className="row">
        <button className="grow" disabled={!props.ready || !(v > 0)} onClick={props.onSet}>Set Cal</button>
        <button className="outlined grow" disabled={!props.ready} onClick={props.onReset}>Reset Cal</button>
      </div>
      {props.status && <div className={'body-s ' + (props.status.includes('failed') ? 'error' : 'primary')}>{props.status}</div>}
    </div>
  )
}

/** Devices this Hub hears (CAMERA_NEARBY_DEVICES), polled every 5 s while connected. */
function NearbyDevicesCard(props: { nameForAddress: (a: string) => string | null; onOpen: (addr: string) => void }) {
  const gatt = useGattStatus()
  const [nearby, setNearby] = useState<NearbyDevice[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (gatt.state !== 'READY') return
    let stop = false
    void (async () => {
      while (!stop) {
        const result = await readNearbyDevices()
        if (stop) break
        setFailed(result == null)
        if (result) setNearby(sortNearbyForDisplay(result))
        await sleep(5_000)
      }
    })()
    return () => { stop = true }
  }, [gatt.state])

  return (
    <div className="card col gap8">
      <div className="title-m">Nearby Devices{nearby ? ` (${nearby.length})` : ''}</div>
      <div className="body-s muted">Camtraptions devices this Hub hears, refreshed every 5 s. Click one for its logged history.</div>
      {gatt.state !== 'READY' ? (
        <div>Connect to the Hub to see nearby devices.</div>
      ) : nearby == null && failed ? (
        <div>Couldn't read the list from the Hub.</div>
      ) : nearby == null ? (
        <div>Reading…</div>
      ) : nearby.length === 0 ? (
        <div>No devices heard yet.</div>
      ) : (
        <div>
          {nearby.map((n) => (
            <NearbyDeviceRow key={n.address} device={n} knownName={props.nameForAddress(n.address)} onClick={() => props.onOpen(n.address)} />
          ))}
        </div>
      )}
    </div>
  )
}
