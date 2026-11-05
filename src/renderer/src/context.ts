import { createContext, useContext } from 'react'
import type { GattStatus } from '../../shared/types'

export const ToastContext = createContext<(msg: string) => void>(() => {})
export const useToast = () => useContext(ToastContext)

/** Live GATT connection state (BleGattManager.state / errorMessage). */
export const GattContext = createContext<GattStatus>({ state: 'IDLE', errorMessage: null })
export const useGattStatus = () => useContext(GattContext)
