/**
 * CC Deck — install-path mutation driver interface. FROZEN.
 *
 * A `MutationDriver` knows how to read/apply/revert ONE kind of target that can
 * influence how `claude` resolves on this machine (registry PATH, shell rc
 * files, ~/.claude/settings.json, launcher shims).
 *
 * Orchestration (locking, journalling, conflict detection, backup records) lives
 * in `install-manager.ts` and is owned by another agent — drivers stay pure and
 * side-effect-scoped to a single target.
 */
import type {
  BackupEntry,
  ConflictEvent,
  MutationTarget,
  MutationTargetKind
} from '@shared/types'

/** Everything a driver needs to apply/revert the custom install path. */
export interface TargetContext {
  /** Resolved custom install root (absolute). */
  installPath: string
  /** Directory that must end up on PATH (contains the `claude` launcher). */
  binDir: string
  /** Resolved launcher inside the install, if known. */
  executable: string | null
  /** Prepend (recommended) vs append the binDir on PATH. */
  prependPath: boolean
  /** When true, compute the change but do not write anything. */
  dryRun: boolean
}

/** Result of applying one target. */
export interface ApplyOutcome {
  /** Whether the target content actually changed. */
  changed: boolean
  /** New full value (file content or registry value), for display. */
  newValue: string | null
  /** What we must remember to be able to revert. */
  backup: BackupEntry
  /** Concurrency events observed while mutating this target. */
  conflicts: ConflictEvent[]
}

export interface MutationDriver {
  /** Stable driver id (also the target-id prefix). */
  id: string
  kind: MutationTargetKind
  /** Enumerate applicable targets on the current platform (may be empty). */
  list(): Promise<MutationTarget[]>
  /** Whether `target` already contains `ctx.binDir` on PATH / in config. */
  isApplied(target: MutationTarget, ctx: TargetContext): Promise<boolean>
  /** Apply the custom install to `target`. Must be idempotent + atomic. */
  apply(target: MutationTarget, ctx: TargetContext): Promise<ApplyOutcome>
  /** Restore a target from a previously-captured backup entry. */
  revert(entry: BackupEntry): Promise<{ ok: boolean; message: string }>
}
