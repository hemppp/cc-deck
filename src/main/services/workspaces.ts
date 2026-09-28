/**
 * CC Deck — workspace CRUD.
 *
 * Workspaces are plain records persisted in the electron-store. This module is
 * the only writer of the `workspaces` collection and returns the mutated
 * collection so the renderer can refresh in one round-trip.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dialog } from 'electron'
import type { Workspace } from '@shared/types'
import { getWorkspaces, setWorkspaces } from '../store'

export type WorkspaceInput = Pick<Workspace, 'name' | 'path'> & Partial<Workspace>

function asNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Workspace "${label}" is required`)
  }
  return value.trim()
}

/**
 * Normalise a persisted workspace. Records written before `installPath`
 * existed lack the field, so we coerce it to `null` on read to keep the UI and
 * the frozen `Workspace` type happy.
 */
function normalizeWorkspace(workspace: Workspace): Workspace {
  return { ...workspace, installPath: workspace.installPath ?? null }
}

/** All workspaces, newest first. */
export async function listWorkspaces(): Promise<Workspace[]> {
  return getWorkspaces().map(normalizeWorkspace)
}

/** Create a workspace. `name`/`path` are required; the rest is filled in. */
export async function addWorkspace(input: WorkspaceInput): Promise<Workspace> {
  const name = asNonEmpty(input?.name, 'name')
  const path = asNonEmpty(input?.path, 'path')

  const workspace: Workspace = {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    name,
    path,
    modelConfigId: input.modelConfigId ?? null,
    installPath: input.installPath ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    lastOpenedAt: input.lastOpenedAt ?? null,
    color: input.color ?? null
  }

  setWorkspaces([...getWorkspaces(), workspace])
  return workspace
}

/** Delete a workspace and return the remaining list. */
export async function removeWorkspace(id: string): Promise<Workspace[]> {
  if (typeof id !== 'string' || !id) throw new Error('Workspace id is required')
  const next = getWorkspaces().filter((w) => w.id !== id)
  return setWorkspaces(next)
}

/** Patch a workspace in place; `id` and `createdAt` are immutable. */
export async function updateWorkspace(id: string, patch: Partial<Workspace>): Promise<Workspace> {
  if (typeof id !== 'string' || !id) throw new Error('Workspace id is required')

  const workspaces = getWorkspaces()
  const index = workspaces.findIndex((w) => w.id === id)
  if (index === -1) throw new Error(`Workspace not found: ${id}`)

  const current = normalizeWorkspace(workspaces[index] as Workspace)
  const updated: Workspace = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    installPath: patch.installPath !== undefined ? patch.installPath : current.installPath
  }

  const next = [...workspaces]
  next[index] = updated
  setWorkspaces(next)
  return updated
}

/** Open a native directory picker for choosing a workspace folder. */
export async function pickWorkspaceDir(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Select workspace directory',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/** Touch `lastOpenedAt` for a workspace (used by the launcher). Best-effort. */
export async function touchWorkspace(id: string): Promise<void> {
  try {
    await updateWorkspace(id, { lastOpenedAt: new Date().toISOString() })
  } catch {
    /* workspace may have been deleted concurrently */
  }
}

/** True when the directory still exists on disk. */
export async function workspaceExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    return stat.isDirectory()
  } catch {
    return false
  }
}
