import { and, desc, eq, inArray, isNull, like, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { parseLinksForBroker } from '../baidu/service'
import { accountUsabilityMessage, accountUsabilityReason, isUsableLocalAccount } from '../baidu/accountUsability'
import { appSettings, baiduAccounts, brokerRunEvents, brokerRuns, type BaiduAccount, type BrokerRun } from '../db/schema'
import { ensureSystemUser } from '../localUser'
import { badRequest, upstreamError, unknownErrorMessage } from '../lib/errors'
import { getLinkProxyConfig } from '../lib/linkProxy'
import {
  getDownloadSettings,
  getSettingBoolean,
  getSettingNumber,
  getSettingString,
  getSettingWithSource,
  readSettingRaw,
  settingKeys,
  setSetting,
} from '../settings/service'
import { agentClientVersion, agentVersion } from '../version'
import { config } from '../config'

export type BrokerConfig = {
  baseUrl: string
  agentToken: string
  enabled: boolean
  heartbeatIntervalSeconds: number
  pollIntervalSeconds: number
  maxConcurrentRuns: number
  lastHeartbeatAt: string | null
  lastHeartbeatStatus: 'idle' | 'ok' | 'failed'
  lastHeartbeatHttpStatus: number | null
  lastHeartbeatErrorCode: string | null
  lastHeartbeatErrorMessage: string | null
  lastPollAt: string | null
  lastPollStatus: 'idle' | 'ok' | 'failed'
  lastPollHttpStatus: number | null
  lastPollErrorCode: string | null
  lastPollErrorMessage: string | null
  lastRequestBaseUrl: string | null
  lastError: string | null
}

export type PublicBrokerConfig = Omit<BrokerConfig, 'agentToken'> & {
  agentToken: ''
  agentTokenConfigured: boolean
  baseUrlSource: 'database' | 'env' | 'default'
  agentTokenSource: 'database' | 'env' | 'default'
  enabledSource: 'database' | 'env' | 'default'
}

export type BrokerRunStatus = BrokerRun['status']
export type BrokerRuntimeState = 'running' | 'disabled' | 'misconfigured' | 'paused_no_usable_accounts' | 'maintenance_stopping'
export type BrokerRunListQuery = {
  page?: number
  pageSize?: number
  status?: string
  q?: string
}

type LegacyBrokerConfig = Partial<BrokerConfig>

type LegacyBrokerRun = {
  id?: string
  taskId?: string
  participationId?: string | null
  status?: string
  failureCode?: string | null
  message?: string
  createdAt?: string
  updatedAt?: string
  payloadSummary?: {
    provider?: string
    fileId?: string
    fileName?: string
    fileSizeBytes?: number
  } | null
}

type BrokerTask = {
  task_id: string
}

type BrokerParticipation = {
  participation_id: string
  task_id: string
  status: string
  next_poll_after?: number
}

type BrokerParticipationPoll = {
  status?: string
  next_poll_after?: number
  task_payload?: unknown
  parse_deadline?: string
}

type BrokerTaskPayload = {
  provider: string
  file_id: string
  file_name: string
  file_size: number
  file_size_bytes: number
  share_url: string
  dir: string
  password?: string
}

type RuntimeEventInput = {
  runId?: string | null
  taskId?: string | null
  participationId?: string | null
  type: string
  status?: 'info' | 'success' | 'failed' | 'warning'
  code?: string | null
  message: string
  details?: Record<string, unknown> | null
}

const brokerConfigKey = 'agent_broker_config'
const legacyBrokerRunsKey = 'agent_broker_runs'
const maxAllowedConcurrentRuns = 5
const brokerRequestTimeoutMs = 30_000
const activeRunStatuses: BrokerRunStatus[] = ['idle', 'polling', 'participating', 'waiting', 'active', 'parsing', 'submitting']
const terminalStatuses = new Set<BrokerRunStatus>(['success', 'failed', 'not_selected', 'expired', 'submitted_success', 'submitted_failure'])

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let runtimeStarted = false
let pollLoopRunning = false
let heartbeatLoopRunning = false
let pollLoopStartedAt: Date | null = null
let heartbeatLoopStartedAt: Date | null = null
const runningExecutions = new Set<string>()
let legacyConfigMigrated = false
let maintenanceStopping = false

const queryJson = <T>(key: string, fallback: T): T => {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

const setJson = (key: string, value: unknown) => {
  db.insert(appSettings)
    .values({
      key,
      value: JSON.stringify(value),
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: JSON.stringify(value),
        updatedAt: new Date(),
      },
    })
    .run()
}

const clampSeconds = (value: unknown, fallback: number, min: number, max: number) => {
  const numeric = Math.floor(Number(value))
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

const clampConcurrentRuns = (value: unknown, fallback = 2) => {
  const numeric = Math.floor(Number(value))
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(maxAllowedConcurrentRuns, numeric))
}

const defaultBrokerConfig = (): BrokerConfig => ({
  baseUrl: getSettingString('brokerBaseUrl'),
  agentToken: getSettingString('brokerAgentToken'),
  enabled: getSettingBoolean('brokerEnabled'),
  heartbeatIntervalSeconds: getSettingNumber('brokerHeartbeatIntervalSeconds'),
  pollIntervalSeconds: getSettingNumber('brokerPollIntervalSeconds'),
  maxConcurrentRuns: getSettingNumber('brokerMaxConcurrentRuns'),
  lastHeartbeatAt: null,
  lastHeartbeatStatus: 'idle',
  lastHeartbeatHttpStatus: null,
  lastHeartbeatErrorCode: null,
  lastHeartbeatErrorMessage: null,
  lastPollAt: null,
  lastPollStatus: 'idle',
  lastPollHttpStatus: null,
  lastPollErrorCode: null,
  lastPollErrorMessage: null,
  lastRequestBaseUrl: null,
  lastError: null,
})

const getBrokerRuntimeState = () => queryJson<LegacyBrokerConfig>(brokerConfigKey, {})

const migrateLegacyBrokerConfig = () => {
  if (legacyConfigMigrated) return
  legacyConfigMigrated = true
  const legacy = getBrokerRuntimeState()
  if (typeof legacy.baseUrl === 'string' && legacy.baseUrl && !readSettingRaw(settingKeys.brokerBaseUrl)) {
    setSetting('brokerBaseUrl', legacy.baseUrl)
  }
  if (typeof legacy.agentToken === 'string' && legacy.agentToken && !readSettingRaw(settingKeys.brokerAgentToken)) {
    setSetting('brokerAgentToken', legacy.agentToken)
  }
  if (typeof legacy.enabled === 'boolean' && !readSettingRaw(settingKeys.brokerEnabled)) {
    setSetting('brokerEnabled', legacy.enabled)
  }
  if (legacy.heartbeatIntervalSeconds !== undefined && !readSettingRaw(settingKeys.brokerHeartbeatIntervalSeconds)) {
    setSetting('brokerHeartbeatIntervalSeconds', legacy.heartbeatIntervalSeconds)
  }
  if (legacy.pollIntervalSeconds !== undefined && !readSettingRaw(settingKeys.brokerPollIntervalSeconds)) {
    setSetting('brokerPollIntervalSeconds', legacy.pollIntervalSeconds)
  }
  if (legacy.maxConcurrentRuns !== undefined && !readSettingRaw(settingKeys.brokerMaxConcurrentRuns)) {
    setSetting('brokerMaxConcurrentRuns', legacy.maxConcurrentRuns)
  }
}

const normalizeBrokerConfig = (configValue: LegacyBrokerConfig): BrokerConfig => {
  const fallback = defaultBrokerConfig()
  return {
    baseUrl: fallback.baseUrl,
    agentToken: fallback.agentToken,
    enabled: fallback.enabled,
    heartbeatIntervalSeconds: clampSeconds(fallback.heartbeatIntervalSeconds, fallback.heartbeatIntervalSeconds, 5, 3600),
    pollIntervalSeconds: clampSeconds(fallback.pollIntervalSeconds, fallback.pollIntervalSeconds, 3, 3600),
    maxConcurrentRuns: clampConcurrentRuns(fallback.maxConcurrentRuns, fallback.maxConcurrentRuns),
    lastHeartbeatAt: typeof configValue.lastHeartbeatAt === 'string' ? configValue.lastHeartbeatAt : null,
    lastHeartbeatStatus:
      configValue.lastHeartbeatStatus === 'ok' || configValue.lastHeartbeatStatus === 'failed' ? configValue.lastHeartbeatStatus : fallback.lastHeartbeatStatus,
    lastHeartbeatHttpStatus: Number.isFinite(Number(configValue.lastHeartbeatHttpStatus)) ? Number(configValue.lastHeartbeatHttpStatus) : null,
    lastHeartbeatErrorCode: typeof configValue.lastHeartbeatErrorCode === 'string' ? configValue.lastHeartbeatErrorCode : null,
    lastHeartbeatErrorMessage: typeof configValue.lastHeartbeatErrorMessage === 'string' ? configValue.lastHeartbeatErrorMessage : null,
    lastPollAt: typeof configValue.lastPollAt === 'string' ? configValue.lastPollAt : null,
    lastPollStatus: configValue.lastPollStatus === 'ok' || configValue.lastPollStatus === 'failed' ? configValue.lastPollStatus : fallback.lastPollStatus,
    lastPollHttpStatus: Number.isFinite(Number(configValue.lastPollHttpStatus)) ? Number(configValue.lastPollHttpStatus) : null,
    lastPollErrorCode: typeof configValue.lastPollErrorCode === 'string' ? configValue.lastPollErrorCode : null,
    lastPollErrorMessage: typeof configValue.lastPollErrorMessage === 'string' ? configValue.lastPollErrorMessage : null,
    lastRequestBaseUrl: typeof configValue.lastRequestBaseUrl === 'string' ? configValue.lastRequestBaseUrl : null,
    lastError: typeof configValue.lastError === 'string' ? configValue.lastError : null,
  }
}

export const getBrokerConfig = () => {
  migrateLegacyBrokerConfig()
  return normalizeBrokerConfig(getBrokerRuntimeState())
}

export const getPublicBrokerConfig = (broker = getBrokerConfig()): PublicBrokerConfig => ({
  ...broker,
  agentToken: '',
  agentTokenConfigured: Boolean(broker.agentToken),
  baseUrlSource: getSettingWithSource('brokerBaseUrl').source,
  agentTokenSource: getSettingWithSource('brokerAgentToken').source,
  enabledSource: getSettingWithSource('brokerEnabled').source,
})

const saveBrokerRuntimeState = (configValue: Partial<BrokerConfig>) => {
  const current = getBrokerRuntimeState()
  const pick = <K extends keyof BrokerConfig>(key: K, fallback: BrokerConfig[K]) =>
    Object.prototype.hasOwnProperty.call(configValue, key) ? configValue[key] : ((current[key] as BrokerConfig[K] | undefined) ?? fallback)
  setJson(brokerConfigKey, {
    lastHeartbeatAt: pick('lastHeartbeatAt', null),
    lastHeartbeatStatus: pick('lastHeartbeatStatus', 'idle'),
    lastHeartbeatHttpStatus: pick('lastHeartbeatHttpStatus', null),
    lastHeartbeatErrorCode: pick('lastHeartbeatErrorCode', null),
    lastHeartbeatErrorMessage: pick('lastHeartbeatErrorMessage', null),
    lastPollAt: pick('lastPollAt', null),
    lastPollStatus: pick('lastPollStatus', 'idle'),
    lastPollHttpStatus: pick('lastPollHttpStatus', null),
    lastPollErrorCode: pick('lastPollErrorCode', null),
    lastPollErrorMessage: pick('lastPollErrorMessage', null),
    lastRequestBaseUrl: pick('lastRequestBaseUrl', null),
    lastError: pick('lastError', null),
  })
}

export const updateBrokerConfig = (input: {
  baseUrl: string
  agentToken: string
  enabled?: boolean
  heartbeatIntervalSeconds?: number
  pollIntervalSeconds?: number
  maxConcurrentRuns?: number
}) => {
  const current = getBrokerConfig()
  setSetting('brokerBaseUrl', input.baseUrl)
  setSetting('brokerAgentToken', input.agentToken)
  setSetting('brokerEnabled', input.enabled ?? current.enabled)
  setSetting('brokerHeartbeatIntervalSeconds', input.heartbeatIntervalSeconds ?? current.heartbeatIntervalSeconds)
  setSetting('brokerPollIntervalSeconds', input.pollIntervalSeconds ?? current.pollIntervalSeconds)
  setSetting('brokerMaxConcurrentRuns', input.maxConcurrentRuns ?? current.maxConcurrentRuns)
  saveBrokerRuntimeState({ lastError: null })
  const next = getBrokerConfig()
  ensureRuntimeTimers()
  return next
}

const writeBrokerConfigPatch = (patch: Partial<BrokerConfig>) => {
  saveBrokerRuntimeState(patch)
}

const brokerHeaders = (configValue: BrokerConfig) => ({
  Authorization: `Bearer ${configValue.agentToken}`,
  'Content-Type': 'application/json',
})

const brokerDraftHeaders = (agentToken: string) => ({
  Authorization: `Bearer ${agentToken}`,
  'Content-Type': 'application/json',
})

const brokerTimeoutError = (targetUrl: string) =>
  upstreamError('BROKER_REQUEST_TIMEOUT', `Broker 请求超过 ${Math.round(brokerRequestTimeoutMs / 1000)} 秒未响应`, {
    httpStatus: null,
    targetUrl,
  })

const requestBrokerJson = async <T>(
  path: string,
  options: {
    method?: 'GET' | 'POST'
    body?: unknown
  },
) => {
  const broker = getBrokerConfig()
  if (!broker.baseUrl || !broker.agentToken || !broker.enabled) {
    const reason = !broker.baseUrl ? 'Broker Base URL 未配置' : !broker.agentToken ? 'Agent Token 未配置' : 'Broker 执行未启用'
    throw badRequest('BROKER_NOT_CONFIGURED', reason, {
      targetUrl: broker.baseUrl || null,
      httpStatus: null,
    })
  }
  const targetUrl = new URL(path, broker.baseUrl).toString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), brokerRequestTimeoutMs)
  let response: Response
  try {
    response = await fetch(targetUrl, {
      method: options.method ?? 'GET',
      headers: brokerHeaders(broker),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw brokerTimeoutError(targetUrl)
    throw error
  } finally {
    clearTimeout(timeout)
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const error = upstreamError(
      typeof json?.code === 'string' ? json.code : 'BROKER_REQUEST_FAILED',
      typeof json?.message === 'string' ? json.message : `Broker 请求失败: ${response.status}`,
      {
        ...(json ?? {}),
        httpStatus: response.status,
        targetUrl,
      },
    )
    throw error
  }
  return json as T
}

export const verifyBrokerDraftConfig = async (input: { baseUrl: string; agentToken: string }) => {
  const targetUrl = new URL('/api/lc/agent/heartbeat', input.baseUrl).toString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), brokerRequestTimeoutMs)
  let response: Response
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: brokerDraftHeaders(input.agentToken),
      body: JSON.stringify({
        available: true,
        capabilities: buildCapabilities(),
        client_version: agentClientVersion,
        client_info: buildClientInfo(),
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw brokerTimeoutError(targetUrl)
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    throw upstreamError(
      typeof json?.code === 'string' ? json.code : 'BROKER_VERIFY_FAILED',
      typeof json?.message === 'string' ? json.message : `Broker 连接检测失败: ${response.status}`,
      {
        ...(json ?? {}),
        httpStatus: response.status,
        targetUrl,
      },
    )
  }

  const status = typeof json?.status === 'string' ? json.status : ''
  if (status !== 'ok' && status !== 'too_early') {
    throw upstreamError('BROKER_VERIFY_FAILED', status ? `Broker 返回未知状态: ${status}` : 'Broker 返回不是有效 heartbeat 响应', {
      ...(json ?? {}),
      httpStatus: response.status,
      targetUrl,
    })
  }

  return {
    ok: true,
    status,
    nextPollAfter: Number.isFinite(Number(json?.next_poll_after)) ? Number(json?.next_poll_after) : null,
    targetUrl,
  }
}

