// Camera Hub WiFi sessions, shared by Camera Logs (one Hub, interactive) and the Graphs tab's
// "Download Hub Logs" (every Hub in range, unattended). Same steps as CameraLogsScreen.kt's sync:
// over GATT set the clock and start the Hub's SoftAP, join it (netsh, in main), check /status.

import { GattUuids } from '../../shared/gattUuids'
import {
  HubCommands, HubWifiApInfo, RemoteLogFile, apBaseUrl, parseHubWifiApInfo, statusMatches
} from '../../shared/hubProtocol'
import { BleDevice, CachedHubLog } from '../../shared/types'
import { api, sleep } from './api'

export class HubSyncError extends Error {}

export type SessionPhase = 'STARTING_AP' | 'JOINING_WIFI' | 'VERIFYING'

/** A cached copy matches the Hub's file (same stream, name and size), so it needn't be downloaded again. */
export const sameFile = (c: CachedHubLog, r: RemoteLogFile) =>
  c.stream === r.stream && c.filename === r.filename && c.sizeBytes === r.sizeBytes

/**
 * Over an open GATT connection to the Hub: sets its clock, starts its AP, joins it and checks /status
 * belongs to hubAddress. Returns the Hub's base URL. onJoining fires just before the PC joins the
 * Hub's network, from which point the caller must call closeHubSession, even on failure.
 */
export async function openHubSession(
  hubAddress: string,
  onPhase: (p: SessionPhase) => void,
  onJoining: () => void
): Promise<string> {
  onPhase('STARTING_AP')
  await api.gattWrite(GattUuids.CAMERA_TIME_SYNC, HubCommands.nowTimeSync(), 3_000)
  const started = await api.gattWrite(GattUuids.CAMERA_WIFI_AP_CONTROL, HubCommands.AP_START, 3_000)
  if (!started) throw new HubSyncError("Couldn't ask the Hub to start WiFi (is it still connected over Bluetooth?)")

  let info: HubWifiApInfo | null = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    info = parseHubWifiApInfo(await api.gattRead(GattUuids.CAMERA_WIFI_AP_INFO, 3_000))
    if (info?.apState === 'UP' || info?.apState === 'ERROR') break
    await sleep(500)
  }
  if (!info || info.apState !== 'UP') throw new HubSyncError(`Hub WiFi didn't start (state: ${info?.apState ?? 'no response'})`)

  onPhase('JOINING_WIFI')
  onJoining()
  const joined = await api.hubWifiConnect(info.ssid, info.password, info.ip)
  if (!joined.ok) throw new HubSyncError(`Couldn't join ${info.ssid}: ${joined.error}`)

  onPhase('VERIFYING')
  const url = apBaseUrl(info)
  const status = await api.hubStatus(url)
  if (!status.ok) throw new HubSyncError(status.error)
  if (!statusMatches(status.value, hubAddress)) throw new HubSyncError(`Joined network belongs to a different Hub (${status.value.bleMac})`)
  return url
}

/**
 * Leaves the Hub's WiFi (if joined) and asks it to stop its AP. restoreWifi = false when another Hub
 * follows straight away, so the PC's own network is only restored once at the end.
 */
export async function closeHubSession(joined: boolean, restoreWifi = true): Promise<void> {
  if (joined) await api.hubWifiRelease(restoreWifi)
  // Best effort: if this doesn't reach the Hub, it turns its AP off by itself shortly after we leave.
  await api.gattWrite(GattUuids.CAMERA_WIFI_AP_CONTROL, HubCommands.AP_STOP, 3_000)
}

// ─── Download from every Hub ───────────────────────────────────────────────

export type HubSyncState =
  | { kind: 'waiting' }
  | { kind: 'connecting' }
  | { kind: 'session'; phase: SessionPhase }
  | { kind: 'downloading'; index: number; total: number; filename: string }
  | { kind: 'done'; downloaded: number; upToDate: number; failed: number }
  | { kind: 'skipped' | 'error'; message: string }

export const SESSION_PHASE_LABEL: Record<SessionPhase, string> = {
  STARTING_AP: 'Starting Hub WiFi…',
  JOINING_WIFI: 'Joining Hub WiFi…',
  VERIFYING: 'Checking Hub…'
}

/**
 * For each Hub in turn: connect over Bluetooth, open a WiFi session, download every log file not
 * already on this PC (or whose size changed), then close the session and disconnect. The PC's own
 * WiFi is restored once, after the last Hub. isCancelled is checked between files and between Hubs.
 */
export async function downloadAllHubLogs(
  hubs: BleDevice[],
  onState: (address: string, s: HubSyncState) => void,
  isCancelled: () => boolean
): Promise<void> {
  let joinedAny = false
  try {
    for (const hub of hubs) {
      if (isCancelled()) { onState(hub.address, { kind: 'skipped', message: 'Cancelled' }); continue }
      onState(hub.address, { kind: 'connecting' })
      let joined = false
      try {
        if ((await api.gattConnect(hub.address)) !== 'READY') throw new HubSyncError("Couldn't connect over Bluetooth")
        if (!(await api.gattHas(GattUuids.CAMERA_LOG_STATUS))) {
          onState(hub.address, { kind: 'skipped', message: 'No SD log service (not an ESP32 Hub)' })
          continue
        }
        const url = await openHubSession(hub.address, (phase) => onState(hub.address, { kind: 'session', phase }), () => {
          joined = true
          joinedAny = true
        })
        const list = await api.hubListLogs(url)
        if (!list.ok) throw new HubSyncError(`Couldn't list logs: ${list.error}`)
        const cached = await api.loadCatalog(hub.address)
        const pending = list.value.filter((r) => !cached.some((c) => sameFile(c, r)))
        let downloaded = 0
        let failed = 0
        for (let i = 0; i < pending.length && !isCancelled(); i++) {
          const f = pending[i]
          onState(hub.address, { kind: 'downloading', index: i + 1, total: pending.length, filename: f.filename })
          const r = await api.hubDownload(url, hub.address, f.stream, f.filename)
          if (r.ok) downloaded++
          else {
            failed++
            if (r.code === 0) throw new HubSyncError(`Lost the Hub during ${f.filename}: ${r.error}`)
          }
        }
        onState(hub.address, isCancelled() && downloaded + failed < pending.length
          ? { kind: 'skipped', message: `Cancelled after ${downloaded} of ${pending.length} files` }
          : { kind: 'done', downloaded, upToDate: list.value.length - pending.length, failed })
      } catch (e) {
        onState(hub.address, { kind: 'error', message: (e as Error).message })
      } finally {
        await closeHubSession(joined, false)
        await api.gattDisconnect()
      }
    }
  } finally {
    // Back onto the PC's own network once, after the last Hub.
    if (joinedAny) await api.hubWifiRelease(true)
  }
}
