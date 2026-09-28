import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  History,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Terminal,
  XCircle,
  Zap
} from 'lucide-react'
import type {
  ApplyRequest,
  BackupRecord,
  ConflictEvent,
  EnvScope,
  MutationTarget,
  MutationTargetKind,
  TargetResult
} from '@shared/types'
import { useInstallsStore } from '@/store/installs'
import { useT } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { truncatePath } from '@/lib/format'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Modal,
  Skeleton,
  StatusDot,
  Switch,
  Tooltip,
  toast
} from '@/components/ui'

const KIND_LABEL: Record<MutationTargetKind, TranslationKey> = {
  'windows-user-path': 'installs.kind.windowsUserPath',
  'windows-system-path': 'installs.kind.windowsSystemPath',
  'unix-shell-profile': 'installs.kind.unixShellProfile',
  'claude-settings': 'installs.kind.claudeSettings',
  'launcher-shim': 'installs.kind.launcherShim'
}

const SCOPE_LABEL: Record<EnvScope, TranslationKey> = {
  user: 'installs.userScope',
  system: 'installs.systemScope'
}

const SCOPE_ORDER: EnvScope[] = ['user', 'system']

const CONFLICT_KIND_LABEL: Record<ConflictEvent['kind'], TranslationKey> = {
  'external-modification': 'installs.externalModification',
  'lock-contention': 'installs.lockContention'
}

const RESOLUTION_META: Record<
  ConflictEvent['resolution'],
  { labelKey: TranslationKey; variant: 'success' | 'warning' | 'destructive' }
> = {
  retried: { labelKey: 'installs.resolution.retried', variant: 'warning' },
  merged: { labelKey: 'installs.resolution.merged', variant: 'success' },
  aborted: { labelKey: 'installs.resolution.aborted', variant: 'destructive' }
}

function pathLabel(value: string | null): string {
  return value ? truncatePath(value, 64) : '—'
}

/* ------------------------------------------------------------------ */
/* Target row                                                          */
/* ------------------------------------------------------------------ */

