// Loads @stoprocent/noble lazily: requiring it opens the native Bluetooth binding, which throws
// on machines without a usable adapter. Callers treat null as "Bluetooth unsupported".

import type NobleType from '@stoprocent/noble'
import { createRequire } from 'node:module'

export type Noble = typeof NobleType

let instance: Noble | null | undefined
export let nobleLoadError: string | null = null

export function getNoble(): Noble | null {
  if (instance !== undefined) return instance
  try {
    instance = createRequire(import.meta.url)('@stoprocent/noble') as Noble
  } catch (e) {
    nobleLoadError = e instanceof Error ? e.message : String(e)
    console.error('noble failed to load:', e)
    instance = null
  }
  return instance
}

/** noble's address (lower case, sometimes empty on Windows) -> "AA:BB:CC:DD:EE:FF". */
export function normalizeAddress(address: string | undefined, id: string): string {
  const raw = address && address.length > 0 ? address : id
  const hex = raw.replace(/[^0-9a-fA-F]/g, '')
  return hex.length === 12 ? hex.toUpperCase().match(/../g)!.join(':') : raw.toUpperCase()
}
