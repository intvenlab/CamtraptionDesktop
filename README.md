# Camtraption Desktop

Windows desktop port (Electron + React + TypeScript) of **Camtraption Assistant 2**
(`C:\GitHub\camtraptionAssistant2`, Android). It monitors and configures Camtraptions BLE devices
(cameras, strobes, focus lights, feeders, battery monitors) and browses ESP32 Camera Hub SD logs.

Features match the Android app:
- live scan list with Kits;
- device dashboard with connection history;
- Setup;
- Settings: Camera Logic, Feeder (including Run Pump hold), calibration, factory reset, Hub nearby devices and Send Log;
- Camera Logs: join the Hub's WiFi, then download, delete and save log files;
- Log Viewer.

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

Electron 45 doesn't download its binary during `npm install`. If `node_modules/electron/dist` is missing, run `node node_modules/electron/install.js`.

## Debug features (`npm run dev`)

- A **T** button on the scan screen injects fake devices and Kits.
- Every Camera shows **Camera Logs**, with **Use mock server**. Point it at
  `python ..\camtraptionAssistant2\firmware\tools\mock_hub.py --port 8080`, whose default URL is `http://localhost:8080`.

## Differences from Android

- **Hub WiFi:** Windows has no app-scoped network, so Camera Logs switches the PC's WiFi to the Hub (`netsh wlan`). When you disconnect, leave the screen or quit, it deletes the temporary profile and reconnects the previous network.
- **Sharing:** Android share sheets become **Save…** (a copy to a chosen file or folder) plus a pre-filled email to attach the file to.
- **Back:** Android Back maps to the ← button, Esc, or the mouse back button.
- **Long-press to forget** is press-and-hold or right-click.
- **Data location:** `%APPDATA%\camtraption-desktop\`. It uses the same JSON files and shapes as the Android stores (`known_devices.json`, `device_history_<addr>.json`, `camera_log_catalog.json`, `hub_logs\…`). Kit names live in `group_names.json`.
