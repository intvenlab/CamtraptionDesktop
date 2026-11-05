// Electron main process: owns Bluetooth (noble), the Hub WiFi/HTTP session and the JSON stores,
// and serves them to the renderer over IPC (see src/shared/api.ts).

import { app, BrowserWindow, dialog, ipcMain, shell, WebContents } from 'electron'
import { copyFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { HubResult } from '../shared/api'
import type { AdapterState, BleDevice, CachedHubLog, DeviceHistoryEntry } from '../shared/types'
import { GattManager } from './ble/gatt'
import { Scanner } from './ble/scanner'
import { HubHttpClient, HubHttpError } from './hub/http'
import { HubWifiManager } from './hub/wifi'
import { CameraLogCatalogStore, DeviceHistoryStore, GroupNameStore, KnownDeviceStore, TelemetryStore } from './stores'

const isDebug = !app.isPackaged
let win: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  const known = new KnownDeviceStore(dataDir)
  const history = new DeviceHistoryStore(dataDir)
  const groupNames = new GroupNameStore(dataDir)
  const catalog = new CameraLogCatalogStore(dataDir)
  const telemetry = new TelemetryStore(dataDir)
  const wifi = new HubWifiManager()

  let adapter: { state: AdapterState; error: string | null } = { state: 'unknown', error: null }
  const scanner = new Scanner(
    (devices: BleDevice[]) => {
      devices.forEach((d) => { known.save(d); telemetry.record(d) })
      send('devices', devices)
    },
    (state, error) => {
      adapter = { state, error }
      send('adapterState', state, error)
    }
  )
  const gatt = new GattManager((addr) => scanner.peripherals.get(addr), (s) => send('gattStatus', s))

  /** Hub HTTP calls: errors become values so the renderer gets the code (409 etc.) back. */
  async function hub<T>(fn: () => Promise<T>): Promise<HubResult<T>> {
    try {
      return { ok: true, value: await fn() }
    } catch (e) {
      const code = e instanceof HubHttpError ? e.code : 0
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : null
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, code, error: cause && msg === 'fetch failed' ? cause : msg }
    }
  }

  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args) => fn(...args))

  handle('getAdapterState', () => adapter)
  handle('loadKnownDevices', () => known.loadAll())
  handle('forgetDevice', (addr: string) => known.forgetDevice(addr))
  handle('forgetKit', (groupId: number) => known.forgetKit(groupId))
  handle('loadGroupNames', () => groupNames.loadAll())
  handle('saveGroupName', (id: number, name: string) => groupNames.save(id, name))
  handle('loadHistory', (addr: string) => history.load(addr))
  handle('appendHistory', (addr: string, e: DeviceHistoryEntry) => history.append(addr, e))
  handle('loadCatalog', (addr: string) => catalog.loadFor(addr))
  handle('loadTelemetry', (addrs: string[], from: number, to: number) => telemetry.load(addrs, from, to))
  handle('removeCached', (e: CachedHubLog) => catalog.remove(e))
  handle('readLogTexts', async (entries: CachedHubLog[]) =>
    Promise.all(entries.filter((e) => existsSync(e.localCachePath))
      .map(async (e) => [e.filename, await readFile(e.localCachePath, 'utf8')] as [string, string])))

  handle('getGattStatus', () => gatt.getStatus())
  handle('gattConnect', (addr: string) => gatt.connect(addr))
  handle('gattDisconnect', () => gatt.disconnect())
  handle('gattRead', (uuid: string, t?: number) => gatt.read(uuid, t))
  handle('gattWrite', (uuid: string, v: Uint8Array, t?: number) => gatt.write(uuid, v, t))
  handle('gattHas', (uuid: string) => gatt.hasCharacteristic(uuid))
  handle('gattEnableNotification', (uuid: string) => gatt.enableNotification(uuid))
  handle('gattWaitForNotification', (uuid: string, t: number) => gatt.waitForNotification(uuid, t))

  handle('hubWifiConnect', (ssid: string, pass: string, ip: string) => hub(() => wifi.connect(ssid, pass, ip)))
  handle('hubWifiRelease', () => wifi.release())
  handle('hubStatus', (base: string) => hub(() => new HubHttpClient(base).status()))
  handle('hubNearby', (base: string) => hub(() => new HubHttpClient(base).nearby()))
  handle('hubListLogs', (base: string) => hub(() => new HubHttpClient(base).listLogs()))
  handle('hubDelete', (base: string, stream: string, file: string) => hub(() => new HubHttpClient(base).delete(stream, file)))
  ipcMain.handle('hubDownload', (e, base: string, addr: string, stream: string, file: string) =>
    hub(async () => {
      const key = `${stream}/${file}`
      const dest = catalog.localFileFor(addr, stream, file)
      const sender: WebContents = e.sender
      const bytes = await new HubHttpClient(base).download(stream, file, dest, (done, total) => {
        if (!sender.isDestroyed()) sender.send('downloadProgress', { key, done, total })
      })
      catalog.upsert({ cameraAddress: addr, stream, filename: file, localCachePath: dest, downloadedAt: Date.now(), sizeBytes: bytes })
      return bytes
    }))

  handle('historyFilePath', (addr: string) => {
    const f = history.fileFor(addr)
    return existsSync(f) ? f : null
  })
  handle('showInFolder', (p: string) => shell.showItemInFolder(p))
  handle('composeEmail', (subject: string, body: string) =>
    shell.openExternal(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`))
  handle('saveCopies', async (paths: string[], suggestedName: string) => {
    const existing = paths.filter((p) => existsSync(p))
    if (existing.length === 0 || !win) return null
    if (existing.length === 1) {
      const r = await dialog.showSaveDialog(win, { defaultPath: suggestedName || basename(existing[0]) })
      if (r.canceled || !r.filePath) return null
      await copyFile(existing[0], r.filePath)
      return r.filePath
    }
    const r = await dialog.showOpenDialog(win, { title: 'Save logs to folder', properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    const dir = r.filePaths[0]
    // Files from different streams can share a name (e.g. 2026-10-16.jsonl): prefix the stream folder.
    for (const p of existing) await copyFile(p, join(dir, `${basename(join(p, '..'))}-${basename(p)}`))
    return dir
  })

  win = new BrowserWindow({
    width: 1000,
    height: 820,
    minWidth: 420,
    minHeight: 500,
    title: 'Camtraption Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.error('[renderer]', e.message)
  })
  win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer] process gone:', details.reason, details.exitCode))
  if (isDebug && process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  ipcMain.on('isDebugSync', (e) => { e.returnValue = isDebug })

  win.webContents.once('did-finish-load', () => scanner.start())

  // Hold the quit until the Hub WiFi is released (reconnects the PC's normal network) and GATT is closed.
  let cleanedUp = false
  app.on('before-quit', (e) => {
    if (cleanedUp) return
    e.preventDefault()
    cleanedUp = true
    known.flush()
    telemetry.flush()
    scanner.stop()
    void Promise.allSettled([gatt.disconnect(), wifi.release()]).finally(() => app.quit())
  })
})

app.on('window-all-closed', () => app.quit())
