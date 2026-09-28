import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  BrainCircuit,
  Eye,
  EyeOff,
  Pencil,
  Plug,
  Plus,
  Radio,
  Server,
  Trash2,
  Wrench
} from 'lucide-react'
import { useModelsStore } from '@/store/models'
import { useGatewayStore } from '@/store/gateway'
import { useT, type TranslationKey } from '@/i18n'
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
  StatusDot,
  Switch,
  toast
} from '@/components/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import type { ModelConfig, ProviderKind, TestConnectionResult } from '@shared/types'

interface FormState {
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: string
  supportsTools: boolean
  supportsStreaming: boolean
  supportsVision: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  kind: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  model: '',
  timeoutMs: '',
  supportsTools: true,
  supportsStreaming: true,
  supportsVision: false
}

const KIND_KEY: Record<ProviderKind, TranslationKey> = {
  anthropic: 'models.kind.anthropic',
  'openai-compatible': 'models.kind.openai',
  ollama: 'models.kind.ollama',
  custom: 'models.kind.custom'
}

const KIND_VARIANT: Record<ProviderKind, string> = {
  anthropic: 'bg-primary/15 text-primary',
  'openai-compatible': 'bg-success/15 text-success',
  ollama: 'bg-warning/15 text-warning',
  custom: 'bg-secondary text-secondary-foreground'
}

function configToForm(c: ModelConfig): FormState {
  return {
    name: c.name,
    kind: c.kind,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    model: c.model,
    timeoutMs: c.timeoutMs != null ? String(c.timeoutMs) : '',
    supportsTools: c.supportsTools ?? false,
    supportsStreaming: c.supportsStreaming ?? false,
    supportsVision: c.supportsVision ?? false
  }
}

