# CLAUDE.md

Electron desktop port of Camtraption Assistant 2. **The Kotlin app in `C:\GitHub\camtraptionAssistant2` is the
source of truth** for behaviour, wire formats and wording. Port changes from there, and keep the file and function
names recognisable. The Hub protocol is in `camtraptionAssistant2/firmware/README.md`.

## Commands (Windows; Node may not be on PATH in Git Bash: use "/c/Program Files/nodejs")

```
npm run dev | npm test | npm run typecheck | npm run build | npm run dist
```

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

  `api.ts` is the IPC contract.
- `src/main/` is the Electron main process. It owns all I/O:
  - `ble/scanner.ts`: noble, scanning with allowDuplicates, batched pushes.
  - `ble/gatt.ts`: the BleGattManager equivalent, with serialised operations.
  - `hub/wifi.ts`: netsh WiFi join and release.
  - `hub/http.ts`: HubHttpClient.
  - `stores.ts`: the JSON stores in userData.
  - `index.ts`: IPC handlers.
- `src/preload/index.ts` exposes `window.camtraption`.
- `src/renderer/src/` is React with no router: `App.tsx` holds the device map and a screen stack (`nav.tsx`). There is one file per screen in `screens/`, mirroring the Kotlin screens, and shared UI is in `components.tsx`.

## Conventions

- Device addresses are upper-case `AA:BB:…` everywhere, the same as Android. They key the stores and the Hub `/status` `bleMac` check.
- GATT calls come from the renderer through `api.gatt*`. Main serialises them, so the renderer may poll and save concurrently.
- No React StrictMode, because double-run effects would double-connect and double-log history.
- Debug-only UI is gated on `api.isDebug` (`!app.isPackaged`).