export const appErrorInfo = (error: unknown) => {
  if (error && typeof error === 'object') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null
    const message = 'message' in error && typeof error.message === 'string' ? error.message : null
    const details = 'details' in error ? error.details : undefined
    const httpStatus = details && typeof details === 'object' && details !== null && 'httpStatus' in details ? Number(details.httpStatus) : null
    const targetUrl =
      details && typeof details === 'object' && details !== null && 'targetUrl' in details && typeof details.targetUrl === 'string' ? details.targetUrl : null
    if (code || message) {
      return {
        code: code ?? 'UNKNOWN_ERROR',
        message: message ?? code ?? '未知错误',
        httpStatus: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
        targetUrl,
      }
    }
  }
  if (error instanceof Error) return { code: 'UNKNOWN_ERROR', message: error.message, httpStatus: null, targetUrl: null }
  return { code: 'UNKNOWN_ERROR', message: unknownErrorMessage(error), httpStatus: null, targetUrl: null }
}

const mapFailureCode = (code: string, message: string) => {
  const text = `${code} ${message}`.toLowerCase()
  if (text.includes('bad_share_url') || text.includes('invalid_share_link') || text.includes('链接错误')) return 'INVALID_SHARE_LINK'
  if (text.includes('过期') || text.includes('share_expired')) return 'SHARE_EXPIRED'
  if (text.includes('提取码错误') || text.includes('password') || text.includes('pwd')) return 'PASSWORD_REQUIRED_OR_INVALID'
  if (text.includes('not_found') || text.includes('fs_id_not_found') || text.includes('文件不存在')) return 'FILE_NOT_FOUND'
  if (text.includes('local_account_unavailable') || text.includes('没有可用本地账号')) return 'PARSE_FAILED'
  if (text.includes('parse_failed')) return 'PARSE_FAILED'
  return 'UNKNOWN_ERROR'
}

