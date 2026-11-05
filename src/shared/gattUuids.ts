// GATT UUIDs. Port of GattUuids in AppScreen.kt (the source of truth over the Android README table).
// Written the way noble reports them: lower case, no dashes.

const u = (suffix: string) => `ca5000${suffix}${'0'.repeat(24)}`

export const GattUuids = {
  SERVICE: u('00'),
  DEVICE_NAME: u('01'),
  GROUP_ID: u('02'),
  GROUP_NAME: u('03'),
  DEVICE_TYPE: u('04'),
  CHEMISTRY: u('05'),
  CELL_COUNT: u('06'),
  SHUTTER_COUNT: u('07'),
  RESET_SHUTTER: u('08'),
  FACTORY_RESET: u('09'),
  CAMERA_CONFIG: u('0a'),
  TELEMETRY: u('0b'),
  CAL_SET: u('0c'),
  INT_CAL_SET: u('0d'),
  CAMERA_CONFIG_STATUS: u('0e'),
  FEEDER_CONFIG: u('0f'),
  FEEDER_CONFIG_STATUS: u('10'),
  FEEDER_PUMP_OVERRIDE: u('11'),
  // ESP32 Camera Hub (firmware/camera_hub/src/hub_protocol.h; payloads parsed in hubProtocol.ts).
  // nRF52 Cameras don't expose these -- check hasCharacteristic() first.
  CAMERA_LOG_STATUS: u('12'),
  CAMERA_WIFI_AP_CONTROL: u('13'),
  CAMERA_WIFI_AP_INFO: u('14'),
  CAMERA_TIME_SYNC: u('15'),
  CAMERA_NEARBY_DEVICES: u('16')
} as const

export type GattUuid = (typeof GattUuids)[keyof typeof GattUuids]
