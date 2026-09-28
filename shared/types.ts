/**
 * CC Deck — Shared contract between Electron main, preload, and renderer.
 * FROZEN: any change here must be coordinated with all agents.
 */

/* ------------------------------------------------------------------ */
/* Claude Code installation discovery                                  */
/* ------------------------------------------------------------------ */

export type Platform = 'win32' | 'darwin' | 'linux'

export interface ClaudeInstall {
  /** Absolute path to the install root (e.g. the global node_modules/@anthropic-ai/claude-code) */
  path: string
  /** Absolute path to the launcher (claude.cmd / claude / claude.ps1 or the native binary) */
  executable: string | null
  /** Version string if discoverable */
  version: string | null
  /** Where this entry came from */
  source: 'npm-global' | 'local-bin' | 'native' | 'custom' | 'path'
  /** True if this is the user-pinned / selected install */
  active: boolean
  /** Whether the path still exists on disk */
  valid: boolean
}

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

export interface Workspace {
  id: string
  name: string
  /** Absolute directory path */
  path: string
  /** Optional per-workspace model config id; falls back to global default */
  modelConfigId: string | null
  /** Optional per-workspace Claude Code install path; falls back to the active install */
  installPath: string | null
  createdAt: string
  lastOpenedAt: string | null
  color: string | null
}

/* ------------------------------------------------------------------ */
/* Model configurations + gateway                                      */
/* ------------------------------------------------------------------ */

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'ollama' | 'custom'

export interface ModelConfig {
  id: string
  name: string
  kind: ProviderKind
  /** Upstream base URL, e.g. http://localhost:11434/v1 or https://api.openai.com/v1 */
  baseUrl: string
  /** API key / token for the upstream provider (may be empty for local) */
  apiKey: string
  /** Default model id to request, e.g. "qwen2.5-coder:14b" */
  model: string
  /** Optional extra headers sent upstream */
  headers?: Record<string, string>
  /** Capabilities used by the gateway to decide translations */
  supportsTools?: boolean
  supportsStreaming?: boolean
  supportsVision?: boolean
  /** Per-request timeout in ms */
  timeoutMs?: number
  createdAt: string
}

export type GatewayStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface GatewayState {
  status: GatewayStatus
  /** Local port the Anthropic-compatible endpoint listens on */
  port: number | null
  /** Full base URL to hand to Claude Code, e.g. http://127.0.0.1:8788 */
  baseUrl: string | null
  /** Model config currently routed through the gateway */
  activeConfigId: string | null
  /** Token the gateway requires (exposed so we can write ANTHROPIC_AUTH_TOKEN) */
  token: string | null
  error: string | null
  /** Rolling count of proxied requests */
  requestCount: number
}

/* ------------------------------------------------------------------ */
/* Launch                                                              */
/* ------------------------------------------------------------------ */

export interface LaunchOptions {
  workspaceId: string
  /** null => use global default model config */
  modelConfigId: string | null
  /** Which Claude Code install to launch. null/undefined => the active install. */
  installPath?: string | null
  /** Additional CLI args passed through to `claude` */
  extraArgs?: string[]
  /** Extra env vars */
  env?: Record<string, string>
}

/** One verification assertion about a would-be / actual launch. */
export interface VerificationCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

/** A resolved, not-yet-executed launch description (dry-run). */
export interface LaunchPlan {
  workspaceId: string
  workspaceName: string
  workspacePath: string
  /** Whether the workspace directory exists and is a directory. */
  workspaceValid: boolean
  /** Install root actually chosen to launch. */
  installPath: string | null
  /** Launcher that will be executed. */
  executable: string
  executableExists: boolean
  /** Version of the chosen install, when resolvable. */
  version: string | null
  /** What the caller asked for (null => active install). */
  requestedInstallPath: string | null
  /** True when `executable` belongs to the requested/active install. */
  installMatches: boolean
  /** Effective model id injected via env (ANTHROPIC_MODEL), if any. */
  model: string | null
  gatewayBaseUrl: string | null
  gatewayRunning: boolean
  launchMode: 'external-terminal' | 'in-app'
  args: string[]
  /** Env that will be injected (auth token masked). */
  env: Record<string, string>
}

export interface LaunchVerification {
  ok: boolean
  plan: LaunchPlan
  checks: VerificationCheck[]
  message: string
}

export interface LaunchResult {
  ok: boolean
  /** Environment actually used (secrets redacted in UI) */
  env: Record<string, string>
  pid?: number
  error?: string
  /** Resolved install that was launched. */
  installPath?: string | null
  executable?: string
  version?: string | null
  workspacePath?: string
  /** Id of the recorded session (see LaunchSession). */
  sessionId?: string
  /** Post-launch verification checks. */
  checks?: VerificationCheck[]
}

/** A tracked Claude Code process started for a workspace. */
export interface LaunchSession {
  id: string
  workspaceId: string
  workspaceName: string
  workspacePath: string
  installPath: string | null
  executable: string
  version: string | null
  pid: number | null
  launchMode: 'external-terminal' | 'in-app'
  startedAt: string
  status: 'running' | 'exited'
}

/* ------------------------------------------------------------------ */
/* Connectivity testing                                                */
/* ------------------------------------------------------------------ */

