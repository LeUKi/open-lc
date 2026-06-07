import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, ExternalLink, HelpCircle, LogOut, Loader2, Lock, Plus, RotateCcw, Save, Settings, ShieldOff, Trash2 } from 'lucide-react'
import { useSetAtom } from 'jotai'
import {
  api,
  clearStoredAgentPassword,
  getStoredAgentPassword,
  messageFromError,
  setStoredAgentPassword,
  type AgentSetting,
  type AgentSettings,
  type BrokerVerifyResult,
  type DesktopRuntime,
  type RiskConsentType,
  type TempFilesCleanupResult,
  type WorkerV2VerifyResult,
} from '../api'
import { RiskConsentDialog } from '../components/RiskConsentDialog'
import { TempFileCleanupProgressModal } from '../components/TempFileCleanupProgress'
import { Button, ConfirmDialog, CopyButton, MiddleEllipsis, Modal, Panel } from '../components/ui'
import {
  defaultDownloaderForPreset,
  defaultDownloaderForType,
  parseDownloaders,
  serializeDownloaders,
  type DownloaderConfig,
  type DownloaderPreset,
  type DownloaderType,
} from '../lib/downloaders'
import { formatDateTime } from '../lib/format'
import { errorAtom, clearParseExecutionAtom, pushNotificationAtom } from '../state'
import esaWorkerSource from '../../../../scripts/esa.edge.js?raw'
import workerSource from '../../../../scripts/worker.js?raw'

type SettingsForm = Record<string, string>
type SettingsGroupKey = keyof AgentSettings['groups']
type SettingsCategoryKey = 'security' | 'broker' | 'runtime' | 'advanced' | 'maintenance'
type AdvancedSectionKey = 'baidu' | 'deployment'
type DesktopSwitchOverlay = {
  targetEnabled: boolean
  message: string
} | null
type MaintenanceConfirmTarget = 'cleanup' | 'factory-reset' | 'temp-files' | null
type MaintenanceSummaryResponse = (typeof api.api.maintenance.summary.$get.$infer)['data']
type MaintenanceSummary = MaintenanceSummaryResponse['data']
type DownloaderDraft = DownloaderConfig
type PendingRiskConsent = {
  type: RiskConsentType
  afterAccept: () => void
} | null
type WorkerHelpTab = 'quick' | 'manual' | 'esa'
type WorkerConfigVersion = 'none' | 'v1' | 'v2'
type WorkerWizardStep = 'version' | 'form' | 'verify' | 'save'
type BrokerWizardStep = 'mode' | 'form' | 'verify' | 'save'
type LinkTtlChoice = 'default' | 'fixed' | 'custom'

const downloaderPresets = ['motrix', 'motrix-next', 'tauri-motrix', 'abdm', 'aria2'] as const satisfies readonly DownloaderPreset[]

const workerDeployUrl = 'https://deploy.workers.cloudflare.com/?url=https://github.com/LeUKi/open-lc/tree/main/worker'
const workerSourceUrl = 'https://github.com/LeUKi/open-lc/blob/main/scripts/worker.js'
const esaSourceUrl = 'https://github.com/LeUKi/open-lc/blob/main/scripts/esa.edge.js'
const esaDeployUrl = 'https://esa.console.aliyun.com/edge/pages'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const desktopSwitchTimeoutMs = 15_000
const desktopSwitchPollMs = 350
const settingsRowClassName = 'grid gap-2 px-3 py-3 sm:px-4 lg:grid-cols-[minmax(150px,230px)_86px_minmax(180px,400px)_minmax(188px,auto)] lg:items-center'
const settingsInputClassName =
  'h-8 w-full min-w-0 rounded-md border border-slate-300 bg-white px-2.5 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-500'
const settingsValueCellClassName = 'w-full min-w-0 lg:max-w-[400px]'
const settingsBadgeCellClassName = 'hidden items-center lg:flex lg:justify-start'
const settingsActionCellClassName =
  'grid min-h-8 grid-cols-[repeat(auto-fit,minmax(76px,1fr))] gap-1.5 sm:flex sm:flex-wrap sm:items-center lg:flex-nowrap lg:justify-end'
const settingsActionButtonClassName = 'w-full sm:w-auto'
const settingsCardClassName = 'overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm shadow-slate-200/50'
const defaultWorkerMaxTokenTtlSeconds = 86_400
const linkTtlFixedOptions = [
  { value: 3600, label: '1 小时' },
  { value: 4 * 60 * 60, label: '4 小时' },
  { value: 6 * 60 * 60, label: '6 小时' },
  { value: 12 * 60 * 60, label: '12 小时' },
  { value: 24 * 60 * 60, label: '24 小时' },
] as const

type WorkerTtlLimit = {
  endpoint: string
  maxTokenTtlSeconds: number
}

type LinkCacheTtlRisk = {
  message: string
  description: string
}

type BrokerWizardVerifyResult = BrokerVerifyResult & {
  baseUrl?: string
  agentToken?: string
  heartbeatIntervalSeconds?: string
  pollIntervalSeconds?: string
  maxConcurrentRuns?: string
  error?: string
}

type PendingLinkTtlConfirm = {
  setting: AgentSetting
  value: string
  risk: LinkCacheTtlRisk
} | null

type PendingLinkTtlWizardConfirm = {
  value: string
  risk: LinkCacheTtlRisk
} | null

const groupMeta: Record<SettingsGroupKey, { title: string }> = {
  desktop: {
    title: '桌面端',
  },
  broker: {
    title: 'Broker 连接',
  },
  account: {
    title: '账号策略',
  },
  download: {
    title: '下载与代理',
  },
  parse: {
    title: '解析限制',
  },
  health: {
    title: '健康检查',
  },
  baidu: {
    title: 'Baidu 运行参数',
  },
  deployment: {
    title: '部署只读项',
  },
}

const categoryMeta: Array<{ key: SettingsCategoryKey; title: string }> = [
  { key: 'security', title: '访问与安全' },
  { key: 'broker', title: 'Broker 连接' },
  { key: 'runtime', title: '解析与账号' },
  { key: 'advanced', title: '下载与高级' },
  { key: 'maintenance', title: '数据维护' },
]

const sourceLabel = (source: string) => {
  if (source === 'database') return '页面'
  if (source === 'env') return '环境变量'
  return '默认值'
}

const sourceClassName = (source: string) => {
  if (source === 'database') return 'bg-blue-50 text-blue-700 ring-blue-200'
  if (source === 'env') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  return 'bg-slate-100 text-slate-600 ring-slate-200'
}

const initialFormFromSettings = (settings: AgentSettings | undefined): SettingsForm => {
  if (!settings) return {}
  const next: SettingsForm = {}
  for (const item of Object.values(settings.items)) {
    if (!item.editable) continue
    next[item.name] = item.sensitive ? '' : item.value
  }
  return next
}

const settingsCount = (settings: AgentSettings | undefined, groups: SettingsGroupKey[]) =>
  groups.reduce((count, group) => count + (settings?.groups[group]?.length ?? 0), 0)

const visibleSettings = (items: AgentSetting[]) => items.filter((item) => item.name !== 'downloadersJson')
const workerWizardSettingNames = new Set(['linkProxyBaseUrl', 'linkProxySecret', 'linkProxyV2Endpoints'])
const visibleDownloadSettings = (items: AgentSetting[]) => visibleSettings(items).filter((item) => !workerWizardSettingNames.has(item.name))
const brokerWizardSettingNames = new Set([
  'brokerBaseUrl',
  'brokerAgentToken',
  'brokerHeartbeatIntervalSeconds',
  'brokerPollIntervalSeconds',
  'brokerMaxConcurrentRuns',
])
const visibleBrokerSettings = (items: AgentSetting[]) => items.filter((item) => !brokerWizardSettingNames.has(item.name))

const normalizeWorkerConfigVersion = (value: unknown): WorkerConfigVersion => {
  if (value === 'v2') return 'v2'
  if (value === 'v1') return 'v1'
  return 'none'
}

const workerConfigVersionLabel = (value: unknown) => {
  const version = normalizeWorkerConfigVersion(value)
  if (version === 'v2') return 'v2 公钥发现'
  if (version === 'v1') return 'v1 共享密钥'
  return '无'
}

const workerConfigVersionDescription = (value: unknown) => {
  const version = normalizeWorkerConfigVersion(value)
  if (version === 'v2') return '当前使用 Worker v2 代理结果链接。'
  if (version === 'v1') return '当前使用 Worker v1 共享密钥代理结果链接。'
  return '当前不使用 Worker 代理，结果会直接返回真实下载链接。'
}

const brokerEnabledLabel = (value: unknown) => (String(value) === 'true' ? '已启用' : '未启用')

const parsePositiveInteger = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null
}

const parsePositiveWorkerVersion = (value: unknown) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

const workerRuntimeLabel = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return '未声明'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'cloudflare') return 'Cloudflare Worker'
  if (normalized === 'esa') return '阿里云 ESA'
  return value.trim()
}

const buildLinkCacheTtlRisk = (version: string, ttlSeconds: number | null, workerLimits: WorkerTtlLimit[]): LinkCacheTtlRisk | null => {
  if (version !== 'v2' || ttlSeconds === null) return null

  if (workerLimits.length > 0) {
    const exceededLimits = workerLimits.filter((item) => ttlSeconds > item.maxTokenTtlSeconds)
    if (exceededLimits.length === 0) return null
    return {
      message: `当前链接有效期 ${ttlSeconds} 秒超过已检测 Worker 上限。`,
      description: `超过 Worker MAX_TOKEN_TTL_SECONDS 后，v2 加密结果链接访问会返回 forbidden。受影响端点：${exceededLimits
        .map((item) => `${item.endpoint}（${item.maxTokenTtlSeconds} 秒）`)
        .join('；')}`,
    }
  }

  if (ttlSeconds <= defaultWorkerMaxTokenTtlSeconds) return null
  return {
    message: `当前链接有效期 ${ttlSeconds} 秒超过 Worker 默认上限 ${defaultWorkerMaxTokenTtlSeconds} 秒。`,
    description: '当前未检测到 Worker 返回 maxTokenTtlSeconds。如果 Worker 仍使用默认 MAX_TOKEN_TTL_SECONDS，v2 加密结果链接访问会返回 forbidden。',
  }
}

const ttlLabel = (seconds: number | null) => {
  if (seconds === null) return '未知'
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} 天`
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}

const linkTtlSourceLabel = (setting?: AgentSetting) => {
  const value = parsePositiveInteger(setting?.value)
  const label = ttlLabel(value)
  if (!setting) return '当前：未知'
  if (setting.source === 'database') return `当前：固定配置（${label}）`
  if (setting.source === 'env') return `当前：环境变量（${label}）`
  return `当前：默认值（${label}）`
}

const riskConsentTypeForSettingToggle = (setting: AgentSetting, nextValue: string, consents?: Record<RiskConsentType, boolean>): RiskConsentType | null => {
  if (nextValue !== 'true') return null
  if (setting.name === 'showCookieAccountAddButton' && !consents?.cookie_account) return 'cookie_account'
  if (setting.name === 'brokerEnabled' && !consents?.broker_execution) return 'broker_execution'
  return null
}

function SourceBadge({ setting }: { setting: AgentSetting }) {
  return (
    <span className={`inline-flex h-6 items-center rounded-md px-2 text-[11px] font-semibold ring-1 ${sourceClassName(setting.source)}`}>
      {sourceLabel(setting.source)}
    </span>
  )
}

function StatusBadge({ enabled, enabledLabel, disabledLabel }: { enabled: boolean; enabledLabel: string; disabledLabel: string }) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded-md px-2 text-[11px] font-semibold ring-1 ${enabled ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-slate-100 text-slate-600 ring-slate-200'}`}
    >
      {enabled ? enabledLabel : disabledLabel}
    </span>
  )
}

function SettingInput({
  setting,
  value,
  pending,
  saving,
  onChange,
}: {
  setting: AgentSetting
  value: string
  pending: boolean
  saving: boolean
  onChange: (value: string) => void
}) {
  if (setting.type === 'boolean') {
    return (
      <Button
        aria-pressed={value === 'true'}
        className="w-full sm:w-auto"
        disabled={!setting.editable || pending}
        onClick={() => onChange(String(value !== 'true'))}
        size="sm"
        type="button"
        variant={value === 'true' ? 'primary' : 'secondary'}
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : null}
        {value === 'true' ? '已开启' : '未开启'}
      </Button>
    )
  }

  if (setting.name === 'linkProxyVersion') {
    return null
  }

  if (setting.name === 'linkProxyV2Endpoints') {
    return (
      <textarea
        className={`${settingsInputClassName} min-h-24 resize-y py-2`}
        disabled={!setting.editable}
        onChange={(event) => onChange(event.target.value)}
        placeholder="https://dl-a.example.com&#10;https://dl-b.example.com"
        value={value}
      />
    )
  }

  return (
    <input
      className={settingsInputClassName}
      disabled={!setting.editable}
      max={setting.max}
      min={setting.min}
      onChange={(event) => onChange(event.target.value)}
      placeholder={setting.sensitive ? setting.displayValue : setting.envName}
      type={setting.type === 'number' ? 'number' : setting.sensitive ? 'password' : 'text'}
      value={value}
    />
  )
}

