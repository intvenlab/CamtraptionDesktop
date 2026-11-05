// Camera Log Browser for ESP32 Camera Hubs. Port of CameraLogsScreen.kt: reads CAMERA_LOG_STATUS
// over the already-open GATT connection, starts the Hub's SoftAP, joins it (netsh, in main), then
// lists / downloads / deletes the Hub's SD log files over HTTP. Downloads are cached locally.

import { useCallback, useEffect, useRef, useState } from 'react'
import { GattUuids } from '../../../shared/gattUuids'
import { friendlyLogName } from '../../../shared/hubLogParser'
import {
  CameraLogStatus, HUB_STREAM_CAMERA, HUB_STREAM_SCAN, HubCommands, NearbyDevice, RemoteLogFile, parseCameraLogStatus,
  sortNearbyForDisplay, statusMatches
} from '../../../shared/hubProtocol'
import { formatBytes, formatEpoch } from '../../../shared/scanList'
import { BleDevice, CachedHubLog } from '../../../shared/types'
import { api, sleep } from '../api'
import { useGattStatus, useToast } from '../context'
import { HubSyncError, closeHubSession, openHubSession, sameFile } from '../hubSync'
import { ConfirmDialog, Divider, GattStatusBanner, NearbyDeviceRow, Progress, Screen, TextField } from '../components'

type SyncPhase = 'IDLE' | 'STARTING_AP' | 'JOINING_WIFI' | 'VERIFYING' | 'READY' | 'LOST' | 'STOPPING' | 'ERROR'

const PHASE_LABEL: Record<SyncPhase, string> = {
  IDLE: 'Not connected to Hub WiFi',
  STARTING_AP: 'Starting Hub WiFi…',
  JOINING_WIFI: 'Joining Hub WiFi…',
  VERIFYING: 'Checking Hub…',
  READY: 'Connected to Hub WiFi',
  LOST: 'Hub not responding – click Refresh to retry',
  STOPPING: 'Disconnecting…',
  ERROR: 'Error'
}

/** Phases where an HTTP session exists (file list + Disconnect are shown). */
const hasSession = (p: SyncPhase) => p === 'READY' || p === 'LOST'

const byStreamNewestFirst = (a: RemoteLogFile, b: RemoteLogFile) =>
  a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0

