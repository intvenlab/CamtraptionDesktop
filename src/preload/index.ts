import { contextBridge, ipcRenderer } from 'electron'
import type { CamtraptionApi } from '../shared/api'

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: CamtraptionApi = {
  isDebug: ipcRenderer.sendSync('isDebugSync') === true,

  onDevices: (cb) => subscribe('devices', cb),
  onAdapterState: (cb) => subscribe('adapterState', cb),
  getAdapterState: invoke('getAdapterState') as CamtraptionApi['getAdapterState'],

  loadKnownDevices: invoke('loadKnownDevices') as CamtraptionApi['loadKnownDevices'],
  forgetDevice: invoke('forgetDevice') as CamtraptionApi['forgetDevice'],
  forgetKit: invoke('forgetKit') as CamtraptionApi['forgetKit'],
  loadGroupNames: invoke('loadGroupNames') as CamtraptionApi['loadGroupNames'],
  saveGroupName: invoke('saveGroupName') as CamtraptionApi['saveGroupName'],
  loadHistory: invoke('loadHistory') as CamtraptionApi['loadHistory'],
  appendHistory: invoke('appendHistory') as CamtraptionApi['appendHistory'],
  loadCatalog: invoke('loadCatalog') as CamtraptionApi['loadCatalog'],
  removeCached: invoke('removeCached') as CamtraptionApi['removeCached'],
  readLogTexts: invoke('readLogTexts') as CamtraptionApi['readLogTexts'],

  onGattStatus: (cb) => subscribe('gattStatus', cb),
  getGattStatus: invoke('getGattStatus') as CamtraptionApi['getGattStatus'],
  gattConnect: invoke('gattConnect') as CamtraptionApi['gattConnect'],
  gattDisconnect: invoke('gattDisconnect') as CamtraptionApi['gattDisconnect'],
  gattRead: invoke('gattRead') as CamtraptionApi['gattRead'],
  gattWrite: invoke('gattWrite') as CamtraptionApi['gattWrite'],
  gattHas: invoke('gattHas') as CamtraptionApi['gattHas'],
  gattEnableNotification: invoke('gattEnableNotification') as CamtraptionApi['gattEnableNotification'],
  gattWaitForNotification: invoke('gattWaitForNotification') as CamtraptionApi['gattWaitForNotification'],

  hubWifiConnect: invoke('hubWifiConnect') as CamtraptionApi['hubWifiConnect'],
  hubWifiRelease: invoke('hubWifiRelease') as CamtraptionApi['hubWifiRelease'],
  hubStatus: invoke('hubStatus') as CamtraptionApi['hubStatus'],
  hubNearby: invoke('hubNearby') as CamtraptionApi['hubNearby'],
  hubListLogs: invoke('hubListLogs') as CamtraptionApi['hubListLogs'],
  hubDownload: invoke('hubDownload') as CamtraptionApi['hubDownload'],
  hubDelete: invoke('hubDelete') as CamtraptionApi['hubDelete'],
  onDownloadProgress: (cb) => subscribe('downloadProgress', cb),

  saveCopies: invoke('saveCopies') as CamtraptionApi['saveCopies'],
  showInFolder: invoke('showInFolder') as CamtraptionApi['showInFolder'],
  historyFilePath: invoke('historyFilePath') as CamtraptionApi['historyFilePath'],
  composeEmail: invoke('composeEmail') as CamtraptionApi['composeEmail']
}

contextBridge.exposeInMainWorld('camtraption', api)
