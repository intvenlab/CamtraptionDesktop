// Shared UI. Port of CommonComposables.kt plus the small helpers the Android screens share.

import { ReactNode, useEffect, useRef, useState } from 'react'
import { NearbyDevice } from '../../shared/hubProtocol'
import { formatLastSeen, volts } from '../../shared/scanList'
import {
  BleDevice, DeviceType, GattStatus, cameraStateLabel, deviceIcon, deviceTypeName
} from '../../shared/types'
import { useBackHandler } from './nav'

// ─── Layout ────────────────────────────────────────────────────────────────

export function Screen(props: {
  title: ReactNode
  subtitle?: ReactNode
  onBack?: () => void
  actions?: ReactNode
  /** Rendered under the header (e.g. a Tabs bar), outside the scrolling content. */
  tabs?: ReactNode
  /** Form-like screens read better at a fixed width. */
  narrow?: boolean
  children: ReactNode
}) {
  useBackHandler(props.onBack)
  return (
    <div className="app">
      <div className={'topbar' + (props.tabs ? ' with-tabs' : '')}>
        {props.onBack && (
          <button className="icon" title="Back (Esc)" onClick={props.onBack}>←</button>
        )}
        <div className="grow col" style={{ gap: 0 }}>
          <h1>{props.title}</h1>
          {props.subtitle && <div className="subtitle">{props.subtitle}</div>}
        </div>
        {props.actions}
      </div>
      {props.tabs}
      <div className="content">
        <div className={'content-inner' + (props.narrow ? ' narrow' : '')}>{props.children}</div>
      </div>
    </div>
  )
}

export interface TabDef<T extends string> { id: T; label: string; dot?: boolean }

export function Tabs<T extends string>(props: { tabs: TabDef<T>[]; value: T; onChange: (t: T) => void; className?: string }) {
  return (
    <div className={'tabs ' + (props.className ?? '')} role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === props.value}
          className={'tab' + (t.id === props.value ? ' active' : '')}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
          {t.dot && <span className="tab-dot" />}
        </button>
      ))}
    </div>
  )
}