const runFailureCode = (code: string, message: string) => {
  if (code === 'LOCAL_ACCOUNT_UNAVAILABLE') return code
  return mapFailureCode(code, message)
}

const serializeDetails = (details?: Record<string, unknown> | null) => (details ? JSON.stringify(details) : null)

const recordBrokerEvent = (input: RuntimeEventInput) => {
  if (maintenanceStopping) return
  db.insert(brokerRunEvents)
    .values({
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      participationId: input.participationId ?? null,
      type: input.type,
      status: input.status ?? 'info',
      code: input.code ?? null,
      message: input.message,
      details: serializeDetails(input.details),
    })
    .run()
}

const activeRunCondition = () => inArray(brokerRuns.status, activeRunStatuses)

const activeRuns = () => db.select().from(brokerRuns).where(activeRunCondition()).orderBy(desc(brokerRuns.updatedAt)).all()

const countActiveRuns = () => {
  const [row] = db.select({ value: sql<number>`COUNT(*)` }).from(brokerRuns).where(activeRunCondition()).all()
  return Number(row.value)
}

const findActiveRunForTask = (taskId: string) =>
  db
    .select()
    .from(brokerRuns)
    .where(and(eq(brokerRuns.taskId, taskId), activeRunCondition()))
    .get()

const findActiveRunForParticipation = (participationId: string) =>
  db
    .select()
    .from(brokerRuns)
    .where(and(eq(brokerRuns.participationId, participationId), activeRunCondition()))
    .get()