export interface TestConnectionResult {
  ok: boolean
  /** Round-trip latency in ms */
  latencyMs: number | null
  /** Model ids returned by the endpoint, when discoverable */
  models: string[]
  /** Human readable message (error or summary) */
  message: string
  /** HTTP status when applicable */
  status?: number | null
}

/* ------------------------------------------------------------------ */
/* App settings                                                        */
/* ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark' | 'system'

/** UI language. */
export type Language = 'en' | 'zh'

export interface AppSettings {
  /** Pinned Claude Code install path (null => auto-detected) */
  claudeInstallPath: string | null
  /** Preferred gateway port; 0 => auto-pick a free port */
  gatewayPort: number
  defaultModelConfigId: string | null
  theme: ThemeMode
  /** UI language (English / Chinese). */
  language: Language
  /** Launch terminal: open a new system terminal window vs. run in-app */
  launchMode: 'external-terminal' | 'in-app'
}

/* ------------------------------------------------------------------ */
/* Install path mutation: env vars, registry, config files            */
/* ------------------------------------------------------------------ */

export type EnvScope = 'user' | 'system'

export type MutationTargetKind =
  | 'windows-user-path' // HKCU\Environment PATH (REG_EXPAND_SZ)
  | 'windows-system-path' // HKLM\...\Session Manager\Environment PATH (needs elevation)
  | 'unix-shell-profile' // ~/.zshrc | ~/.bashrc | ~/.profile | fish config
  | 'claude-settings' // ~/.claude/settings.json  (env block)
  | 'launcher-shim' // a `claude` launcher/symlink placed on PATH

export interface MutationTarget {
  id: string
  kind: MutationTargetKind
  label: string
  /** Absolute file path, or a registry key path for registry targets. */
  location: string
  scope: EnvScope
  /** Applicable on the current platform (e.g. registry only on Windows). */
  available: boolean
  /** Writable without elevation. */
  writable: boolean
  /** Needs admin/root (system scope). */
  requiresElevation: boolean
  /** Whether the custom install path is currently present in this target. */
  applied: boolean
  /** Current value / content preview (truncated for display). */
  currentValue: string | null
  note?: string
}

export interface InstallStatus {
  /** The pinned custom install root, or null when auto-detected. */
  installPath: string | null
  executable: string | null
  version: string | null
  /** What `claude` currently resolves to on PATH (if any). */
  pathResolvesTo: string | null
  /** True when PATH resolves to the pinned custom install. */
  pathApplied: boolean
  targets: MutationTarget[]
  backups: BackupRecord[]
  platform: Platform
}

export interface ApplyRequest {
  installPath: string
  /** Target ids to mutate (from InstallStatus.targets). */
  targetIds: string[]
  /** Prepend the install's bin dir to PATH (recommended) vs. append. */
  prependPath: boolean
}

export interface TargetResult {
  targetId: string
  ok: boolean
  /** Whether the target's content actually changed. */
  changed: boolean
  message: string
  newValue?: string | null
}

export interface BackupEntry {
  targetId: string
  kind: MutationTargetKind
  location: string
  /** Whether the target existed before we touched it. */
  existed: boolean
  /** Raw previous file content, or previous registry value (null if absent). */
  previous: string | null
}

export interface BackupRecord {
  id: string
  createdAt: string
  installPath: string
  entries: BackupEntry[]
}

/** A concurrent-modification or lock-contention event observed while mutating. */
export interface ConflictEvent {
  targetId: string
  location: string
  detectedAt: string
  kind: 'external-modification' | 'lock-contention'
  resolution: 'retried' | 'merged' | 'aborted'
  message: string
}

export interface ApplyResult {
  ok: boolean
  /** Backup created for this apply (used for revert). */
  backupId: string | null
  results: TargetResult[]
  /** Concurrency events observed during the apply. */
  conflicts: ConflictEvent[]
  error?: string
}

export interface ValidateResult {
  ok: boolean
  isClaudeCode: boolean
  version: string | null
  executable: string | null
  message: string
}

/* ------------------------------------------------------------------ */
/* IPC channel names                                                   */
/* ------------------------------------------------------------------ */

export const IPC = {
  // installs
  installsDetect: 'installs:detect',
  installsSelect: 'installs:select',
  installsPickDir: 'installs:pick-dir',
  installsStatus: 'installs:status',
  installsValidate: 'installs:validate',
  installsApply: 'installs:apply',
  installsRevert: 'installs:revert',
  installsBackups: 'installs:backups',
  installsRefresh: 'installs:refresh',

  // workspaces
  workspacesList: 'workspaces:list',
  workspacesAdd: 'workspaces:add',
  workspacesRemove: 'workspaces:remove',
  workspacesUpdate: 'workspaces:update',
  workspacesPickDir: 'workspaces:pick-dir',

  // models
  modelsList: 'models:list',
  modelsSave: 'models:save',
  modelsRemove: 'models:remove',
  modelsTest: 'models:test',

  // gateway
  gatewayStart: 'gateway:start',
  gatewayStop: 'gateway:stop',
  gatewayState: 'gateway:state',

  // launch
  launchRun: 'launch:run',
  launchVerify: 'launch:verify',
  launchSessions: 'launch:sessions',

  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  // events (main -> renderer)
  eventGatewayState: 'event:gateway-state',
  eventInstallMutation: 'event:install-mutation',
  eventLaunchSession: 'event:launch-session'
} as const