export function Segmented<T extends string>(props: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {props.options.map((o) => (
        <button key={o.id} className={o.id === props.value ? 'selected' : ''} onClick={() => props.onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  )
}

/** Centred placeholder: a faint image (the logo, as on the Android scan screen) or glyph, plus a line of text. */
export function EmptyState({ glyph, image, text }: { glyph?: string; image?: string; text: ReactNode }) {
  return (
    <div className="watermark">
      {image ? <img className="mark" src={image} alt="" /> : <div className="glyph">{glyph}</div>}
      <div>{text}</div>
    </div>
  )
}

export function Card(props: { children: ReactNode; className?: string; onClick?: () => void; onLongPress?: () => void }) {
  const press = useLongPress(props.onLongPress)
  const cls = ['card', props.onClick ? 'clickable' : '', props.className ?? ''].join(' ')
  return (
    <div
      className={cls}
      onClick={() => { if (!press.fired()) props.onClick?.() }}
      onContextMenu={props.onLongPress ? (e) => { e.preventDefault(); props.onLongPress?.() } : undefined}
      {...press.handlers}
    >
      {props.children}
    </div>
  )
}

/** Press-and-hold (500 ms) as on the phone; right-click does the same via onContextMenu. */
function useLongPress(onLongPress?: () => void) {
  const timer = useRef<number | null>(null)
  const firedRef = useRef(false)
  const clear = () => { if (timer.current != null) window.clearTimeout(timer.current); timer.current = null }
  return {
    fired: () => { const f = firedRef.current; firedRef.current = false; return f },
    handlers: onLongPress
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            if (e.button !== 0) return
            firedRef.current = false
            clear()
            timer.current = window.setTimeout(() => { firedRef.current = true; onLongPress() }, 500)
          },
          onPointerUp: clear,
          onPointerLeave: clear
        }
      : {}
  }
}

export function Divider() {
  return <hr className="divider" />
}

// ─── Feedback ──────────────────────────────────────────────────────────────

export function ConfirmDialog(props: {
  title: string
  text: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onDismiss: () => void
  destructive?: boolean
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); props.onDismiss() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  })
  return (
    <div className="backdrop" onClick={props.onDismiss}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        <div className="muted">{props.text}</div>
        <div className="actions">
          <button className="text" onClick={props.onDismiss}>Cancel</button>
          <button className={'text' + (props.destructive !== false ? ' danger' : '')} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function StatusText({ text, ok }: { text: string | null; ok: boolean }) {
  if (!text) return null
  return <div className={'body-s ' + (ok ? 'primary' : 'error')}>{text}</div>
}

export function Progress({ value, color }: { value?: number; color?: string }) {
  return (
    <div className={'progress' + (value == null ? ' indeterminate' : '')} style={{ color: color ?? 'var(--primary)' }}>
      <div style={value == null ? undefined : { width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

/** Blue while healthy; amber and red are kept as status colours. */
export function batteryColor(percent: number): string {
  if (percent > 50) return 'var(--primary)'
  if (percent > 20) return 'var(--warn)'
  return 'var(--error)'
}

export function GattStatusBanner({ status }: { status: GattStatus }) {
  const [text, color] = {
    IDLE: ['Not connected', 'var(--on-variant)'],
    CONNECTING: ['Connecting…', 'var(--accent)'],
    READY: ['Connected', 'var(--green)'],
    ERROR: [status.errorMessage ?? 'Connection error', 'var(--error)']
  }[status.state]
  return <div className="label-m" style={{ color }}>● {text}</div>
}

export function StatItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="col center" style={{ alignItems: 'center', gap: 0 }}>
      <div className="body-l semibold" style={{ color }}>{value}</div>
      <div className="label-s muted">{label}</div>
    </div>
  )
}

// ─── Form controls ─────────────────────────────────────────────────────────

export function TextField(props: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  maxLength?: number
  inputMode?: 'decimal' | 'numeric' | 'text'
}) {
  return (
    <div className="field">
      <label>{props.label}</label>
      <input
        value={props.value}
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        onChange={(e) => {
          const v = e.target.value
          if (props.maxLength == null || v.length <= props.maxLength) props.onChange(v)
        }}
      />
    </div>
  )
}

/** Digits only, at most maxDigits (NumberField in CommonComposables.kt). */
export function NumberField(props: { label: string; value: string; onChange: (v: string) => void; maxDigits?: number }) {
  const max = props.maxDigits ?? 3
  return (
    <div className="field">
      <label>{props.label}</label>
      <input
        value={props.value}
        inputMode="numeric"
        onChange={(e) => {
          const v = e.target.value
          if (v.length <= max && /^\d*$/.test(v)) props.onChange(v)
        }}
      />
    </div>
  )
}

export function Select<T extends string | number>(props: {
  label: string
  value: T
  options: T[]
  display: (v: T) => string
  onChange: (v: T) => void
}) {
  return (
    <div className="field">
      <label>{props.label}</label>
      <select
        value={String(props.value)}
        onChange={(e) => {
          const picked = props.options.find((o) => String(o) === e.target.value)
          if (picked !== undefined) props.onChange(picked)
        }}
      >
        {props.options.map((o) => <option key={String(o)} value={String(o)}>{props.display(o)}</option>)}
      </select>
    </div>
  )
}

export const CellCountSelect = (p: { value: number; onChange: (v: number) => void }) => (
  <Select label="Cell Count" value={p.value} options={[1, 2, 3, 4]} display={(c) => `${c} cell${c > 1 ? 's' : ''}`} onChange={p.onChange} />
)

export const KitSelect = (p: { value: number; onChange: (v: number) => void }) => (
  <Select
    label="Kit"
    value={p.value}
    options={Array.from({ length: 16 }, (_, i) => i)}
    display={(id) => (id === 0 ? 'No Kit (0)' : `Kit ${id}`)}
    onChange={p.onChange}
  />
)

export function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  )
}

export function SwitchCard({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="card row between">
      <div className="body-l">{label}</div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  )
}

