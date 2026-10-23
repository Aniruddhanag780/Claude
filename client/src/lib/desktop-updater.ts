import { useEffect, useState } from 'react'

/** A check that stalls the bridge must not freeze the dialog on "Checking". */
const BRIDGE_TIMEOUT_MS = 30_000

/** Mirrors desktop/src/update-support.ts — the main process's updater state. */
export type DesktopUpdateState =
  | { phase: 'unsupported'; reason: 'dev' | 'package' }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; checkedAt: string }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; during?: 'check' | 'download' | 'install'; message: string }

interface DesktopUpdaterBridge {
  state: () => Promise<DesktopUpdateState>
  check: () => Promise<DesktopUpdateState>
  download: () => Promise<DesktopUpdateState>
  install: () => Promise<DesktopUpdateState>
  subscribe: (listener: (state: DesktopUpdateState) => void) => () => void
}

function bridge(): DesktopUpdaterBridge | null {
  if (typeof window === 'undefined') return null
  return (window as { __FREEAPI_UPDATER__?: DesktopUpdaterBridge }).__FREEAPI_UPDATER__ ?? null
}

/** True when this page runs in a desktop build with the updater bridge. */
export function hasDesktopUpdater(): boolean {
  return bridge() !== null
}

/** Reject a promise after `ms` milliseconds, so a stalled bridge leaves the
 *  dialog rather than freezing it on "Checking" forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Starts a desktop update check; the new state arrives through the hook. */
export function checkDesktopUpdates(): Promise<DesktopUpdateState> | null {
  return bridge()?.check() ?? null
}

/**
 * The desktop shell's in-app updater, or null in a browser and in a desktop
 * build that cannot replace itself (deb/rpm, the portable zip, a dev build) —
 * callers then keep their "open the releases page" fallback.
 */
export function useDesktopUpdater() {
  const updater = bridge()
  const [state, setState] = useState<DesktopUpdateState | null>(null)

  useEffect(() => {
    if (!updater) return
    let cancelled = false
    void withTimeout(updater.state(), BRIDGE_TIMEOUT_MS, 'reading the updater state')
      .then(next => { if (!cancelled) setState(next) })
      .catch(() => { /* leave the hook null; the dialog falls through */ })
    const unsubscribe = updater.subscribe(next => setState(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [updater])

  // Even an unsupported build (portable zip, dev) is surfaced so the dialog can
  // explain it and point at the latest GitHub release, instead of falling
  // through to a check that never resolves.
  if (!updater || !state) return null
  return {
    state,
    check: () => updater.check().then(next => { setState(next); return next }),
    download: () => updater.download().then(next => { setState(next); return next }),
    install: () => updater.install().then(next => { setState(next); return next }),
  }
}

export type DesktopUpdater = NonNullable<ReturnType<typeof useDesktopUpdater>>
