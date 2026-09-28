import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  CheckCircle2,
  FolderSearch,
  Info,
  Monitor,
  Palette,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Terminal,
  XCircle
} from 'lucide-react'
import { useSettingsStore } from '@/store/settings'
import { useModelsStore } from '@/store/models'
import { useInstallsStore } from '@/store/installs'
import { InstallTargets } from '@/components/installs/InstallTargets'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Skeleton,
  StatusDot,
  toast
} from '@/components/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { useT, useLanguage, useSetLanguage, type TranslationKey } from '@/i18n'
import type { AppSettings, ClaudeInstall, Language, ThemeMode, ValidateResult } from '@shared/types'

const SOURCE_KEY: Record<ClaudeInstall['source'], TranslationKey> = {
  'npm-global': 'settings.install.source.npmGlobal',
  'local-bin': 'settings.install.source.localBin',
  native: 'settings.install.source.native',
  custom: 'settings.install.source.custom',
  path: 'settings.install.source.path'
}

function readAppVersion(): string {
  const bridge = window.ccdeck as unknown as { version?: string; appVersion?: string }
  return bridge.version ?? bridge.appVersion ?? '0.1.0'
}

export default function SettingsPage(): JSX.Element {
  const t = useT()
  const language = useLanguage()
  const setLanguage = useSetLanguage()

  const settings = useSettingsStore((s) => s.settings)
  const loading = useSettingsStore((s) => s.loading)
  const error = useSettingsStore((s) => s.error)
  const load = useSettingsStore((s) => s.load)
  const update = useSettingsStore((s) => s.update)

  const models = useModelsStore((s) => s.models)
  const loadModels = useModelsStore((s) => s.load)

  const installs = useInstallsStore((s) => s.installs)
  const installsStatus = useInstallsStore((s) => s.status)
  const installsLoading = useInstallsStore((s) => s.loading)
  const installsError = useInstallsStore((s) => s.error)
  const loadInstalls = useInstallsStore((s) => s.load)
  const selectInstall = useInstallsStore((s) => s.select)
  const pickInstallDir = useInstallsStore((s) => s.pickDir)
  const validateInstall = useInstallsStore((s) => s.validate)
  const subscribeInstalls = useInstallsStore((s) => s.subscribe)

  const [selectingPath, setSelectingPath] = useState<string | null>(null)
  const [validatePath, setValidatePath] = useState<string>('')
  const [validating, setValidating] = useState(false)
  const [validateResult, setValidateResult] = useState<ValidateResult | null>(null)

  const [portDraft, setPortDraft] = useState<string>('')
  const [portError, setPortError] = useState<string | null>(null)

  useEffect(() => {
    void load()
    void loadModels()
    void loadInstalls()
    const unsubscribe = subscribeInstalls()
    return () => unsubscribe()
  }, [load, loadModels, loadInstalls, subscribeInstalls])

  useEffect(() => {
    if (settings) setPortDraft(String(settings.gatewayPort))
  }, [settings])

  // Seed the validate field from the pinned install the first time we see it.
  useEffect(() => {
    const pinned = installsStatus?.installPath ?? installs.find((i) => i.active)?.path ?? ''
    setValidatePath((prev) => (prev ? prev : pinned))
  }, [installsStatus, installs])

  const persist = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      await update(patch)
      toast({ title: t('settings.saved'), variant: 'success' })
    } catch (err) {
      toast({
        title: t('settings.saveFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    }
  }

  const chooseInstall = async (install: ClaudeInstall): Promise<void> => {
    setSelectingPath(install.path)
    try {
      await selectInstall(install.path)
      toast({ title: t('settings.install.updated'), description: install.path, variant: 'success' })
    } catch (err) {
      toast({
        title: t('settings.install.selectFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setSelectingPath(null)
    }
  }

  const browseInstall = async (): Promise<void> => {
    try {
      const dir = await pickInstallDir()
      if (!dir) return
      await selectInstall(dir)
      toast({ title: t('settings.install.customSelected'), description: dir, variant: 'success' })
    } catch (err) {
      toast({
        title: t('settings.install.addFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    }
  }

  const runValidate = useCallback(async (): Promise<void> => {
    const target = validatePath.trim()
    if (!target) {
      setValidateResult({
        ok: false,
        isClaudeCode: false,
        version: null,
        executable: null,
        message: t('settings.install.enterPath')
      })
      return
    }
    setValidating(true)
    try {
      const result = await validateInstall(target)
      setValidateResult(result)
    } catch (err) {
      setValidateResult({
        ok: false,
        isClaudeCode: false,
        version: null,
        executable: null,
        message: err instanceof Error ? err.message : t('settings.install.validationFailed')
      })
    } finally {
      setValidating(false)
    }
  }, [validatePath, validateInstall, t])

  const commitPort = (): void => {
    const raw = portDraft.trim()
    const n = Number(raw)
    if (!raw || !Number.isInteger(n) || n < 1 || n > 65535) {
      setPortError(t('settings.defaults.portError'))
      return
    }
    setPortError(null)
    if (settings && n === settings.gatewayPort) return
    void persist({ gatewayPort: n })
  }

  const activeInstall = installs.find((i) => i.active) ?? null

  const modelOptions = [
    { label: t('common.none'), value: '' },
    ...models.map((m) => ({ label: m.name, value: m.id }))
  ]

  const themeOptions: { label: string; value: ThemeMode }[] = [
    { label: t('settings.appearance.themeLight'), value: 'light' },
    { label: t('settings.appearance.themeDark'), value: 'dark' },
    { label: t('settings.appearance.themeSystem'), value: 'system' }
  ]

  const languageOptions: { label: string; value: Language }[] = [
    { label: t('settings.language.en'), value: 'en' },
    { label: t('settings.language.zh'), value: 'zh' }
  ]

  const launchModeOptions: { label: string; value: AppSettings['launchMode'] }[] = [
    { label: t('settings.defaults.launchModeExternal'), value: 'external-terminal' },
    { label: t('settings.defaults.launchModeInApp'), value: 'in-app' }
  ]

  if (!settings) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 px-6 py-8">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
        {error ? (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        {loading ? null : (
          <Button variant="outline" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8"
    >
      <PageHeader title={t('settings.title')} description={t('settings.description')} />

      {error ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Claude Code install */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              <CardTitle>{t('settings.install.title')}</CardTitle>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadInstalls()}
                loading={installsLoading}
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t('settings.install.reDetect')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void browseInstall()}>
                <FolderSearch className="mr-2 h-3.5 w-3.5" />
                {t('common.browse')}
              </Button>
            </div>
          </div>
          <CardDescription>{t('settings.install.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeInstall ? (
            <div className="flex items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('settings.install.activeInstall')}
                </p>
                <p className="truncate font-mono text-sm" title={activeInstall.path}>
                  {activeInstall.path}
                </p>
                <p className="text-xs text-muted-foreground">
                  {activeInstall.version ? `v${activeInstall.version}` : t('settings.install.versionUnknown')}{' '}
                  · {t(SOURCE_KEY[activeInstall.source])}
                </p>
              </div>
            </div>
          ) : null}

          {installsLoading && installs.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : installsError && installs.length === 0 ? (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{installsError}</span>
            </div>
          ) : installs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('settings.install.noInstalls')}</p>
          ) : (
            <div className="space-y-2">
              {installs.map((install) => (
                <div
                  key={install.path}
                  className={[
                    'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 transition',
                    install.active ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  ].join(' ')}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs" title={install.path}>
                      {install.path}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <Badge className="bg-secondary text-secondary-foreground">
                        {t(SOURCE_KEY[install.source])}
                      </Badge>
                      <Badge className="bg-secondary text-secondary-foreground">
                        {install.version ? `v${install.version}` : t('settings.install.versionUnknown')}
                      </Badge>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        {install.valid ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-success" /> {t('common.valid')}
                          </>
                        ) : (
                          <>
                            <XCircle className="h-3.5 w-3.5 text-destructive" />{' '}
                            {t('settings.install.missing')}
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                  {install.active ? (
                    <Badge className="bg-primary/15 text-primary">{t('common.active')}</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!install.valid}
                      loading={selectingPath === install.path}
                      onClick={() => void chooseInstall(install)}
                    >
                      {t('common.select')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Validate a chosen / custom path */}
          <div className="space-y-2 rounded-lg border border-border bg-surface-muted/40 p-3.5">
            <Label htmlFor="s-validate-path">{t('settings.install.validatePath')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="s-validate-path"
                value={validatePath}
                onChange={(e) => {
                  setValidatePath(e.target.value)
                  if (validateResult) setValidateResult(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runValidate()
                }}
                placeholder="C:\\path\\to\\claude-code"
                className="min-w-0 flex-1 font-mono text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                loading={validating}
                disabled={!validatePath.trim()}
                onClick={() => void runValidate()}
              >
                <ShieldCheck className="mr-2 h-3.5 w-3.5" />
                {t('settings.install.validate')}
              </Button>
            </div>
            {validateResult ? (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <StatusDot
                  status={validateResult.ok ? 'ok' : 'error'}
                  label={validateResult.ok ? t('settings.install.validInstall') : t('common.invalid')}
                />
                {validateResult.isClaudeCode ? (
                  <Badge variant="success">Claude Code</Badge>
                ) : (
                  <Badge variant="warning">{t('settings.install.notClaudeCode')}</Badge>
                )}
                {validateResult.version ? (
                  <Badge variant="outline">v{validateResult.version}</Badge>
                ) : null}
                <span className="text-xs text-muted-foreground">{validateResult.message}</span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('settings.install.validateHint')}</p>
            )}
          </div>

          <div className="border-t border-border pt-4">
            <InstallTargets />
          </div>
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-primary" />
            <CardTitle>{t('settings.appearance.title')}</CardTitle>
          </div>
          <CardDescription>{t('settings.appearance.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid max-w-md grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="s-theme">{t('settings.appearance.theme')}</Label>
              <Select
                id="s-theme"
                options={themeOptions}
                value={settings.theme}
                onChange={(e) => void persist({ theme: e.target.value as ThemeMode })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="s-language">{t('settings.appearance.language')}</Label>
              <Select
                id="s-language"
                options={languageOptions}
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Default model */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-primary" />
            <CardTitle>{t('settings.defaults.model')}</CardTitle>
          </div>
          <CardDescription>{t('settings.defaults.modelDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-md space-y-2">
            <Label htmlFor="s-model">{t('settings.defaults.modelConfig')}</Label>
            <Select
              id="s-model"
              options={modelOptions}
              value={settings.defaultModelConfigId ?? ''}
              onChange={(e) => void persist({ defaultModelConfigId: e.target.value || null })}
            />
            {models.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('settings.defaults.noModels')}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Launch */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-primary" />
            <CardTitle>{t('settings.defaults.launch')}</CardTitle>
          </div>
          <CardDescription>{t('settings.defaults.launchDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="s-launch">{t('settings.defaults.launchMode')}</Label>
            <Select
              id="s-launch"
              options={launchModeOptions}
              value={settings.launchMode}
              onChange={(e) =>
                void persist({ launchMode: e.target.value as AppSettings['launchMode'] })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="s-port">{t('settings.defaults.gatewayPort')}</Label>
            <Input
              id="s-port"
              type="number"
              min={1}
              max={65535}
              value={portDraft}
              onChange={(e) => {
                setPortDraft(e.target.value)
                if (portError) setPortError(null)
              }}
              onBlur={commitPort}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPort()
              }}
              aria-invalid={portError !== null}
              aria-describedby={portError ? 's-port-error' : undefined}
            />
            {portError ? (
              <p id="s-port-error" className="text-xs text-destructive">
                {portError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('settings.defaults.portHint')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* About */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-primary" />
            <CardTitle>{t('settings.about.title')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StatusDot status="ok" />
              <div>
                <p className="font-semibold text-foreground">{t('app.name')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.about.description')}</p>
              </div>
            </div>
            <Badge className="bg-secondary text-secondary-foreground font-mono">
              {t('settings.about.version')} v{readAppVersion()}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