export default function CameraLogsScreen(props: {
  device: BleDevice
  nameForAddress: (addr: string) => string | null
  onOpenLogs: (entries: CachedHubLog[], stream: string, device: string | null) => void
  onBack: () => void
}) {
  const d = props.device
  const gatt = useGattStatus()
  const toast = useToast()
  const [logStatus, setLogStatus] = useState<CameraLogStatus | null>(null)
  const [notAHub, setNotAHub] = useState(false)
  const [statusReadFailed, setStatusReadFailed] = useState(false)
  const [phase, setPhase] = useState<SyncPhase>('IDLE')
  const [message, setMessage] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [remoteFiles, setRemoteFiles] = useState<RemoteLogFile[]>([])
  const [cached, setCached] = useState<CachedHubLog[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [deleteTarget, setDeleteTarget] = useState<RemoteLogFile | null>(null)
  const [mockUrl, setMockUrl] = useState('http://localhost:8080')
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [seen, setSeen] = useState<NearbyDevice[] | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const baseUrlRef = useRef(baseUrl)
  baseUrlRef.current = baseUrl
  const joinedWifi = useRef(false)

  const reloadCache = useCallback(async () => setCached(await api.loadCatalog(d.address)), [d.address])

  const readLogStatus = async () => {
    const parsed = parseCameraLogStatus(await api.gattRead(GattUuids.CAMERA_LOG_STATUS, 5_000))
    setStatusReadFailed(parsed == null)
    if (parsed) setLogStatus(parsed)
    else if (gatt.state === 'READY' && !(await api.gattHas(GattUuids.CAMERA_LOG_STATUS))) setNotAHub(true)
  }

  /** Throws { network: true } style errors: HTTP errors keep the session, network errors lose it. */
  const refreshRemote = async (url = baseUrlRef.current) => {
    if (!url) return
    const r = await api.hubListLogs(url)
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code })
    setRemoteFiles([...r.value].sort(byStreamNewestFirst))
    setMessage(null)
    if (phaseRef.current === 'LOST') setPhase('READY')
  }

  /** For user-initiated refreshes: a network failure marks the session LOST instead of throwing. */
  const refreshRemoteOrMarkLost = async () => {
    try {
      await refreshRemote()
    } catch (e) {
      const code = (e as { code?: number }).code ?? 0
      if (code > 0) setMessage(`Refresh failed: ${(e as Error).message}`)
      else {
        setMessage(`Can't reach the Hub (${(e as Error).message})`)
        setPhase('LOST')
      }
    }
  }

  const stopSync = async () => {
    setBaseUrl(null)
    setRemoteFiles([])
    const joined = joinedWifi.current
    joinedWifi.current = false
    await closeHubSession(joined)
  }
  const stopSyncRef = useRef(stopSync)
  stopSyncRef.current = stopSync

  const startSync = async () => {
    setMessage(null)
    try {
      const url = await openHubSession(d.address, setPhase, () => { joinedWifi.current = true })
      setBaseUrl(url)
      await refreshRemote(url)
      setPhase('READY')
    } catch (e) {
      setMessage((e as Error).message)
      setPhase('ERROR')
      await stopSync()
    }
  }

  const connectMock = async () => {
    setMessage(null)
    try {
      setPhase('VERIFYING')
      const url = mockUrl.trim()
      const status = await api.hubStatus(url)
      if (!status.ok) throw new HubSyncError(status.error)
      setBaseUrl(url)
      await refreshRemote(url)
      setPhase('READY')
      if (!statusMatches(status.value, d.address)) setMessage(`Mock server (bleMac ${status.value.bleMac} ≠ this device)`)
    } catch (e) {
      setMessage((e as Error).message)
      setPhase('ERROR')
      setBaseUrl(null)
    }
  }

  const download = async (f: RemoteLogFile) => {
    const url = baseUrlRef.current
    if (!url) return
    const key = `${f.stream}/${f.filename}`
    setProgress((p) => ({ ...p, [key]: 0 }))
    try {
      const r = await api.hubDownload(url, d.address, f.stream, f.filename)
      if (!r.ok) {
        setMessage(`Download failed: ${f.filename} – ${r.error}`)
        if (r.code === 0) setPhase('LOST')
      }
      await reloadCache()
    } finally {
      setProgress((p) => { const n = { ...p }; delete n[key]; return n })
    }
  }

  const deleteFile = async (f: RemoteLogFile) => {
    const url = baseUrlRef.current
    if (!url) return
    const r = await api.hubDelete(url, f.stream, f.filename)
    if (!r.ok) {
      setMessage(r.code === 409 ? `${f.filename} is still being written – it can be deleted after it rotates` : `Delete failed: ${r.error}`)
      return
    }
    try { await refreshRemote() } catch { /* Refresh reports it */ }
    await readLogStatus()
  }

  // Download progress from main.
  useEffect(() => api.onDownloadProgress(({ key, done, total }) => {
    if (total > 0) setProgress((p) => (key in p ? { ...p, [key]: done / total } : p))
  }), [])

  // On (re)connect: set the Hub clock and read SD status.
  useEffect(() => {
    void reloadCache()
    if (gatt.state !== 'READY') return
    void (async () => {
      await api.gattWrite(GattUuids.CAMERA_TIME_SYNC, HubCommands.nowTimeSync(), 3_000)
      await readLogStatus()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatt.state])

  // While connected to the Hub's WiFi, list the devices it hears (GET /nearby every 5 s).
  useEffect(() => {
    setSeen(null)
    if (!baseUrl) return
    let stop = false
    void (async () => {
      while (!stop) {
        const r = await api.hubNearby(baseUrl)
        if (stop) break
        if (r.ok) setSeen(sortNearbyForDisplay(r.value))
        await sleep(5_000)
      }
    })()
    return () => { stop = true }
  }, [baseUrl])

  // Leaving the screen always tears the session down: Hub WiFi released, Hub AP stopped.
  useEffect(() => () => { void stopSyncRef.current() }, [])

  const busy = phase === 'STARTING_AP' || phase === 'JOINING_WIFI' || phase === 'VERIFYING' || phase === 'STOPPING'
  const downloading = Object.keys(progress).length > 0
  const pending = remoteFiles.filter((r) => !cached.some((c) => sameFile(c, r)))
  const closedFiles = remoteFiles.filter((f) => !f.isCurrentlyOpen)
  const scanLogs = cached.filter((c) => c.stream === HUB_STREAM_SCAN)
  const hubLogs = cached.filter((c) => c.stream === HUB_STREAM_CAMERA)
  const s = logStatus

  const share = async (entries: CachedHubLog[]) => {
    const label = `${d.groupId !== 0 ? `Kit ${d.groupId} - ` : ''}${d.name ?? d.address}`
    const saved = await api.saveCopies(entries.map((e) => e.localCachePath), entries.length === 1 ? entries[0].filename : '')
    if (saved) {
      toast(`Saved to ${saved}`)
      void api.showInFolder(saved)
      void api.composeEmail(`Camera Hub Logs: ${label}`, `MAC: ${d.address}\n\nSent from Camtraption Desktop\n\n(Attach the saved files from: ${saved})`)
    }
  }

  return (
    <Screen title="Camera Logs" onBack={props.onBack}>
      <GattStatusBanner status={gatt} />

      <div className="card col" style={{ gap: 6 }}>
        <div className="title-m">Hub SD Card</div>
        {notAHub ? (
          <div>This Camera doesn't support SD logging (nRF52 firmware). Log sync needs an ESP32 Camera Hub.</div>
        ) : s == null ? (
          <div>
            {gatt.state === 'CONNECTING' ? 'Connecting over Bluetooth…'
              : gatt.state !== 'READY' ? 'Not connected over Bluetooth. Go back and reopen Settings to reconnect.'
                : statusReadFailed ? "Couldn't read SD status – click Refresh" : 'Reading status…'}
          </div>
        ) : (
          <>
            <LabelValue label="SD card" value={s.sdState[0] + s.sdState.slice(1).toLowerCase() + (s.sdTotalMB > 0 ? `  (${s.sdUsedMB} / ${s.sdTotalMB} MB)` : '')} />
            <LabelValue label="Camera log" value={`${s.cameraFileCount} files, ${formatBytes(s.cameraBytes)}`} />
            <LabelValue label="Scan log" value={`${s.scanFileCount} files, ${formatBytes(s.scanBytes)}`} />
            <LabelValue label="Hub clock" value={s.timeSynced ? formatEpoch(s.epochNow) : 'Not set'} />
            {s.droppedRecords > 0 && <LabelValue label="Dropped records" value={String(s.droppedRecords)} />}
          </>
        )}
        <div><button className="text" disabled={gatt.state !== 'READY' || busy} onClick={() => void readLogStatus()}>Refresh</button></div>
      </div>

      <div className="card col gap8">
        <div className="title-m">Log Sync</div>
        <div>{PHASE_LABEL[phase]}</div>
        {message && <div className="body-s error">{message}</div>}
        {busy && <Progress />}
        {hasSession(phase) ? (
          <>
            <button className="outlined full" onClick={async () => { setPhase('STOPPING'); await stopSync(); setPhase('IDLE') }}>
              Disconnect Hub WiFi
            </button>
            <Divider />
            <div className="title-s">Devices seen by Hub{seen ? ` (${seen.length})` : ''}</div>
            {seen == null ? <div className="body-s">Reading…</div>
              : seen.length === 0 ? <div className="body-s">No devices heard in the last 20 s.</div>
                : (
                  <div>
                    {seen.map((n) => (
                      <NearbyDeviceRow key={n.address} device={n} knownName={props.nameForAddress(n.address)}
                        onClick={() => props.onOpenLogs(scanLogs, HUB_STREAM_SCAN, n.address)} />
                    ))}
                  </div>
                )}
          </>
        ) : (
          <>
            <button className="full" disabled={busy || notAHub || gatt.state !== 'READY'} onClick={() => void startSync()}>
              Connect to Hub WiFi
            </button>
            <div className="body-s muted">This PC leaves its current WiFi network while syncing and reconnects afterwards.</div>
          </>
        )}
        {api.isDebug && !hasSession(phase) && (
          <>
            <Divider />
            <div className="label-m">Debug: mock Hub server (firmware/tools/mock_hub.py)</div>
            <TextField label="Mock server URL" value={mockUrl} onChange={setMockUrl} />
            <button className="outlined full" disabled={busy} onClick={() => void connectMock()}>Use mock server</button>
          </>
        )}
      </div>

      {hasSession(phase) && (
        <>
          <div className="row">
            <button
              className="grow"
              disabled={pending.length === 0 || downloading || bulkDownloading}
              onClick={async () => {
                setBulkDownloading(true)
                try { for (const f of pending) await download(f) } finally { setBulkDownloading(false) }
              }}
            >
              {pending.length === 0 ? 'All downloaded' : `Download ${pending.length} new`}
            </button>
            <button className="outlined" disabled={downloading || bulkDownloading} onClick={() => void refreshRemoteOrMarkLost()}>Refresh</button>
          </div>
          {closedFiles.length > 0 && (
            <button className="outlined danger full" disabled={downloading || bulkDownloading || bulkDeleting} onClick={() => setConfirmBulkDelete(true)}>
              {bulkDeleting ? 'Deleting…' : `Delete old files on Hub (${closedFiles.length})`}
            </button>
          )}
          {[HUB_STREAM_CAMERA, HUB_STREAM_SCAN].map((stream) => {
            const files = remoteFiles.filter((f) => f.stream === stream)
            return (
              <div key={stream} className="col gap8">
                <div className="title-s">{stream === HUB_STREAM_CAMERA ? 'On Hub – Camera events' : 'On Hub – Nearby devices'}</div>
                {files.length === 0 && <div className="body-s">No files</div>}
                {files.map((f) => {
                  const key = `${f.stream}/${f.filename}`
                  const isCached = cached.some((c) => sameFile(c, f))
                  const p = progress[key]
                  const detail = [formatBytes(f.sizeBytes), f.isCurrentlyOpen ? 'recording' : null, isCached ? 'downloaded' : null].filter(Boolean).join(' · ')
                  return (
                    <div key={key} className="card compact col gap8">
                      <div className="row">
                        <div className="col grow" style={{ gap: 0 }}>
                          <span className="body-l">{friendlyLogName(f.filename)}</span>
                          <span className="body-s muted">{detail}</span>
                        </div>
                        <button className="text" disabled={p != null} onClick={() => void download(f)}>{isCached ? 'Re-download' : 'Download'}</button>
                        <button className={'text' + (f.isCurrentlyOpen ? '' : ' danger')} disabled={p != null || f.isCurrentlyOpen} onClick={() => setDeleteTarget(f)}>Delete</button>
                      </div>
                      {p != null && <Progress value={p} />}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </>
      )}

      <div className="title-s">Downloaded to this computer</div>
      {cached.length === 0 ? (
        <div className="body-s">Nothing downloaded yet</div>
      ) : (
        <>
          <div className="row">
            <button className="grow" disabled={scanLogs.length === 0} onClick={() => props.onOpenLogs(scanLogs, HUB_STREAM_SCAN, null)}>Devices the Hub heard</button>
            <button className="outlined grow" disabled={hubLogs.length === 0} onClick={() => props.onOpenLogs(hubLogs, HUB_STREAM_CAMERA, null)}>Hub log (all days)</button>
          </div>
          <button className="outlined full" onClick={() => void share(cached)}>Save all ({cached.length})…</button>
          {cached.map((c) => (
            <div key={`${c.stream}/${c.filename}`} className="card compact clickable row" onClick={() => props.onOpenLogs([c], c.stream, null)}>
              <div className="col grow" style={{ gap: 0 }}>
                <span className="body-l">{(c.stream === HUB_STREAM_SCAN ? 'Nearby devices' : 'Hub log') + ' · ' + friendlyLogName(c.filename)}</span>
                <span className="body-s muted">{formatBytes(c.sizeBytes)} · downloaded {formatEpoch(Math.floor(c.downloadedAt / 1000))}</span>
              </div>
              <button className="text" onClick={(e) => { e.stopPropagation(); props.onOpenLogs([c], c.stream, null) }}>View</button>
              <button className="text" onClick={(e) => { e.stopPropagation(); void share([c]) }}>Save…</button>
              <button className="text" onClick={async (e) => { e.stopPropagation(); await api.removeCached(c); await reloadCache() }}>Remove</button>
            </div>
          ))}
        </>
      )}

      {confirmBulkDelete && (() => {
        const notDownloaded = closedFiles.filter((r) => !cached.some((c) => sameFile(c, r))).length
        return (
          <ConfirmDialog
            title={`Delete ${closedFiles.length} old files from the Hub?`}
            text={"Deletes every file on the Hub except the ones it's currently writing. " +
              (notDownloaded > 0 ? `${notDownloaded} of them have NOT been downloaded to this computer and will be lost.` : 'All of them are downloaded on this computer.')}
            confirmLabel="Delete"
            onDismiss={() => setConfirmBulkDelete(false)}
            onConfirm={async () => {
              setConfirmBulkDelete(false)
              setBulkDeleting(true)
              let failed = 0
              for (const f of closedFiles) {
                const r = baseUrl ? await api.hubDelete(baseUrl, f.stream, f.filename) : { ok: false }
                if (!r.ok) failed++
              }
              setBulkDeleting(false)
              try { await refreshRemote() } catch { /* Refresh reports it */ }
              await readLogStatus()
              if (failed > 0) setMessage(`${failed} file(s) couldn't be deleted`)
            }}
          />
        )
      })()}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${deleteTarget.filename} from the Hub?`}
          text={cached.some((c) => sameFile(c, deleteTarget))
            ? 'A copy is downloaded on this computer.'
            : 'This file has NOT been downloaded to this computer. It will be permanently lost.'}
          confirmLabel="Delete"
          onDismiss={() => setDeleteTarget(null)}
          onConfirm={() => { const f = deleteTarget; setDeleteTarget(null); void deleteFile(f) }}
        />
      )}
    </Screen>
  )
}

function LabelValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between">
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  )
}
