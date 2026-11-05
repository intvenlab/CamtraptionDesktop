// Camera Logic (CAMERA_CONFIG, 22 bytes v3) and Feeder (FEEDER_CONFIG, 12 bytes v1) blobs.
// Port of buildCamBytes / buildFeederBytes and the read-back parsing in DeviceScreen.kt.
// The UI works in ms (as strings, like the Android text fields); the wire uses coarser units.

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const toInt = (s: string, dflt: number) => {
  const n = /^\d+$/.test(s.trim()) ? parseInt(s, 10) : NaN
  return Number.isNaN(n) ? dflt : n
}

export interface CameraLogicForm {
  enabled: boolean
  wakeHalfPressHoldSec: string       // ms
  minHalfPressBeforeShutter: string  // ms
  shutterPulseDuration: string       // ms
  startFrameSpacingTicks: string     // ms
  postShutterHpHoldTenths: string    // ms
  hpDebounceMs: string
  fpDebounceMs: string
  fullPressIgnoreGapTenths: string   // ms
  frameCount: string
  maxSequenceCount: string
  wakeHoldRefreshPolicy: number
  fullPressWithoutHpPolicy: number
  fpAfterMaxSeqCountPolicy: number
  powerSaveIdleMode: boolean
}

export const CAMERA_LOGIC_DEFAULTS: CameraLogicForm = {
  enabled: false,
  wakeHalfPressHoldSec: '10000',
  minHalfPressBeforeShutter: '500',
  shutterPulseDuration: '100',
  startFrameSpacingTicks: '1000',
  postShutterHpHoldTenths: '2000',
  hpDebounceMs: '35',
  fpDebounceMs: '20',
  fullPressIgnoreGapTenths: '3100',
  frameCount: '4',
  maxSequenceCount: '4',
  wakeHoldRefreshPolicy: 0,
  fullPressWithoutHpPolicy: 0,
  fpAfterMaxSeqCountPolicy: 0,
  powerSaveIdleMode: false
}

export const CAMERA_CONFIG_SIZE = 22
export const CAMERA_CONFIG_VERSION = 3

export function buildCameraConfig(f: CameraLogicForm): Uint8Array {
  const shutter = clamp(Math.trunc(toInt(f.shutterPulseDuration, 100) / 10), 1, 3000)
  const spacing = clamp(Math.trunc(toInt(f.startFrameSpacingTicks, 1000) / 10), 1, 3000)
  const b = new Uint8Array(CAMERA_CONFIG_SIZE)
  b[0] = CAMERA_CONFIG_VERSION
  b[1] = f.enabled ? 1 : 0
  b[2] = clamp(Math.trunc(toInt(f.wakeHalfPressHoldSec, 10000) / 1000), 1, 60)
  b[3] = clamp(Math.trunc(toInt(f.minHalfPressBeforeShutter, 500) / 100), 1, 100)
  b[4] = shutter & 0xff
  b[5] = (shutter >> 8) & 0xff
  b[6] = spacing & 0xff
  b[7] = (spacing >> 8) & 0xff
  b[8] = clamp(Math.trunc(toInt(f.postShutterHpHoldTenths, 2000) / 100), 0, 200)  // 0 = release HP right after each pulse
  b[9] = clamp(toInt(f.hpDebounceMs, 35), 1, 250)
  b[10] = clamp(toInt(f.fpDebounceMs, 20), 1, 250)
  b[11] = clamp(toInt(f.frameCount, 4), 0, 64)
  b[12] = clamp(toInt(f.maxSequenceCount, 4), 0, 64)
  b[13] = clamp(f.wakeHoldRefreshPolicy, 0, 2)
  b[14] = 0  // halfPressDuringBurstPolicy (forced)
  b[15] = clamp(f.fullPressWithoutHpPolicy, 0, 1)
  b[16] = 0  // activityHalfPressHoldPolicy (forced)
  b[17] = clamp(f.fpAfterMaxSeqCountPolicy, 0, 1)
  b[18] = 0  // inputActivePolarity (forced by fw)
  b[19] = 0  // outputDriveMode (forced by fw)
  b[20] = f.powerSaveIdleMode ? 1 : 0
  b[21] = clamp(Math.trunc(toInt(f.fullPressIgnoreGapTenths, 3100) / 100), 5, 250)
  return b
}