const normalizeStatus = (status: string): BrokerRunStatus => {
  if (status === 'SUBMITTED_SUCCESS') return 'submitted_success'
  if (status === 'SUBMITTED_FAILURE') return 'submitted_failure'
  if (status === 'NOT_SELECTED') return 'not_selected'
  if (status === 'EXPIRED') return 'expired'
  if (status === 'ACTIVE') return 'active'
  if (status === 'CANDIDATE_WAITING' || status === 'APPLIED') return 'waiting'
  return 'polling'
}

const updateRun = (runId: string, patch: Partial<BrokerRun>) => {
  db.update(brokerRuns)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(brokerRuns.id, runId))
    .run()
}

const finishRun = (runId: string, patch: Partial<BrokerRun> & { status: BrokerRunStatus }) => {
  updateRun(runId, {
    ...patch,
    finishedAt: new Date(),
  })
}

const createRun = (taskId: string, participation?: BrokerParticipation) => {
  const now = new Date()
  const runId = crypto.randomUUID()
  db.insert(brokerRuns)
    .values({
      id: runId,
      taskId,
      participationId: participation?.participation_id ?? null,
      status: participation ? 'participating' : 'idle',
      message: participation ? '已参与任务，等待激活' : '准备参与任务',
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  recordBrokerEvent({
    runId,
    taskId,
    participationId: participation?.participation_id ?? null,
    type: participation ? 'participation_created' : 'run_created',
    message: participation ? '已创建 Participation' : '已创建 Broker run',
    details: participation ? { status: participation.status } : null,
  })
  return db.select().from(brokerRuns).where(eq(brokerRuns.id, runId)).get()!
}

const setRunParticipation = (runId: string, participation: BrokerParticipation) => {
  updateRun(runId, {
    participationId: participation.participation_id,
    status: 'participating',
    message: '已参与任务，等待激活',
    nextPollAt: nextPollAt(participation.next_poll_after),
  })
  recordBrokerEvent({
    runId,
    taskId: participation.task_id,
    participationId: participation.participation_id,
    type: 'participation_created',
    message: '已创建 Participation',
    details: { status: participation.status, nextPollAfter: participation.next_poll_after },
  })
}

const nextPollAt = (seconds?: number) => new Date(Date.now() + Math.max(1, Number(seconds ?? 2)) * 1000)

const sleepUntil = async (date: Date | null) => {
  if (!date) return
  const waitMs = date.getTime() - Date.now()
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
}

const parseIsoDate = (value?: string) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const listLocallyAvailableAccounts = () => {
  const now = new Date()
  return db
    .select()
    .from(baiduAccounts)
    .where(
      and(
        eq(baiduAccounts.status, 'active'),
        or(isNull(baiduAccounts.cooldownUntil), lt(baiduAccounts.cooldownUntil, now)),
        eq(baiduAccounts.healthStatus, 'healthy'),
        eq(baiduAccounts.isSvip, true),
        or(sql`${baiduAccounts.credentialSource} != 'open_platform'`, inArray(baiduAccounts.tokenStatus, ['valid', 'refreshed'])),
      ),
    )
    .all()
}

const listBlockedAccounts = () =>
  db
    .select()
    .from(baiduAccounts)
    .orderBy(sql`${baiduAccounts.id} ASC`)
    .all()
    .filter((account) => !isUsableLocalAccount(account))

const linkProxyFeatures = () => {
  const proxy = getLinkProxyConfig()
  if (!proxy.enabled) return []
  return [`link_proxy:${proxy.version}`]
}

export const buildCapabilities = () => {
  const features = linkProxyFeatures()
  const resultLinkTtlSeconds = getDownloadSettings().linkCacheTtlSeconds
  return {
    schemaVersion: 1,
    providers: ['baidu'],
    features,
    providerCapabilities: {
      baidu: {
        features,
        resultLinkTtlSeconds,
      },
    },
  }
}

export const buildClientInfo = () => ({
  name: 'lc-agent',
  version: agentVersion,
  runtime: config.desktopMode ? 'desktop' : 'daemon',
  platform: process.platform,
  arch: process.arch,
})

const runtimeStateFor = (broker = getBrokerConfig(), usableAccountCount = listLocallyAvailableAccounts().length) => {
  if (maintenanceStopping) return { state: 'maintenance_stopping' as const, message: '本地维护中，Broker 执行已暂停' }
  if (!broker.enabled) return { state: 'disabled' as const, message: 'Broker 执行未启用' }
  if (!broker.baseUrl || !broker.agentToken) return { state: 'misconfigured' as const, message: 'Broker Base URL 或 Agent Token 未配置' }
  if (usableAccountCount <= 0) return { state: 'paused_no_usable_accounts' as const, message: '无可用 SVIP 账号，Broker 执行已暂停' }
  return { state: 'running' as const, message: 'Broker 执行正常运行' }
}

const brokerRequestLockTimeoutMs = () => brokerRequestTimeoutMs + 5000

const cleanupStaleRuntimeLocks = () => {
  const now = Date.now()
  const staleMs = brokerRequestLockTimeoutMs()
  if (heartbeatLoopRunning && heartbeatLoopStartedAt && now - heartbeatLoopStartedAt.getTime() > staleMs) {
    heartbeatLoopRunning = false
    heartbeatLoopStartedAt = null
    recordBrokerEvent({
      type: 'heartbeat',
      status: 'warning',
      code: 'BROKER_HEARTBEAT_STALE_LOCK',
      message: 'Heartbeat 运行锁超时，已自动恢复',
    })
  }
  if (pollLoopRunning && pollLoopStartedAt && now - pollLoopStartedAt.getTime() > staleMs) {
    pollLoopRunning = false
    pollLoopStartedAt = null
    recordBrokerEvent({
      type: 'poll',
      status: 'warning',
      code: 'BROKER_POLL_STALE_LOCK',
      message: 'Poll 运行锁超时，已自动恢复',
    })
  }
}

export const heartbeatBroker = async () => {
  if (maintenanceStopping) return getBrokerConfig()
  cleanupStaleRuntimeLocks()
  if (heartbeatLoopRunning) return getBrokerConfig()
  heartbeatLoopRunning = true
  heartbeatLoopStartedAt = new Date()
  const broker = getBrokerConfig()
  if (!broker.enabled || !broker.baseUrl || !broker.agentToken) {
    heartbeatLoopRunning = false
    heartbeatLoopStartedAt = null
    return broker
  }
  const accounts = listLocallyAvailableAccounts()
  const state = runtimeStateFor(broker, accounts.length)
  if (state.state !== 'running') {
    heartbeatLoopRunning = false
    heartbeatLoopStartedAt = null
    return getBrokerConfig()
  }
  try {
    const response = await requestBrokerJson<Record<string, unknown>>('/api/lc/agent/heartbeat', {
      method: 'POST',
      body: {
        available: true,
        capabilities: buildCapabilities(),
        client_version: agentClientVersion,
        client_info: buildClientInfo(),
      },
    })
    const tooEarly = String(response.status ?? '') === 'too_early'
    writeBrokerConfigPatch({
      lastHeartbeatAt: new Date().toISOString(),
      lastHeartbeatStatus: 'ok',
      lastHeartbeatHttpStatus: 200,
      lastHeartbeatErrorCode: null,
      lastHeartbeatErrorMessage: null,
      lastRequestBaseUrl: broker.baseUrl,
      lastError: null,
    })
    recordBrokerEvent({
      type: 'heartbeat',
      status: tooEarly ? 'warning' : 'success',
      code: tooEarly ? 'BROKER_HEARTBEAT_TOO_EARLY' : null,
      message: tooEarly ? 'Heartbeat 被 Broker 轮询租约限制' : 'Heartbeat 成功',
    })
  } catch (error) {
    const info = appErrorInfo(error)
    writeBrokerConfigPatch({
      lastHeartbeatAt: new Date().toISOString(),
      lastHeartbeatStatus: 'failed',
      lastHeartbeatHttpStatus: info.httpStatus,
      lastHeartbeatErrorCode: info.code,
      lastHeartbeatErrorMessage: info.message,
      lastRequestBaseUrl: broker.baseUrl,
      lastError: info.message,
    })
    recordBrokerEvent({
      type: 'heartbeat',
      status: 'failed',
      code: info.code,
      message: info.message,
    })
  } finally {
    heartbeatLoopRunning = false
    heartbeatLoopStartedAt = null
  }
  return getBrokerConfig()
}

const parsePayload = (payload: unknown): BrokerTaskPayload => {
  if (!payload || typeof payload !== 'object') {
    throw badRequest('BROKER_PAYLOAD_MISSING', 'Broker 未返回任务 payload')
  }
  const value = payload as Record<string, unknown>
  const parsed = {
    provider: String(value.provider ?? 'baidu'),
    file_id: String(value.file_id ?? ''),
    file_name: String(value.file_name ?? ''),
    file_size: Number(value.file_size ?? value.file_size_bytes ?? 0),
    file_size_bytes: Number(value.file_size_bytes ?? value.file_size ?? 0),
    share_url: String(value.share_url ?? ''),
    dir: typeof value.dir === 'string' && value.dir.trim() ? value.dir.trim() : '/',
    password: typeof value.password === 'string' ? value.password : undefined,
  }
  if (!parsed.file_id || !parsed.share_url) {
    throw badRequest('BROKER_PAYLOAD_INVALID', 'Broker payload 缺少 file_id 或 share_url')
  }
  return parsed
}

const submitFailure = async (participationId: string, code: string, message: string) => {
  await requestBrokerJson(`/api/lc/agent/participations/${participationId}/submit`, {
    method: 'POST',
    body: {
      type: 'failure',
      failure_code: mapFailureCode(code, message),
      note: message,
    },
  })
}

const submitSuccess = async (participationId: string, first: Record<string, unknown>) => {
  await requestBrokerJson(`/api/lc/agent/participations/${participationId}/submit`, {
    method: 'POST',
    body: {
      type: 'success',
      result_url: String(Array.isArray(first.urls) ? (first.urls[0] ?? '') : ''),
      expires_at: String(first.link_expires_at ?? new Date(Date.now() + getDownloadSettings().linkCacheTtlSeconds * 1000).toISOString()),
      headers: {
        'User-Agent': String(first.ua ?? ''),
      },
      note: 'Submitted by local agent',
    },
  })
}

const executeActivePayload = async (run: BrokerRun, participationId: string, payload: BrokerTaskPayload, parseDeadline?: Date | null) => {
  updateRun(run.id, {
    status: 'parsing',
    message: '本地执行解析中',
    provider: payload.provider,
    fileId: payload.file_id,
    fileName: payload.file_name,
    fileSizeBytes: payload.file_size_bytes,
  })
  recordBrokerEvent({
    runId: run.id,
    taskId: run.taskId,
    participationId,
    type: 'parse_started',
    message: '本地解析开始',
    details: {
      provider: payload.provider,
      fileId: payload.file_id,
      fileName: payload.file_name,
      fileSizeBytes: payload.file_size_bytes,
      dir: payload.dir,
    },
  })

  try {
    const waitDeadline = parseDeadline ? new Date(parseDeadline.getTime() - 2000) : undefined
    const localResult = await parseLinksForBroker(
      {
        shareUrl: payload.share_url,
        pwd: payload.password,
        dir: payload.dir,
        fsIds: [payload.file_id],
      },
      ensureSystemUser(),
      {
        accountWait: {
          deadline: waitDeadline,
          onWait: ({ waitMs }) => {
            updateRun(run.id, {
              status: 'parsing',
              message: '等待可用本地账号',
            })
            recordBrokerEvent({
              runId: run.id,
              taskId: run.taskId,
              participationId,
              type: 'account_waiting',
              message: '等待可用本地账号',
              details: { waitMs, parseDeadline: parseDeadline?.toISOString() },
            })
          },
        },
      },
    )
    const first = localResult[0] as Record<string, unknown>
    updateRun(run.id, {
      status: 'submitting',
      message: '本地解析成功，提交 Broker 中',
      localParseRecordId: Number(first.record_id ?? 0) || null,
    })
    await submitSuccess(participationId, first)
    finishRun(run.id, {
      status: 'success',
      message: '提交成功结果',
    })
    recordBrokerEvent({
      runId: run.id,
      taskId: run.taskId,
      participationId,
      type: 'submit_success',
      status: 'success',
      message: '已提交 success 结果',
      details: { recordId: first.record_id },
    })
  } catch (error) {
    const info = appErrorInfo(error)
    const failureCode = runFailureCode(info.code, info.message)
    try {
      updateRun(run.id, {
        status: 'submitting',
        failureCode,
        message: '本地解析失败，提交 failure 中',
      })
      await submitFailure(participationId, info.code, info.message)
      finishRun(run.id, {
        status: 'failed',
        failureCode,
        message: info.message,
      })
      recordBrokerEvent({
        runId: run.id,
        taskId: run.taskId,
        participationId,
        type: 'submit_failure',
        status: 'failed',
        code: failureCode,
        message: info.message,
      })
    } catch (submitError) {
      const submitInfo = appErrorInfo(submitError)
      finishRun(run.id, {
        status: 'failed',
        failureCode,
        message: submitInfo.message,
      })
      recordBrokerEvent({
        runId: run.id,
        taskId: run.taskId,
        participationId,
        type: 'submit_failure_failed',
        status: 'failed',
        code: submitInfo.code,
        message: submitInfo.message,
      })
    }
  }
}

const executeRun = async (runId: string) => {
  if (maintenanceStopping) return
  if (runningExecutions.has(runId)) return
  runningExecutions.add(runId)
  try {
    let run = db.select().from(brokerRuns).where(eq(brokerRuns.id, runId)).get()
    if (!run || terminalStatuses.has(run.status)) return

    let participationId = run.participationId
    if (!participationId) {
      const existing = findActiveRunForTask(run.taskId)
      if (existing && existing.id !== run.id) {
        finishRun(run.id, {
          status: 'failed',
          failureCode: 'DUPLICATE_ACTIVE_RUN',
          message: '同一 Task 已有运行中的 run',
        })
        return
      }
      const participation = await requestBrokerJson<BrokerParticipation>(`/api/lc/agent/tasks/${run.taskId}/participations`, {
        method: 'POST',
        body: {},
      })
      participationId = participation.participation_id
      const duplicate = findActiveRunForParticipation(participationId)
      if (duplicate && duplicate.id !== run.id) {
        finishRun(run.id, {
          status: 'failed',
          failureCode: 'DUPLICATE_ACTIVE_PARTICIPATION',
          message: '同一 Participation 已有运行中的 run',
        })
        return
      }
      setRunParticipation(run.id, participation)
      run = db.select().from(brokerRuns).where(eq(brokerRuns.id, runId)).get()
      if (!run) return
    }

    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      run = db.select().from(brokerRuns).where(eq(brokerRuns.id, runId)).get()
      if (!run || terminalStatuses.has(run.status)) return
      if (maintenanceStopping) return
      await sleepUntil(run.nextPollAt)
      if (maintenanceStopping) return

      const polled = await requestBrokerJson<BrokerParticipationPoll>(`/api/lc/agent/participations/${participationId}`, {
        method: 'GET',
      })
      const status = String(polled.status ?? '')
      if (status === 'too_early') {
        const next = nextPollAt(polled.next_poll_after)
        updateRun(run.id, {
          nextPollAt: next,
          message: 'Broker 要求稍后轮询',
        })
        continue
      }

      const nextStatus = normalizeStatus(status)
      updateRun(run.id, {
        status: nextStatus,
        nextPollAt: nextPollAt(polled.next_poll_after),
        message: `Participation 状态: ${status || 'UNKNOWN'}`,
      })
      recordBrokerEvent({
        runId: run.id,
        taskId: run.taskId,
        participationId,
        type: 'participation_polled',
        message: `Participation 状态: ${status || 'UNKNOWN'}`,
        details: { nextPollAfter: polled.next_poll_after },
      })

      if (status === 'ACTIVE' && polled.task_payload) {
        await executeActivePayload(run, participationId, parsePayload(polled.task_payload), parseIsoDate(polled.parse_deadline))
        return
      }

      if (nextStatus === 'not_selected' || nextStatus === 'expired' || nextStatus === 'submitted_success' || nextStatus === 'submitted_failure') {
        finishRun(run.id, {
          status: nextStatus,
          message: `Broker 终态: ${status}`,
        })
        recordBrokerEvent({
          runId: run.id,
          taskId: run.taskId,
          participationId,
          type: 'terminal_status',
          status: nextStatus === 'submitted_success' ? 'success' : 'failed',
          message: `Broker 终态: ${status}`,
        })
        return
      }
    }

    finishRun(run.id, {
      status: 'failed',
      failureCode: 'PARTICIPATION_POLL_TIMEOUT',
      message: 'Participation 轮询超时',
    })
  } catch (error) {
    const info = appErrorInfo(error)
    finishRun(runId, {
      status: 'failed',
      failureCode: info.code,
      message: info.message,
    })
    const run = db.select().from(brokerRuns).where(eq(brokerRuns.id, runId)).get()
    recordBrokerEvent({
      runId,
      taskId: run?.taskId,
      participationId: run?.participationId,
      type: 'run_failed',
      status: 'failed',
      code: info.code,
      message: info.message,
    })
  } finally {
    runningExecutions.delete(runId)
  }
}

const startExecution = (runId: string) => {
  void executeRun(runId)
}

const adoptLegacyRuns = () => {
  const existing = db.select({ id: brokerRuns.id }).from(brokerRuns).limit(1).all()
  if (existing.length > 0) return
  const legacy = queryJson<LegacyBrokerRun[]>(legacyBrokerRunsKey, [])
  for (const item of legacy.slice(0, 50)) {
    if (!item.id || !item.taskId) continue
    const status = normalizeLegacyRunStatus(item.status)
    db.insert(brokerRuns)
      .values({
        id: item.id,
        taskId: item.taskId,
        participationId: item.participationId ?? null,
        status,
        failureCode: item.failureCode ?? null,
        message: item.message ?? '',
        provider: item.payloadSummary?.provider ?? null,
        fileId: item.payloadSummary?.fileId ?? null,
        fileName: item.payloadSummary?.fileName ?? null,
        fileSizeBytes: item.payloadSummary?.fileSizeBytes ?? null,
        createdAt: parseDate(item.createdAt) ?? new Date(),
        updatedAt: parseDate(item.updatedAt) ?? new Date(),
        finishedAt: terminalStatuses.has(status) ? (parseDate(item.updatedAt) ?? new Date()) : null,
      })
      .onConflictDoNothing()
      .run()
  }
}

const parseDate = (value?: string) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const normalizeLegacyRunStatus = (status?: string): BrokerRunStatus => {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'submitting') return 'submitting'
  if (status === 'participating') return 'participating'
  if (status === 'polling') return 'polling'
  return 'idle'
}

