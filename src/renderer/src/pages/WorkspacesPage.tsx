import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  FolderPlus,
  History,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  XCircle
} from 'lucide-react'
import { useWorkspacesStore } from '@/store/workspaces'
import { useModelsStore } from '@/store/models'
import { useInstallsStore } from '@/store/installs'
import { useLaunchStore } from '@/store/launch'
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Label,
  Modal,
  Select,
  Skeleton,
  Spinner,
  StatusDot,
  Tooltip,
  toast
} from '@/components/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { InstallPicker } from '@/components/installs/InstallPicker'
import { cn } from '@/lib/cn'
import { truncatePath } from '@/lib/format'
import { useLanguage, useT, type TranslationKey, type TFunction } from '@/i18n'
import type {
  ClaudeInstall,
  Language,
  LaunchResult,
  LaunchSession,
  LaunchVerification,
  VerificationCheck,
  Workspace
} from '@shared/types'

const DEFAULT_MODEL = '__default__'

/** Maps stable backend check ids to translation keys. */
const CHECK_KEYS: Record<string, TranslationKey> = {
  'workspace-exists': 'check.workspaceExists',
  'workspace-is-dir': 'check.workspaceIsDir',
  'install-selected': 'check.installSelected',
  'install-version': 'check.installVersion',
  'executable-exists': 'check.executableExists',
  'install-matches': 'check.installMatches',
  'model-configured': 'check.modelConfigured',
  'routing-mode': 'check.routingMode',
  'gateway-state': 'check.gatewayState'
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** Localized relative time ("18m ago" / "18 分钟前"), self-contained to this page. */
function relativeTime(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '—'
  const date = new Date(iso)
  const time = date.getTime()
  if (Number.isNaN(time)) return '—'

  const diff = time - Date.now()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' })

  if (abs < MINUTE) return rtf.format(Math.round(diff / SECOND), 'second')
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute')
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour')
  if (abs < WEEK) return rtf.format(Math.round(diff / DAY), 'day')

  return date.toLocaleDateString(lang === 'zh' ? 'zh-CN' : undefined, {
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

function shortenPath(p: string, max = 40): string {
  if (p.length <= max) return p
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return `…${p.slice(-(max - 1))}`
  const tail = parts.slice(-2).join('/')
  const candidate = `…/${tail}`
  return candidate.length <= max ? candidate : `…${candidate.slice(-(max - 1))}`
}

/** Resolve the version string for a workspace's effective install. */
function resolveInstallVersion(
  installPath: string | null,
  installs: ClaudeInstall[],
  activeInstall: ClaudeInstall | null
): string | null {
  if (installPath) {
    return installs.find((i) => i.path === installPath)?.version ?? null
  }
  return activeInstall?.version ?? null
}

/** Per-workspace run status derived from tracked launch sessions. */
type WorkspaceStatus = 'running' | 'exited' | 'idle'

const STATUS_DOT: Record<WorkspaceStatus, 'running' | 'stopped' | 'ok'> = {
  running: 'running',
  exited: 'stopped',
  idle: 'stopped'
}

const STATUS_LABEL_KEY: Record<WorkspaceStatus, TranslationKey> = {
  running: 'workspaces.card.statusRunning',
  exited: 'workspaces.card.statusExited',
  idle: 'workspaces.card.statusIdle'
}

/**
 * Status for a workspace: 'running' when any of its tracked sessions is still
 * live, else 'exited' when it has any recorded session, else 'idle'.
 */
function workspaceStatus(sessions: LaunchSession[], workspaceId: string): WorkspaceStatus {
  const ws = sessions.filter((s) => s.workspaceId === workspaceId)
  if (ws.some((s) => s.status === 'running')) return 'running'
  return ws.length > 0 ? 'exited' : 'idle'
}

export default function WorkspacesPage(): JSX.Element {
  const t = useT()
  const lang = useLanguage()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const loading = useWorkspacesStore((s) => s.loading)
  const error = useWorkspacesStore((s) => s.error)
  const load = useWorkspacesStore((s) => s.load)
  const add = useWorkspacesStore((s) => s.add)
  const remove = useWorkspacesStore((s) => s.remove)
  const update = useWorkspacesStore((s) => s.update)

  const models = useModelsStore((s) => s.models)
  const loadModels = useModelsStore((s) => s.load)

  const installs = useInstallsStore((s) => s.installs)
  const loadInstalls = useInstallsStore((s) => s.load)
  const activeInstall = useMemo(
    () => installs.find((i) => i.active) ?? null,
    [installs]
  )
  const activePath = activeInstall?.path ?? null

  const sessions = useLaunchStore((s) => s.sessions)
  const sessionsLoading = useLaunchStore((s) => s.loading)
  const loadSessions = useLaunchStore((s) => s.loadSessions)
  const verifyLaunch = useLaunchStore((s) => s.verify)
  const runLaunch = useLaunchStore((s) => s.run)
  const subscribe = useLaunchStore((s) => s.subscribe)

  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftPath, setDraftPath] = useState('')
  const [draftInstall, setDraftInstall] = useState<string | null>(null)
  const [draftModel, setDraftModel] = useState<string>(DEFAULT_MODEL)
  const [browsing, setBrowsing] = useState(false)
  const [saving, setSaving] = useState(false)

  const [editTarget, setEditTarget] = useState<Workspace | null>(null)
  const [editInstall, setEditInstall] = useState<string | null>(null)
  const [editModel, setEditModel] = useState<string>(DEFAULT_MODEL)
  const [savingEdit, setSavingEdit] = useState(false)

  const [launchTarget, setLaunchTarget] = useState<Workspace | null>(null)
  const [launchModel, setLaunchModel] = useState<string>(DEFAULT_MODEL)
  const [launchInstall, setLaunchInstall] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verification, setVerification] = useState<LaunchVerification | null>(null)
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null)

  const [removeTarget, setRemoveTarget] = useState<Workspace | null>(null)
  const [removing, setRemoving] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)

  useEffect(() => {
    void load()
    void loadModels()
    void loadInstalls().catch(() => {})
    void loadSessions().catch(() => {})
  }, [load, loadModels, loadInstalls, loadSessions])

  // Live session updates while the page is mounted.
  useEffect(() => subscribe(), [subscribe])

  const modelName = useCallback(
    (id: string | null): string => {
      if (!id) return t('workspaces.card.defaultModel')
      const found = models.find((m) => m.id === id)
      return found ? found.name : t('common.unknown')
    },
    [models, t]
  )

  const modelOptions = useMemo(
    () => [
      { label: t('workspaces.launch.useDefaultModel'), value: DEFAULT_MODEL },
      ...models.map((m) => ({ label: m.name, value: m.id }))
    ],
    [models, t]
  )

  const openAdd = (): void => {
    setDraftName('')
    setDraftPath('')
    setDraftInstall(null)
    setDraftModel(DEFAULT_MODEL)
    setAddOpen(true)
  }

  const browse = async (): Promise<void> => {
    setBrowsing(true)
    try {
      const dir = await useWorkspacesStore.getState().pickDir()
      if (dir) {
        setDraftPath(dir)
        if (!draftName.trim()) {
          const parts = dir.split(/[\\/]/).filter(Boolean)
          setDraftName(parts[parts.length - 1] ?? '')
        }
      }
    } catch {
      toast({ title: t('toast.failedFolderPicker'), variant: 'error' })
    } finally {
      setBrowsing(false)
    }
  }

  const submitAdd = async (): Promise<void> => {
    const name = draftName.trim()
    const path = draftPath.trim()
    if (!name || !path) {
      toast({ title: t('toast.namePathRequired'), variant: 'error' })
      return
    }
    setSaving(true)
    try {
      await add({
        name,
        path,
        installPath: draftInstall,
        modelConfigId: draftModel === DEFAULT_MODEL ? null : draftModel
      })
      toast({ title: t('toast.workspaceAdded'), description: name, variant: 'success' })
      setAddOpen(false)
    } catch (err) {
      toast({
        title: t('toast.failedAddWorkspace'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (ws: Workspace): void => {
    setEditTarget(ws)
    setEditInstall(ws.installPath)
    setEditModel(ws.modelConfigId ?? DEFAULT_MODEL)
  }

  const submitEdit = async (): Promise<void> => {
    if (!editTarget) return
    setSavingEdit(true)
    try {
      await update(editTarget.id, {
        installPath: editInstall,
        modelConfigId: editModel === DEFAULT_MODEL ? null : editModel
      })
      toast({ title: t('toast.installUpdated'), description: editTarget.name, variant: 'success' })
      setEditTarget(null)
    } catch (err) {
      toast({
        title: t('toast.failedUpdateWorkspace'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setSavingEdit(false)
    }
  }

  const openLaunch = (ws: Workspace): void => {
    setLaunchTarget(ws)
    setLaunchModel(ws.modelConfigId ?? DEFAULT_MODEL)
    setLaunchInstall(ws.installPath)
    setVerification(null)
    setLaunchResult(null)
  }

  const launchOptions = useCallback(
    (ws: Workspace) => ({
      workspaceId: ws.id,
      modelConfigId: launchModel === DEFAULT_MODEL ? null : launchModel,
      installPath: launchInstall
    }),
    [launchModel, launchInstall]
  )

  const runVerify = async (): Promise<LaunchVerification | null> => {
    if (!launchTarget) return null
    setVerifying(true)
    try {
      const result = await verifyLaunch(launchOptions(launchTarget))
      setVerification(result)
      return result
    } catch (err) {
      toast({
        title: t('toast.verificationFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
      return null
    } finally {
      setVerifying(false)
    }
  }

  const submitLaunch = async (): Promise<void> => {
    if (!launchTarget) return
    setLaunching(true)
    try {
      const result = await runLaunch(launchOptions(launchTarget))
      setLaunchResult(result)
      if (result.ok) {
        toast({
          title: t('toast.launchStarted'),
          description: `${launchTarget.name}${result.version ? ` · v${result.version}` : ''}`,
          variant: 'success'
        })
        setVerification(null)
      } else {
        toast({
          title: t('toast.launchFailed'),
          description: result.error ?? t('common.unknown'),
          variant: 'error'
        })
      }
    } catch (err) {
      toast({
        title: t('toast.launchFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setLaunching(false)
    }
  }

  const submitRemove = async (): Promise<void> => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      await remove(removeTarget.id)
      toast({ title: t('toast.workspaceRemoved'), description: removeTarget.name, variant: 'success' })
      if (selectedId === removeTarget.id) setSelectedId(null)
      setRemoveTarget(null)
    } catch (err) {
      toast({
        title: t('toast.failedRemoveWorkspace'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setRemoving(false)
    }
  }

  const showSkeletons = loading && workspaces.length === 0
  const isEmpty = !loading && workspaces.length === 0

  const criticalFail = verification ? !verification.ok : false

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="mx-auto w-full max-w-6xl px-6 py-8"
    >
      <PageHeader
        title={t('workspaces.title')}
        description={t('workspaces.description')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setSessionsOpen(true)}>
              <History className="mr-2 h-4 w-4" />
              {t('workspaces.sessions')}
              {sessions.length > 0 ? (
                <Badge className="ml-1 bg-secondary text-secondary-foreground">{sessions.length}</Badge>
              ) : null}
            </Button>
            <Button onClick={openAdd}>
              <Plus className="mr-2 h-4 w-4" />
              {t('workspaces.addWorkspace')}
            </Button>
          </div>
        }
      />

      {error ? (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mt-6">
        {showSkeletons ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="space-y-3 p-5">
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-4 w-1/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            icon={Boxes}
            title={t('workspaces.empty.title')}
            description={t('workspaces.empty.description')}
            action={
              <Button onClick={openAdd}>
                <FolderPlus className="mr-2 h-4 w-4" />
                {t('workspaces.addWorkspace')}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((ws) => {
              const isSelected = ws.id === selectedId
              const version = resolveInstallVersion(ws.installPath, installs, activeInstall)
              const usingActive = ws.installPath === null
              const status = workspaceStatus(sessions, ws.id)
              return (
                <div
                  key={ws.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedId(ws.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedId(ws.id)
                    }
                  }}
                  className={[
                    'group flex cursor-pointer flex-col rounded-xl border bg-surface p-5 shadow-sm transition',
                    'hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected ? 'border-primary ring-1 ring-primary' : 'border-border'
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-foreground">{ws.name}</h3>
                      <p
                        className="mt-1 truncate font-mono text-xs text-muted-foreground"
                        title={ws.path}
                      >
                        {shortenPath(ws.path)}
                      </p>
                    </div>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <FolderOpen className="h-4 w-4" />
                    </span>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Tooltip
                      label={t('workspaces.card.statusAria', {
                        name: ws.name,
                        status: t(STATUS_LABEL_KEY[status])
                      })}
                    >
                      <StatusDot status={STATUS_DOT[status]} label={t(STATUS_LABEL_KEY[status])} />
                    </Tooltip>
                    <Badge className="bg-secondary text-secondary-foreground">
                      {modelName(ws.modelConfigId)}
                    </Badge>
                    <Tooltip label={ws.installPath ?? t('workspaces.card.followsActive')}>
                      <button
                        type="button"
                        aria-label={t('workspaces.card.versionAria', {
                          name: ws.name,
                          version: version ? `v${version}` : t('common.unknown')
                        })}
                        onClick={(e) => {
                          e.stopPropagation()
                          openEdit(ws)
                        }}
                        className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-surface"
                      >
                        <Terminal className="size-3 text-muted-foreground" />
                        {t('workspaces.card.claudeCode', { version: version ? `v${version}` : '—' })}
                        {usingActive ? (
                          <span className="text-muted-foreground">
                            · {t('workspaces.card.activeSuffix')}
                          </span>
                        ) : null}
                      </button>
                    </Tooltip>
                    <span className="text-xs text-muted-foreground">
                      {t('workspaces.card.lastOpened', { time: relativeTime(ws.lastOpenedAt, lang) })}
                    </span>
                  </div>

                  <div className="mt-5 flex items-center gap-2 border-t border-border pt-4">
                    <Button
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        openLaunch(ws)
                      }}
                    >
                      <Play className="mr-2 h-3.5 w-3.5" />
                      {t('workspaces.card.launch')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        openEdit(ws)
                      }}
                    >
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      {t('workspaces.card.install')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRemoveTarget(ws)
                      }}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      {t('workspaces.card.remove')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add workspace */}
      <Modal
        open={addOpen}
        onOpenChange={setAddOpen}
        title={t('workspaces.add.title')}
        description={t('workspaces.add.description')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void submitAdd()} loading={saving}>
              {t('workspaces.add.submit')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-name">{t('workspaces.add.nameLabel')}</Label>
            <Input
              id="ws-name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder={t('workspaces.add.namePlaceholder')}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-path">{t('workspaces.add.pathLabel')}</Label>
            <div className="flex gap-2">
              <Input
                id="ws-path"
                value={draftPath}
                onChange={(e) => setDraftPath(e.target.value)}
                placeholder={t('workspaces.add.pathPlaceholder')}
                className="font-mono text-xs"
              />
              <Button variant="outline" onClick={() => void browse()} loading={browsing}>
                {t('common.browse')}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ws-model">{t('workspaces.add.modelLabel')}</Label>
            <Select
              id="ws-model"
              options={modelOptions}
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('workspaces.add.modelHint')}</p>
          </div>

          <InstallPicker
            value={draftInstall}
            onChange={setDraftInstall}
            installs={installs}
            activePath={activePath}
          />
        </div>
      </Modal>

      {/* Edit install */}
      <Modal
        open={editTarget !== null}
        onOpenChange={(o) => {
          if (!o) setEditTarget(null)
        }}
        title={t('workspaces.editInstall.title')}
        description={
          editTarget ? t('workspaces.editInstall.description', { name: editTarget.name }) : undefined
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditTarget(null)} disabled={savingEdit}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void submitEdit()} loading={savingEdit}>
              {t('workspaces.editInstall.save')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-edit-model">{t('workspaces.editInstall.modelLabel')}</Label>
            <Select
              id="ws-edit-model"
              options={modelOptions}
              value={editModel}
              onChange={(e) => setEditModel(e.target.value)}
            />
          </div>
          <InstallPicker
            value={editInstall}
            onChange={setEditInstall}
            installs={installs}
            activePath={activePath}
          />
        </div>
      </Modal>

      {/* Launch */}
      <Modal
        open={launchTarget !== null}
        onOpenChange={(o) => {
          if (!o) setLaunchTarget(null)
        }}
        title={t('workspaces.launch.title')}
        description={
          launchTarget ? t('workspaces.launch.description', { name: launchTarget.name }) : undefined
        }
        className="max-w-xl"
        footer={
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              onClick={() => void runVerify()}
              loading={verifying}
              disabled={launching}
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              {t('workspaces.launch.verify')}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setLaunchTarget(null)} disabled={launching}>
                {t('common.close')}
              </Button>
              <Button onClick={() => void submitLaunch()} loading={launching}>
                <Play className="mr-2 h-4 w-4" />
                {criticalFail ? t('workspaces.launch.launchAnyway') : t('workspaces.launch.launch')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-launch-model">{t('workspaces.launch.modelLabel')}</Label>
            <Select
              id="ws-launch-model"
              options={modelOptions}
              value={launchModel}
              onChange={(e) => {
                setLaunchModel(e.target.value)
                setVerification(null)
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t('workspaces.launch.useDefaultModelHint')}
            </p>
          </div>

          <InstallPicker
            value={launchInstall}
            onChange={(p) => {
              setLaunchInstall(p)
              setVerification(null)
            }}
            installs={installs}
            activePath={activePath}
          />

          {criticalFail ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{t('workspaces.launch.criticalFail')}</span>
            </div>
          ) : null}

          <AnimatePresence>
            {verification ? (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className={cn(
                  'space-y-3 rounded-xl border p-3',
                  verification.ok
                    ? 'border-success/40 bg-success/10'
                    : 'border-destructive/40 bg-destructive/10'
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <Badge variant={verification.ok ? 'success' : 'destructive'}>
                    {verification.ok ? (
                      <>
                        <CheckCircle2 />
                        {t('check.pass')}
                      </>
                    ) : (
                      <>
                        <XCircle />
                        {t('check.fail')}
                      </>
                    )}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {verification.plan.workspaceName}
                    {verification.plan.version ? ` · v${verification.plan.version}` : ''}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{verification.message}</p>
                <ul className="max-h-60 space-y-2 overflow-y-auto overscroll-contain pr-1">
                  {verification.checks.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ul>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {launchResult ? <LaunchResultCard result={launchResult} /> : null}
        </div>
      </Modal>

      {/* Sessions */}
      <Modal
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        title={t('workspaces.sessions.title')}
        description={t('workspaces.sessions.description')}
        className="max-w-2xl"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => void loadSessions().catch(() => {})}
              loading={sessionsLoading}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('common.refresh')}
            </Button>
            <Button variant="outline" onClick={() => setSessionsOpen(false)}>
              {t('common.close')}
            </Button>
          </div>
        }
      >
        {sessionsLoading && sessions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            {t('workspaces.sessions.loading')}
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={History}
            title={t('workspaces.sessions.empty.title')}
            description={t('workspaces.sessions.empty.description')}
          />
        ) : (
          <ul className="divide-y divide-border">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-start gap-3 py-3">
                <StatusDot
                  status={session.status === 'running' ? 'running' : 'stopped'}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {session.workspaceName}
                    </span>
                    <Badge variant={session.status === 'running' ? 'success' : 'outline'}>
                      {session.status === 'running'
                        ? t('status.runningLower')
                        : t('status.exited')}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {truncatePath(session.workspacePath, 56)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {session.version
                      ? `v${session.version}`
                      : t('workspaces.sessions.versionUnknown')}
                    {session.pid ? ` · ${t('workspaces.sessions.pid', { pid: session.pid })}` : ''}
                    {` · ${
                      session.launchMode === 'in-app'
                        ? t('settings.defaults.launchModeInApp')
                        : t('settings.defaults.launchModeExternal')
                    }`}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {relativeTime(session.startedAt, lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      {/* Remove confirm */}
      <Modal
        open={removeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null)
        }}
        title={t('workspaces.remove.title')}
        description={
          removeTarget
            ? t('workspaces.remove.description', { name: removeTarget.name })
            : undefined
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemoveTarget(null)} disabled={removing}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void submitRemove()} loading={removing}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('common.remove')}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">{t('workspaces.remove.hint')}</p>
      </Modal>
    </motion.div>
  )
}

function CheckRow({ check }: { check: VerificationCheck }): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const key = CHECK_KEYS[check.id]
  const label = key ? t(key) : check.label
  return (
    <li className="rounded-lg border border-border/60 bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left"
      >
        <StatusDot status={check.ok ? 'ok' : 'error'} />
        <span className="flex-1 text-xs font-medium text-foreground">{label}</span>
        <ChevronDown
          className={cn(
            'size-3.5 text-muted-foreground transition-transform',
            open ? 'rotate-180' : ''
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.p
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden px-2.5 pb-2 pl-6 text-xs text-muted-foreground"
          >
            {check.detail}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </li>
  )
}

function LaunchResultCard({ result }: { result: LaunchResult }): JSX.Element {
  const t = useT()
  return (
    <div
      className={cn(
        'space-y-2 rounded-xl border p-3',
        result.ok ? 'border-border bg-surface-muted/50' : 'border-destructive/40 bg-destructive/10'
      )}
    >
      <div className="flex items-center gap-2">
        {result.ok ? (
          <CheckCircle2 className="size-4 text-success" />
        ) : (
          <XCircle className="size-4 text-destructive" />
        )}
        <span className="text-sm font-medium text-foreground">
          {result.ok ? t('workspaces.launch.launched') : t('workspaces.launch.failed')}
        </span>
        {result.pid ? (
          <Badge variant="outline">{t('workspaces.sessions.pid', { pid: result.pid })}</Badge>
        ) : null}
      </div>
      {!result.ok && result.error ? (
        <p className="text-xs text-destructive">{result.error}</p>
      ) : null}
      <dl className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
        <ResultRow
          label={t('common.version')}
          value={result.version ? `v${result.version}` : t('common.unknown')}
        />
        <ResultRow
          label={t('workspaces.result.executable')}
          value={truncatePath(result.executable, 48)}
          mono
        />
        <ResultRow
          label={t('workspaces.result.workspace')}
          value={truncatePath(result.workspacePath, 48)}
          mono
        />
        <ResultRow
          label={t('workspaces.result.install')}
          value={truncatePath(result.installPath, 48)}
          mono
        />
      </dl>
    </div>
  )
}

function ResultRow({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 truncate text-foreground', mono ? 'font-mono' : '')} title={value}>
        {value}
      </dd>
    </div>
  )
}
