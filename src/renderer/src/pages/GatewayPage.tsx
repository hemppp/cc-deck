import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  Activity,
  Check,
  Copy,
  Cpu,
  Globe,
  KeyRound,
  Play,
  RefreshCw,
  Square,
  TerminalSquare
} from 'lucide-react'
import { useGatewayStore } from '@/store/gateway'
import { useModelsStore } from '@/store/models'
import { useSettingsStore } from '@/store/settings'
import { useT, type TranslationKey } from '@/i18n'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  StatusDot,
  toast
} from '@/components/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import type { GatewayStatus } from '@shared/types'

const STATUS_KEY: Record<GatewayStatus, TranslationKey> = {
  stopped: 'status.stopped',
  starting: 'gateway.startingTitle',
  running: 'gateway.runningTitle',
  error: 'gateway.errorTitle'
}

function maskToken(token: string | null): string {
  if (!token) return '—'
  if (token.length <= 8) return '••••••••'
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`
}

function CopyRow({
  label,
  value,
  display,
  mono = true
}: {
  label: string
  value: string
  display?: string
  mono?: boolean
}): JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast({ title: t('toast.copied'), description: label, variant: 'success' })
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast({ title: t('toast.copyFailed'), variant: 'error' })
    }
  }, [value, label, t])

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-muted/50 px-3 py-2">
      <span className="w-44 shrink-0 font-mono text-xs text-muted-foreground">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-sm ${mono ? 'font-mono' : ''}`}>
        {display ?? value}
      </span>
      <Button
        size="icon"
        variant="ghost"
        aria-label={`${t('common.copy')} ${label}`}
        onClick={() => void copy()}
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  )
}