export const brokerLoop = async () => {
  if (maintenanceStopping) return getBrokerRuntimeSnapshot()
  cleanupStaleRuntimeLocks()
  if (pollLoopRunning) return getBrokerRuntimeSnapshot()
  pollLoopRunning = true
  pollLoopStartedAt = new Date()
  try {
    adoptLegacyRuns()
    const broker = getBrokerConfig()
    if (!broker.enabled || !broker.baseUrl || !broker.agentToken) return getBrokerRuntimeSnapshot()
    const usableAccounts = listLocallyAvailableAccounts()
    const state = runtimeStateFor(broker, usableAccounts.length)
    if (state.state !== 'running') {
      return getBrokerRuntimeSnapshot()
    }
    if (!heartbeatLoopRunning) {
      void heartbeatBroker()
    }

    const capacity = Math.max(0, broker.maxConcurrentRuns - countActiveRuns())
    if (capacity <= 0) {
      writeBrokerConfigPatch({
        lastPollAt: new Date().toISOString(),
        lastPollStatus: 'ok',
        lastPollHttpStatus: 200,
        lastPollErrorCode: null,
        lastPollErrorMessage: null,
        lastRequestBaseUrl: broker.baseUrl,
        lastError: null,
      })
      return getBrokerRuntimeSnapshot()
    }

    const polled = await requestBrokerJson<Record<string, unknown>>(`/api/lc/agent/tasks?limit=${capacity}`, {
      method: 'GET',
    })
    if (String(polled.status ?? '') === 'too_early') {
      writeBrokerConfigPatch({
        lastPollAt: new Date().toISOString(),
        lastPollStatus: 'ok',
        lastPollHttpStatus: 200,
        lastPollErrorCode: null,
        lastPollErrorMessage: null,
        lastRequestBaseUrl: broker.baseUrl,
        lastError: null,
      })
      return getBrokerRuntimeSnapshot()
    }

    const tasks = Array.isArray(polled.tasks) ? (polled.tasks as BrokerTask[]) : []
    let started = 0
    for (const task of tasks) {
      if (!task.task_id || started >= capacity) continue
      if (findActiveRunForTask(task.task_id)) continue
      const run = createRun(task.task_id)
      startExecution(run.id)
      started += 1
    }

    writeBrokerConfigPatch({
      lastPollAt: new Date().toISOString(),
      lastPollStatus: 'ok',
      lastPollHttpStatus: 200,
      lastPollErrorCode: null,
      lastPollErrorMessage: null,
      lastRequestBaseUrl: broker.baseUrl,
      lastError: null,
    })
    recordBrokerEvent({
      type: 'poll',
      status: 'success',
      message: `Poll 成功，启动 ${started} 个 run`,
      details: { taskCount: tasks.length, capacity },
    })
  } catch (error) {
    const info = appErrorInfo(error)
    writeBrokerConfigPatch({
      lastPollAt: new Date().toISOString(),
      lastPollStatus: 'failed',
      lastPollHttpStatus: info.httpStatus,
      lastPollErrorCode: info.code,
      lastPollErrorMessage: info.message,
      lastRequestBaseUrl: getBrokerConfig().baseUrl,
      lastError: info.message,
    })
    recordBrokerEvent({
      type: 'poll',
      status: 'failed',
      code: info.code,
      message: info.message,
    })
  } finally {
    pollLoopRunning = false
    pollLoopStartedAt = null
  }
  return getBrokerRuntimeSnapshot()
}

