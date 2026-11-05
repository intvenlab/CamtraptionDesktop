import type { CamtraptionApi } from '../../shared/api'

declare global {
  interface Window {
    camtraption: CamtraptionApi
  }
}

export const api: CamtraptionApi = window.camtraption

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