function SettingRow({
  setting,
  form,
  pending,
  savingSettingName,
  savingSettingValue,
  titleHelperForSetting,
  valueForSetting,
  helperForSetting,
  onChange,
  onReset,
  onSave,
}: {
  setting: AgentSetting
  form: SettingsForm
  pending: boolean
  savingSettingName: string | null
  savingSettingValue: string | null
  titleHelperForSetting?: (setting: AgentSetting) => ReactNode
  valueForSetting?: (setting: AgentSetting) => ReactNode
  helperForSetting?: (setting: AgentSetting) => ReactNode
  onChange: (setting: AgentSetting, value: string) => void
  onReset: (setting: AgentSetting) => void
  onSave: (setting: AgentSetting, value?: string) => void
}) {
  const titleHelper = titleHelperForSetting?.(setting)
  const customValue = valueForSetting?.(setting)
  const helper = helperForSetting?.(setting)
  return (
    <div className={settingsRowClassName}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="min-w-0 truncate text-sm font-semibold text-slate-900">{setting.label}</div>
          <span className="lg:hidden">
            <SourceBadge setting={setting} />
          </span>
          {setting.sensitive ? (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">敏感</span>
          ) : null}
          {!setting.editable ? (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">只读</span>
          ) : null}
        </div>
        {titleHelper ? <div className="mt-1">{titleHelper}</div> : null}
        <MiddleEllipsis text={setting.envName} className="mt-0.5 hidden text-[11px] text-slate-500 sm:block" copyable />
      </div>
      <div className={settingsBadgeCellClassName}>
        <SourceBadge setting={setting} />
      </div>
      <div className={settingsValueCellClassName}>
        {customValue ?? (
          <SettingInput
            setting={setting}
            pending={pending}
            saving={pending && savingSettingName === setting.name}
            value={setting.editable ? (form[setting.name] ?? '') : setting.value}
            onChange={(value) => onChange(setting, value)}
          />
        )}
        {setting.sensitive ? <div className="mt-1 text-[11px] text-slate-500">当前：{setting.displayValue}</div> : null}
        {helper}
      </div>
      <div className={settingsActionCellClassName}>
        {setting.editable && setting.type !== 'boolean' && setting.name !== 'linkCacheTtlSeconds' ? (
          <>
            {setting.name === 'linkProxyVersion' ? null : (
              <Button className={settingsActionButtonClassName} disabled={pending} onClick={() => onSave(setting)} size="sm">
                <Save className="size-4" />
                保存
              </Button>
            )}
            {setting.name === 'linkProxyVersion' ? null : (
              <Button
                className={settingsActionButtonClassName}
                disabled={pending || setting.source !== 'database'}
                onClick={() => onReset(setting)}
                size="sm"
                variant="secondary"
              >
                <RotateCcw className="size-4" />
                回退
              </Button>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

function SectionHeader({ title, count, action }: { title: string; count: number; action?: ReactNode }) {
  return (
    <div className="flex min-h-11 min-w-0 flex-col items-stretch gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="truncate text-sm font-bold text-slate-900">{title}</h3>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{count}</span>
      </div>
      {action ? <div className="min-w-0 sm:shrink-0">{action}</div> : null}
    </div>
  )
}

function SettingsSection({
  title,
  items,
  form,
  pending,
  savingSettingName,
  savingSettingValue,
  collapsed = false,
  collapsible = false,
  onChange,
  onReset,
  onSave,
  onToggle,
  titleHelperForSetting,
  valueForSetting,
  helperForSetting,
}: {
  title: string
  items: AgentSetting[]
  form: SettingsForm
  pending: boolean
  savingSettingName: string | null
  savingSettingValue: string | null
  collapsed?: boolean
  collapsible?: boolean
  onChange: (setting: AgentSetting, value: string) => void
  onReset: (setting: AgentSetting) => void
  onSave: (setting: AgentSetting, value?: string) => void
  onToggle?: () => void
  titleHelperForSetting?: (setting: AgentSetting) => ReactNode
  valueForSetting?: (setting: AgentSetting) => ReactNode
  helperForSetting?: (setting: AgentSetting) => ReactNode
}) {
  if (items.length === 0) return null

  return (
    <section className={settingsCardClassName}>
      <SectionHeader
        title={title}
        count={items.length}
        action={
          collapsible ? (
            <Button onClick={onToggle} size="sm" variant="ghost">
              {collapsed ? '展开' : '收起'}
              {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
            </Button>
          ) : null
        }
      />
      {collapsed ? null : (
        <div className="divide-y divide-slate-100">
          {items.map((setting) => (
            <SettingRow
              form={form}
              key={setting.key}
              pending={pending}
              titleHelperForSetting={titleHelperForSetting}
              valueForSetting={valueForSetting}
              helperForSetting={helperForSetting}
              savingSettingName={savingSettingName}
              savingSettingValue={savingSettingValue}
              setting={setting}
              onChange={onChange}
              onReset={onReset}
              onSave={onSave}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className={`${settingsCardClassName} flex items-center gap-2 px-3 py-5 text-sm font-semibold text-slate-600 sm:px-4`}>
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  )
}

function SettingsLoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-5 text-sm font-semibold text-slate-600 sm:px-4">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  )
}

function EmptyBlock({ label }: { label: string }) {
  return <div className={`${settingsCardClassName} px-3 py-8 text-center text-sm font-semibold text-slate-500 sm:px-4`}>{label}</div>
}

function WorkerHelpButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-blue-600 transition hover:bg-blue-50 hover:text-blue-700"
      onClick={onClick}
      aria-label="Worker 代理端点帮助"
      type="button"
    >
      <HelpCircle className="size-4" />
      这是什么？
    </button>
  )
}

const workerWizardSteps: Array<{ key: WorkerWizardStep; label: string }> = [
  { key: 'version', label: '方式' },
  { key: 'form', label: '填写' },
  { key: 'verify', label: '检测' },
  { key: 'save', label: '保存' },
]

const brokerWizardSteps: Array<{ key: BrokerWizardStep; label: string }> = [
  { key: 'mode', label: '状态' },
  { key: 'form', label: '填写' },
  { key: 'verify', label: '检测' },
  { key: 'save', label: '保存' },
]

const normalizeWorkerEndpoint = (value: string) => {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return value.trim()
  if (url.search || url.hash) return value.trim()
  return url.toString().replace(/\/+$/, '')
}

const normalizeEndpointLines = (value: string) => {
  const endpoints = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return normalizeWorkerEndpoint(item)
      } catch {
        return item
      }
    })
  return Array.from(new Set(endpoints)).join('\n')
}

function BrokerConfigWizard({
  open,
  initialForm,
  verifying,
  saving,
  verifyResult,
  error,
  onClose,
  onVerify,
  onSave,
}: {
  open: boolean
  initialForm: SettingsForm
  verifying: boolean
  saving: boolean
  verifyResult: BrokerWizardVerifyResult | null
  error: string | null
  onClose: () => void
  onVerify: (values: Record<string, string>) => Promise<void>
  onSave: (values: Record<string, string>) => Promise<void>
}) {
  const [step, setStep] = useState<BrokerWizardStep>('mode')
  const [enabled, setEnabled] = useState(true)
  const [baseUrl, setBaseUrl] = useState('')
  const [agentToken, setAgentToken] = useState('')
  const [heartbeatIntervalSeconds, setHeartbeatIntervalSeconds] = useState('30')
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState('10')
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState('2')
  const [localError, setLocalError] = useState<string | null>(null)
  const currentStepIndex = brokerWizardSteps.findIndex((item) => item.key === step)
  const pending = verifying || saving
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  const draftValues = {
    brokerEnabled: String(enabled),
    brokerBaseUrl: normalizedBaseUrl,
    brokerAgentToken: agentToken.trim(),
    brokerHeartbeatIntervalSeconds: heartbeatIntervalSeconds.trim(),
    brokerPollIntervalSeconds: pollIntervalSeconds.trim(),
    brokerMaxConcurrentRuns: maxConcurrentRuns.trim(),
  }
  const verifyMatchesCurrentInput =
    verifyResult?.ok === true &&
    verifyResult.baseUrl === draftValues.brokerBaseUrl &&
    verifyResult.agentToken === draftValues.brokerAgentToken &&
    verifyResult.heartbeatIntervalSeconds === draftValues.brokerHeartbeatIntervalSeconds &&
    verifyResult.pollIntervalSeconds === draftValues.brokerPollIntervalSeconds &&
    verifyResult.maxConcurrentRuns === draftValues.brokerMaxConcurrentRuns

  useEffect(() => {
    if (!open) return
    setStep('mode')
    setEnabled(String(initialForm.brokerEnabled) === 'true')
    setBaseUrl(initialForm.brokerBaseUrl ?? '')
    setAgentToken('')
    setHeartbeatIntervalSeconds(initialForm.brokerHeartbeatIntervalSeconds || '30')
    setPollIntervalSeconds(initialForm.brokerPollIntervalSeconds || '10')
    setMaxConcurrentRuns(initialForm.brokerMaxConcurrentRuns || '2')
    setLocalError(null)
  }, [initialForm, open])

  const validateForm = () => {
    if (!draftValues.brokerBaseUrl) return '请填写 Broker Base URL'
    if (!draftValues.brokerAgentToken) return '请填写 Agent Token'
    if (!draftValues.brokerHeartbeatIntervalSeconds) return '请填写 Heartbeat 间隔秒数'
    if (!draftValues.brokerPollIntervalSeconds) return '请填写任务轮询间隔秒数'
    if (!draftValues.brokerMaxConcurrentRuns) return '请填写最大并发 Runs'
    return null
  }

  const goNext = () => {
    setLocalError(null)
    if (step === 'mode') {
      if (!enabled) {
        setStep('save')
        return
      }
      setStep('form')
      return
    }
    if (step === 'form') {
      const message = validateForm()
      if (message) {
        setLocalError(message)
        return
      }
      setStep('verify')
      return
    }
    if (step === 'verify') {
      if (!verifyMatchesCurrentInput) {
        setLocalError('请先完成 Broker 连接检测')
        return
      }
      setStep('save')
    }
  }

  const goBack = () => {
    setLocalError(null)
    if (step === 'save') setStep(enabled ? 'verify' : 'mode')
    else if (step === 'verify') setStep('form')
    else if (step === 'form') setStep('mode')
  }

  const verify = async () => {
    setLocalError(null)
    const message = validateForm()
    if (message) {
      setLocalError(message)
      return
    }
    await onVerify(draftValues)
  }

  const save = async () => {
    setLocalError(null)
    if (!enabled) {
      await onSave({ brokerEnabled: 'false' })
      return
    }
    if (!verifyMatchesCurrentInput) {
      setLocalError('请先完成 Broker 连接检测')
      return
    }
    await onSave(draftValues)
  }

  const alert = localError || error

  return (
    <Modal open={open} title="Broker 配置向导" onClose={onClose} maxWidthClassName="max-w-3xl">
      <div className="grid gap-5">
        <div className="grid grid-cols-4 items-start gap-1.5">
          {brokerWizardSteps.map((item, index) => {
            const active = item.key === step
            const done = index < currentStepIndex
            return (
              <div className="relative grid min-w-0 justify-items-center gap-1.5 text-center" key={item.key}>
                {index > 0 ? <div className={`absolute right-1/2 top-3 h-px w-full ${done || active ? 'bg-emerald-200' : 'bg-slate-200'}`} /> : null}
                <div
                  className={`relative z-10 flex size-6 items-center justify-center rounded-full text-xs font-bold ring-1 ${active ? 'bg-blue-600 text-white ring-blue-600' : done ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-white text-slate-400 ring-slate-200'}`}
                >
                  {index + 1}
                </div>
                <div className={`truncate text-xs font-semibold ${active ? 'text-blue-700' : done ? 'text-emerald-700' : 'text-slate-400'}`}>{item.label}</div>
              </div>
            )
          })}
        </div>

        {alert ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{alert}</div> : null}

        {step === 'mode' ? (
          <div className="grid gap-3 md:grid-cols-2">
            <button
              className={`rounded-lg border p-4 text-left transition ${enabled ? 'border-blue-300 bg-blue-50 text-blue-900 ring-2 ring-blue-100' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
              onClick={() => setEnabled(true)}
              type="button"
            >
              <div className="text-base font-bold">启用 Broker 执行</div>
              <div className="mt-2 text-sm leading-6">本地 Agent 会向 Broker 上报能力、报名任务并执行解析。</div>
            </button>
            <button
              className={`rounded-lg border p-4 text-left transition ${!enabled ? 'border-blue-300 bg-blue-50 text-blue-900 ring-2 ring-blue-100' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
              onClick={() => setEnabled(false)}
              type="button"
            >
              <div className="text-base font-bold">关闭 Broker 执行</div>
              <div className="mt-2 text-sm leading-6">停止参与 Broker 任务，但保留已填写的 URL、Token 和轮询参数。</div>
            </button>
          </div>
        ) : null}

        {step === 'form' ? (
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
              Broker Base URL
              <input
                className={settingsInputClassName}
                disabled={pending}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://broker.example.com"
                value={baseUrl}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
              Agent Token
              <input
                className={settingsInputClassName}
                disabled={pending}
                onChange={(event) => setAgentToken(event.target.value)}
                placeholder="从 Broker 后台 Agent 页面复制"
                type="password"
                value={agentToken}
              />
              <span className="text-xs font-medium leading-5 text-slate-500">Agent Token 不会回显；启用或修改 Broker 连接时需要重新填写。</span>
            </label>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
                Heartbeat 间隔秒数
                <input
                  className={settingsInputClassName}
                  disabled={pending}
                  min={5}
                  max={3600}
                  onChange={(event) => setHeartbeatIntervalSeconds(event.target.value)}
                  type="number"
                  value={heartbeatIntervalSeconds}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
                Poll 间隔秒数
                <input
                  className={settingsInputClassName}
                  disabled={pending}
                  min={3}
                  max={3600}
                  onChange={(event) => setPollIntervalSeconds(event.target.value)}
                  type="number"
                  value={pollIntervalSeconds}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
                最大并发 Runs
                <input
                  className={settingsInputClassName}
                  disabled={pending}
                  min={1}
                  max={5}
                  onChange={(event) => setMaxConcurrentRuns(event.target.value)}
                  type="number"
                  value={maxConcurrentRuns}
                />
              </label>
            </div>
          </div>
        ) : null}

        {step === 'verify' ? (
          <div className="grid gap-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
              点击检测后，本地 Agent 会使用当前草稿配置向 Broker 发送一次 heartbeat。检测只验证连接，不会保存配置或启动执行。
            </div>
            <Button disabled={pending} onClick={verify} type="button" variant="secondary">
              {verifying ? <Loader2 className="size-4 animate-spin" /> : null}
              检测 Broker 连接
            </Button>
            {verifyResult ? (
              verifyResult.ok && verifyMatchesCurrentInput ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
                  检测通过：Broker 返回 {verifyResult.status === 'too_early' ? 'too_early，连接和 Token 有效' : 'ok'}。
                </div>
              ) : verifyResult.ok ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-700">
                  配置内容已修改，请重新检测。
                </div>
              ) : (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
                  检测失败：{verifyResult.error ?? 'Broker 连接检测失败'}
                </div>
              )
            ) : null}
          </div>
        ) : null}

        {step === 'save' ? (
          <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <div className="font-bold text-slate-900">即将保存</div>
            <div>Broker 执行：{enabled ? '启用' : '关闭'}</div>
            {enabled ? (
              <>
                <div className="break-all">Broker Base URL：{draftValues.brokerBaseUrl}</div>
                <div>
                  Heartbeat / Poll：{draftValues.brokerHeartbeatIntervalSeconds}s / {draftValues.brokerPollIntervalSeconds}s
                </div>
                <div>最大并发 Runs：{draftValues.brokerMaxConcurrentRuns}</div>
              </>
            ) : (
              <div>将保留当前 Broker URL、Token 和轮询参数，之后可通过向导重新启用。</div>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
          <Button disabled={pending} onClick={onClose} type="button" variant="secondary">
            取消
          </Button>
          {step !== 'mode' ? (
            <Button disabled={pending} onClick={goBack} type="button" variant="secondary">
              上一步
            </Button>
          ) : null}
          {step === 'save' ? (
            <Button disabled={pending} onClick={save} type="button">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存配置
            </Button>
          ) : (
            <Button disabled={pending} onClick={goNext} type="button">
              下一步
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function WorkerConfigWizard({
  open,
  initialForm,
  preferredVersion,
  verifying,
  saving,
  verifyResult,
  error,
  onClose,
  onOpenHelp,
  onVerifyV2,
  onSave,
}: {
  open: boolean
  initialForm: SettingsForm
  preferredVersion?: WorkerConfigVersion | null
  verifying: boolean
  saving: boolean
  verifyResult: WorkerV2VerifyResult | null
  error: string | null
  onClose: () => void
  onOpenHelp: () => void
  onVerifyV2: (endpoints: string) => Promise<void>
  onSave: (values: Record<string, string>) => Promise<void>
}) {
  const [step, setStep] = useState<WorkerWizardStep>('version')
  const [version, setVersion] = useState<WorkerConfigVersion>('v2')
  const [baseUrl, setBaseUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [v2Endpoints, setV2Endpoints] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const currentStepIndex = workerWizardSteps.findIndex((item) => item.key === step)
  const pending = verifying || saving
  const normalizedV2Endpoints = normalizeEndpointLines(v2Endpoints)
  const verifyMatchesCurrentInput = verifyResult?.endpoints.join('\n') === normalizedV2Endpoints
  const v2Verified = version === 'v2' && verifyResult?.ok === true && verifyMatchesCurrentInput

  useEffect(() => {
    if (!open) return
    const currentVersion = normalizeWorkerConfigVersion(initialForm.linkProxyVersion)
    setStep('version')
    setVersion(preferredVersion ?? currentVersion)
    setBaseUrl(initialForm.linkProxyBaseUrl ?? '')
    setSecret('')
    setV2Endpoints(initialForm.linkProxyV2Endpoints ?? '')
    setLocalError(null)
  }, [initialForm, open, preferredVersion])

  const goNext = () => {
    setLocalError(null)
    if (step === 'version') {
      if (version === 'none') {
        setStep('save')
        return
      }
      setStep('form')
      return
    }
    if (step === 'form') {
      if (version === 'v2' && !normalizedV2Endpoints) {
        setLocalError('请至少填写一个 Worker v2 代理端点')
        return
      }
      if (version === 'v1' && !baseUrl.trim()) {
        setLocalError('请填写 Worker 代理端点')
        return
      }
      if (version === 'v1' && !secret.trim()) {
        setLocalError('请填写 Worker 加密密钥')
        return
      }
      if (version === 'v1' && secret.trim() === 'changeme') {
        setLocalError('Worker 加密密钥不能使用示例值 changeme，请换成自己的密钥。')
        return
      }
      setStep('verify')
      return
    }
    if (step === 'verify') {
      if (version === 'v2' && !v2Verified) {
        setLocalError('请先完成 v2 端点检测')
        return
      }
      setStep('save')
    }
  }

  const goBack = () => {
    setLocalError(null)
    if (step === 'save') setStep(version === 'none' ? 'version' : 'verify')
    else if (step === 'verify') setStep('form')
    else if (step === 'form') setStep('version')
  }

  const verify = async () => {
    setLocalError(null)
    if (version !== 'v2') return
    if (!normalizedV2Endpoints) {
      setLocalError('请至少填写一个 Worker v2 代理端点')
      return
    }
    await onVerifyV2(normalizedV2Endpoints)
  }

  const save = async () => {
    setLocalError(null)
    if (version === 'none') {
      await onSave({
        linkProxyVersion: 'none',
      })
      return
    }
    if (version === 'v2') {
      if (!v2Verified) {
        setLocalError('请先完成 v2 端点检测')
        return
      }
      await onSave({
        linkProxyVersion: 'v2',
        linkProxyV2Endpoints: normalizedV2Endpoints,
      })
      return
    }
    await onSave({
      linkProxyVersion: 'v1',
      linkProxyBaseUrl: baseUrl.trim(),
      linkProxySecret: secret,
    })
  }

  const alert = localError || error

  return (
    <Modal open={open} title="Worker 配置向导" onClose={onClose} maxWidthClassName="max-w-3xl">
      <div className="grid gap-5">
        <div className="grid grid-cols-4 items-start gap-1.5">
          {workerWizardSteps.map((item, index) => {
            const active = item.key === step
            const done = index < currentStepIndex
            return (
              <div className="relative grid min-w-0 justify-items-center gap-1.5 text-center" key={item.key}>
                {index > 0 ? <div className={`absolute right-1/2 top-3 h-px w-full ${done || active ? 'bg-emerald-200' : 'bg-slate-200'}`} /> : null}
                <div
                  className={`relative z-10 flex size-6 items-center justify-center rounded-full text-xs font-bold ring-1 ${active ? 'bg-blue-600 text-white ring-blue-600' : done ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-white text-slate-400 ring-slate-200'}`}
                >
                  {index + 1}
                </div>
                <div className={`truncate text-xs font-semibold ${active ? 'text-blue-700' : done ? 'text-emerald-700' : 'text-slate-400'}`}>{item.label}</div>
              </div>
            )
          })}
        </div>

        {alert ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{alert}</div> : null}

        {step === 'version' ? (
          <div className="grid gap-3 md:grid-cols-3">
            <button
              className={`rounded-lg border p-4 text-left transition ${version === 'none' ? 'border-blue-300 bg-blue-50 text-blue-900 ring-2 ring-blue-100' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
              onClick={() => setVersion('none')}
              type="button"
            >
              <div className="text-base font-bold">无</div>
              <div className="mt-2 text-sm leading-6">不使用 Worker 代理。结果会直接返回真实下载链接，配置最简单，但不会隐藏真实直链。</div>
            </button>
            <button
              className={`rounded-lg border p-4 text-left transition ${version === 'v2' ? 'border-blue-300 bg-blue-50 text-blue-900 ring-2 ring-blue-100' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
              onClick={() => setVersion('v2')}
              type="button"
            >
              <div className="text-base font-bold">v2 公钥发现</div>
              <div className="mt-2 text-sm leading-6">推荐新配置使用。Agent 只保存 Worker 代理端点，通过 /lc/v2.auto 获取公钥，支持多个端点按顺序回退。</div>
            </button>
            <button
              className={`rounded-lg border p-4 text-left transition ${version === 'v1' ? 'border-blue-300 bg-blue-50 text-blue-900 ring-2 ring-blue-100' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
              onClick={() => setVersion('v1')}
              type="button"
            >
              <div className="text-base font-bold">v1 共享密钥</div>
              <div className="mt-2 text-sm leading-6">兼容旧配置。Agent 和 Worker 都需要填写同一个 URL_ENCRYPTION_KEY。</div>
            </button>
          </div>
        ) : null}

        {step === 'form' ? (
          <div className="grid gap-4">
            {version === 'none' ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
                选择“无”后不需要填写 Worker 端点或密钥。已有 v1/v2 配置会保留，之后可通过向导重新启用。
              </div>
            ) : version === 'v2' ? (
              <div className="grid gap-1.5 text-sm font-semibold text-slate-700">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span>Worker v2 代理端点</span>
                  <button
                    className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-blue-600 transition hover:bg-blue-50 hover:text-blue-700"
                    onClick={onOpenHelp}
                    type="button"
                  >
                    <HelpCircle className="size-4" />
                    Worker 代理端点帮助
                  </button>
                </div>
                <textarea
                  aria-label="Worker v2 代理端点"
                  className={`${settingsInputClassName} min-h-32 resize-y py-2`}
                  disabled={pending}
                  onChange={(event) => setV2Endpoints(event.target.value)}
                  placeholder="https://dl-a.example.com&#10;https://dl-b.example.com"
                  value={v2Endpoints}
                />
                <p className="text-xs font-medium leading-5 text-slate-500">一行一个端点。</p>
              </div>
            ) : (
              <>
                <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
                  Worker 代理端点
                  <input
                    className={settingsInputClassName}
                    disabled={pending}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://dl.example.com"
                    value={baseUrl}
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
                  Worker 加密密钥
                  <input
                    className={settingsInputClassName}
                    disabled={pending}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder="与 Worker 的 URL_ENCRYPTION_KEY 一致"
                    type="password"
                    value={secret}
                  />
                </label>
              </>
            )}
          </div>
        ) : null}

        {step === 'verify' ? (
          <div className="grid gap-4">
            {version === 'none' ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
                无代理模式无需检测。保存后 Agent 会直接返回真实下载链接。
              </div>
            ) : version === 'v2' ? (
              <>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
                  点击检测后，本地 Agent 会请求每个端点的 <span className="font-mono text-xs">/lc/v2.auto</span>，确认版本、kid 和 publicKey 可用。
                </div>
                <Button disabled={pending || !normalizedV2Endpoints} onClick={verify} type="button" variant="secondary">
                  {verifying ? <Loader2 className="size-4 animate-spin" /> : null}
                  检测 v2 端点
                </Button>
                {verifyResult && verifyMatchesCurrentInput ? (
                  <div className="grid gap-2">
                    {verifyResult.results.map((item) => (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" key={item.endpoint}>
                        <div className="font-bold break-all">{item.endpoint}</div>
                        <div className="mt-1 grid gap-1 text-xs font-semibold">
                          <div>Worker 类型：{workerRuntimeLabel(item.workerRuntime)}</div>
                          <div>Worker Discovery 版本：{parsePositiveWorkerVersion(item.workerVersion) ?? '未声明'}</div>
                          <div>kid: {item.kid}</div>
                          <div>publicKey: {item.publicKeyPreview}</div>
                          <div>fingerprint: {item.publicKeyFingerprint}</div>
                          <div className="break-all">tokenPrefix: {item.tokenPrefix}</div>
                          <div>
                            最大链接有效期：
                            {parsePositiveInteger(item.maxTokenTtlSeconds)
                              ? `${parsePositiveInteger(item.maxTokenTtlSeconds)} 秒`
                              : `未声明，按 Worker 默认上限 ${defaultWorkerMaxTokenTtlSeconds} 秒判断`}
                          </div>
                        </div>
                      </div>
                    ))}
                    {verifyResult.failures.map((item) => (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" key={item.endpoint}>
                        <div className="font-bold break-all">{item.endpoint}</div>
                        <div className="mt-1 text-xs font-semibold">{item.message}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {verifyResult && !verifyMatchesCurrentInput ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-700">
                    端点内容已修改，请重新检测。
                  </div>
                ) : null}
              </>
            ) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
                v1 不做强检测。请确认 Worker 代理端点已部署，且 Agent 填写的密钥与 Worker 的 URL_ENCRYPTION_KEY 一致。
              </div>
            )}
          </div>
        ) : null}

        {step === 'save' ? (
          <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <div className="font-bold text-slate-900">即将保存</div>
            <div>加密方式：{workerConfigVersionLabel(version)}</div>
            {version === 'none' ? (
              <div>将不使用 Worker 代理，结果链接会直接暴露真实下载地址。</div>
            ) : version === 'v2' ? (
              <div className="whitespace-pre-wrap break-all">Worker v2 代理端点：{normalizedV2Endpoints}</div>
            ) : (
              <div className="break-all">Worker 代理端点：{baseUrl.trim()}</div>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
          <Button disabled={pending} onClick={onClose} type="button" variant="secondary">
            取消
          </Button>
          {step !== 'version' ? (
            <Button disabled={pending} onClick={goBack} type="button" variant="secondary">
              上一步
            </Button>
          ) : null}
          {step === 'save' ? (
            <Button disabled={pending} onClick={save} type="button">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存配置
            </Button>
          ) : (
            <Button disabled={pending} onClick={goNext} type="button">
              下一步
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function LinkTtlConfigWizard({
  open,
  setting,
  activeLinkProxyVersion,
  workerTtlLimits,
  saving,
  onClose,
  onSave,
}: {
  open: boolean
  setting?: AgentSetting
  activeLinkProxyVersion: WorkerConfigVersion
  workerTtlLimits: WorkerTtlLimit[]
  saving: boolean
  onClose: () => void
  onSave: (value: string) => Promise<void>
}) {
  const effectiveSeconds = parsePositiveInteger(setting?.value) ?? 6 * 60 * 60
  const currentFixedOption = linkTtlFixedOptions.find((item) => String(item.value) === setting?.value)
  const [choice, setChoice] = useState<LinkTtlChoice>('default')
  const [fixedSeconds, setFixedSeconds] = useState(6 * 60 * 60)
  const [customSeconds, setCustomSeconds] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (setting?.source === 'database' && currentFixedOption) {
      setChoice('fixed')
      setFixedSeconds(currentFixedOption.value)
      setCustomSeconds('')
    } else if (setting?.source === 'database' && setting.value) {
      setChoice('custom')
      setFixedSeconds(6 * 60 * 60)
      setCustomSeconds(setting.value)
    } else {
      setChoice('default')
      setFixedSeconds(6 * 60 * 60)
      setCustomSeconds('')
    }
    setLocalError(null)
  }, [currentFixedOption, open, setting?.source, setting?.value])

  const selectedValue = choice === 'default' ? '' : choice === 'fixed' ? String(fixedSeconds) : customSeconds.trim()
  const selectedSeconds = choice === 'default' ? effectiveSeconds : parsePositiveInteger(selectedValue)
  const risk = buildLinkCacheTtlRisk(activeLinkProxyVersion, selectedSeconds, workerTtlLimits)
  const blocksSave = Boolean(risk && workerTtlLimits.length > 0)

  const save = async () => {
    setLocalError(null)
    if (choice === 'custom') {
      if (selectedSeconds === null) {
        setLocalError('自定义有效期必须是正整数秒数')
        return
      }
      if (selectedSeconds < 60) {
        setLocalError('自定义有效期不能小于 60 秒')
        return
      }
    }
    if (blocksSave) return
    await onSave(selectedValue)
  }

  return (
    <Modal open={open} title="链接有效期配置向导" onClose={onClose} maxWidthClassName="max-w-2xl">
      <div className="grid gap-5">
        {localError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{localError}</div> : null}
        <div className="grid gap-3">
          <button
            className={`rounded-lg border p-4 text-left transition ${choice === 'default' ? 'border-blue-300 bg-blue-50 text-blue-900 ring-2 ring-blue-100' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
            onClick={() => setChoice('default')}
            type="button"
          >
            <div className="text-base font-bold">使用默认值（当前 {ttlLabel(effectiveSeconds)}）</div>
          </button>

          <div className={`rounded-lg border p-4 ${choice === 'fixed' ? 'border-blue-300 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button className="text-left text-base font-bold text-slate-900" onClick={() => setChoice('fixed')} type="button">
                固定时长
              </button>
              <div className="text-xs font-semibold text-slate-500">不会随默认值变化</div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {linkTtlFixedOptions.map((option) => (
                <button
                  className={`h-9 rounded-md px-2 text-sm font-semibold ring-1 transition ${choice === 'fixed' && fixedSeconds === option.value ? 'bg-blue-600 text-white ring-blue-600' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'}`}
                  key={option.value}
                  onClick={() => {
                    setChoice('fixed')
                    setFixedSeconds(option.value)
                  }}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <label
            className={`grid gap-2 rounded-lg border p-4 ${choice === 'custom' ? 'border-blue-300 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-200 bg-white'}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-base font-bold text-slate-900">自定义秒数</span>
              <span className="text-xs font-semibold text-slate-500">固定配置</span>
            </div>
            <input
              className={settingsInputClassName}
              min={60}
              onChange={(event) => {
                setChoice('custom')
                setCustomSeconds(event.target.value)
              }}
              placeholder="21600"
              type="number"
              value={customSeconds}
            />
          </label>
        </div>

        <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
          <div className="font-bold text-slate-900">即将生效</div>
          <div>生效值：{ttlLabel(selectedSeconds)}</div>
          <div>该值决定 Agent 生成结果链接的默认有效期、转存文件清理保护时间，并会作为 Broker 接单能力上报。</div>
          <div>Broker 任务自己的最短要求由请求者创建任务时选择。</div>
          <div>环境变量 LINK_CACHE_TTL_SECONDS 会优先于代码默认值；固定时长不会随默认值变化。</div>
        </div>

        {risk ? (
          <div
            className={`rounded-md border px-3 py-2 text-sm ${blocksSave ? 'border-red-200 bg-red-50 font-semibold text-red-700' : 'border-amber-200 bg-amber-50 font-semibold text-amber-800'}`}
          >
            <div>{risk.message}</div>
            <div className="mt-1 font-medium">{risk.description}</div>
            {blocksSave ? <div className="mt-1">请调低有效期，或先提高 Worker MAX_TOKEN_TTL_SECONDS 后重新检测端点。</div> : null}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
          <Button disabled={saving} onClick={onClose} type="button" variant="secondary">
            取消
          </Button>
          <Button disabled={saving || blocksSave} onClick={save} type="button">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存配置
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function WorkerHelpModal({
  open,
  activeTab,
  onTabChange,
  onClose,
}: {
  open: boolean
  activeTab: WorkerHelpTab
  onTabChange: (tab: WorkerHelpTab) => void
  onClose: () => void
}) {
  const tabs: Array<{ key: WorkerHelpTab; label: string }> = [
    { key: 'quick', label: 'Cloudflare 一键' },
    { key: 'manual', label: 'Cloudflare 手动' },
    { key: 'esa', label: '阿里云 ESA' },
  ]
  const current = tabs.some((tab) => tab.key === activeTab) ? activeTab : 'quick'

  return (
    <Modal open={open} title="Worker 代理端点帮助" onClose={onClose} maxWidthClassName="max-w-5xl">
      <div className="grid gap-5">
        <div className="grid gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-4 text-sm leading-6 text-blue-900">
          <p className="font-semibold">解析出的下载链接可能包含私密令牌。直接暴露真实链接，等同于交出资源访问权，可能带来不必要的损失。</p>
          <p>Worker 代理端点用于接收加密后的链接，再由 Worker 解密并代理真实下载链接。这样外部只会看到代理地址，不会直接看到原始直链。</p>
        </div>
        <div className="grid gap-3 text-sm text-slate-700 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="font-bold text-slate-900">Worker 代理端点</div>
            <div className="mt-1 leading-6">填写部署后的 Worker 公开地址，用于生成代理下载入口。</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="font-bold text-slate-900">代理模式</div>
            <div className="mt-1 leading-6">可选择无代理、v2 公钥发现或 v1 共享密钥。推荐需要隐藏真实直链时使用 v2；无代理会直接返回真实下载链接。</div>
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2">
            <div className="flex flex-wrap gap-1 rounded-lg bg-slate-200/70 p-1">
              {tabs.map((tab) => (
                <button
                  className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${current === tab.key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                  key={tab.key}
                  onClick={() => onTabChange(tab.key)}
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 px-4 py-4 text-sm leading-6 text-slate-700">
            {current === 'quick' && (
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <div className="font-bold text-slate-900">一键部署到 Cloudflare</div>
                  <div className="mt-1">
                    点击按钮后按 Cloudflare 页面提示完成授权和部署。部署完成后，在 Worker 的变量与密钥里添加 Secret：
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">URL_ENCRYPTION_KEY</code>。
                  </div>
                </div>
                <a
                  className="inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
                  href={workerDeployUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="size-4" />
                  一键部署
                </a>
              </div>
            )}
            {current === 'manual' && (
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-bold text-slate-900">手动部署到 Cloudflare Dashboard</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-100 hover:bg-blue-50"
                      href={workerSourceUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink className="size-3.5" />
                      worker.js
                    </a>
                    <CopyButton value={workerSource} label="复制脚本" copiedLabel="已复制" size="sm" />
                  </div>
                </div>
                <ol className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  <li>1. 打开 Cloudflare Dashboard，进入 Workers & Pages。</li>
                  <li>2. 创建 Worker，进入编辑器。</li>
                  <li>3. 打开上方的 worker.js 或点击复制脚本，将内容粘贴到 Worker 编辑器并部署。</li>
                  <li>4. 在 Settings - Variables and Secrets 中添加 Secret：URL_ENCRYPTION_KEY。</li>
                  <li>5. 确认 Variables 中的 MAX_TOKEN_TTL_SECONDS 不小于 Agent 的链接有效期秒数；Worker 默认上限为 86400 秒。</li>
                  <li>6. 回到 Agent，填写部署后的 Worker 地址。</li>
                </ol>
              </div>
            )}
            {current === 'esa' && (
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-bold text-slate-900">部署到阿里云 ESA</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-100 hover:bg-blue-50"
                      href={esaDeployUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink className="size-3.5" />
                      ESA 控制台
                    </a>
                    <a
                      className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-semibold text-blue-700 ring-1 ring-blue-100 hover:bg-blue-50"
                      href={esaSourceUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink className="size-3.5" />
                      esa.edge.js
                    </a>
                    <CopyButton value={esaWorkerSource} label="复制脚本" copiedLabel="已复制" size="sm" />
                  </div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  ESA 对国内访问更友好，适合需要降低跨境访问波动的场景。
                </div>
                <ol className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  <li>1. 打开 ESA Edge Pages 控制台，创建边缘函数。</li>
                  <li>2. 打开上方的 esa.edge.js 或点击复制脚本，将内容粘贴到编辑器。</li>
                  <li>3. 在脚本顶部 CONFIG.URL_ENCRYPTION_KEY 改成高强度随机字符串。</li>
                  <li>4. 确认 CONFIG.MAX_TOKEN_TTL_SECONDS 不小于 Agent 的链接有效期秒数；Worker 默认上限为 86400 秒。</li>
                  <li>5. ALLOWED_HOSTS 默认是 *，通常无需修改。</li>
                  <li>6. 部署后回到 Agent，填写 ESA 公开访问地址。</li>
                </ol>
              </div>
            )}
            <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="font-bold text-slate-900">密钥与加密方式</div>
              <div>
                Cloudflare 需要设置 Secret：<code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs text-slate-800">URL_ENCRYPTION_KEY</code>；ESA
                需要修改脚本顶部的 <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs text-slate-800">CONFIG.URL_ENCRYPTION_KEY</code>。
              </div>
              <div>选择“无”时不使用 Worker 代理，Agent 会直接返回真实下载链接；使用 v2 时，Agent 只填 Worker 地址；使用 v1 时，Agent 还要填写同一个密钥。</div>
              <div>Agent 的链接有效期秒数会写入 v2 加密链接 exp，不能超过 Worker 的 MAX_TOKEN_TTL_SECONDS，否则代理访问会返回 forbidden。</div>
              <div>ALLOWED_HOSTS 默认是 *，通常无需配置；如需限制上游域名，可填写逗号分隔的 host。</div>
              <div className="rounded-md bg-white px-3 py-2 font-mono text-xs leading-5 text-slate-600 ring-1 ring-slate-200">
                Cloudflare: Workers & Pages -&gt; 选择 Worker -&gt; Settings -&gt; Variables and Secrets -&gt; Add -&gt; Secret
              </div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
              v2 验证：访问 <span className="font-mono text-xs">https://your-worker.example.com/lc/v2.auto</span>，应返回{' '}
              <span className="font-mono text-xs">version: "v2"</span>、<span className="font-mono text-xs">kid: "x1"</span> 和{' '}
              <span className="font-mono text-xs">publicKey</span>。新版本还会返回 <span className="font-mono text-xs">workerRuntime</span>、{' '}
              <span className="font-mono text-xs">workerVersion</span> 和 <span className="font-mono text-xs">maxTokenTtlSeconds</span>，用于排查端点类型和提示
              Agent 链接有效期上限。
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function PasswordAccessSection({
  passwordEnabled,
  loading,
  password,
  pending,
  onPasswordChange,
  onSubmit,
  onLogout,
  onDisable,
}: {
  passwordEnabled: boolean
  loading: boolean
  password: string
  pending: boolean
  onPasswordChange: (password: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onLogout: () => void
  onDisable: () => void
}) {
  return (
    <section className={settingsCardClassName}>
      <SectionHeader title="访问密码" count={1} />
      {loading ? (
        <SettingsLoadingRow label="正在读取访问设置" />
      ) : (
        <form onSubmit={onSubmit}>
          <div className={settingsRowClassName}>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <div className="min-w-0 truncate text-sm font-semibold text-slate-900">页面访问</div>
                <span className="lg:hidden">
                  <StatusBadge enabled={passwordEnabled} enabledLabel="保护中" disabledLabel="开放" />
                </span>
              </div>
            </div>
            <div className={settingsBadgeCellClassName}>
              <StatusBadge enabled={passwordEnabled} enabledLabel="保护中" disabledLabel="开放" />
            </div>
            <div className={settingsValueCellClassName}>
              <input
                className={settingsInputClassName}
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                placeholder={passwordEnabled ? '输入新密码' : '输入密码'}
                type="password"
              />
            </div>
            <div className={settingsActionCellClassName}>
              <Button className={settingsActionButtonClassName} disabled={pending || !password.trim()} size="sm" type="submit">
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
                {passwordEnabled ? '更新' : '开启'}
              </Button>
              {passwordEnabled ? (
                <>
                  <Button className={settingsActionButtonClassName} disabled={pending} onClick={onLogout} size="sm" variant="secondary">
                    <LogOut className="size-4" />
                    退出
                  </Button>
                  <Button className={settingsActionButtonClassName} disabled={pending} onClick={onDisable} size="sm" variant="secondary">
                    <ShieldOff className="size-4" />
                    关闭
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </form>
      )}
    </section>
  )
}

function DesktopAccessSection({
  runtime,
  pending,
  opening,
  onToggle,
  onOpenBrowser,
}: {
  runtime: DesktopRuntime
  pending: boolean
  opening: boolean
  onToggle: (enabled: boolean) => void
  onOpenBrowser: () => void
}) {
  const enabled = runtime.externalAccessEnabled

  return (
    <section className={settingsCardClassName}>
      <SectionHeader title="桌面访问" count={1} />
      <div className={settingsRowClassName}>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <div className="min-w-0 truncate text-sm font-semibold text-slate-900">外部访问</div>
            <span className="lg:hidden">
              <StatusBadge enabled={enabled} enabledLabel="外部" disabledLabel="本机" />
            </span>
            {runtime.restartPending ? (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">切换中</span>
            ) : null}
          </div>
        </div>
        <div className={settingsBadgeCellClassName}>
          <StatusBadge enabled={enabled} enabledLabel="外部" disabledLabel="本机" />
        </div>
        <div className={`${settingsValueCellClassName} flex min-h-8 items-center`}>
          <Button
            className="w-full sm:w-auto"
            disabled={pending || runtime.restartPending}
            onClick={() => onToggle(!enabled)}
            size="sm"
            variant={enabled ? 'secondary' : 'primary'}
          >
            {pending || runtime.restartPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {enabled ? '关闭外部访问' : '开启外部访问'}
          </Button>
        </div>
        <div className={settingsActionCellClassName}>
          <Button
            className={settingsActionButtonClassName}
            disabled={pending || opening || runtime.restartPending || (!runtime.primaryExternalUrl && !runtime.localUrl)}
            onClick={onOpenBrowser}
            size="sm"
            variant="secondary"
          >
            {opening ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
            打开浏览器
          </Button>
        </div>
      </div>
    </section>
  )
}

function DesktopSwitchLoading({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 px-4 text-slate-900">
      <div className="flex w-full max-w-xs items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-xl shadow-slate-900/20">
        <Loader2 className="size-5 shrink-0 animate-spin text-blue-600" />
        <div className="min-w-0 text-sm font-semibold text-slate-800">{message}</div>
      </div>
    </div>
  )
}

function DownloadersSection({
  downloaders,
  pending,
  onChange,
  onSave,
}: {
  downloaders: DownloaderDraft[]
  pending: boolean
  onChange: (downloaders: DownloaderDraft[]) => void
  onSave: () => void
}) {
  const isBuiltInDefaultName = (type: DownloaderType, value: string) =>
    downloaderPresets.some((preset) => {
      const config = defaultDownloaderForPreset(preset)
      return config.type === type && config.name === value
    })
  const isBuiltInDefaultRpcUrl = (type: DownloaderType, value: string) =>
    downloaderPresets.some((preset) => {
      const config = defaultDownloaderForPreset(preset)
      return config.type === type && config.rpcUrl === value
    })
  const addDownloader = (preset: DownloaderPreset) => {
    const next = defaultDownloaderForPreset(preset)
    onChange([
      ...downloaders.map((item) => ({ ...item, isDefault: downloaders.length === 0 ? false : item.isDefault })),
      { ...next, isDefault: downloaders.length === 0 },
    ])
  }
  const updateDownloader = (id: string, patch: Partial<DownloaderDraft>) => {
    onChange(
      downloaders.map((item) => {
        if (item.id !== id) return item
        const updated = { ...item, ...patch }
        if (patch.type && patch.type !== item.type) {
          const fallback = defaultDownloaderForType(patch.type)
          updated.rpcUrl = isBuiltInDefaultRpcUrl(item.type, item.rpcUrl) ? fallback.rpcUrl : item.rpcUrl
          updated.name = isBuiltInDefaultName(item.type, item.name) ? fallback.name : item.name
        }
        return updated
      }),
    )
  }
  const removeDownloader = (id: string) => {
    const next = downloaders.filter((item) => item.id !== id)
    if (next.length > 0 && !next.some((item) => item.isDefault)) next[0] = { ...next[0], isDefault: true }
    onChange(next)
  }
  const setDefault = (id: string) => {
    onChange(downloaders.map((item) => ({ ...item, isDefault: item.id === id })))
  }

  return (
    <section className={settingsCardClassName}>
      <SectionHeader
        title="下载器"
        count={downloaders.length}
        action={
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {downloaderPresets.map((preset) => (
              <Button className="min-w-0" disabled={pending} key={preset} onClick={() => addDownloader(preset)} size="sm" variant="secondary">
                <Plus className="size-4" />
                <span className="truncate">{defaultDownloaderForPreset(preset).name}</span>
              </Button>
            ))}
          </div>
        }
      />
      <div className="grid gap-3 px-3 py-3 sm:px-4">
        {downloaders.length === 0 ? (
          <div className="rounded-md bg-slate-50 px-3 py-5 text-center text-sm font-semibold text-slate-500">未配置下载器</div>
        ) : (
          downloaders.map((downloader) => (
            <div className="grid gap-3 rounded-lg border border-slate-200 p-3" key={downloader.id}>
              <div className="grid gap-2 md:grid-cols-[120px_minmax(120px,1fr)_minmax(200px,2fr)]">
                <label className="grid gap-1 text-xs font-semibold text-slate-500">
                  协议
                  <select
                    className={settingsInputClassName}
                    value={downloader.type}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                      updateDownloader(downloader.id, { type: event.target.value === 'abdm' ? 'abdm' : 'aria2' })
                    }
                  >
                    <option value="aria2">aria2 JSON-RPC</option>
                    <option value="abdm">ABDM</option>
                  </select>
                </label>
                <label className="grid gap-1 text-xs font-semibold text-slate-500">
                  名称
                  <input
                    className={settingsInputClassName}
                    value={downloader.name}
                    onChange={(event) => updateDownloader(downloader.id, { name: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-xs font-semibold text-slate-500">
                  RPC URL
                  <input
                    className={settingsInputClassName}
                    value={downloader.rpcUrl}
                    onChange={(event) => updateDownloader(downloader.id, { rpcUrl: event.target.value })}
                  />
                </label>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(120px,1fr)_minmax(120px,1fr)]">
                <label className="grid gap-1 text-xs font-semibold text-slate-500">
                  Token
                  <input
                    className={settingsInputClassName}
                    value={downloader.token}
                    onChange={(event) => updateDownloader(downloader.id, { token: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-xs font-semibold text-slate-500">
                  下载目录
                  <input
                    className={settingsInputClassName}
                    value={downloader.downloadDir}
                    onChange={(event) => updateDownloader(downloader.id, { downloadDir: event.target.value })}
                  />
                </label>
              </div>
              <label className="flex items-start gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
                <input
                  checked={downloader.preserveSourceDir}
                  className="mt-1 size-4 rounded border-slate-300 text-blue-600"
                  disabled={pending}
                  onChange={(event) => updateDownloader(downloader.id, { preserveSourceDir: event.target.checked })}
                  type="checkbox"
                />
                <span className="grid gap-1">
                  <span className="font-semibold text-slate-900">保留来源目录结构</span>
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={pending}
                  onClick={() => updateDownloader(downloader.id, { enabled: !downloader.enabled })}
                  size="sm"
                  variant={downloader.enabled ? 'primary' : 'secondary'}
                >
                  {downloader.enabled ? '已启用' : '未启用'}
                </Button>
                <Button
                  disabled={pending || downloader.isDefault}
                  onClick={() => setDefault(downloader.id)}
                  size="sm"
                  variant={downloader.isDefault ? 'primary' : 'secondary'}
                >
                  {downloader.isDefault ? '默认' : '设为默认'}
                </Button>
                <Button disabled={pending} onClick={() => removeDownloader(downloader.id)} size="sm" variant="danger">
                  <Trash2 className="size-4" />
                  删除
                </Button>
              </div>
            </div>
          ))
        )}
        <div className="flex justify-end">
          <Button disabled={pending} onClick={onSave} size="sm">
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存下载器
          </Button>
        </div>
      </div>
    </section>
  )
}

function MaintenanceSection({
  summary,
  loading,
  pending,
  tempCleanupPending,
  onRefresh,
  onCleanup,
  onTempCleanup,
  onFactoryReset,
}: {
  summary?: MaintenanceSummary
  loading: boolean
  pending: boolean
  tempCleanupPending: boolean
  onRefresh: () => void
  onCleanup: () => void
  onTempCleanup: () => void
  onFactoryReset: () => void
}) {
  if (loading) return <LoadingBlock label="正在读取维护状态" />

  const runtimeCount = summary
    ? summary.parseJobs +
      summary.parseRecords +
      summary.parseEvents +
      summary.baiduTempFiles +
      summary.accountEvents +
      summary.brokerRuns +
      summary.brokerRunEvents
    : 0
  const factoryCount = summary ? runtimeCount + summary.baiduAccounts + summary.appSettings : runtimeCount
  const activeCount = summary ? summary.activeParseJobs + summary.activeBrokerRuns : 0
  const parseRunning = (summary?.activeParseJobs ?? 0) > 0
  const tempCleanup = summary?.tempFileCleanup

  return (
    <>
      <section className={settingsCardClassName}>
        <SectionHeader
          title="维护状态"
          count={activeCount}
          action={
            <Button disabled={pending} onClick={onRefresh} size="sm" variant="secondary">
              <RotateCcw className="size-4" />
              刷新
            </Button>
          }
        />
        <div className="grid gap-2 px-3 py-3 sm:grid-cols-2 sm:px-4 lg:grid-cols-4">
          <Metric label="运行数据" value={runtimeCount} />
          <Metric label="恢复出厂项" value={factoryCount} />
          <Metric label="解析运行中" value={summary?.activeParseJobs ?? 0} />
          <Metric label="Broker 运行中" value={summary?.activeBrokerRuns ?? 0} />
        </div>
      </section>
      <section className={settingsCardClassName}>
        <SectionHeader
          title="中转文件清理"
          count={(tempCleanup?.deletePending ?? 0) + (tempCleanup?.deleteFailed ?? 0) + (tempCleanup?.orphan ?? 0)}
          action={
            <Button disabled={pending || tempCleanupPending} onClick={onTempCleanup} size="sm" variant="secondary">
              <Trash2 className="size-4" />
              手动清理
            </Button>
          }
        />
        <div className="grid gap-2 px-3 py-3 sm:grid-cols-2 sm:px-4 lg:grid-cols-5">
          <Metric label="待清理" value={tempCleanup?.deletePending ?? 0} />
          <Metric label="清理失败" value={tempCleanup?.deleteFailed ?? 0} />
          <Metric label="孤儿文件" value={tempCleanup?.orphan ?? 0} />
          <Metric label="活跃记录" value={tempCleanup?.active ?? 0} />
          <Metric label="已删除" value={tempCleanup?.deleted ?? 0} />
        </div>
        <div className="grid gap-3 px-3 pb-3 sm:px-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            {tempCleanup?.lastRun ? (
              <div>
                上次{tempCleanup.lastRun.trigger === 'manual' ? '手动' : '自动'}清理：{formatDateTime(tempCleanup.lastRun.finishedAt)} · 尝试{' '}
                {tempCleanup.lastRun.result.attempted} · 删除 {tempCleanup.lastRun.result.deleted} · 跳过 {tempCleanup.lastRun.result.skipped}
                {tempCleanup.lastRun.result.failed ? ` · 失败 ${tempCleanup.lastRun.result.failed}` : ''}
              </div>
            ) : (
              <div>暂未记录中转文件清理运行状态。</div>
            )}
          </div>
          {tempCleanup?.recentOrphans.length ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="font-bold">最近孤儿文件</div>
              <div className="mt-2 grid gap-1">
                {tempCleanup.recentOrphans.map((item) => (
                  <div className="break-all" key={item.id}>
                    #{item.id} · {item.path || item.tempDir}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {tempCleanup?.recentErrors.length ? (
            <div className="rounded-lg border border-slate-200 p-3 text-sm text-slate-600">
              <div className="font-bold text-slate-900">待处理问题文件</div>
              <div className="mt-2 grid gap-1">
                {tempCleanup.recentErrors.map((item) => (
                  <div className="break-all" key={item.id}>
                    #{item.id} · {item.status} · 失败 {item.retryCount} 次{item.retryCount > 2 ? ' · 定时清理已跳过' : ''}
                    {item.retryCount > 5 ? ' · 手动清理也会跳过' : ''} · {item.errorMessage || item.path}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {tempCleanup?.recentRuns.length ? (
            <div className="rounded-lg border border-slate-200 p-3 text-sm text-slate-600">
              <div className="font-bold text-slate-900">最近运行</div>
              <div className="mt-2 grid gap-2">
                {tempCleanup.recentRuns.slice(0, 3).map((run) => (
                  <div className="rounded-md bg-white px-3 py-2 ring-1 ring-slate-100" key={run.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800">
                        #{run.id} · {run.trigger === 'manual' ? '手动' : '自动'}清理 · {run.status}
                      </span>
                      <span className="text-xs text-slate-500">{formatDateTime(run.finishedAt || run.startedAt)}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      处理 {run.processed}/{run.totalCandidates} · 尝试 {run.result.attempted} · 删除 {run.result.deleted} · 跳过 {run.result.skipped}
                      {run.result.failed ? ` · 失败 ${run.result.failed}` : ''}
                    </div>
                    {run.result.firstError ? <div className="mt-1 break-all text-xs font-semibold text-amber-700">{run.result.firstError}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>
      <section className={settingsCardClassName}>
        <SectionHeader title="危险操作" count={2} />
        <div className="divide-y divide-slate-100">
          <MaintenanceActionRow
            actionLabel="清理"
            count={runtimeCount}
            disabled={pending || parseRunning}
            label="清理运行数据"
            pending={pending}
            variant="secondary"
            onAction={onCleanup}
          />
          <MaintenanceActionRow
            actionLabel="恢复出厂"
            count={factoryCount}
            disabled={pending || parseRunning}
            label="恢复出厂"
            pending={pending}
            variant="danger"
            onAction={onFactoryReset}
          />
        </div>
      </section>
    </>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2 ring-1 ring-slate-100">
      <div className="text-[11px] font-semibold text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-bold text-slate-900">{value}</div>
    </div>
  )
}

function MaintenanceActionRow({
  label,
  count,
  actionLabel,
  variant,
  pending,
  disabled,
  onAction,
}: {
  label: string
  count: number
  actionLabel: string
  variant: 'secondary' | 'danger'
  pending: boolean
  disabled: boolean
  onAction: () => void
}) {
  return (
    <div className={settingsRowClassName}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="min-w-0 truncate text-sm font-semibold text-slate-900">{label}</div>
          <span className="lg:hidden">
            <StatusBadge enabled={count > 0} enabledLabel={`${count} 项`} disabledLabel="空" />
          </span>
        </div>
      </div>
      <div className={settingsBadgeCellClassName}>
        <StatusBadge enabled={count > 0} enabledLabel={`${count} 项`} disabledLabel="空" />
      </div>
      <div className={`${settingsValueCellClassName} flex min-h-8 items-center`} />
      <div className={settingsActionCellClassName}>
        <Button className={settingsActionButtonClassName} disabled={disabled} onClick={onAction} size="sm" variant={variant}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}

function FactoryResetDialog({
  open,
  confirmText,
  disabled,
  onChange,
  onConfirm,
  onCancel,
}: {
  open: boolean
  confirmText: string
  disabled: boolean
  onChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  const confirmed = confirmText.trim() === 'RESET'
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 px-4 py-6">
      <div
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl shadow-slate-900/20"
        role="dialog"
        aria-modal="true"
        aria-labelledby="factory-reset-dialog-title"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-red-50 p-2 text-red-600">
            <Trash2 className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-slate-900" id="factory-reset-dialog-title">
              恢复出厂
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">将删除账号、Broker 配置、访问密码和历史。输入 RESET 确认。</p>
            <input
              autoFocus
              className={`${settingsInputClassName} mt-3`}
              onChange={(event) => onChange(event.target.value)}
              placeholder="RESET"
              value={confirmText}
            />
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button disabled={disabled} onClick={onCancel} variant="secondary">
            取消
          </Button>
          <Button disabled={disabled || !confirmed} onClick={onConfirm} variant="danger">
            {disabled ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            恢复出厂
          </Button>
        </div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const clearParseExecution = useSetAtom(clearParseExecutionAtom)
  const pushNotification = useSetAtom(pushNotificationAtom)
  const setError = useSetAtom(errorAtom)
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryKey>('security')
  const [advancedOpen, setAdvancedOpen] = useState<Record<AdvancedSectionKey, boolean>>({
    baidu: false,
    deployment: false,
  })
  const [password, setPassword] = useState('')
  const [form, setForm] = useState<SettingsForm>({})
  const [savingSettingName, setSavingSettingName] = useState<string | null>(null)
  const [savingSettingValue, setSavingSettingValue] = useState<string | null>(null)
  const [settingsQueryErrorDismissed, setSettingsQueryErrorDismissed] = useState(false)
  const [confirmExternalAccess, setConfirmExternalAccess] = useState(false)
  const [maintenanceConfirm, setMaintenanceConfirm] = useState<MaintenanceConfirmTarget>(null)
  const [factoryResetConfirmText, setFactoryResetConfirmText] = useState('')
  const [desktopSwitchOverlay, setDesktopSwitchOverlay] = useState<DesktopSwitchOverlay>(null)
  const [downloadersDraft, setDownloadersDraft] = useState<DownloaderDraft[]>([])
  const [pendingRiskConsent, setPendingRiskConsent] = useState<PendingRiskConsent>(null)
  const [brokerWizardOpen, setBrokerWizardOpen] = useState(false)
  const [brokerWizardError, setBrokerWizardError] = useState<string | null>(null)
  const [brokerVerifyResult, setBrokerVerifyResult] = useState<BrokerWizardVerifyResult | null>(null)
  const [workerHelpOpen, setWorkerHelpOpen] = useState(false)
  const [workerHelpTab, setWorkerHelpTab] = useState<WorkerHelpTab>('quick')
  const [workerWizardOpen, setWorkerWizardOpen] = useState(false)
  const [workerWizardPreferredVersion, setWorkerWizardPreferredVersion] = useState<WorkerConfigVersion | null>(null)
  const [workerWizardError, setWorkerWizardError] = useState<string | null>(null)
  const [workerV2VerifyResult, setWorkerV2VerifyResult] = useState<WorkerV2VerifyResult | null>(null)
  const [linkTtlWizardOpen, setLinkTtlWizardOpen] = useState(false)
  const [pendingLinkTtlConfirm, setPendingLinkTtlConfirm] = useState<PendingLinkTtlConfirm>(null)
  const [pendingLinkTtlWizardConfirm, setPendingLinkTtlWizardConfirm] = useState<PendingLinkTtlWizardConfirm>(null)
  const [tempCleanupResult, setTempCleanupResult] = useState<TempFilesCleanupResult | null>(null)
  const [tempCleanupError, setTempCleanupError] = useState<string | null>(null)
  const statusQuery = api.api.security.status.$get.useQuery()
  const agentSettingsQuery = api.api.settings.$get.useQuery()
  const desktopRuntimeQuery = api.api.desktop.runtime.$get.useQuery()
  const maintenanceSummaryQuery = api.api.maintenance.summary.$get.useQuery()
  const securityMutation = api.api.security.settings.$put.useMutation()
  const agentSettingsMutation = api.api.settings.$put.useMutation()
  const brokerVerifyMutation = api.api.broker.verify.$post.useMutation()
  const workerV2VerifyMutation = api.api.settings['link-proxy'].v2.verify.$post.useMutation()
  const desktopAccessMutation = api.api.desktop['external-access'].$put.useMutation()
  const desktopOpenBrowserMutation = api.api.desktop['open-external-browser'].$post.useMutation()
  const maintenanceCleanupMutation = api.api.maintenance.cleanup.$post.useMutation()
  const tempFilesCleanupMutation = api.api.maintenance['temp-files'].cleanup.$post.useMutation()
  const tempCleanupStatusQuery = api.api.maintenance['temp-files'].cleanup.status.$get.useQuery({
    refetchInterval: maintenanceConfirm === 'temp-files' || tempFilesCleanupMutation.isPending ? 1000 : false,
  })
  const maintenanceFactoryResetMutation = api.api.maintenance['factory-reset'].$post.useMutation()
  const passwordEnabled = statusQuery.data?.data.passwordEnabled === true
  const settings = agentSettingsQuery.data?.data
  const desktopRuntime = desktopRuntimeQuery.data?.data
  const desktopMode = desktopRuntime?.desktopMode === true
  const maintenanceSummary = maintenanceSummaryQuery.data?.data
  const maintenancePending = maintenanceCleanupMutation.isPending || maintenanceFactoryResetMutation.isPending || tempFilesCleanupMutation.isPending
  const settingsQueryError =
    agentSettingsQuery.isError && !settingsQueryErrorDismissed ? messageFromError(agentSettingsQuery.error, '读取 Agent 配置失败') : null
  const normalizedCurrentV2Endpoints = normalizeEndpointLines(form.linkProxyV2Endpoints ?? settings?.items.linkProxyV2Endpoints?.value ?? '')
  const workerV2VerifyMatchesCurrentSettings = workerV2VerifyResult?.endpoints.join('\n') === normalizedCurrentV2Endpoints
  const workerTtlLimits = useMemo<WorkerTtlLimit[]>(() => {
    if (!workerV2VerifyMatchesCurrentSettings) return []
    return (
      workerV2VerifyResult?.results
        .map((item) => ({
          endpoint: item.endpoint,
          maxTokenTtlSeconds: parsePositiveInteger(item.maxTokenTtlSeconds),
        }))
        .filter((item): item is WorkerTtlLimit => item.maxTokenTtlSeconds !== null) ?? []
    )
  }, [workerV2VerifyMatchesCurrentSettings, workerV2VerifyResult])
  const activeLinkProxyVersion = normalizeWorkerConfigVersion(form.linkProxyVersion || settings?.items.linkProxyVersion?.value)
  const currentLinkCacheTtlRisk = buildLinkCacheTtlRisk(
    activeLinkProxyVersion,
    parsePositiveInteger(form.linkCacheTtlSeconds ?? settings?.items.linkCacheTtlSeconds?.value),
    workerTtlLimits,
  )

  useEffect(() => {
    if (!passwordEnabled) return
    setPassword(getStoredAgentPassword())
  }, [passwordEnabled])

  useEffect(() => {
    setForm(initialFormFromSettings(settings))
    setDownloadersDraft(parseDownloaders(settings?.items.downloadersJson?.value))
  }, [settings])

  useEffect(() => {
    if (window.location.hash.includes('section=downloaders')) setActiveCategory('advanced')
  }, [])

  useEffect(() => {
    if (agentSettingsQuery.isError) setSettingsQueryErrorDismissed(false)
  }, [agentSettingsQuery.error])

  useEffect(() => {
    if (!settingsQueryError) return
    pushNotification({
      variant: 'error',
      message: settingsQueryError,
    })
    setSettingsQueryErrorDismissed(true)
  }, [settingsQueryError, pushNotification])

  const categories = useMemo(
    () =>
      categoryMeta.map((category) => {
        const count =
          category.key === 'security'
            ? 1 + (desktopMode ? 1 : 0)
            : category.key === 'broker'
              ? visibleBrokerSettings(settings?.groups.broker ?? []).length
              : category.key === 'runtime'
                ? settingsCount(settings, ['account', 'parse', 'health'])
                : category.key === 'advanced'
                  ? visibleDownloadSettings(settings?.groups.download ?? []).length + settingsCount(settings, ['baidu', 'deployment'])
                  : 2

        return {
          ...category,
          count,
        }
      }),
    [desktopMode, settings],
  )

  const activeCategoryMeta = categories.find((category) => category.key === activeCategory) ?? categories[0]

  const saveEnabled = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      await securityMutation.mutateAsync({
        json: {
          enabled: true,
          password,
        },
      })
      setStoredAgentPassword(password)
      await statusQuery.refetch()
      pushNotification({
        variant: 'success',
        message: passwordEnabled ? '访问密码已更新' : '访问密码保护已开启',
      })
    } catch (err) {
      setError(messageFromError(err, '保存访问设置失败'))
    }
  }

  const disablePassword = async () => {
    setError(null)
    try {
      await securityMutation.mutateAsync({
        json: {
          enabled: false,
        },
      })
      clearStoredAgentPassword()
      setPassword('')
      await statusQuery.refetch()
      pushNotification({
        variant: 'success',
        message: '访问密码保护已关闭',
      })
    } catch (err) {
      setError(messageFromError(err, '关闭访问保护失败'))
    }
  }

  const logout = () => {
    clearStoredAgentPassword()
    window.location.reload()
  }

  const updateSettingValue = (setting: AgentSetting, value: string) => {
    if (setting.name === 'brokerEnabled') {
      openBrokerWizard()
      return
    }
    if (setting.type === 'boolean') {
      const consentType = riskConsentTypeForSettingToggle(setting, value, statusQuery.data?.data.riskConsents)
      if (consentType) {
        setPendingRiskConsent({
          type: consentType,
          afterAccept: () => void saveBooleanSetting(setting, value),
        })
        return
      }
      void saveBooleanSetting(setting, value)
      return
    }
    setForm((current) => ({ ...current, [setting.name]: value }))
  }

  const openWorkerWizard = () => {
    setWorkerWizardError(null)
    setWorkerWizardPreferredVersion(null)
    setWorkerV2VerifyResult(null)
    setWorkerWizardOpen(true)
  }

  const openBrokerWizard = () => {
    setBrokerWizardError(null)
    setBrokerVerifyResult(null)
    setBrokerWizardOpen(true)
  }

  const titleHelperForSetting = (setting: AgentSetting) => {
    if (setting.name === 'brokerEnabled') {
      return <div className="text-xs leading-5 text-slate-500">Broker 执行会让本地 Agent 参与 Broker 任务，需要有效 Broker Base URL 和 Agent Token。</div>
    }
    if (setting.name !== 'linkProxyVersion') return null
    return <WorkerHelpButton onClick={() => setWorkerHelpOpen(true)} />
  }

  const valueForSetting = (setting: AgentSetting) => {
    if (setting.name === 'brokerEnabled') {
      const enabled = form.brokerEnabled ?? settings?.items.brokerEnabled?.value ?? 'false'
      return (
        <button
          className="flex h-9 w-full min-w-0 items-center overflow-hidden rounded-md border border-slate-300 bg-white text-left text-sm font-semibold text-slate-800 outline-none transition hover:border-blue-300 hover:bg-blue-50/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
          disabled={agentSettingsMutation.isPending}
          onClick={openBrokerWizard}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate px-2.5">当前：{brokerEnabledLabel(enabled)}</span>
          <span className="h-full w-px shrink-0 bg-slate-200" aria-hidden="true" />
          <span className="grid h-full w-9 shrink-0 place-items-center text-slate-500">
            {agentSettingsMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Settings className="size-4" />}
          </span>
        </button>
      )
    }
    if (setting.name === 'linkCacheTtlSeconds') {
      return (
        <button
          className="flex h-9 w-full min-w-0 items-center overflow-hidden rounded-md border border-slate-300 bg-white text-left text-sm font-semibold text-slate-800 outline-none transition hover:border-blue-300 hover:bg-blue-50/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
          disabled={agentSettingsMutation.isPending}
          onClick={() => setLinkTtlWizardOpen(true)}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate px-2.5">{linkTtlSourceLabel(setting)}</span>
          <span className="h-full w-px shrink-0 bg-slate-200" aria-hidden="true" />
          <span className="grid h-full w-9 shrink-0 place-items-center text-slate-500">
            {agentSettingsMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Settings className="size-4" />}
          </span>
        </button>
      )
    }
    if (setting.name !== 'linkProxyVersion') return null
    const version = normalizeWorkerConfigVersion(form.linkProxyVersion || settings?.items.linkProxyVersion?.value)
    return (
      <button
        className="flex h-9 w-full min-w-0 items-center overflow-hidden rounded-md border border-slate-300 bg-white text-left text-sm font-semibold text-slate-800 outline-none transition hover:border-blue-300 hover:bg-blue-50/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
        disabled={agentSettingsMutation.isPending}
        onClick={openWorkerWizard}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate px-2.5">当前：{workerConfigVersionLabel(version)}</span>
        <span className="h-full w-px shrink-0 bg-slate-200" aria-hidden="true" />
        <span className="grid h-full w-9 shrink-0 place-items-center text-slate-500">
          {agentSettingsMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Settings className="size-4" />}
        </span>
      </button>
    )
  }

  const linkTtlSetting = settings?.items.linkCacheTtlSeconds

  const helperForSetting = (setting: AgentSetting) => {
    if (setting.name === 'brokerEnabled') {
      const baseUrl = form.brokerBaseUrl ?? settings?.items.brokerBaseUrl?.value ?? ''
      const tokenConfigured = Boolean(settings?.items.brokerAgentToken?.displayValue === '已设置' || settings?.items.brokerAgentToken?.value)
      const heartbeat = form.brokerHeartbeatIntervalSeconds ?? settings?.items.brokerHeartbeatIntervalSeconds?.value ?? '30'
      const poll = form.brokerPollIntervalSeconds ?? settings?.items.brokerPollIntervalSeconds?.value ?? '10'
      const maxRuns = form.brokerMaxConcurrentRuns ?? settings?.items.brokerMaxConcurrentRuns?.value ?? '2'
      return (
        <div className="mt-1.5 grid gap-1.5 text-xs leading-5 text-slate-500">
          <div>修改启用状态、Broker URL、Agent Token 或轮询参数都需要通过配置向导完成。</div>
          {baseUrl ? (
            <div className="break-all rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-slate-600">Broker Base URL：{baseUrl}</div>
          ) : null}
          <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-slate-600">
            Agent Token：{tokenConfigured ? '已设置' : '未设置'}；Heartbeat / Poll：{heartbeat}s / {poll}s；最大并发 Runs：{maxRuns}
          </div>
        </div>
      )
    }
    if (setting.name === 'linkProxyVersion') {
      const version = normalizeWorkerConfigVersion(form.linkProxyVersion || settings?.items.linkProxyVersion?.value)
      const v1Endpoint = form.linkProxyBaseUrl ?? settings?.items.linkProxyBaseUrl?.value ?? ''
      const v2Endpoints = normalizeEndpointLines(form.linkProxyV2Endpoints ?? settings?.items.linkProxyV2Endpoints?.value ?? '')
      return (
        <div className="mt-1.5 grid gap-1.5 text-xs leading-5 text-slate-500">
          <div>{workerConfigVersionDescription(version)} 修改代理模式、端点或密钥都需要通过配置向导完成。</div>
          {version === 'v2' && v2Endpoints ? (
            <div className="whitespace-pre-wrap break-all rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-slate-600">
              v2 端点：{v2Endpoints}
            </div>
          ) : null}
          {version === 'v1' && v1Endpoint ? (
            <div className="break-all rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-slate-600">v1 端点：{v1Endpoint}</div>
          ) : null}
          {version !== 'none' && !v1Endpoint && !v2Endpoints ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 font-semibold text-amber-800">
              当前模式缺少可用端点，请通过配置向导补全。
            </div>
          ) : null}
        </div>
      )
    }
    if (setting.name !== 'linkCacheTtlSeconds') return null
    return (
      <div className="mt-2 grid gap-1.5 text-xs leading-5">
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600">
          该值决定 Agent 生成结果链接的默认有效期和转存文件清理保护时间，也会作为 Broker 接单能力上报；Broker 任务自己的最短要求由请求者创建任务时选择。
          {activeLinkProxyVersion === 'v2'
            ? ` 使用 Worker v2 时，不能超过 Worker 的 MAX_TOKEN_TTL_SECONDS，否则访问代理链接会返回 forbidden。Worker 默认上限为 ${defaultWorkerMaxTokenTtlSeconds} 秒。`
            : null}
        </div>
        {currentLinkCacheTtlRisk ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 font-semibold text-amber-800">
            <div>{currentLinkCacheTtlRisk.message}</div>
            <div className="mt-1 font-medium">{currentLinkCacheTtlRisk.description}</div>
          </div>
        ) : null}
      </div>
    )
  }

  const verifyWorkerV2Endpoints = async (endpoints: string) => {
    setWorkerWizardError(null)
    setWorkerV2VerifyResult(null)
    try {
      const response = await workerV2VerifyMutation.mutateAsync({
        json: {
          endpoints,
        },
      })
      setWorkerV2VerifyResult(response.data)
      if (!response.data.ok) setWorkerWizardError(`检测失败：${response.data.failures.map((item) => `${item.endpoint} ${item.message}`).join('；')}`)
    } catch (err) {
      setWorkerWizardError(messageFromError(err, '检测 Worker v2 代理端点失败'))
    }
  }

  const verifyBrokerConfig = async (values: Record<string, string>) => {
    setBrokerWizardError(null)
    setBrokerVerifyResult(null)
    try {
      const response = await brokerVerifyMutation.mutateAsync({
        json: {
          baseUrl: values.brokerBaseUrl,
          agentToken: values.brokerAgentToken,
          heartbeatIntervalSeconds: Number(values.brokerHeartbeatIntervalSeconds),
          pollIntervalSeconds: Number(values.brokerPollIntervalSeconds),
          maxConcurrentRuns: Number(values.brokerMaxConcurrentRuns),
        },
      })
      setBrokerVerifyResult({
        ...response.data,
        baseUrl: values.brokerBaseUrl,
        agentToken: values.brokerAgentToken,
        heartbeatIntervalSeconds: values.brokerHeartbeatIntervalSeconds,
        pollIntervalSeconds: values.brokerPollIntervalSeconds,
        maxConcurrentRuns: values.brokerMaxConcurrentRuns,
      })
      if (response.data.ok === false) setBrokerWizardError('error' in response.data ? response.data.error : 'Broker 连接检测失败')
    } catch (err) {
      setBrokerWizardError(messageFromError(err, '检测 Broker 连接失败'))
    }
  }

  const persistBrokerWizardSettings = async (values: Record<string, string>) => {
    setBrokerWizardError(null)
    try {
      await agentSettingsMutation.mutateAsync({
        json: {
          values,
        },
      })
      const result = await agentSettingsQuery.refetch()
      setForm(initialFormFromSettings(result.data?.data))
      await api.api.settings.$get.invalidate()
      setBrokerWizardOpen(false)
      pushNotification({
        variant: 'success',
        message: values.brokerEnabled === 'false' ? 'Broker 执行已关闭' : 'Broker 配置已保存',
      })
    } catch (err) {
      setBrokerWizardError(messageFromError(err, '保存 Broker 配置失败'))
    }
  }

  const saveBrokerWizardSettings = async (values: Record<string, string>) => {
    if (values.brokerEnabled === 'true' && !statusQuery.data?.data.riskConsents.broker_execution) {
      setPendingRiskConsent({
        type: 'broker_execution',
        afterAccept: () => void persistBrokerWizardSettings(values),
      })
      return
    }
    await persistBrokerWizardSettings(values)
  }

  const saveWorkerWizardSettings = async (values: Record<string, string>) => {
    setWorkerWizardError(null)
    try {
      await agentSettingsMutation.mutateAsync({
        json: {
          values,
        },
      })
      const result = await agentSettingsQuery.refetch()
      setForm(initialFormFromSettings(result.data?.data))
      setWorkerWizardOpen(false)
      setWorkerWizardPreferredVersion(null)
      pushNotification({
        variant: 'success',
        message: 'Worker 配置已保存',
      })
    } catch (err) {
      setWorkerWizardError(messageFromError(err, '保存 Worker 配置失败'))
    }
  }

  const persistLinkTtlWizardSetting = async (value: string) => {
    setError(null)
    try {
      await agentSettingsMutation.mutateAsync({
        json: {
          values: {
            linkCacheTtlSeconds: value,
          },
        },
      })
      const result = await agentSettingsQuery.refetch()
      setForm(initialFormFromSettings(result.data?.data))
      setLinkTtlWizardOpen(false)
      pushNotification({
        variant: 'success',
        message: value.trim() ? '链接有效期已保存为固定配置' : '链接有效期已切回默认值',
      })
    } catch (err) {
      setError(messageFromError(err, '保存链接有效期失败'))
    }
  }

  const saveLinkTtlWizardSetting = async (value: string) => {
    const effectiveSeconds = value.trim() ? parsePositiveInteger(value) : parsePositiveInteger(linkTtlSetting?.value)
    const risk = buildLinkCacheTtlRisk(activeLinkProxyVersion, effectiveSeconds, workerTtlLimits)
    if (risk && workerTtlLimits.length === 0) {
      setPendingLinkTtlWizardConfirm({ value, risk })
      return
    }
    await persistLinkTtlWizardSetting(value)
  }

  const saveBooleanSetting = async (setting: AgentSetting, value: string) => {
    setError(null)
    setSavingSettingName(setting.name)
    setSavingSettingValue(null)
    setForm((current) => ({ ...current, [setting.name]: value }))
    try {
      await agentSettingsMutation.mutateAsync({
        json: {
          values: {
            [setting.name]: value,
          },
        },
      })
      await Promise.all([agentSettingsQuery.refetch(), setting.name === 'brokerEnabled' ? api.api.settings.$get.invalidate() : Promise.resolve()])
      pushNotification({
        variant: 'success',
        message: `${setting.label} 已保存`,
      })
    } catch (err) {
      setError(messageFromError(err, `保存 ${setting.label} 失败`))
      await agentSettingsQuery.refetch()
    } finally {
      setSavingSettingName((current) => (current === setting.name ? null : current))
      setSavingSettingValue(null)
    }
  }

  const saveSetting = async (setting: AgentSetting, overrideValue?: string) => {
    if (setting.name === 'linkProxyVersion') {
      return
    }
    setError(null)
    const value = form[setting.name] ?? ''
    if (setting.name === 'linkProxySecret' && value.trim() === 'changeme') {
      setError('Worker 加密密钥不能使用示例值 changeme，请换成自己的密钥。')
      return
    }
    if (setting.name === 'linkCacheTtlSeconds') {
      const risk = buildLinkCacheTtlRisk(activeLinkProxyVersion, parsePositiveInteger(value), workerTtlLimits)
      if (risk) {
        setPendingLinkTtlConfirm({ setting, value, risk })
        return
      }
    }
    await persistSetting(setting, value)
  }

  const persistSetting = async (setting: AgentSetting, value: string) => {
    const values: Record<string, string> = {
      [setting.name]: value,
    }
    try {
      await agentSettingsMutation.mutateAsync({
        json: {
          values,
        },
      })
      await agentSettingsQuery.refetch()
      pushNotification({
        variant: 'success',
        message: `${setting.label} 已保存`,
      })
    } catch (err) {
      setError(messageFromError(err, `保存 ${setting.label} 失败`))
    }
  }

  const resetSetting = async (setting: AgentSetting) => {
    setError(null)
    const values: Record<string, string> =
      setting.name === 'linkProxyV2Endpoints'
        ? {
            linkProxyV2Endpoints: '',
          }
        : {
            [setting.name]: '',
          }
    try {
      await agentSettingsMutation.mutateAsync({
        json: {
          values,
        },
      })
      await agentSettingsQuery.refetch()
      pushNotification({
        variant: 'success',
        message: setting.name === 'linkProxyV2Endpoints' ? '已回退 Worker v2 代理端点' : `${setting.label} 已回退到环境变量或默认值`,
      })
    } catch (err) {
      setError(messageFromError(err, `回退 ${setting.label} 失败`))
    }
  }

  const saveDownloaders = async () => {
    setError(null)
    try {
      await agentSettingsMutation.mutateAsync({
        json: {
          values: {
            downloadersJson: serializeDownloaders(downloadersDraft),
          },
        },
      })
      await agentSettingsQuery.refetch()
      pushNotification({
        variant: 'success',
        message: '下载器已保存',
      })
    } catch (err) {
      setError(messageFromError(err, '保存下载器失败'))
    }
  }

  const waitForHealth = async () => {
    const deadline = Date.now() + desktopSwitchTimeoutMs
    while (Date.now() < deadline) {
      try {
        const response = await fetch('/health', {
          cache: 'no-store',
          credentials: 'include',
        })
        if (response.ok) return
      } catch {
        // The listener can briefly disappear while Bun restarts the socket.
      }
      await sleep(desktopSwitchPollMs)
    }
    throw new Error('桌面监听启动超时')
  }

  const waitForDesktopRuntime = async (targetEnabled: boolean) => {
    const deadline = Date.now() + desktopSwitchTimeoutMs
    const targetHost = targetEnabled ? '0.0.0.0' : '127.0.0.1'
    while (Date.now() < deadline) {
      try {
        const result = await desktopRuntimeQuery.refetch()
        const runtime = result.data?.data
        if (runtime?.lastSwitchError) throw new Error(runtime.lastSwitchError)
        if (runtime && !runtime.restartPending && runtime.externalAccessEnabled === targetEnabled && runtime.bindHost === targetHost) {
          return runtime
        }
      } catch (err) {
        if (err instanceof Error && err.message !== 'Failed to fetch') throw err
      }
      await sleep(desktopSwitchPollMs)
    }
    throw new Error('桌面监听状态确认超时')
  }

  const saveDesktopAccess = async (enabled: boolean) => {
    setError(null)
    setDesktopSwitchOverlay({
      targetEnabled: enabled,
      message: enabled ? '正在开启外部访问' : '正在关闭外部访问',
    })
    try {
      await desktopAccessMutation.mutateAsync({
        json: { enabled },
      })
      setDesktopSwitchOverlay({
        targetEnabled: enabled,
        message: '正在等待桌面监听启动',
      })
      await waitForHealth()
      setDesktopSwitchOverlay({
        targetEnabled: enabled,
        message: '正在确认桌面监听状态',
      })
      await waitForDesktopRuntime(enabled)
      await agentSettingsQuery.refetch()
      window.location.reload()
    } catch (err) {
      setError(messageFromError(err, enabled ? '开启桌面外部访问失败' : '关闭桌面外部访问失败'))
      setDesktopSwitchOverlay(null)
    }
  }

  const toggleDesktopAccess = (enabled: boolean) => {
    if (enabled) {
      setConfirmExternalAccess(true)
      return
    }
    void saveDesktopAccess(false)
  }

  const openExternalBrowser = async () => {
    setError(null)
    try {
      await desktopOpenBrowserMutation.mutateAsync({ json: {} })
      pushNotification({
        variant: 'success',
        message: '已打开外部浏览器',
      })
    } catch (err) {
      setError(messageFromError(err, '打开外部浏览器失败'))
    }
  }

  const toggleAdvancedSection = (key: AdvancedSectionKey) => {
    setAdvancedOpen((current) => ({ ...current, [key]: !current[key] }))
  }

  const switchCategory = (category: SettingsCategoryKey) => {
    setActiveCategory(category)
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'auto' })
  }

  const refreshMaintenanceSummary = () => {
    void maintenanceSummaryQuery.refetch()
  }

  const cleanupRuntime = async () => {
    setError(null)
    try {
      await maintenanceCleanupMutation.mutateAsync({ json: {} })
      clearParseExecution()
      await Promise.all([maintenanceSummaryQuery.refetch(), agentSettingsQuery.refetch(), desktopRuntimeQuery.refetch()])
      pushNotification({
        variant: 'success',
        message: '运行数据已清理',
      })
    } catch (err) {
      setError(messageFromError(err, '清理运行数据失败'))
    } finally {
      setMaintenanceConfirm(null)
    }
  }

  const cleanupTempFiles = async () => {
    setError(null)
    setTempCleanupError(null)
    setTempCleanupResult(null)
    try {
      const response = await tempFilesCleanupMutation.mutateAsync({ json: {} })
      const result = response.data
      setTempCleanupResult(result)
      await Promise.all([maintenanceSummaryQuery.refetch(), tempCleanupStatusQuery.refetch()])
      pushNotification({
        variant: result.failed || result.orphan ? 'warning' : 'success',
        message: `中转文件清理完成：尝试 ${result.attempted} · 删除 ${result.deleted} · 跳过 ${result.skipped}${result.failed ? ` · 失败 ${result.failed}` : ''}${result.orphan ? ` · 孤儿 ${result.orphan}` : ''}`,
      })
      if (result.firstError) setError(result.firstError)
    } catch (err) {
      const message = messageFromError(err, '清理中转文件失败')
      setError(message)
      setTempCleanupError(message)
    }
  }

  const factoryReset = async () => {
    setError(null)
    try {
      await maintenanceFactoryResetMutation.mutateAsync({ json: {} })
      clearParseExecution()
      clearStoredAgentPassword()
      setPassword('')
      setMaintenanceConfirm(null)
      window.location.reload()
    } catch (err) {
      setError(messageFromError(err, '恢复出厂失败'))
      setMaintenanceConfirm(null)
    }
  }

  const renderSettingsContent = () => {
    if (activeCategory === 'maintenance') {
      return (
        <MaintenanceSection
          loading={maintenanceSummaryQuery.isLoading}
          pending={maintenancePending}
          tempCleanupPending={tempFilesCleanupMutation.isPending}
          summary={maintenanceSummary}
          onCleanup={() => setMaintenanceConfirm('cleanup')}
          onTempCleanup={() => setMaintenanceConfirm('temp-files')}
          onFactoryReset={() => {
            setFactoryResetConfirmText('')
            setMaintenanceConfirm('factory-reset')
          }}
          onRefresh={refreshMaintenanceSummary}
        />
      )
    }

    if (activeCategory !== 'security') {
      if (agentSettingsQuery.isLoading) return <LoadingBlock label="正在读取 Agent 配置" />
      if (!settings || agentSettingsQuery.isError) return <EmptyBlock label="配置不可用" />
    }

    if (activeCategory === 'security') {
      return (
        <div className="grid gap-4">
          <PasswordAccessSection
            loading={statusQuery.isLoading}
            password={password}
            passwordEnabled={passwordEnabled}
            pending={securityMutation.isPending}
            onDisable={disablePassword}
            onLogout={logout}
            onPasswordChange={setPassword}
            onSubmit={saveEnabled}
          />
          {desktopMode && desktopRuntime ? (
            <DesktopAccessSection
              opening={desktopOpenBrowserMutation.isPending}
              pending={desktopAccessMutation.isPending}
              runtime={desktopRuntime}
              onOpenBrowser={openExternalBrowser}
              onToggle={toggleDesktopAccess}
            />
          ) : null}
        </div>
      )
    }

    if (!settings) return <EmptyBlock label="配置不可用" />

    if (activeCategory === 'broker') {
      return (
        <SettingsSection
          form={form}
          items={visibleBrokerSettings(settings.groups.broker)}
          pending={agentSettingsMutation.isPending}
          savingSettingName={savingSettingName}
          savingSettingValue={savingSettingValue}
          title={groupMeta.broker.title}
          titleHelperForSetting={titleHelperForSetting}
          valueForSetting={valueForSetting}
          helperForSetting={helperForSetting}
          onChange={updateSettingValue}
          onReset={resetSetting}
          onSave={saveSetting}
        />
      )
    }

    if (activeCategory === 'runtime') {
      return (
        <div className="grid gap-4">
          <SettingsSection
            form={form}
            items={settings.groups.account}
            pending={agentSettingsMutation.isPending}
            savingSettingName={savingSettingName}
            savingSettingValue={savingSettingValue}
            title={groupMeta.account.title}
            onChange={updateSettingValue}
            onReset={resetSetting}
            onSave={saveSetting}
          />
          <SettingsSection
            form={form}
            items={settings.groups.parse}
            pending={agentSettingsMutation.isPending}
            savingSettingName={savingSettingName}
            savingSettingValue={savingSettingValue}
            title={groupMeta.parse.title}
            onChange={updateSettingValue}
            onReset={resetSetting}
            onSave={saveSetting}
          />
          <SettingsSection
            form={form}
            items={settings.groups.health}
            pending={agentSettingsMutation.isPending}
            savingSettingName={savingSettingName}
            savingSettingValue={savingSettingValue}
            title={groupMeta.health.title}
            onChange={updateSettingValue}
            onReset={resetSetting}
            onSave={saveSetting}
          />
        </div>
      )
    }

    return (
      <div className="grid gap-4">
        <SettingsSection
          form={form}
          items={visibleDownloadSettings(settings.groups.download)}
          pending={agentSettingsMutation.isPending}
          savingSettingName={savingSettingName}
          savingSettingValue={savingSettingValue}
          title={groupMeta.download.title}
          titleHelperForSetting={titleHelperForSetting}
          valueForSetting={valueForSetting}
          helperForSetting={helperForSetting}
          onChange={updateSettingValue}
          onReset={resetSetting}
          onSave={saveSetting}
        />
        <DownloadersSection downloaders={downloadersDraft} pending={agentSettingsMutation.isPending} onChange={setDownloadersDraft} onSave={saveDownloaders} />
        <SettingsSection
          collapsed={!advancedOpen.baidu}
          collapsible
          form={form}
          items={settings.groups.baidu}
          pending={agentSettingsMutation.isPending}
          savingSettingName={savingSettingName}
          savingSettingValue={savingSettingValue}
          title={groupMeta.baidu.title}
          onChange={updateSettingValue}
          onReset={resetSetting}
          onSave={saveSetting}
          onToggle={() => toggleAdvancedSection('baidu')}
        />
        <SettingsSection
          collapsed={!advancedOpen.deployment}
          collapsible
          form={form}
          items={settings.groups.deployment}
          pending={agentSettingsMutation.isPending}
          savingSettingName={savingSettingName}
          savingSettingValue={savingSettingValue}
          title={groupMeta.deployment.title}
          onChange={updateSettingValue}
          onReset={resetSetting}
          onSave={saveSetting}
          onToggle={() => toggleAdvancedSection('deployment')}
        />
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
        <Panel className="!p-1.5 lg:sticky lg:top-4">
          <div className="grid gap-0.5">
            {categories.map((category) => {
              const active = category.key === activeCategory
              return (
                <button
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex min-h-9 min-w-0 items-center rounded-md px-4 py-2 text-left text-sm font-semibold ring-1 transition before:absolute before:left-1.5 before:bottom-2 before:top-2 before:w-0.5 before:rounded-full ${active ? 'bg-blue-50 text-blue-700 ring-blue-100 before:bg-blue-600' : 'text-slate-600 ring-transparent before:bg-transparent hover:bg-slate-50 hover:text-slate-900'}`}
                  key={category.key}
                  onClick={() => switchCategory(category.key)}
                  type="button"
                >
                  <span className="truncate">{category.title}</span>
                </button>
              )
            })}
          </div>
        </Panel>

        <div className="grid min-w-0 gap-4">
          <div className="flex min-h-14 items-center px-1 py-1">
            <h2 className="min-w-0 truncate text-base font-bold text-slate-900 sm:text-lg">{activeCategoryMeta.title}</h2>
          </div>

          {renderSettingsContent()}
        </div>
      </div>

      <ConfirmDialog
        confirmLabel="开启"
        description="开启后会监听 0.0.0.0，同局域网设备可访问此 Agent。"
        disabled={desktopAccessMutation.isPending}
        open={confirmExternalAccess}
        title="开启外部访问"
        variant="primary"
        onCancel={() => setConfirmExternalAccess(false)}
        onConfirm={() => {
          setConfirmExternalAccess(false)
          void saveDesktopAccess(true)
        }}
      />
      <ConfirmDialog
        confirmLabel="清理"
        description="将删除解析历史、事件日志和 Broker 执行记录，账号与设置会保留。"
        disabled={maintenancePending}
        open={maintenanceConfirm === 'cleanup'}
        title="清理运行数据"
        onCancel={() => setMaintenanceConfirm(null)}
        onConfirm={() => {
          void cleanupRuntime()
        }}
      />
      <ConfirmDialog
        confirmLabel="开始清理"
        description="将尝试删除本机 Agent 记录的网盘中转文件。手动清理会重试失败项；未过期的开放平台中转文件会跳过；孤儿文件需要到百度网盘手动删除。"
        disabled={maintenancePending}
        open={maintenanceConfirm === 'temp-files' && !tempFilesCleanupMutation.isPending && !tempCleanupResult && !tempCleanupError}
        title="清理中转文件"
        variant="primary"
        onCancel={() => setMaintenanceConfirm(null)}
        onConfirm={() => {
          void cleanupTempFiles()
        }}
      />
      <TempFileCleanupProgressModal
        error={tempCleanupError}
        open={maintenanceConfirm === 'temp-files' && (tempFilesCleanupMutation.isPending || Boolean(tempCleanupResult) || Boolean(tempCleanupError))}
        pending={tempFilesCleanupMutation.isPending}
        result={tempCleanupResult}
        status={tempCleanupStatusQuery.data?.data}
        onClose={() => {
          setMaintenanceConfirm(null)
          setTempCleanupResult(null)
          setTempCleanupError(null)
        }}
      />
      <FactoryResetDialog
        confirmText={factoryResetConfirmText}
        disabled={maintenancePending}
        open={maintenanceConfirm === 'factory-reset'}
        onCancel={() => setMaintenanceConfirm(null)}
        onChange={setFactoryResetConfirmText}
        onConfirm={() => {
          void factoryReset()
        }}
      />
      <RiskConsentDialog
        open={pendingRiskConsent !== null}
        type={pendingRiskConsent?.type ?? null}
        onAccepted={() => {
          const afterAccept = pendingRiskConsent?.afterAccept
          setPendingRiskConsent(null)
          afterAccept?.()
        }}
        onCancel={() => setPendingRiskConsent(null)}
      />
      <ConfirmDialog
        cancelLabel="返回修改"
        confirmLabel="仍然保存"
        description={pendingLinkTtlConfirm ? `${pendingLinkTtlConfirm.risk.message} ${pendingLinkTtlConfirm.risk.description}` : undefined}
        disabled={agentSettingsMutation.isPending}
        open={pendingLinkTtlConfirm !== null}
        title="链接有效期可能超过 Worker 上限"
        variant="primary"
        onCancel={() => setPendingLinkTtlConfirm(null)}
        onConfirm={() => {
          const pending = pendingLinkTtlConfirm
          setPendingLinkTtlConfirm(null)
          if (pending) void persistSetting(pending.setting, pending.value)
        }}
      />
      <ConfirmDialog
        cancelLabel="返回修改"
        confirmLabel="仍然保存"
        description={pendingLinkTtlWizardConfirm ? `${pendingLinkTtlWizardConfirm.risk.message} ${pendingLinkTtlWizardConfirm.risk.description}` : undefined}
        disabled={agentSettingsMutation.isPending}
        open={pendingLinkTtlWizardConfirm !== null}
        title="链接有效期可能超过 Worker 上限"
        variant="primary"
        onCancel={() => setPendingLinkTtlWizardConfirm(null)}
        onConfirm={() => {
          const pending = pendingLinkTtlWizardConfirm
          setPendingLinkTtlWizardConfirm(null)
          if (pending) void persistLinkTtlWizardSetting(pending.value)
        }}
      />
      <BrokerConfigWizard
        error={brokerWizardError}
        initialForm={form}
        open={brokerWizardOpen}
        saving={agentSettingsMutation.isPending}
        verifying={brokerVerifyMutation.isPending}
        verifyResult={brokerVerifyResult}
        onClose={() => {
          setBrokerWizardOpen(false)
          setBrokerVerifyResult(null)
        }}
        onSave={saveBrokerWizardSettings}
        onVerify={verifyBrokerConfig}
      />
      <WorkerHelpModal activeTab={workerHelpTab} open={workerHelpOpen} onClose={() => setWorkerHelpOpen(false)} onTabChange={setWorkerHelpTab} />
      <WorkerConfigWizard
        error={workerWizardError}
        initialForm={form}
        open={workerWizardOpen}
        preferredVersion={workerWizardPreferredVersion}
        saving={agentSettingsMutation.isPending}
        verifying={workerV2VerifyMutation.isPending}
        verifyResult={workerV2VerifyResult}
        onClose={() => {
          setWorkerWizardOpen(false)
          setWorkerWizardPreferredVersion(null)
        }}
        onOpenHelp={() => {
          setWorkerWizardOpen(false)
          setWorkerWizardPreferredVersion(null)
          setWorkerHelpTab('quick')
          setWorkerHelpOpen(true)
        }}
        onSave={saveWorkerWizardSettings}
        onVerifyV2={verifyWorkerV2Endpoints}
      />
      <LinkTtlConfigWizard
        activeLinkProxyVersion={activeLinkProxyVersion}
        open={linkTtlWizardOpen}
        saving={agentSettingsMutation.isPending}
        setting={linkTtlSetting}
        workerTtlLimits={workerTtlLimits}
        onClose={() => {
          setLinkTtlWizardOpen(false)
          setPendingLinkTtlWizardConfirm(null)
        }}
        onSave={saveLinkTtlWizardSetting}
      />
      {desktopSwitchOverlay ? <DesktopSwitchLoading message={desktopSwitchOverlay.message} /> : null}
    </div>
  )
}