export default function GatewayPage(): JSX.Element {
  const t = useT()
  const state = useGatewayStore((s) => s.state)
  const loading = useGatewayStore((s) => s.loading)
  const error = useGatewayStore((s) => s.error)
  const load = useGatewayStore((s) => s.load)
  const start = useGatewayStore((s) => s.start)
  const stop = useGatewayStore((s) => s.stop)
  const subscribe = useGatewayStore((s) => s.subscribe)

  const models = useModelsStore((s) => s.models)
  const loadModels = useModelsStore((s) => s.load)

  const settings = useSettingsStore((s) => s.settings)
  const loadSettings = useSettingsStore((s) => s.load)

  const [configId, setConfigId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void load()
    void loadModels()
    void loadSettings()
    const unsubscribe = subscribe()
    return () => unsubscribe()
  }, [load, loadModels, loadSettings, subscribe])

  // Default the select to the settings default (or the active config) once known.
  useEffect(() => {
    if (configId) return
    const preferred = state.activeConfigId ?? settings?.defaultModelConfigId ?? null
    if (preferred) setConfigId(preferred)
  }, [configId, state.activeConfigId, settings?.defaultModelConfigId])

  const modelOptions = useMemo(
    () => models.map((m) => ({ label: m.name, value: m.id })),
    [models]
  )

  const activeConfigName = useMemo(() => {
    const id = state.activeConfigId
    if (!id) return '—'
    return models.find((m) => m.id === id)?.name ?? t('common.unknown')
  }, [models, state.activeConfigId, t])

  const isRunning = state.status === 'running'
  const isStarting = state.status === 'starting'

  const statusHint = isRunning
    ? t('gateway.runningHint')
    : isStarting
      ? t('gateway.startingHint')
      : state.status === 'error'
        ? t('gateway.errorHint')
        : t('gateway.stoppedHint')

  const handleStart = async (): Promise<void> => {
    if (!configId) {
      toast({ title: t('gateway.selectConfigFirst'), variant: 'error' })
      return
    }
    setBusy(true)
    try {
      const port =
        settings && settings.gatewayPort > 0 ? settings.gatewayPort : undefined
      await start(configId, port)
      toast({ title: t('toast.gatewayStarted'), variant: 'success' })
    } catch (err) {
      toast({
        title: t('toast.failedStartGateway'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    setBusy(true)
    try {
      await stop()
      toast({ title: t('toast.gatewayStopped'), variant: 'success' })
    } catch (err) {
      toast({
        title: t('toast.failedStopGateway'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setBusy(false)
    }
  }

  const baseUrl = state.baseUrl ?? '—'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="mx-auto w-full max-w-5xl px-6 py-8"
    >
      <PageHeader
        title={t('gateway.title')}
        description={t('gateway.description')}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} loading={loading}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            {t('gateway.refresh')}
          </Button>
        }
      />

      {error ? (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {state.status === 'error' && state.error ? (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      ) : null}

      {/* Status */}
      <Card className="mt-6 overflow-hidden">
        <div className="h-1 w-full bg-gradient-to-r from-primary/70 via-primary/30 to-transparent" />
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <StatusDot status={state.status} />
              <div>
                <CardTitle className="text-lg">{t(STATUS_KEY[state.status])}</CardTitle>
                <CardDescription>{statusHint}</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void handleStart()}
                disabled={isRunning || isStarting || !configId}
                loading={busy && !isRunning}
              >
                <Play className="mr-2 h-4 w-4" />
                {t('gateway.start')}
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleStop()}
                disabled={state.status === 'stopped' || isStarting}
                loading={busy && (isRunning || isStarting)}
              >
                <Square className="mr-2 h-4 w-4" />
                {t('gateway.stop')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('gateway.modelConfig')}
              </p>
              <Select
                aria-label={t('gateway.modelConfig')}
                options={
                  modelOptions.length
                    ? modelOptions
                    : [{ label: t('gateway.noConfigs'), value: '' }]
                }
                value={configId}
                onChange={(e) => setConfigId(e.target.value)}
                disabled={isRunning || isStarting || modelOptions.length === 0}
              />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('gateway.activeConfig')}
              </p>
              <div className="flex h-10 items-center gap-2 rounded-md border border-border bg-surface-muted/50 px-3">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <span className="truncate text-sm">{activeConfigName}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-surface-muted/50 p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Globe className="h-3.5 w-3.5" /> {t('gateway.port')}
              </div>
              <p className="mt-1 font-mono text-sm">{state.port ?? '—'}</p>
            </div>
            <div className="rounded-lg border border-border bg-surface-muted/50 p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Activity className="h-3.5 w-3.5" /> {t('gateway.requests')}
              </div>
              <p className="mt-1 font-mono text-sm">{state.requestCount}</p>
            </div>
            <div className="col-span-2 rounded-lg border border-border bg-surface-muted/50 p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Globe className="h-3.5 w-3.5" /> {t('gateway.baseUrl')}
              </div>
              <p className="mt-1 truncate font-mono text-sm" title={baseUrl}>
                {baseUrl}
              </p>
            </div>
          </div>

          {state.baseUrl ? (
            <CopyRow label={t('gateway.baseUrl')} value={state.baseUrl} />
          ) : (
            <p className="text-xs text-muted-foreground">{t('gateway.baseUrlHint')}</p>
          )}
        </CardContent>
      </Card>

      {/* How to use */}
      <Card className="mt-6">
        <CardHeader>
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-primary" />
            <CardTitle>{t('gateway.howToUse')}</CardTitle>
          </div>
          <CardDescription>{t('gateway.howToUseBody')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyRow label="ANTHROPIC_BASE_URL" value={state.baseUrl ?? ''} />
          <CopyRow
            label="ANTHROPIC_AUTH_TOKEN"
            value={state.token ?? ''}
            display={maskToken(state.token)}
          />
          <div className="flex items-start gap-2 rounded-lg border border-border bg-accent/40 px-3 py-2 text-xs text-accent-foreground">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('gateway.tokenNote')}</span>
          </div>
          {state.status !== 'running' ? (
            <div className="flex items-center gap-2">
              <Badge className="bg-warning/15 text-warning">{t('gateway.notRunning')}</Badge>
              <span className="text-xs text-muted-foreground">{t('gateway.notRunningHint')}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  )
}
