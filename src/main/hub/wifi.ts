// Joins the Camera Hub's SoftAP. Desktop equivalent of HubWifiManager.kt, using Windows `netsh wlan`.
// Unlike Android's app-scoped WifiNetworkSpecifier, this switches the PC's WiFi to the Hub for the
// whole sync; release() puts it back on the network it was on before.

import { execFile } from 'node:child_process'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm, writeFile } from 'node:fs/promises'

const JOIN_TIMEOUT_MS = 30_000

function netsh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Verbatim so key="value with spaces" reaches netsh exactly as written.
    execFile('netsh', args, { windowsHide: true, windowsVerbatimArguments: true, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stdout || stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

/** netsh key="value" argument (quotes can't be escaped for netsh, so they're dropped). */
const kv = (key: string, value: string) => `${key}="${value.replace(/"/g, '')}"`

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function profileXml(ssid: string, password: string): string {
  const name = xmlEscape(ssid)
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${name}</name>
  <SSIDConfig><SSID><name>${name}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(password)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>`
}

interface WlanInterface {
  name: string
  state: string
  ssid: string | null
  profile: string | null
}

/** First wireless interface from `netsh wlan show interfaces` (English labels). */
async function currentInterface(): Promise<WlanInterface | null> {
  const out = await netsh(['wlan', 'show', 'interfaces'])
  const field = (label: string) => {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, 'mi').exec(out)
    return m ? m[1].trim() : null
  }
  const name = field('Name')
  if (!name) return null
  return { name, state: field('State') ?? '', ssid: field('SSID'), profile: field('Profile') }
}

/** True once some interface has an IPv4 address in the Hub's /24. */
function hasAddressNear(hubIp: string): boolean {
  const prefix = hubIp.split('.').slice(0, 3).join('.') + '.'
  return Object.values(networkInterfaces()).some((list) =>
    (list ?? []).some((a) => a.family === 'IPv4' && a.address.startsWith(prefix) && a.address !== hubIp))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class HubWifiManager {
  private joinedSsid: string | null = null
  private previousProfile: string | null = null
  private interfaceName: string | null = null

  /** Joins ssid; throws with a user-facing message if it can't. */
  async connect(ssid: string, password: string, hubIp: string): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Joining the Hub WiFi is only implemented on Windows')
    const iface = await currentInterface().catch(() => null)
    if (!iface) throw new Error('No WiFi adapter found on this PC')
    this.interfaceName = iface.name
    if (iface.ssid !== ssid) this.previousProfile = iface.state.toLowerCase() === 'connected' ? iface.profile : null

    const file = join(tmpdir(), `camtraption-hub-${Date.now()}.xml`)
    await writeFile(file, profileXml(ssid, password), 'utf8')
    try {
      await netsh(['wlan', 'add', 'profile', kv('filename', file), kv('interface', iface.name), 'user=current'])
    } finally {
      await rm(file, { force: true })
    }
    this.joinedSsid = ssid
    await netsh(['wlan', 'connect', kv('name', ssid), kv('ssid', ssid), kv('interface', iface.name)])

    const deadline = Date.now() + JOIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      const now = await currentInterface().catch(() => null)
      if (now?.ssid === ssid && now.state.toLowerCase() === 'connected' && hasAddressNear(hubIp)) return
      await sleep(500)
    }
    throw new Error(`Couldn't join ${ssid} (timed out)`)
  }

  /** Forgets the Hub network and reconnects the previous one. Safe to call when not joined. */
  async release(): Promise<void> {
    const ssid = this.joinedSsid
    const prev = this.previousProfile
    const iface = this.interfaceName
    this.joinedSsid = null
    this.previousProfile = null
    if (!ssid || process.platform !== 'win32') return
    const ifaceArg = iface ? [kv('interface', iface)] : []
    await netsh(['wlan', 'disconnect', ...ifaceArg]).catch(() => {})
    await netsh(['wlan', 'delete', 'profile', kv('name', ssid), ...ifaceArg]).catch(() => {})
    if (prev) await netsh(['wlan', 'connect', kv('name', prev), ...ifaceArg]).catch((e) => console.warn('reconnect failed', e))
  }
}
