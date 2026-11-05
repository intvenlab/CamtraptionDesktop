# Camtraption Desktop

Windows desktop port (Electron + React + TypeScript) of **Camtraption Assistant 2**
(`C:\GitHub\camtraptionAssistant2`, Android). It monitors and configures Camtraptions BLE devices
(cameras, strobes, focus lights, feeders, battery monitors) and browses ESP32 Camera Hub SD logs.

Features match the Android app, laid out for a PC (dark theme, master/detail):
- **Devices tab:** the scan list (unconfigured devices, Kits, other devices) is a searchable sidebar; selecting a Kit or
  device opens it on the right.
- **Device panel tabs:** Overview (dashboard + connection history, no connection needed) · Settings (name, type,
  chemistry, cells, Kit, Send Log, factory reset) · Camera Logic or Feeder · Calibration · Hub (Camera Logs, nearby
  devices). Any tab other than Overview connects over Bluetooth; Overview disconnects.
- **Camera Logs:** join the Hub's WiFi, then download, delete and save log files; Log Viewer.
- **Graphs tab** (desktop only): battery voltage and level, signal, shutters per hour and devices heard by a Hub, from
  live telemetry this PC records and/or downloaded Hub logs, filtered by Kit, Hub or device and time range.

## Requirements

- Windows 10 1703+ with a Bluetooth LE adapter. BLE uses `@stoprocent/noble`'s WinRT binding, which ships a prebuilt binary, so no compiler is needed.
- Node.js 22.12+ (installed with `winget install OpenJS.NodeJS.LTS`).

## Commands

```
npm install
npm run dev        # run with hot reload (debug features on)
npm test           # vitest: protocol, log parser, HTTP client, config blobs
npm run typecheck
npm run build      # production bundle in out/
npm run dist       # Windows installer in dist/ (electron-builder)
```

npm 11 blocks dependency install scripts, so Electron's own binary download doesn't run during `npm install`. This
project's `postinstall` does it instead (`node node_modules/electron/install.js`), then runs `npm run fix-ffmpeg`
(see Troubleshooting). `npm run dist` runs `fix-ffmpeg` again and packages from `node_modules/electron/dist`
(`build.electronDist`), so the installer ships the same ffmpeg.dll.

## Debug features (`npm run dev`)

- A **T** button on the scan screen injects fake devices and Kits.
- Every Camera shows **Camera Logs**, with **Use mock server**. Point it at
  `python ..\camtraptionAssistant2\firmware\tools\mock_hub.py --port 8080`, whose default URL is `http://localhost:8080`.

## Differences from Android

- **Hub WiFi:** Windows has no app-scoped network, so Camera Logs switches the PC's WiFi to the Hub (`netsh wlan`). When you disconnect, leave the screen or quit, it deletes the temporary profile and reconnects the previous network.
- **Sharing:** Android share sheets become **Save…** (a copy to a chosen file or folder) plus a pre-filled email to attach the file to.
- **Back:** Android Back maps to the ← button, Esc, or the mouse back button.
- **Long-press to forget** is press-and-hold or right-click.
- **Data location:** `%APPDATA%\Camtraption Desktop\`. It uses the same JSON files and shapes as the Android stores (`known_devices.json`, `device_history_<addr>.json`, `camera_log_catalog.json`, `hub_logs\…`). Kit names live in `group_names.json`.
- **Telemetry** (Graphs): `telemetry\<addr>.jsonl`, one reading per device at most every 30 s (or on a shutter/battery
  change), kept 30 days.

## Troubleshooting

- **Blank window / "Renderer process crashed" (exit 0x80000003):** check that
  `node_modules\electron\dist\ffmpeg.dll` exists. Microsoft Defender flags the stock `ffmpeg.dll` of Electron 45.2.3
  as `Trojan:Win32/Posilod.EB!cl` (a cloud-heuristic false positive) and quarantines it; every Electron window crashes
  without it. `scripts/fix-ffmpeg.mjs` (run by `postinstall`, `npm run dist` and `npm run fix-ffmpeg`) replaces it
  with Electron's free-codecs build from the same release (`ffmpeg-v<version>-win32-x64.zip`, checked against the
  release's `SHASUMS256.txt`), which Defender doesn't flag. The app plays no media, so nothing is lost. If the window
  is blank again, run `npm run fix-ffmpeg`.