/** Button that reports press / release (Run Pump (Hold)). Release also fires on leave, blur and unmount. */
export function HoldButton(props: { label: string; disabled?: boolean; onPress: () => void; onRelease: () => void }) {
  const held = useRef(false)
  const release = () => {
    if (!held.current) return
    held.current = false
    props.onRelease()
  }
  const releaseRef = useRef(release)
  releaseRef.current = release
  useEffect(() => {
    const onBlur = () => releaseRef.current()
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('blur', onBlur); releaseRef.current() }
  }, [])
  return (
    <button
      className="full"
      disabled={props.disabled}
      onPointerDown={(e) => {
        if (e.button !== 0 || held.current) return
        held.current = true
        props.onPress()
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
    >
      {props.label}
    </button>
  )
}

// ─── Device widgets ────────────────────────────────────────────────────────

export function CameraCard(props: {
  device: BleDevice
  onReset: () => void
  resetStatus?: string | null
  resetEnabled?: boolean
}) {
  const d = props.device
  const activity = (d.cameraLiveFlags & 0x01) !== 0
  const hp = (d.cameraLiveFlags & 0x02) !== 0
  return (
    <div className="card col gap8">
      <div className="title-m">Camera</div>
      <div className="row between">
        <div className="col" style={{ gap: 0 }}>
          <div className="label-m muted">Shutter Count</div>
          <div className="headline">{d.shutterCount}</div>
        </div>
        <button className="tonal-error" onClick={props.onReset} disabled={props.resetEnabled === false}>Reset</button>
      </div>
      {props.resetStatus && <StatusText text={props.resetStatus} ok={props.resetStatus.startsWith('Shutter')} />}
      <Divider />
      <div className="row between">
        <div className="label-m muted">State</div>
        <div className={'semibold' + (d.cameraState === 3 ? ' primary' : '')}>{cameraStateLabel(d.cameraState)}</div>
      </div>
      {(activity || hp) && (
        <div className="row body-s">
          {activity && <span className="primary">● Activity</span>}
          {hp && <span className="tertiary-text">● HP Out</span>}
        </div>
      )}
    </div>
  )
}

export function connectionText(d: BleDevice, fallback: string): string {
  return d.isConnected ? 'Connected' : d.lastSeen > 0 ? formatLastSeen(d.lastSeen) : fallback
}

/** One device line inside a Kit card on the scan list (DeviceRow in MainActivity.kt). */
export function DeviceRow({ device }: { device: BleDevice }) {
  const pct = device.extBatteryPercent
  const color = batteryColor(Math.max(0, pct))
  return (
    <div className="row">
      <span>{deviceIcon(device.deviceType)}</span>
      <span className="ellipsis" style={{ flex: 1 }}>{device.name ?? device.address}</span>
      {device.isConnected ? (
        <>
          <div style={{ flex: 2 }}><Progress value={Math.max(0, pct) / 100} color={color} /></div>
          <span className="body-s" style={{ color, minWidth: 34, textAlign: 'right' }}>{pct >= 0 ? `${pct}%` : '--'}</span>
          {pct >= 0 && pct <= 19 && <span className="body-s">⚠</span>}
        </>
      ) : (
        <div style={{ flex: 2 }} />
      )}
      <span className={'label-s ' + (device.isConnected ? 'green' : 'muted')} style={{ minWidth: 64, textAlign: 'right' }}>
        {connectionText(device, '')}
      </span>
    </div>
  )
}

export function IndividualDeviceCard(props: { device: BleDevice; onClick: () => void; onForget: () => void }) {
  const d = props.device
  const pct = d.extBatteryPercent
  const color = batteryColor(Math.max(0, pct))
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <Card onClick={props.onClick} onLongPress={() => setConfirm(true)}>
        <div className="row between">
          <div className="row">
            <span className="title-m">{deviceIcon(d.deviceType)}</span>
            <div className="col" style={{ gap: 0 }}>
              <span className="title-m">{d.name ?? d.address}</span>
              <span className={'label-s ' + (d.isConnected ? 'green' : 'muted')}>{connectionText(d, 'Disconnected')}</span>
            </div>
          </div>
          <span className="title-l" style={{ color }}>{pct >= 0 ? `${pct}%` : '--'}</span>
        </div>
        <div style={{ margin: '8px 0' }}><Progress value={Math.max(0, pct) / 100} color={color} /></div>
        <div className="row between">
          <span>{d.extVoltageMillivolts > 0 ? `${volts(d.extVoltageMillivolts)}V` : '--'}</span>
          <span>{d.rssi} dBm</span>
        </div>
      </Card>
      {confirm && (
        <ConfirmDialog
          title={`Forget ${d.name ?? d.address}?`}
          text="Removes this device from memory. If it is still nearby it will reappear automatically."
          confirmLabel="Forget"
          onConfirm={() => { setConfirm(false); props.onForget() }}
          onDismiss={() => setConfirm(false)}
        />
      )}
    </>
  )
}

/** One device the Hub hears (Settings card + Camera Logs screen). */
export function NearbyDeviceRow(props: { device: NearbyDevice; knownName: string | null; onClick?: () => void }) {
  const d = props.device
  const parts = [
    d.kit === 0 ? 'No Kit' : `Kit ${d.kit}`,
    d.extBatteryPercent >= 0 ? `${d.extBatteryPercent}% ext` : 'no ext batt',
    `int ${d.batteryPercent}%`
  ]
  if (d.deviceType === DeviceType.CAMERA) parts.push(`${d.shutterCount} shutters`)
  return (
    <div className={'row list-row'} onClick={props.onClick} style={{ cursor: props.onClick ? 'pointer' : 'default' }}>
      <span className="body-l">{deviceIcon(d.deviceType)}</span>
      <div className="col grow" style={{ gap: 0 }}>
        <span className="body-l">{props.knownName ?? (d.isConfigured ? deviceTypeName(d.deviceType) : 'Unconfigured device')}</span>
        <span className="body-s muted">{parts.join(' · ')}</span>
        <span className="label-s muted mono">{d.address}</span>
      </div>
      <div className="col" style={{ alignItems: 'flex-end', gap: 0 }}>
        <span className="body-s">{d.rssi} dBm</span>
        <span className="label-s muted">{d.ageSeconds < 5 ? 'now' : `${d.ageSeconds}s ago`}</span>
      </div>
    </div>
  )
}
