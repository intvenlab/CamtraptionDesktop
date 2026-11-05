// Device settings. Port of DeviceSettingsScreen (DeviceScreen.kt), split into the device panel's
// tabs: Settings (name/type/chemistry/cells/Kit, info, Send Log, factory reset), Camera Logic,
// Feeder, Calibration and Hub (nearby list). useDeviceConfig holds the state they share, so the
// device is read once per connection rather than once per tab.

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
  CellCountSelect, ConfirmDialog, Divider, HoldButton, KitSelect, NearbyDeviceRow, NumberField, Select,
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

export type DeviceConfig = ReturnType<typeof useDeviceConfig>

/** Form state for every settings tab, read from the device each time GATT becomes READY. */
export function useDeviceConfig(d: BleDevice) {
  const gatt = useGattStatus()
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

  return {
    device: d, ready, isCamera, isFeeder, isCameraHub,
    name, setName, type, setType, chem, setChem, cells, setCells, kit, setKit, saveStatus, setSaveStatus,
    cal, setCal, calStatus, setCalStatus, intCal, setIntCal, intCalStatus, setIntCalStatus,
    cam, camLoaded, camStatus, setCamStatus, setCamField,
    feeder, feederLoaded, feederStatus, setFeederStatus, setFeederField,
    saveWithAck, startPump, stopPump
  }
}

/** Shown on BLE tabs until the device is connected. */
function NotReady({ c }: { c: DeviceConfig }) {
  if (c.ready) return null
  return <div className="card body-s muted">Values are read from the device once it's connected.</div>
}

export function SettingsTab(props: { c: DeviceConfig; onFactoryReset: () => void }) {
  const { c } = props
  const d = c.device
  const toast = useToast()
  const [confirmReset, setConfirmReset] = useState(false)

  const sendLog = async () => {
    const file = await api.historyFilePath(d.address)
    if (!file) {
      toast('No log for this device yet')
      return
    }
    const label = `${c.kit !== 0 ? `Kit ${c.kit} - ` : ''}${d.name ?? d.address}`
    const saved = await api.saveCopies([file], `Device Log - ${label.replace(/[\\/:*?"<>|]/g, '_')}.json`)
    if (saved) {
      toast(`Saved ${saved}`)
      void api.showInFolder(saved)
      void api.composeEmail(`Device Log: ${label}`, `MAC: ${d.address}\n\nSent from Camtraption Desktop\n\n(Attach the saved file: ${saved})`)
    }
  }

  return (
    <div className="grid-2">
      <div className="stack">
        <NotReady c={c} />
        <div className="card col gap12">
          <div className="title-m">Device Settings</div>
          <TextField label="Device Name" value={c.name} maxLength={20} onChange={c.setName} />
          <div className="fields-2">
            <Select label="Device Type" value={c.type} options={DEVICE_TYPES} display={deviceTypeName} onChange={c.setType} />
            <Select label="Battery Chemistry" value={c.chem} options={CHEMISTRIES} display={chemistryName} onChange={c.setChem} />
            <CellCountSelect value={c.cells} onChange={c.setCells} />
            <KitSelect value={c.kit} onChange={c.setKit} />
          </div>
          <div className="row">
            <button
              disabled={!c.ready}
              onClick={async () => {
                const ok = c.ready && (await writeDeviceSettings(c.name, c.type, c.chem, c.cells, c.kit))
                c.setSaveStatus(ok ? 'Saved successfully' : 'Save failed – not connected')
              }}
            >
              Save
            </button>
            <StatusText text={c.saveStatus} ok={!!c.saveStatus?.startsWith('Saved')} />
          </div>
        </div>
      </div>

      <div className="stack">
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
        <div className="card row between">
          <div className="col" style={{ gap: 0 }}>
            <span className="semibold">Device log</span>
            <span className="body-s muted">Save this device's event history and email it.</span>
          </div>
          <button className="outlined" onClick={() => void sendLog()}>Send Log</button>
        </div>
        <div className="card danger-zone row between">
          <div className="col" style={{ gap: 0 }}>
            <span className="semibold error">Factory Reset</span>
            <span className="body-s muted">Returns the device to unconfigured and disconnects.</span>
          </div>
          <button className="outlined danger" disabled={!c.ready} onClick={() => setConfirmReset(true)}>Factory Reset</button>
        </div>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title="Factory reset this device?"
          text={`${d.name ?? d.address} goes back to unconfigured and disconnects.`}
          confirmLabel="Reset"
          onConfirm={async () => {
            setConfirmReset(false)
            await api.gattWrite(GattUuids.FACTORY_RESET, new Uint8Array([0x01]))
            await api.gattDisconnect()
            props.onFactoryReset()
          }}
          onDismiss={() => setConfirmReset(false)}
        />
      )}
    </div>
  )
}

