# CLAUDE.md

Electron desktop port of Camtraption Assistant 2. **The Kotlin app in `C:\GitHub\camtraptionAssistant2` is the
source of truth** for behaviour, wire formats and wording. Port changes from there, and keep the file and function
names recognisable. The Hub protocol is in `camtraptionAssistant2/firmware/README.md`.

## Commands (Windows; Node may not be on PATH in Git Bash: use "/c/Program Files/nodejs")

```
npm run dev | npm test | npm run typecheck | npm run build | npm run dist
```

Electron's stock `ffmpeg.dll` is quarantined by Defender here; `scripts/fix-ffmpeg.mjs` swaps in the free-codecs build
(postinstall, `npm run dist`, `npm run fix-ffmpeg`). Blank window / renderer exit 0x80000003 = run `npm run fix-ffmpeg`.

## Layout

- `src/shared/` is pure TypeScript with no Electron imports, and it is unit-tested in `test/`. Each file is a port of a Kotlin file:

  | TypeScript | Kotlin source |
  |---|---|
  | `advert.ts` | `MainActivity.parseScanResult` |
  | `gattUuids.ts` | `GattUuids` (lower case, no dashes, as noble reports them) |
  | `deviceConfig.ts` | Camera Logic 22 B v3 and Feeder 12 B v1 blobs, from `DeviceScreen.kt` |
  | `hubProtocol.ts` | `HubProtocol.kt` |
  | `hubLogParser.ts` | `HubLogParser.kt` |
  | `scanList.ts` | `buildScanList` and the formatters |
  | `types.ts` | the model |
  | `series.ts` | desktop only: Graphs series from telemetry and Hub logs |

  `api.ts` is the IPC contract.
- `src/main/` is the Electron main process. It owns all I/O:
  - `ble/scanner.ts`: noble, scanning with allowDuplicates, batched pushes.
  - `ble/gatt.ts`: the BleGattManager equivalent, with serialised operations.
  - `hub/wifi.ts`: netsh WiFi join and release.
  - `hub/http.ts`: HubHttpClient.
  - `stores.ts`: the JSON stores in userData, plus `TelemetryStore` (desktop only, feeds Graphs).
  - `index.ts`: IPC handlers.
- `src/preload/index.ts` exposes `window.camtraption`.
- Startup: `index.ts` shows `src/renderer/splash.html` (frameless, transparent; a second Vite input in
  `electron.vite.config.ts`) until the main window's `ready-to-show`, at least 3 s.
  Scanning starts at launch (not on page load) so the splash can show a live device count.
- Logo/icon come from the Android app's `res/drawable/loso_logo.png`: `build/icon.ico` + `build/icon.png` (installer and
  exe icon) and `src/renderer/src/assets/logo.png` (app bar, empty-pane watermark). The splash artwork is
  `img/CamtrationDesktopLogo2.png` (transparent), downscaled to `src/renderer/src/assets/splash.png`.
- `src/renderer/src/` is React with no router. `App.tsx` holds the device map and the layout: an app bar with
  Devices | Graphs, and on Devices a sidebar (`screens/ScanList.tsx`) plus a detail pane. The pane is a stack (`nav.tsx`)
  whose root is the sidebar selection (Kit, device, Setup); Camera Logs and Log Viewer push on top. Lower layers stay
  mounted but hidden (`PaneActiveContext`), so a device panel keeps its tab, form state and GATT connection.
  - `screens/DevicePanel.tsx`: device tabs. Overview is `DeviceScreen.tsx` (+ `useDeviceHistory`); the settings tabs and
    their shared `useDeviceConfig` hook are in `SettingsScreen.tsx`. Non-Overview tabs hold the GATT connection.
  - `screens/GraphsScreen.tsx` + `Chart.tsx` (uPlot).
  - Shared UI is in `components.tsx`; theme tokens are in `styles.css` (blues only, red/amber/green for status).

## Conventions

- Device addresses are upper-case `AA:BB:…` everywhere, the same as Android. They key the stores and the Hub `/status` `bleMac` check.
- GATT calls come from the renderer through `api.gatt*`. Main serialises them, so the renderer may poll and save concurrently.
- No React StrictMode, because double-run effects would double-connect and double-log history.
- Debug-only UI is gated on `api.isDebug` (`!app.isPackaged`).
