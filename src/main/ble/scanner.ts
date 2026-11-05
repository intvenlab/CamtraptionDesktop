// Advertisement scanning. Equivalent of MainActivity.startScanning / parseScanResult: every
// advertisement carrying company ID 0xFFFF becomes a BleDevice, pushed to the renderer in batches.

import type { Peripheral } from '@stoprocent/noble'
import { parseManufacturerData, stripCompanyId } from '../../shared/advert'
import { AdapterState, BleDevice } from '../../shared/types'
import { getNoble, nobleLoadError, normalizeAddress } from './noble'

// Belt-and-braces scan restart, as on Android.
const SCAN_RESTART_MS = 10 * 60_000
const PUSH_INTERVAL_MS = 200

export class Scanner {
  readonly peripherals = new Map<string, Peripheral>()
  private names = new Map<string, string>()
  private pending = new Map<string, BleDevice>()
  private pushTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  adapterState: AdapterState = 'unknown'

  constructor(
    private readonly onDevices: (devices: BleDevice[]) => void,
    private readonly onAdapterState: (state: AdapterState, error: string | null) => void
  ) {}

  start() {
    const noble = getNoble()
    if (!noble) {
      this.setAdapterState('unsupported')
      return
    }
    noble.on('stateChange', (s) => {
      this.setAdapterState(s)
      if (s === 'poweredOn') void this.startScan()
    })
    noble.on('discover', (p) => this.onDiscover(p))
    this.setAdapterState(noble.state as AdapterState)
    if (noble.state === 'poweredOn') void this.startScan()
    this.restartTimer = setInterval(() => {
      if (this.adapterState === 'poweredOn') void this.restartScan()
    }, SCAN_RESTART_MS)
  }

  stop() {
    if (this.restartTimer) clearInterval(this.restartTimer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    void getNoble()?.stopScanningAsync().catch(() => {})
  }

  private setAdapterState(s: AdapterState) {
    this.adapterState = s
    this.onAdapterState(s, s === 'unsupported' ? nobleLoadError : null)
  }

  private async startScan() {
    try {
      // allowDuplicates: every advertisement, not just the first per device (live telemetry).
      await getNoble()?.startScanningAsync([], true)
    } catch (e) {
      console.warn('startScanning failed', e)
    }
  }

  private async restartScan() {
    try {
      await getNoble()?.stopScanningAsync()
    } catch {
      /* ignore */
    }
    await this.startScan()
  }

  private onDiscover(p: Peripheral) {
    const data = stripCompanyId(p.advertisement?.manufacturerData)
    if (!data) return
    const fields = parseManufacturerData(data)
    if (!fields) return
    const address = normalizeAddress(p.address, p.id)
    this.peripherals.set(address, p)
    // Windows reports the advertisement and the scan response as separate events, so the
    // local name is often missing; keep the last one seen.
    const localName = p.advertisement?.localName
    if (localName) this.names.set(address, localName)
    this.pending.set(address, {
      ...fields,
      address,
      name: this.names.get(address) ?? null,
      rssi: p.rssi,
      lastSeen: Date.now(),
      isConnected: true
    })
    if (!this.pushTimer) {
      this.pushTimer = setTimeout(() => {
        this.pushTimer = null
        const batch = [...this.pending.values()]
        this.pending.clear()
        this.onDevices(batch)
      }, PUSH_INTERVAL_MS)
    }
  }
}