export function CameraLogicTab({ c }: { c: DeviceConfig }) {
  const cam = c.cam
  const set = c.setCamField
  return (
    <div className="stack">
      <NotReady c={c} />
      {c.ready && !c.camLoaded && !c.camStatus && <div className="body-s muted">Reading Camera Logic…</div>}
      <div className="grid-2">
        <SwitchCard label="Logic Bypass" checked={!cam.enabled} onChange={(v) => set('enabled', !v)} />
        <SwitchCard label="Power Save Idle Mode" checked={cam.powerSaveIdleMode} onChange={(v) => set('powerSaveIdleMode', v)} />
        <div className="stack">
          <div className="card col gap12">
            <div className="title-m">Sequence</div>
            <NumberField label="Frame Count (0–64)" value={cam.frameCount} onChange={(v) => set('frameCount', v)} maxDigits={2} />
            <NumberField label="Max Sequence Count (0–64)" value={cam.maxSequenceCount} onChange={(v) => set('maxSequenceCount', v)} maxDigits={2} />
          </div>
          <div className="card col gap12">
            <div className="title-m">Policies</div>
            <Policy label="Wake Hold Refresh" options={['Extend', 'Restart', 'Ignore While Active']} value={cam.wakeHoldRefreshPolicy} onChange={(v) => set('wakeHoldRefreshPolicy', v)} />
            <Policy label="FP Without Prior HP" options={['Assert HP Then Wait', 'Ignore FP']} value={cam.fullPressWithoutHpPolicy} onChange={(v) => set('fullPressWithoutHpPolicy', v)} />
            <Policy label="FP After Max Sequences" options={['Ignore Until Activity End']} value={cam.fpAfterMaxSeqCountPolicy} onChange={(v) => set('fpAfterMaxSeqCountPolicy', v)} />
          </div>
        </div>
        <div className="card col gap12">
          <div className="title-m">Timing</div>
          <div className="fields-2">
            <NumberField label="Wake HP Hold (ms)" value={cam.wakeHalfPressHoldSec} onChange={(v) => set('wakeHalfPressHoldSec', v)} maxDigits={5} />
            <NumberField label="Min HP Before Shutter (ms)" value={cam.minHalfPressBeforeShutter} onChange={(v) => set('minHalfPressBeforeShutter', v)} maxDigits={5} />
            <NumberField label="Shutter Pulse Duration (ms)" value={cam.shutterPulseDuration} onChange={(v) => set('shutterPulseDuration', v)} maxDigits={5} />
            <NumberField label="Frame Spacing (ms)" value={cam.startFrameSpacingTicks} onChange={(v) => set('startFrameSpacingTicks', v)} maxDigits={5} />
            <NumberField label="Post-Shutter HP Hold (ms)" value={cam.postShutterHpHoldTenths} onChange={(v) => set('postShutterHpHoldTenths', v)} maxDigits={5} />
            <NumberField label="HP Debounce (ms)" value={cam.hpDebounceMs} onChange={(v) => set('hpDebounceMs', v)} />
            <NumberField label="FP Debounce (ms)" value={cam.fpDebounceMs} onChange={(v) => set('fpDebounceMs', v)} />
            <NumberField label="FP Ignore Gap (ms)" value={cam.fullPressIgnoreGapTenths} onChange={(v) => set('fullPressIgnoreGapTenths', v)} maxDigits={5} />
          </div>
        </div>
      </div>
      <div className="row">
        <button
          disabled={!c.camLoaded || !c.ready}
          onClick={async () => c.setCamStatus(await c.saveWithAck(GattUuids.CAMERA_CONFIG, GattUuids.CAMERA_CONFIG_STATUS, buildCameraConfig(cam)))}
        >
          Save Camera Logic
        </button>
        <StatusText text={c.camStatus} ok={!!c.camStatus?.startsWith('Saved')} />
      </div>
    </div>
  )
}