const accountSnapshot = (account: BaiduAccount) => ({
  id: account.id,
  label: account.label,
  baiduName: account.baiduName,
  credentialSource: account.credentialSource,
  status: account.status,
  healthStatus: account.healthStatus,
  tokenStatus: account.tokenStatus,
  uk: account.uk,
  quotaTotalBytes: account.quotaTotalBytes,
  quotaUsedBytes: account.quotaUsedBytes,
  quotaFreeBytes: account.quotaFreeBytes,
  vipLeftSeconds: account.vipLeftSeconds,
  vipExpiresAt: account.vipExpiresAt,
  lastSuccessAt: account.lastSuccessAt,
  lastFailureAt: account.lastFailureAt,
  lastFailureCode: account.lastFailureCode,
  tokenCheckedAt: account.tokenCheckedAt,
  tokenLastRefreshedAt: account.tokenLastRefreshedAt,
  usabilityReason: accountUsabilityReason(account),
  usabilityMessage: accountUsabilityMessage(accountUsabilityReason(account)),
})

const serializeRun = (run: BrokerRun) => ({
  id: run.id,
  taskId: run.taskId,
  participationId: run.participationId,
  status: run.status,
  failureCode: run.failureCode,
  message: run.message,
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
  startedAt: run.startedAt?.toISOString() ?? null,
  finishedAt: run.finishedAt?.toISOString() ?? null,
  nextPollAt: run.nextPollAt?.toISOString() ?? null,
  localParseRecordId: run.localParseRecordId,
  payloadSummary:
    run.provider || run.fileId || run.fileName
      ? {
          provider: run.provider ?? 'baidu',
          fileId: run.fileId ?? '',
          fileName: run.fileName ?? '',
          fileSizeBytes: Number(run.fileSizeBytes ?? 0),
        }
      : null,
})

