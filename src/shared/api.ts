// The renderer's view of the main process (exposed by src/preload as window.camtraption).

import type { HubHttpStatus, NearbyDevice, RemoteLogFile } from './hubProtocol'
import type { AdapterState, BleDevice, CachedHubLog, DeviceHistoryEntry, GattState, GattStatus } from './types'

export interface DownloadProgress {
  key: string
  done: number
  total: number
}

/** Errors from Hub HTTP calls come back as { error, code } (code = HTTP status, or 0 for network failures). */
export type HubResult<T> = { ok: true; value: T } | { ok: false; error: string; code: number }

export interface CamtraptionApi {
  isDebug: boolean

  // Scanning
  onDevices(cb: (devices: BleDevice[]) => void): () => void
  onAdapterState(cb: (state: AdapterState, error: string | null) => void): () => void
  getAdapterState(): Promise<{ state: AdapterState; error: string | null }>

  // Stores
  loadKnownDevices(): Promise<BleDevice[]>
  forgetDevice(address: string): Promise<void>
  forgetKit(groupId: number): Promise<void>
  loadGroupNames(): Promise<Record<number, string>>
  saveGroupName(groupId: number, name: string): Promise<void>
  loadHistory(address: string): Promise<DeviceHistoryEntry[]>
  appendHistory(address: string, entry: DeviceHistoryEntry): Promise<DeviceHistoryEntry[]>
  loadCatalog(cameraAddress: string): Promise<CachedHubLog[]>
  removeCached(entry: CachedHubLog): Promise<void>
  readLogTexts(entries: CachedHubLog[]): Promise<[filename: string, text: string][]>

  // GATT
  onGattStatus(cb: (s: GattStatus) => void): () => void
  getGattStatus(): Promise<GattStatus>
  gattConnect(address: string): Promise<GattState>
  gattDisconnect(): Promise<void>
  gattRead(uuid: string, timeoutMs?: number): Promise<Uint8Array | null>
  gattWrite(uuid: string, value: Uint8Array, timeoutMs?: number): Promise<boolean>
  gattHas(uuid: string): Promise<boolean>
  gattEnableNotification(uuid: string): Promise<boolean>
  gattWaitForNotification(uuid: string, timeoutMs: number): Promise<Uint8Array | null>

  // Camera Hub WiFi + HTTP
  hubWifiConnect(ssid: string, password: string, hubIp: string): Promise<HubResult<void>>
  hubWifiRelease(): Promise<void>
  hubStatus(baseUrl: string): Promise<HubResult<HubHttpStatus>>
  hubNearby(baseUrl: string): Promise<HubResult<NearbyDevice[]>>
  hubListLogs(baseUrl: string): Promise<HubResult<RemoteLogFile[]>>
  hubDownload(baseUrl: string, cameraAddress: string, stream: string, filename: string): Promise<HubResult<number>>
  hubDelete(baseUrl: string, stream: string, filename: string): Promise<HubResult<void>>
  onDownloadProgress(cb: (p: DownloadProgress) => void): () => void

  // Sharing (replaces Android share intents)
  saveCopies(paths: string[], suggestedName: string): Promise<string | null>
  showInFolder(path: string): Promise<void>
  historyFilePath(address: string): Promise<string | null>
  composeEmail(subject: string, body: string): Promise<void>
}
