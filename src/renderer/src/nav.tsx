// Navigation: a hand-rolled back stack, like MainActivity.screenStack + AppScreen.kt.

import { createContext, useContext, useEffect, useRef } from 'react'
import type { BleDevice, CachedHubLog } from '../../shared/types'

export type AppScreen =
  | { kind: 'scan' }
  | { kind: 'group'; groupId: number }
  | { kind: 'device'; device: BleDevice }
  | { kind: 'setup'; device: BleDevice }
  | { kind: 'settings'; device: BleDevice }
  | { kind: 'cameraLogs'; device: BleDevice }
  | { kind: 'logViewer'; entries: CachedHubLog[]; stream: string; initialDevice?: string | null }

/** The current screen's back action, triggered by Esc and the mouse "back" button (Android BackHandler). */
export const BackContext = createContext<{ current: (() => void) | undefined }>({ current: undefined })

export function useBackHandler(onBack: (() => void) | undefined) {
  const ref = useContext(BackContext)
  const latest = useRef(onBack)
  latest.current = onBack
  useEffect(() => {
    const handler = () => latest.current?.()
    ref.current = handler
    return () => { if (ref.current === handler) ref.current = undefined }
  }, [ref])
}