export const listRecentBrokerRuns = (limit = 50) => {
  adoptLegacyRuns()
  return db
    .select()
    .from(brokerRuns)
    .orderBy(desc(brokerRuns.updatedAt))
    .limit(Math.max(1, Math.min(200, Math.floor(limit))))
    .all()
    .map(serializeRun)
}

export const listBrokerRuns = (input: BrokerRunListQuery = {}) => {
  adoptLegacyRuns()
  const page = Math.max(1, Math.floor(Number(input.page ?? 1) || 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(input.pageSize ?? 20) || 20)))
  const filters = []
  const statuses: BrokerRunStatus[] = [
    'idle',
    'polling',
    'participating',
    'waiting',
    'active',
    'parsing',
    'submitting',
    'success',
    'failed',
    'not_selected',
    'expired',
    'submitted_success',
    'submitted_failure',
  ]
  if (input.status && statuses.includes(input.status as BrokerRunStatus)) {
    filters.push(eq(brokerRuns.status, input.status as BrokerRunStatus))
  }
  if (input.q?.trim()) {
    const pattern = `%${input.q.trim()}%`
    filters.push(
      or(
        like(brokerRuns.taskId, pattern),
        like(brokerRuns.participationId, pattern),
        like(brokerRuns.fileName, pattern),
        like(brokerRuns.fileId, pattern),
        like(brokerRuns.failureCode, pattern),
        like(brokerRuns.message, pattern),
      )!,
    )
  }
  const where = filters.length > 0 ? and(...filters) : undefined
  const [{ value: total }] = db.select({ value: sql<number>`COUNT(*)` }).from(brokerRuns).where(where).all()
  const records = db
    .select()
    .from(brokerRuns)
    .where(where)
    .orderBy(desc(brokerRuns.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()
    .map(serializeRun)

  return {
    records,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export const listBrokerRunEvents = (runId: string, limit = 100) =>
  db
    .select()
    .from(brokerRunEvents)
    .where(eq(brokerRunEvents.runId, runId))
    .orderBy(desc(brokerRunEvents.createdAt))
    .limit(Math.max(1, Math.min(500, Math.floor(limit))))
    .all()
    .map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
      details: event.details ? (JSON.parse(event.details) as Record<string, unknown>) : null,
    }))