/** null if [b] isn't a v3 blob (the screen then shows "Unexpected format – reflash firmware"). */
export function parseCameraConfig(b: Uint8Array): CameraLogicForm | null {
  if (b.length < CAMERA_CONFIG_SIZE || b[0] !== CAMERA_CONFIG_VERSION) return null
  return {
    enabled: b[1] !== 0,
    wakeHalfPressHoldSec: String(b[2] * 1000),
    minHalfPressBeforeShutter: String(b[3] * 100),
    shutterPulseDuration: String((b[4] | (b[5] << 8)) * 10),
    startFrameSpacingTicks: String((b[6] | (b[7] << 8)) * 10),
    postShutterHpHoldTenths: String(b[8] * 100),
    hpDebounceMs: String(b[9]),
    fpDebounceMs: String(b[10]),
    frameCount: String(clamp(b[11], 0, 64)),
    maxSequenceCount: String(clamp(b[12], 0, 64)),
    wakeHoldRefreshPolicy: clamp(b[13], 0, 2),
    fullPressWithoutHpPolicy: clamp(b[15], 0, 1),
    fpAfterMaxSeqCountPolicy: clamp(b[17], 0, 1),
    powerSaveIdleMode: b[20] !== 0,
    fullPressIgnoreGapTenths: String(b[21] * 100)
  }
}

// ─── Feeder ────────────────────────────────────────────────────────────────

export interface FeederForm {
  enabled: boolean
  pulseStretchMinMs: string
  pumpOnMs: string
  pumpOffMs: string
}

export const FEEDER_DEFAULTS: FeederForm = { enabled: false, pulseStretchMinMs: '100', pumpOnMs: '2000', pumpOffMs: '10000' }

export const FEEDER_CONFIG_SIZE = 12

export function buildFeederConfig(f: FeederForm): Uint8Array {
  const stretch = clamp(toInt(f.pulseStretchMinMs, 100), 10, 60000)
  const onMs = clamp(toInt(f.pumpOnMs, 2000), 50, 3_600_000)
  const offMs = clamp(toInt(f.pumpOffMs, 10000), 50, 3_600_000)
  const b = new Uint8Array(FEEDER_CONFIG_SIZE)
  const dv = new DataView(b.buffer)
  b[0] = 1  // version
  b[1] = f.enabled ? 1 : 0
  dv.setUint16(2, stretch, true)
  dv.setUint32(4, onMs, true)
  dv.setUint32(8, offMs, true)
  return b
}

export function parseFeederConfig(b: Uint8Array): FeederForm | null {
  if (b.length < FEEDER_CONFIG_SIZE || b[0] !== 1) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return {
    enabled: b[1] !== 0,
    pulseStretchMinMs: String(dv.getUint16(2, true)),
    pumpOnMs: String(dv.getUint32(4, true)),
    pumpOffMs: String(dv.getUint32(8, true))
  }
}

/** First byte of CAMERA_CONFIG_STATUS / FEEDER_CONFIG_STATUS notifications -> status text. */
export function describeConfigAck(ack: Uint8Array | null | undefined): string {
  const b = ack && ack.length > 0 ? ack[0] : null
  switch (b) {
    case 0x00: return 'Saved successfully'
    case 0xe1: return 'Rejected: bad packet format'
    case 0xe2: return 'Rejected: value out of range'
    case 0xe3: return 'Rejected: device busy – try again'
    case null: return 'Sent (no acknowledgment)'
    default: return `Unknown response (0x${b.toString(16).toUpperCase().padStart(2, '0')})`
  }
}

/** CAL_SET / INT_CAL_SET payload: u16 LE millivolts (0 = reset to default). */
export function calibrationBytes(volts: number, maxMv: number): Uint8Array {
  const mv = clamp(Math.round(volts * 1000), 100, maxMv)
  return new Uint8Array([mv & 0xff, (mv >> 8) & 0xff])
}
