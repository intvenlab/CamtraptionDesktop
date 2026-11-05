// Scan list model and shared formatters. Port of buildScanList / formatLastSeen (MainActivity.kt)
// and formatBytes (CameraLogsScreen.kt).

import { BleDevice, sortOrder } from './types'

export type ScanListItem =
  | { kind: 'unconfigured'; device: BleDevice }
  | { kind: 'group'; groupId: number; groupName: string | null; devices: BleDevice[] }
  | { kind: 'individual'; device: BleDevice }

export const byKitOrder = (a: BleDevice, b: BleDevice) => {
  const an = a.name ?? a.address
  const bn = b.name ?? b.address
  return sortOrder(a.deviceType) - sortOrder(b.deviceType) || (an < bn ? -1 : an > bn ? 1 : 0)
}

export function buildScanList(devices: BleDevice[], groupNames: Record<number, string> = {}): ScanListItem[] {
  const unconfigured: ScanListItem[] = devices.filter((d) => !d.isConfigured).map((device) => ({ kind: 'unconfigured', device }))
  const configured = devices.filter((d) => d.isConfigured)

  const byGroup = new Map<number, BleDevice[]>()
  for (const d of configured.filter((d) => d.groupId !== 0)) {
    const list = byGroup.get(d.groupId)
    if (list) list.push(d)
    else byGroup.set(d.groupId, [d])
  }
  const grouped: ScanListItem[] = [...byGroup.entries()]
    .map(([groupId, devs]) => ({ kind: 'group' as const, groupId, groupName: groupNames[groupId] ?? null, devices: [...devs].sort(byKitOrder) }))
    .sort((a, b) => a.groupId - b.groupId)

  const individual: ScanListItem[] = configured
    .filter((d) => d.groupId === 0)
    .sort((a, b) => b.rssi - a.rssi)
    .map((device) => ({ kind: 'individual', device }))

  return [...unconfigured, ...grouped, ...individual]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')

export function formatLastSeen(ts: number, now = Date.now()): string {
  const elapsed = now - ts
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.trunc(elapsed / 60_000)} min ago`
  if (elapsed < 86_400_000) return `${Math.trunc(elapsed / 3_600_000)} hr ago`
  if (elapsed < 172_800_000) return 'Yesterday'
  const d = new Date(ts)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** "MMM d, HH:mm:ss" */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/** "MMM d, yyyy HH:mm" */
export function formatEpoch(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "%,d" */
export const formatThousands = (n: number) => n.toLocaleString('en-US')

export const volts = (mv: number) => (mv / 1000).toFixed(3)