export const getBrokerRunDetail = (runId: string) => {
  adoptLegacyRuns()
  const run = db.select().from(brokerRuns).where(eq(brokerRuns.id, runId)).get()
  if (!run) return null
  return {
    ...serializeRun(run),
    events: listBrokerRunEvents(runId, 200),
  }
}

export const interruptActiveBrokerRuns = (reason = '本地数据维护已中断运行') => {
  const runs = activeRuns()
  for (const run of runs) {
    finishRun(run.id, {
      status: 'failed',
      failureCode: 'LOCAL_MAINTENANCE_INTERRUPTED',
      message: reason,
    })
    recordBrokerEvent({
      runId: run.id,
      taskId: run.taskId,
      participationId: run.participationId,
      type: 'run_interrupted',
      status: 'failed',
      code: 'LOCAL_MAINTENANCE_INTERRUPTED',
      message: reason,
    })
  }
  return runs.length
}

export const beginBrokerMaintenanceStop = () => {
  maintenanceStopping = true
  stopAgentBrokerRuntime()
  return runningExecutions.size
}

export const getActiveBrokerExecutionCount = () => runningExecutions.size

export const endBrokerMaintenanceStop = (options: { restart?: boolean } = {}) => {
  maintenanceStopping = false
  if (options.restart) startAgentBrokerRuntime()
}

export const getBrokerRuntimeSnapshot = () => {
  cleanupStaleRuntimeLocks()
  adoptLegacyRuns()
  const broker = getBrokerConfig()
  const availableAccounts = listLocallyAvailableAccounts()
  const blockedAccounts = listBlockedAccounts()
  const active = activeRuns().map(serializeRun)
  const recent = listRecentBrokerRuns(50)
  const state = runtimeStateFor(broker, availableAccounts.length)

  return {
    broker: getPublicBrokerConfig(broker),
    runtime: {
      state: state.state,
      stateMessage: state.message,
      started: runtimeStarted,
      activeRunCount: active.length,
      capacity: Math.max(0, broker.maxConcurrentRuns - active.length),
      maxConcurrentRuns: broker.maxConcurrentRuns,
      runningExecutions: runningExecutions.size,
      pollLoopRunning,
      heartbeatLoopRunning,
      pollLoopStartedAt: pollLoopStartedAt?.toISOString() ?? null,
      heartbeatLoopStartedAt: heartbeatLoopStartedAt?.toISOString() ?? null,
      requestTimeoutMs: brokerRequestTimeoutMs,
      usableAccountCount: availableAccounts.length,
      blockedAccountCount: blockedAccounts.length,
    },
    activeAccounts: availableAccounts.map(accountSnapshot),
    blockedAccounts: blockedAccounts.map(accountSnapshot),
    activeRuns: active,
    recentRuns: recent,
  }
}

const timerIntervalMs = (seconds: number) => Math.max(1, seconds) * 1000

export const ensureRuntimeTimers = () => {
  const broker = getBrokerConfig()
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (pollTimer) clearInterval(pollTimer)

  heartbeatTimer = setInterval(() => {
    const current = getBrokerConfig()
    if (!current.enabled) return
    void heartbeatBroker()
  }, timerIntervalMs(broker.heartbeatIntervalSeconds))

  pollTimer = setInterval(() => {
    const current = getBrokerConfig()
    if (!current.enabled) return
    void brokerLoop()
  }, timerIntervalMs(broker.pollIntervalSeconds))
}

export const startAgentBrokerRuntime = () => {
  if (runtimeStarted) return
  runtimeStarted = true
  ensureRuntimeTimers()
  for (const run of activeRuns()) {
    if (run.participationId) {
      updateRun(run.id, {
        status: 'failed',
        failureCode: 'AGENT_RESTARTED',
        message: 'Agent 重启，旧运行已中断',
        finishedAt: new Date(),
      })
      recordBrokerEvent({
        runId: run.id,
        taskId: run.taskId,
        participationId: run.participationId,
        type: 'run_interrupted',
        status: 'failed',
        code: 'AGENT_RESTARTED',
        message: 'Agent 重启，旧运行已中断',
      })
    } else {
      db.delete(brokerRuns)
        .where(and(eq(brokerRuns.id, run.id), ne(brokerRuns.status, 'success')))
        .run()
    }
  }
}

export const stopAgentBrokerRuntime = () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  runtimeStarted = false
  heartbeatLoopRunning = false
  pollLoopRunning = false
  heartbeatLoopStartedAt = null
  pollLoopStartedAt = null
}