export default function ModelsPage(): JSX.Element {
  const t = useT()
  const navigate = useNavigate()
  const models = useModelsStore((s) => s.models)
  const loading = useModelsStore((s) => s.loading)
  const error = useModelsStore((s) => s.error)
  const load = useModelsStore((s) => s.load)
  const save = useModelsStore((s) => s.save)
  const remove = useModelsStore((s) => s.remove)

  const gatewayStart = useGatewayStore((s) => s.start)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<ModelConfig | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [startingId, setStartingId] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const openCreate = (): void => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowKey(false)
    setTestResult(null)
    setModalOpen(true)
  }

  const openEdit = (c: ModelConfig): void => {
    setEditingId(c.id)
    setForm(configToForm(c))
    setShowKey(false)
    setTestResult(null)
    setModalOpen(true)
  }

  const buildConfig = (): ModelConfig | null => {
    const name = form.name.trim()
    const baseUrl = form.baseUrl.trim()
    const model = form.model.trim()
    if (!name || !baseUrl || !model) {
      toast({ title: t('models.toast.requiredFields'), variant: 'error' })
      return null
    }
    let timeoutMs: number | undefined
    if (form.timeoutMs.trim()) {
      const n = Number(form.timeoutMs)
      if (!Number.isFinite(n) || n <= 0) {
        toast({ title: t('models.toast.badTimeout'), variant: 'error' })
        return null
      }
      timeoutMs = Math.round(n)
    }
    const existing = editingId ? models.find((m) => m.id === editingId) : undefined
    return {
      id: existing ? existing.id : crypto.randomUUID(),
      name,
      kind: form.kind,
      baseUrl,
      apiKey: form.apiKey,
      model,
      timeoutMs,
      supportsTools: form.supportsTools,
      supportsStreaming: form.supportsStreaming,
      supportsVision: form.supportsVision,
      createdAt: existing ? existing.createdAt : new Date().toISOString()
    }
  }

  const submit = async (): Promise<void> => {
    const config = buildConfig()
    if (!config) return
    setSaving(true)
    try {
      await save(config)
      toast({ title: t('toast.modelSaved'), description: config.name, variant: 'success' })
      setModalOpen(false)
    } catch (err) {
      toast({
        title: t('toast.failedSaveModel'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (): Promise<void> => {
    const config = buildConfig()
    if (!config) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await useModelsStore.getState().test(config)
      setTestResult(result)
    } catch (err) {
      setTestResult({
        ok: false,
        latencyMs: null,
        models: [],
        message: err instanceof Error ? err.message : t('models.form.testFail'),
        status: null
      })
    } finally {
      setTesting(false)
    }
  }

  const submitDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await remove(deleteTarget.id)
      toast({ title: t('toast.modelRemoved'), description: deleteTarget.name, variant: 'success' })
      setDeleteTarget(null)
    } catch (err) {
      toast({
        title: t('toast.failedRemoveModel'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setDeleting(false)
    }
  }

  const startGateway = async (c: ModelConfig): Promise<void> => {
    setStartingId(c.id)
    try {
      await gatewayStart(c.id)
      toast({
        title: t('toast.gatewayStarted'),
        description: t('models.toast.routingVia', { name: c.name }),
        variant: 'success'
      })
      navigate('/gateway')
    } catch (err) {
      toast({
        title: t('toast.failedStartGateway'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error'
      })
    } finally {
      setStartingId(null)
    }
  }

  const showSkeletons = loading && models.length === 0
  const isEmpty = !loading && models.length === 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="mx-auto w-full max-w-6xl px-6 py-8"
    >
      <PageHeader
        title={t('models.title')}
        description={t('models.description')}
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('models.add')}
          </Button>
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
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="flex items-center gap-4 p-5">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-5 w-1/4" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            icon={Server}
            title={t('models.empty.title')}
            description={t('models.empty.description')}
            action={
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" />
                {t('models.empty.action')}
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {models.map((c) => (
              <Card key={c.id} className="transition hover:border-primary/40 hover:shadow-md">
                <CardContent className="flex flex-wrap items-center gap-4 p-5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <Server className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-semibold text-foreground">{c.name}</h3>
                      <Badge className={KIND_VARIANT[c.kind]}>{t(KIND_KEY[c.kind])}</Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={c.baseUrl}>
                      {c.baseUrl}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {t('models.form.model')}:{' '}
                      <span className="font-medium text-foreground">{c.model}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void startGateway(c)}
                      loading={startingId === c.id}
                    >
                      <Plug className="mr-2 h-3.5 w-3.5" />
                      {t('models.startGateway')}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('models.row.edit', { name: c.name })}
                      onClick={() => openEdit(c)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('models.row.delete', { name: c.name })}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(c)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Editor */}
      <Modal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={editingId ? t('models.form.editTitle') : t('models.form.addTitle')}
        description={t('models.form.description')}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="outline" onClick={() => void runTest()} loading={testing}>
              <Radio className="mr-2 h-4 w-4" />
              {t('models.form.test')}
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={saving}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void submit()} loading={saving}>
                {editingId ? t('models.form.saveChanges') : t('models.add')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="m-name">{t('models.form.name')}</Label>
              <Input
                id="m-name"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={t('models.form.namePlaceholder')}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="m-kind">{t('models.form.kind')}</Label>
              <Select
                id="m-kind"
                options={[
                  { label: t('models.kind.anthropic'), value: 'anthropic' },
                  { label: t('models.kind.openai'), value: 'openai-compatible' },
                  { label: t('models.kind.ollama'), value: 'ollama' },
                  { label: t('models.kind.custom'), value: 'custom' }
                ]}
                value={form.kind}
                onChange={(e) => set('kind', e.target.value as ProviderKind)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="m-base">{t('models.form.baseUrl')}</Label>
            <Input
              id="m-base"
              value={form.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
              placeholder={t('models.form.baseUrlPlaceholder')}
              className="font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="m-key">{t('models.form.apiKey')}</Label>
              <div className="relative">
                <Input
                  id="m-key"
                  type={showKey ? 'text' : 'password'}
                  value={form.apiKey}
                  onChange={(e) => set('apiKey', e.target.value)}
                  placeholder={t('models.form.apiKeyPlaceholder')}
                  className="pr-10 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? t('models.form.hideKey') : t('models.form.showKey')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="m-model">{t('models.form.model')}</Label>
              <Input
                id="m-model"
                value={form.model}
                onChange={(e) => set('model', e.target.value)}
                placeholder={t('models.form.modelPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="m-timeout">{t('models.form.timeout')}</Label>
            <Input
              id="m-timeout"
              type="number"
              min={1}
              value={form.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value)}
              placeholder="60000"
            />
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-surface-muted/50 p-4">
            <p className="text-sm font-medium text-foreground">{t('models.form.capabilities')}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Wrench className="h-3.5 w-3.5" /> {t('models.form.supportsTools')}
                </span>
                <Switch checked={form.supportsTools} onCheckedChange={(v) => set('supportsTools', v)} />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Radio className="h-3.5 w-3.5" /> {t('models.form.supportsStreaming')}
                </span>
                <Switch
                  checked={form.supportsStreaming}
                  onCheckedChange={(v) => set('supportsStreaming', v)}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Eye className="h-3.5 w-3.5" /> {t('models.form.supportsVision')}
                </span>
                <Switch checked={form.supportsVision} onCheckedChange={(v) => set('supportsVision', v)} />
              </label>
            </div>
          </div>

          {testing || testResult ? (
            <div className="rounded-lg border border-border bg-surface-muted/50 p-4 text-sm">
              {testing ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <StatusDot status="starting" />
                  {t('models.form.testing')}
                </div>
              ) : testResult ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <StatusDot
                      status={testResult.ok ? 'ok' : 'error'}
                      label={
                        testResult.ok
                          ? t('models.form.testOk', { ms: testResult.latencyMs ?? 0 })
                          : t('models.form.testFail')
                      }
                    />
                    {testResult.latencyMs != null ? (
                      <Badge className="bg-secondary text-secondary-foreground">
                        {testResult.latencyMs} ms
                      </Badge>
                    ) : null}
                    {testResult.status != null ? (
                      <Badge className="bg-secondary text-secondary-foreground">HTTP {testResult.status}</Badge>
                    ) : null}
                  </div>
                  <p className={testResult.ok ? 'text-muted-foreground' : 'text-destructive'}>
                    {testResult.ok
                      ? t('models.form.testOk', { ms: testResult.latencyMs ?? 0 })
                      : t('models.form.testFail')}
                  </p>
                  {testResult.message ? (
                    <p className="text-xs text-muted-foreground">{testResult.message}</p>
                  ) : null}
                  {testResult.models.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {testResult.models.slice(0, 12).map((m) => (
                        <Badge key={m} className="bg-accent text-accent-foreground font-mono text-[11px]">
                          {m}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null)
        }}
        title={t('models.form.deleteTitle')}
        description={
          deleteTarget ? t('models.form.deleteDescription', { name: deleteTarget.name }) : undefined
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void submitDelete()} loading={deleting}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('common.delete')}
            </Button>
          </div>
        }
      >
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <BrainCircuit className="h-4 w-4" />
          {t('models.form.deleteBody')}
        </p>
      </Modal>
    </motion.div>
  )
}
