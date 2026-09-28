import type { CcDeckApi } from '@shared/ipc'

declare global {
  interface Window {
    ccdeck: CcDeckApi
  }
}

export {}
