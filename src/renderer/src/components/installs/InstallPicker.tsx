import { useId, useMemo } from 'react'
import { AlertTriangle, Check, HardDrive } from 'lucide-react'
import type { ClaudeInstall } from '@shared/types'
import { Badge, Label, Select, type SelectOption } from '@/components/ui'
import { cn } from '@/lib/cn'
import { truncatePath } from '@/lib/format'
import { useT, type TFunction } from '@/i18n'

export interface InstallPickerProps {
  /** Selected install path, or `null` to use the active install. */
  value: string | null
  onChange: (path: string | null) => void
  /** Every discovered install on this machine. */
  installs: ClaudeInstall[]
  /** Path of the active/pinned install (used for the "use active" label + badge). */
  activePath: string | null
  className?: string
  disabled?: boolean
  label?: string
}

/** Sentinel for the "use active install" option (maps to `null`). */
const ACTIVE_VALUE = '__active__'

function installLabel(t: TFunction, install: ClaudeInstall): string {
  return t('installPicker.optionLabel', {
    version: install.version ?? t('installPicker.noVersion'),
    source: install.source,
    path: truncatePath(install.path, 44)
  })
}

/**
 * Reusable Claude Code install selector.
 *
 * Lists every discovered install plus a first "use active install" option that
 * maps to `null`. Shows the chosen version prominently and warns when the
 * bound path is no longer detected on disk.
 */
export function InstallPicker({
  value,
  onChange,
  installs,
  activePath,
  className,
  disabled = false,
  label
}: InstallPickerProps): JSX.Element {
  const t = useT()
  const selectId = useId()

  const activeInstall = useMemo(
    () => installs.find((i) => i.path === activePath) ?? installs.find((i) => i.active) ?? null,
    [installs, activePath]
  )

  const selected = useMemo(
    () => (value ? installs.find((i) => i.path === value) ?? null : null),
    [installs, value]
  )

  const notDetected = value !== null && selected === null

  const options = useMemo<SelectOption[]>(() => {
    const activeLabel = activeInstall?.version
      ? t('installPicker.useActive', { version: activeInstall.version })
      : t('installPicker.useActiveNoVersion')
    return [
      { label: activeLabel, value: ACTIVE_VALUE },
      ...installs.map((i) => ({ label: installLabel(t, i), value: i.path })),
      // Keep an undetected bound path selectable so the warning is actionable.
      ...(notDetected && value
        ? [
            {
              label: `${t('installPicker.missing')} · ${truncatePath(value, 44)}`,
              value
            }
          ]
        : [])
    ]
  }, [activeInstall, installs, notDetected, value, t])

  const chosenVersion = value ? selected?.version ?? null : activeInstall?.version ?? null
  const usingActive = value === null

  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={selectId}>{label ?? t('workspaces.editInstall.label')}</Label>
      <Select
        id={selectId}
        options={options}
        value={value ?? ACTIVE_VALUE}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === ACTIVE_VALUE ? null : e.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          <HardDrive className="size-3.5 text-muted-foreground" />
          {chosenVersion
            ? `v${chosenVersion}`
            : `${t('common.version')} ${t('common.unknown')}`}
        </span>

        {usingActive ? (
          <Badge variant="success">
            <Check />
            {t('common.active')}
          </Badge>
        ) : null}

        {selected?.active && !usingActive ? (
          <Badge variant="success">
            <Check />
            {t('common.active')}
          </Badge>
        ) : null}

        {notDetected ? (
          <Badge variant="warning">
            <AlertTriangle />
            {t('installPicker.notDetected')}
          </Badge>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {usingActive
          ? t('installPicker.followsActive')
          : notDetected
            ? t('installPicker.staleHint')
            : truncatePath(value, 64)}
      </p>
    </div>
  )
}