export function FeederTab({ c }: { c: DeviceConfig }) {
  const f = c.feeder
  const set = c.setFeederField
  return (
    <div className="stack">
      <NotReady c={c} />
      <div className="grid-2">
        <SwitchCard label="Feeder Enabled" checked={f.enabled} onChange={(v) => set('enabled', v)} />
        <div className="card col gap8">
          <HoldButton label="Run Pump (Hold)" disabled={!c.ready} onPress={c.startPump} onRelease={c.stopPump} />
          <span className="body-s muted">The pump runs while the button is held.</span>
        </div>
        <div className="card col gap12">
          <div className="title-m">Pump Timer</div>
          <NumberField label="Pump On Time (ms)" value={f.pumpOnMs} onChange={(v) => set('pumpOnMs', v)} maxDigits={7} />
          <NumberField label="Pump Off Time (ms)" value={f.pumpOffMs} onChange={(v) => set('pumpOffMs', v)} maxDigits={7} />
        </div>
        <div className="card col gap12">
          <div className="title-m">Pulse Stretch</div>
          <NumberField label="Minimum Pulse Width (ms)" value={f.pulseStretchMinMs} onChange={(v) => set('pulseStretchMinMs', v)} maxDigits={5} />
        </div>
      </div>
      <div className="row">
        <button
          disabled={!c.feederLoaded || !c.ready}
          onClick={async () => c.setFeederStatus(await c.saveWithAck(GattUuids.FEEDER_CONFIG, GattUuids.FEEDER_CONFIG_STATUS, buildFeederConfig(f)))}
        >
          Save Feeder Settings
        </button>
        <StatusText text={c.feederStatus} ok={!!c.feederStatus?.startsWith('Saved')} />
      </div>
    </div>
  )
}

export function CalibrationTab({ c }: { c: DeviceConfig }) {
  return (
    <div className="stack">
      <NotReady c={c} />
      <div className="grid-2">
        <CalibrationCard
          title="External Battery Calibration"
          help="Connect battery and enter the actual pack voltage measured with a multimeter, then click Set Cal."
          value={c.cal}
          onChange={c.setCal}
          status={c.calStatus}
          ready={c.ready}
          onSet={async () => c.setCalStatus((await api.gattWrite(GattUuids.CAL_SET, calibrationBytes(parseFloat(c.cal) || 0, 30000))) ? 'Calibration set' : 'Write failed')}
          onReset={async () => c.setCalStatus((await api.gattWrite(GattUuids.CAL_SET, new Uint8Array([0, 0]))) ? 'Reset to default' : 'Write failed')}
        />
        <CalibrationCard
          title="Internal CR2032 Calibration"
          help="Enter the actual CR2032 coin cell voltage measured with a multimeter, then click Set Cal."
          value={c.intCal}
          onChange={c.setIntCal}
          status={c.intCalStatus}
          ready={c.ready}
          onSet={async () => c.setIntCalStatus((await api.gattWrite(GattUuids.INT_CAL_SET, calibrationBytes(parseFloat(c.intCal) || 0, 5000))) ? 'Calibration set' : 'Write failed')}
          onReset={async () => c.setIntCalStatus((await api.gattWrite(GattUuids.INT_CAL_SET, new Uint8Array([0, 0]))) ? 'Reset to default' : 'Write failed')}
        />
      </div>
    </div>
  )
}

export function HubTab(props: {
  c: DeviceConfig
  nameForAddress: (addr: string) => string | null
  onOpenCameraLogs: () => void
  onOpenDeviceHistory: (addr: string) => void
}) {
  const { c } = props
  const notHub = c.ready && !c.isCameraHub
  return (
    <div className="grid-2">
      <div className="card col gap8">
        <div className="title-m">Camera Logs (SD card)</div>
        <div className="body-s muted">
          Starts the Hub's WiFi, joins it from this PC, then lists, downloads and deletes the Hub's SD-card logs.
          Downloaded logs also feed the Graphs tab.
        </div>
        {notHub && <div className="body-s error">This Camera doesn't expose the Hub log service (nRF52 firmware).</div>}
        <div className="row">
          {/* Debug builds allow it for every Camera so the mock-server path is reachable without Hub hardware. */}
          <button disabled={!(api.isDebug || (c.ready && c.isCameraHub))} onClick={props.onOpenCameraLogs}>Open Camera Logs</button>
        </div>
      </div>
      {!notHub && <NearbyDevicesCard nameForAddress={props.nameForAddress} onOpen={props.onOpenDeviceHistory} />}
    </div>
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
