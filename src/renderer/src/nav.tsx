// Navigation. The Devices tab is master/detail: the sidebar picks a root (Kit, device or Setup) and
// the detail pane keeps a small stack on top of it (Camera Logs, Log Viewer), like
// MainActivity.screenStack + AppScreen.kt but scoped to the pane.

import { createContext, useContext, useEffect, useRef } from 'react'
import type { CachedHubLog } from '../../shared/types'

export type MainTab = 'devices' | 'graphs'

/** What the sidebar selected; the bottom of the detail pane's stack. */
export type PaneRoot =
  | { kind: 'empty' }
  | { kind: 'group'; groupId: number }
  | { kind: 'device'; address: string }
  | { kind: 'setup'; address: string }

export type PaneView =
  | PaneRoot
  | { kind: 'cameraLogs'; address: string }
  | { kind: 'logViewer'; entries: CachedHubLog[]; stream: string; initialDevice?: string | null }

/** The current screen's back action, triggered by Esc and the mouse "back" button (Android BackHandler). */
export const BackContext = createContext<{ current: (() => void) | undefined }>({ current: undefined })

/**
 * False for detail-pane layers hidden under another view. Views under the top one stay mounted (so a
 * device panel keeps its tab, form state and GATT connection while Camera Logs is open on top of it),
 * but only the visible one owns Back.
 */
export const PaneActiveContext = createContext(true)

export function useBackHandler(onBack: (() => void) | undefined) {
  const ref = useContext(BackContext)
  const active = useContext(PaneActiveContext)
  const latest = useRef(onBack)
  latest.current = onBack
  useEffect(() => {
    if (!active) return
    const handler = () => latest.current?.()
    ref.current = handler
    return () => { if (ref.current === handler) ref.current = undefined }
  }, [ref, active])
}