interface TargetRowProps {
  target: MutationTarget
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

function TargetRow({ target, checked, onCheckedChange }: TargetRowProps): JSX.Element {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const checkboxId = `install-target-${target.id}`

  return (
    <div
      className={cn(
        'rounded-lg border px-3.5 py-3 transition-colors',
        checked ? 'border-primary/50 bg-primary/5' : 'border-border bg-surface',
        !target.available && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 rounded border-border accent-primary focus-ring disabled:cursor-not-allowed"
          checked={checked}
          disabled={!target.available}
          onChange={(e) => onCheckedChange(e.target.checked)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <label htmlFor={checkboxId} className="text-sm font-medium text-foreground">
              {target.label}
            </label>
            <Badge variant="outline">{t(KIND_LABEL[target.kind])}</Badge>
            {target.applied ? (
              <Badge variant="success">
                <CheckCircle2 /> {t('installs.applied')}
              </Badge>
            ) : null}
            {target.requiresElevation ? (
              <Badge variant="warning">
                <ShieldAlert /> {t('installs.requiresAdmin')}
              </Badge>
            ) : null}
            {!target.available ? <Badge variant="outline">{t('installs.unavailable')}</Badge> : null}
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={target.location}>
            {pathLabel(target.location)}
          </p>
          {target.note ? (
            <p className="mt-1 text-xs text-muted-foreground">{target.note}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-2 pl-7">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-ring"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {expanded ? t('installs.hideCurrentValue') : t('installs.showCurrentValue')}
        </button>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-muted p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {target.currentValue ?? t('installs.notSet')}
              </pre>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Concurrency indicator                                               */
/* ------------------------------------------------------------------ */

function ConcurrencyPanel(): JSX.Element {
  const t = useT()
  const conflicts = useInstallsStore((s) => s.conflicts)
  const applying = useInstallsStore((s) => s.applying)
  const clearConflicts = useInstallsStore((s) => s.clearConflicts)

  return (
    <div className="rounded-lg border border-border bg-surface-muted/40 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Zap className={cn('size-3.5', applying ? 'text-warning' : 'text-muted-foreground')} />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('installs.conflicts')}
          </span>
          {applying ? <StatusDot status="starting" label={t('installs.applying')} /> : null}
        </div>
        {conflicts.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={clearConflicts}>
            {t('installs.clear')}
          </Button>
        ) : null}
      </div>

      <div className="mt-2.5">
        {conflicts.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-success" />
            {t('installs.noConflicts')}
          </p>
        ) : (
          <ul className="space-y-1.5">
            <AnimatePresence initial={false}>
              {conflicts.map((c, i) => {
                const res = RESOLUTION_META[c.resolution]
                return (
                  <motion.li
                    key={`${c.targetId}-${c.detectedAt}-${i}`}
                    layout
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs"
                  >
                    <Badge variant={res.variant}>{t(res.labelKey)}</Badge>
                    <span className="font-medium text-foreground">
                      {t(CONFLICT_KIND_LABEL[c.kind])}
                    </span>
                    <span className="truncate font-mono text-muted-foreground" title={c.location}>
                      {pathLabel(c.location)}
                    </span>
                    <span className="text-muted-foreground">{c.message}</span>
                  </motion.li>
                )
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

interface BackupRowProps {
  backup: BackupRecord
  busy: boolean
  onRevert: (backup: BackupRecord) => void
}

function BackupRow({ backup, busy, onRevert }: BackupRowProps): JSX.Element {
  const t = useT()
  const when = new Date(backup.createdAt)
  const stamp = Number.isNaN(when.getTime()) ? backup.createdAt : when.toLocaleString()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{stamp}</p>
        <p className="truncate font-mono text-xs text-muted-foreground" title={backup.installPath}>
          {pathLabel(backup.installPath)}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('installs.backedUp', { count: backup.entries.length })}
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onRevert(backup)}>
        <RotateCcw />
        {t('installs.revert')}
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export interface InstallTargetsProps {
  className?: string
}

export function InstallTargets({ className }: InstallTargetsProps): JSX.Element {
  const t = useT()
  const installs = useInstallsStore((s) => s.installs)
  const status = useInstallsStore((s) => s.status)
  const backups = useInstallsStore((s) => s.backups)
  const loading = useInstallsStore((s) => s.loading)
  const applying = useInstallsStore((s) => s.applying)
  const apply = useInstallsStore((s) => s.apply)
  const revert = useInstallsStore((s) => s.revert)
  const refresh = useInstallsStore((s) => s.refresh)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [prependPath, setPrependPath] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [revertTarget, setRevertTarget] = useState<BackupRecord | null>(null)
  const [lastResults, setLastResults] = useState<TargetResult[] | null>(null)
  const initializedRef = useRef(false)

  // Initialise / prune the selection as targets arrive or refresh.
  useEffect(() => {
    if (!status) return
    const ids = new Set(status.targets.map((t) => t.id))
    setSelected((prev) => {
      if (!initializedRef.current) {
        initializedRef.current = true
        return new Set(status.targets.filter((t) => t.available && t.writable).map((t) => t.id))
      }
      return new Set([...prev].filter((id) => ids.has(id)))
    })
  }, [status])

  const installPath = useMemo(
    () => status?.installPath ?? installs.find((i) => i.active)?.path ?? null,
    [status, installs]
  )

  const groups = useMemo(() => {
    const byScope = new Map<EnvScope, MutationTarget[]>()
    for (const t of status?.targets ?? []) {
      const list = byScope.get(t.scope) ?? []
      list.push(t)
      byScope.set(t.scope, list)
    }
    return SCOPE_ORDER.map((scope) => ({ scope, targets: byScope.get(scope) ?? [] })).filter(
      (g) => g.targets.length > 0
    )
  }, [status])

  const selectedTargets = useMemo(
    () => (status?.targets ?? []).filter((t) => selected.has(t.id)),
    [status, selected]
  )

  const toggle = (id: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const canApply = Boolean(installPath) && selectedTargets.length > 0 && !applying

  const runApply = async (): Promise<void> => {
    if (!installPath) return
    setConfirmOpen(false)
    const req: ApplyRequest = {
      installPath,
      targetIds: selectedTargets.map((tg) => tg.id),
      prependPath
    }
    try {
      const result = await apply(req)
      setLastResults(result.results)
      const changed = result.results.filter((r) => r.changed).length
      toast({
        title: result.ok ? t('toast.installApplied') : t('installs.applyErrors'),
        description: t('installs.appliedCount', {
          changed,
          total: result.results.length
        }),
        variant: result.ok ? 'success' : 'error'
      })
      const byId = new Map((status?.targets ?? []).map((tg) => [tg.id, tg]))
      for (const r of result.results) {
        toast({
          title: `${byId.get(r.targetId)?.label ?? r.targetId} — ${
            r.ok
              ? r.changed
                ? t('installs.resultUpdated')
                : t('installs.resultUnchanged')
              : t('installs.resultFailed')
          }`,
          description: r.message,
          variant: r.ok ? (r.changed ? 'success' : 'default') : 'error'
        })
      }
      if (result.conflicts.length > 0) {
        toast({
          title: t('installs.conflictsDetected'),
          description: t('installs.conflictsResolved', { count: result.conflicts.length }),
          variant: 'default'
        })
      }
    } catch (e) {
      toast({
        title: t('installs.applyFailed'),
        description: e instanceof Error ? e.message : undefined,
        variant: 'error'
      })
    }
  }

  const confirmRevert = async (): Promise<void> => {
    const backup = revertTarget
    if (!backup) return
    setRevertTarget(null)
    try {
      const result = await revert(backup.id)
      toast({
        title: result.ok ? t('installs.backupRestored') : t('installs.revertErrors'),
        description: t('installs.revertProcessed', { count: result.results.length }),
        variant: result.ok ? 'success' : 'error'
      })
    } catch (e) {
      toast({
        title: t('installs.revertFailed'),
        description: e instanceof Error ? e.message : undefined,
        variant: 'error'
      })
    }
  }

  const activeInstall = installs.find((i) => i.active) ?? null

  if (loading && !status) {
    return (
      <div className={cn('space-y-3', className)}>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* Pinned install summary */}
      <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Terminal className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('settings.install.pinned')}
              </p>
              <p className="truncate font-mono text-sm text-foreground" title={installPath ?? undefined}>
                {pathLabel(installPath)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {status?.version
                  ? `v${status.version}`
                  : activeInstall?.version
                    ? `v${activeInstall.version}`
                    : t('settings.install.versionUnknown')}
                {' · '}
                <span className="font-mono" title={status?.executable ?? activeInstall?.executable ?? undefined}>
                  {status?.executable ?? activeInstall?.executable ?? t('installs.noExecutable')}
                </span>
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StatusDot
              status={status?.pathApplied ? 'ok' : 'warn'}
              label={
                status?.pathApplied
                  ? t('settings.install.pathApplied')
                  : t('settings.install.pathNotApplied')
              }
            />
            <p className="max-w-[18rem] truncate text-right text-xs text-muted-foreground" title={status?.pathResolvesTo ?? undefined}>
              PATH → {pathLabel(status?.pathResolvesTo ?? null)}
            </p>
          </div>
        </div>
      </div>

      {/* Targets */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ArrowDownToLine className="size-3.5 text-primary" />
            <span className="text-sm font-medium text-foreground">{t('installs.mutationTargets')}</span>
            <span className="text-xs text-muted-foreground">
              {t('installs.selectedCount', {
                count: selectedTargets.length,
                total: status?.targets.length ?? 0
              })}
            </span>
          </div>
          <Tooltip label={t('installs.refreshHint')}>
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={applying}>
              <RefreshCw />
              {t('common.refresh')}
            </Button>
          </Tooltip>
        </div>

        {groups.length === 0 ? (
          <EmptyState
            icon={Info}
            title={t('installs.noTargets')}
            description={t('installs.noTargetsHint')}
          />
        ) : (
          groups.map((group) => (
            <div key={group.scope} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(SCOPE_LABEL[group.scope])}
              </p>
              <div className="space-y-2">
                {group.targets.map((target) => (
                  <TargetRow
                    key={target.id}
                    target={target}
                    checked={selected.has(target.id)}
                    onCheckedChange={(checked) => toggle(target.id, checked)}
                  />
                ))}
              </div>
            </div>
          ))
        )}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-muted/40 px-3.5 py-3">
          <div className="flex items-center gap-2.5">
            <Switch
              id="install-prepend-path"
              checked={prependPath}
              onCheckedChange={setPrependPath}
              aria-label={t('installs.prepend')}
            />
            <label htmlFor="install-prepend-path" className="text-sm text-foreground">
              {t('installs.prepend')}
            </label>
          </div>
          <Button disabled={!canApply} onClick={() => setConfirmOpen(true)}>
            <CheckCircle2 />
            {t('installs.apply')}
          </Button>
        </div>

        {!installPath ? (
          <p className="flex items-center gap-2 text-xs text-warning">
            <AlertTriangle className="size-3.5" />
            {t('installs.selectPathFirst')}
          </p>
        ) : null}
      </div>

      {/* Concurrency */}
      <ConcurrencyPanel />

      {/* Backups */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <History className="size-3.5 text-primary" />
          <span className="text-sm font-medium text-foreground">{t('installs.backups')}</span>
          <span className="text-xs text-muted-foreground">
            {t('installs.available', { count: backups.length })}
          </span>
        </div>
        {backups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3.5 py-4 text-xs text-muted-foreground">
            {t('installs.noBackups')}. {t('installs.noBackupsHint')}
          </p>
        ) : (
          <div className="space-y-2">
            {backups.map((backup) => (
              <BackupRow
                key={backup.id}
                backup={backup}
                busy={applying}
                onRevert={setRevertTarget}
              />
            ))}
          </div>
        )}
      </div>

      {lastResults ? (
        <div className="rounded-lg border border-border bg-surface-muted/40 p-3.5">
          <div className="flex items-center gap-2">
            <GitBranch className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('installs.lastResults')}
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {lastResults.map((r) => (
              <li key={r.targetId} className="flex items-center gap-2 text-xs">
                {r.ok ? (
                  <CheckCircle2 className={cn('size-3.5', r.changed ? 'text-success' : 'text-muted-foreground')} />
                ) : (
                  <XCircle className="size-3.5 text-destructive" />
                )}
                <span className="text-foreground">{r.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Apply confirmation / preview */}
      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('installs.applyTitle')}
        description={t('installs.applyDescription')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void runApply()}>
              <CheckCircle2 />
              {t('installs.confirmApply')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('installs.installPath')}
            </p>
            <p className="truncate font-mono text-xs text-foreground" title={installPath ?? undefined}>
              {pathLabel(installPath)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('installs.pathMode', {
                mode: prependPath ? t('installs.pathModePrepend') : t('installs.pathModeAppend')
              })}
            </p>
          </div>

          {selectedTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('installs.noTargetsSelected')}</p>
          ) : (
            <ul className="space-y-1.5">
              {selectedTargets.map((tg) => (
                <li key={tg.id} className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{tg.label}</span>
                    <Badge variant="outline">{t(SCOPE_LABEL[tg.scope])}</Badge>
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={tg.location}>
                    {pathLabel(tg.location)}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {tg.applied ? (
                      <Badge variant="success">{t('installs.alreadyApplied')}</Badge>
                    ) : (
                      <Badge variant="warning">{t('installs.willChange')}</Badge>
                    )}
                    {tg.requiresElevation ? (
                      <span className="inline-flex items-center gap-1 text-warning">
                        <ShieldAlert className="size-3.5" /> {t('installs.requiresAdmin')}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            {t('installs.backupNote')}
          </p>
        </div>
      </Modal>

      {/* Revert confirmation */}
      <Modal
        open={revertTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRevertTarget(null)
        }}
        title={t('installs.revertTitle')}
        description={t('installs.revertDescription')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevertTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmRevert()}>
              <RotateCcw />
              {t('installs.revert')}
            </Button>
          </>
        }
      >
        {revertTarget ? (
          <ul className="space-y-1.5">
            {revertTarget.entries.map((entry, i) => (
              <li key={`${entry.targetId}-${i}`} className="rounded-md border border-border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{t(KIND_LABEL[entry.kind])}</span>
                  <Badge variant={entry.existed ? 'warning' : 'outline'}>
                    {entry.existed ? t('installs.willRestore') : t('installs.willRemove')}
                  </Badge>
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground" title={entry.location}>
                  {pathLabel(entry.location)}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </Modal>
    </div>
  )
}
