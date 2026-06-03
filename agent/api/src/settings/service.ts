import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { agentEnvName, config, hasAgentEnv } from '../config'
import { db } from '../db'
import { appSettings } from '../db/schema'
import { badRequest } from '../lib/errors'

export type SettingSource = 'database' | 'env' | 'default'
export type SettingsGroup = 'desktop' | 'broker' | 'account' | 'download' | 'parse' | 'health' | 'baidu' | 'deployment'

type SettingType = 'number' | 'string' | 'boolean' | 'list'

type SettingDefinition = {
  key: string
  group: SettingsGroup
  label: string
  type: SettingType
  defaultValue: string
  envName: string
  envValue?: string
  min?: number
  max?: number
  integer?: boolean
  allowEmpty?: boolean
  sensitive?: boolean
  editable?: boolean
  placeholder?: string
}

const definitions = {
  desktopExternalAccess: {
    key: 'desktop_external_access_enabled',
    group: 'desktop',
    label: '外部访问',
    type: 'boolean',
    defaultValue: String(config.desktopExternalAccess),
    envName: agentEnvName('DESKTOP_EXTERNAL_ACCESS'),
    envValue: hasAgentEnv('DESKTOP_EXTERNAL_ACCESS') ? String(config.desktopExternalAccess) : undefined,
  },
  brokerEnabled: {
    key: 'broker_enabled',
    group: 'broker',
    label: '启用 Broker 执行',
    type: 'boolean',
    defaultValue: String(config.brokerEnabled),
    envName: agentEnvName('BROKER_ENABLED'),
    envValue: hasAgentEnv('BROKER_ENABLED') ? String(config.brokerEnabled) : undefined,
  },
  brokerBaseUrl: {
    key: 'broker_base_url',
    group: 'broker',
    label: 'Broker Base URL',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('BROKER_BASE_URL'),
    envValue: config.brokerBaseUrl,
    allowEmpty: true,
  },
  brokerAgentToken: {
    key: 'broker_agent_token',
    group: 'broker',
    label: 'Agent Token',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('BROKER_AGENT_TOKEN'),
    envValue: config.brokerAgentToken,
    allowEmpty: true,
    sensitive: true,
  },
  brokerHeartbeatIntervalSeconds: {
    key: 'broker_heartbeat_interval_seconds',
    group: 'broker',
    label: 'Heartbeat 间隔秒数',
    type: 'number',
    defaultValue: '30',
    envName: agentEnvName('BROKER_HEARTBEAT_INTERVAL_SECONDS'),
    envValue: hasAgentEnv('BROKER_HEARTBEAT_INTERVAL_SECONDS') ? String(config.brokerHeartbeatIntervalSeconds) : undefined,
    min: 5,
    max: 3600,
    integer: true,
  },
  brokerPollIntervalSeconds: {
    key: 'broker_poll_interval_seconds',
    group: 'broker',
    label: 'Poll 间隔秒数',
    type: 'number',
    defaultValue: '10',
    envName: agentEnvName('BROKER_POLL_INTERVAL_SECONDS'),
    envValue: hasAgentEnv('BROKER_POLL_INTERVAL_SECONDS') ? String(config.brokerPollIntervalSeconds) : undefined,
    min: 3,
    max: 3600,
    integer: true,
  },
  brokerMaxConcurrentRuns: {
    key: 'broker_max_concurrent_runs',
    group: 'broker',
    label: '最大并发 Runs',
    type: 'number',
    defaultValue: '2',
    envName: agentEnvName('BROKER_MAX_CONCURRENT_RUNS'),
    envValue: hasAgentEnv('BROKER_MAX_CONCURRENT_RUNS') ? String(config.brokerMaxConcurrentRuns) : undefined,
    min: 1,
    max: 5,
    integer: true,
  },
  accountLockSeconds: {
    key: 'account_lock_seconds',
    group: 'account',
    label: '账号锁定秒数',
    type: 'number',
    defaultValue: '90',
    envName: agentEnvName('ACCOUNT_LOCK_SECONDS'),
    envValue: hasAgentEnv('ACCOUNT_LOCK_SECONDS') ? String(config.accountLockSeconds) : undefined,
    min: 10,
    integer: true,
  },
  accountCooldownSeconds: {
    key: 'account_cooldown_seconds',
    group: 'account',
    label: '账号冷却秒数',
    type: 'number',
    defaultValue: String(30 * 60),
    envName: agentEnvName('ACCOUNT_COOLDOWN_SECONDS'),
    envValue: hasAgentEnv('ACCOUNT_COOLDOWN_SECONDS') ? String(config.accountCooldownSeconds) : undefined,
    min: 60,
    integer: true,
  },
  maxAccountAttempts: {
    key: 'max_account_attempts',
    group: 'account',
    label: '最大尝试次数',
    type: 'number',
    defaultValue: '5',
    envName: agentEnvName('MAX_ACCOUNT_ATTEMPTS'),
    envValue: hasAgentEnv('MAX_ACCOUNT_ATTEMPTS') ? String(config.maxAccountAttempts) : undefined,
    min: 1,
    integer: true,
  },
  showCookieAccountAddButton: {
    key: 'show_cookie_account_add_button',
    group: 'account',
    label: '显示 Cookie 添加入口',
    type: 'boolean',
    defaultValue: String(config.showCookieAccountAddButton),
    envName: agentEnvName('SHOW_COOKIE_ACCOUNT_ADD_BUTTON'),
    envValue: hasAgentEnv('SHOW_COOKIE_ACCOUNT_ADD_BUTTON') ? String(config.showCookieAccountAddButton) : undefined,
  },
  linkProxyVersion: {
    key: 'link_proxy_version',
    group: 'download',
    label: 'Worker 代理加密方式',
    type: 'string',
    defaultValue: 'none',
    envName: agentEnvName('LINK_PROXY_VERSION'),
    envValue: hasAgentEnv('LINK_PROXY_VERSION') ? config.linkProxyVersion : undefined,
    allowEmpty: true,
  },
  linkProxyBaseUrl: {
    key: 'link_proxy_base_url',
    group: 'download',
    label: 'Worker 代理端点',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('PUBLIC_BASE_URL'),
    envValue: config.linkProxyBaseUrl,
    allowEmpty: true,
  },
  linkProxyV2Endpoints: {
    key: 'link_proxy_v2_endpoints',
    group: 'download',
    label: 'Worker v2 代理端点',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('LINK_PROXY_V2_ENDPOINTS'),
    envValue: config.linkProxyV2Endpoints,
    allowEmpty: true,
  },
  linkProxySecret: {
    key: 'link_proxy_secret',
    group: 'download',
    label: 'Worker 加密密钥',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('URL_ENCRYPTION_KEY'),
    envValue: config.linkProxySecret,
    allowEmpty: true,
    sensitive: true,
  },
  linkCacheTtlSeconds: {
    key: 'link_cache_ttl_seconds',
    group: 'download',
    label: '链接有效期秒数',
    type: 'number',
    defaultValue: String(60 * 60),
    envName: agentEnvName('LINK_CACHE_TTL_SECONDS'),
    envValue: hasAgentEnv('LINK_CACHE_TTL_SECONDS') ? String(config.linkCacheTtlSeconds) : undefined,
    min: 60,
    integer: true,
  },
  tempCleanupIntervalSeconds: {
    key: 'temp_cleanup_interval_seconds',
    group: 'baidu',
    label: '中转清理间隔秒数',
    type: 'number',
    defaultValue: String(60 * 60),
    envName: agentEnvName('TEMP_CLEANUP_INTERVAL_SECONDS'),
    envValue: hasAgentEnv('TEMP_CLEANUP_INTERVAL_SECONDS') ? String(config.tempCleanupIntervalSeconds) : undefined,
    min: 60,
    integer: true,
  },
  directDownloadUA: {
    key: 'baidu_direct_download_ua',
    group: 'download',
    label: '直链下载 UA',
    type: 'string',
    defaultValue: 'pan.baidu.com',
    envName: agentEnvName('BAIDU_DIRECT_DOWNLOAD_UA'),
    envValue: hasAgentEnv('BAIDU_DIRECT_DOWNLOAD_UA') ? config.directDownloadUA : undefined,
  },
  transferDownloadUA: {
    key: 'baidu_transfer_download_ua',
    group: 'download',
    label: '转存下载 UA',
    type: 'string',
    defaultValue: 'netdisk;P2SP;3.0.20.138',
    envName: agentEnvName('BAIDU_TRANSFER_DOWNLOAD_UA'),
    envValue: hasAgentEnv('BAIDU_TRANSFER_DOWNLOAD_UA') ? config.transferDownloadUA : undefined,
  },
  pcsUA: {
    key: 'baidu_pcs_ua',
    group: 'download',
    label: 'PCS 下载 UA',
    type: 'string',
    defaultValue: 'netdisk;P2SP;3.0.20.138',
    envName: agentEnvName('BAIDU_PCS_UA'),
    envValue: hasAgentEnv('BAIDU_PCS_UA') ? config.pcsUA : undefined,
  },
  downloadersJson: {
    key: 'downloaders_json',
    group: 'download',
    label: '下载器配置',
    type: 'string',
    defaultValue: '[]',
    envName: agentEnvName('DOWNLOADERS_JSON'),
    envValue: config.downloadersJson,
    allowEmpty: true,
  },
  requestTimeoutMs: {
    key: 'baidu_request_timeout_ms',
    group: 'parse',
    label: 'Baidu 请求超时 ms',
    type: 'number',
    defaultValue: '20000',
    envName: agentEnvName('BAIDU_REQUEST_TIMEOUT_MS'),
    envValue: hasAgentEnv('BAIDU_REQUEST_TIMEOUT_MS') ? String(config.requestTimeoutMs) : undefined,
    min: 1000,
    integer: true,
  },
  transferDelayMs: {
    key: 'baidu_transfer_delay_ms',
    group: 'parse',
    label: '转存等待 ms',
    type: 'number',
    defaultValue: '800',
    envName: agentEnvName('BAIDU_TRANSFER_DELAY_MS'),
    envValue: hasAgentEnv('BAIDU_TRANSFER_DELAY_MS') ? String(config.transferDelayMs) : undefined,
    min: 0,
    integer: true,
  },
  parseConcurrency: {
    key: 'parse_concurrency',
    group: 'parse',
    label: '解析并发数',
    type: 'number',
    defaultValue: '1',
    envName: agentEnvName('PARSE_CONCURRENCY'),
    envValue: hasAgentEnv('PARSE_CONCURRENCY') ? String(config.parseConcurrency) : undefined,
    min: 1,
    integer: true,
  },
  tempDir: {
    key: 'baidu_temp_dir',
    group: 'baidu',
    label: '网盘临时目录',
    type: 'string',
    defaultValue: '/我的资源/下载',
    envName: agentEnvName('BAIDU_TEMP_DIR'),
    envValue: hasAgentEnv('BAIDU_TEMP_DIR') ? config.tempDir : undefined,
  },
  baiduCookie: {
    key: 'baidu_cookie',
    group: 'baidu',
    label: '默认 Baidu Cookie',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('BAIDU_COOKIE'),
    envValue: config.baiduCookie,
    allowEmpty: true,
    sensitive: true,
  },
  baiduFakeWebUA: {
    key: 'baidu_fake_web_ua',
    group: 'baidu',
    label: 'Baidu Fake Web UA',
    type: 'string',
    defaultValue: config.baiduFakeWebUA,
    envName: agentEnvName('BAIDU_FAKE_WEB_UA'),
    envValue: hasAgentEnv('BAIDU_FAKE_WEB_UA') ? config.baiduFakeWebUA : undefined,
  },
  baiduFakeWxUA: {
    key: 'baidu_fake_wx_ua',
    group: 'baidu',
    label: 'Baidu Fake WX UA',
    type: 'string',
    defaultValue: config.baiduFakeWxUA,
    envName: agentEnvName('BAIDU_FAKE_WX_UA'),
    envValue: hasAgentEnv('BAIDU_FAKE_WX_UA') ? config.baiduFakeWxUA : undefined,
  },
  baiduFakeCookie: {
    key: 'baidu_fake_cookie',
    group: 'baidu',
    label: 'Baidu Fake Cookie',
    type: 'string',
    defaultValue: config.baiduFakeCookie,
    envName: agentEnvName('BAIDU_FAKE_COOKIE'),
    envValue: hasAgentEnv('BAIDU_FAKE_COOKIE') ? config.baiduFakeCookie : undefined,
    sensitive: true,
  },
  accountHealthIntervalSeconds: {
    key: 'account_health_interval_seconds',
    group: 'health',
    label: '健康检查间隔秒数',
    type: 'number',
    defaultValue: String(2 * 60 * 60),
    envName: agentEnvName('ACCOUNT_HEALTH_INTERVAL_SECONDS'),
    envValue: hasAgentEnv('ACCOUNT_HEALTH_INTERVAL_SECONDS') ? String(config.accountHealthIntervalSeconds) : undefined,
    min: 60,
    integer: true,
  },
  accountHealthLowSpaceBytes: {
    key: 'account_health_low_space_bytes',
    group: 'health',
    label: '低空间阈值 bytes',
    type: 'number',
    defaultValue: String(50 * 1024 * 1024 * 1024),
    envName: agentEnvName('ACCOUNT_HEALTH_LOW_SPACE_BYTES'),
    envValue: hasAgentEnv('ACCOUNT_HEALTH_LOW_SPACE_BYTES') ? String(config.accountHealthLowSpaceBytes) : undefined,
    min: 0,
    integer: true,
  },
  accountHealthHistoryTtlDays: {
    key: 'account_health_history_ttl_days',
    group: 'health',
    label: '健康历史保留天数',
    type: 'number',
    defaultValue: '7',
    envName: agentEnvName('ACCOUNT_HEALTH_HISTORY_TTL_DAYS'),
    envValue: hasAgentEnv('ACCOUNT_HEALTH_HISTORY_TTL_DAYS') ? String(config.accountHealthHistoryTtlDays) : undefined,
    min: 1,
    integer: true,
  },
  accountHealthTransientFailureThreshold: {
    key: 'account_health_transient_failure_threshold',
    group: 'health',
    label: '临时失败阈值',
    type: 'number',
    defaultValue: '3',
    envName: agentEnvName('ACCOUNT_HEALTH_TRANSIENT_FAILURE_THRESHOLD'),
    envValue: hasAgentEnv('ACCOUNT_HEALTH_TRANSIENT_FAILURE_THRESHOLD') ? String(config.accountHealthTransientFailureThreshold) : undefined,
    min: 1,
    integer: true,
  },
  databaseUrl: {
    key: 'deployment_database_url',
    group: 'deployment',
    label: '数据库路径',
    type: 'string',
    defaultValue: config.databaseUrl,
    envName: agentEnvName('DATABASE_URL'),
    envValue: hasAgentEnv('DATABASE_URL') ? config.databaseUrl : undefined,
    editable: false,
    sensitive: true,
  },
  port: {
    key: 'deployment_port',
    group: 'deployment',
    label: 'API Port',
    type: 'number',
    defaultValue: '3100',
    envName: agentEnvName('PORT'),
    envValue: hasAgentEnv('PORT') ? String(config.port) : undefined,
    editable: false,
    min: 1,
    integer: true,
  },
  appOrigin: {
    key: 'deployment_app_origin',
    group: 'deployment',
    label: 'App Origin',
    type: 'string',
    defaultValue: 'http://localhost:3100',
    envName: agentEnvName('APP_ORIGIN'),
    envValue: hasAgentEnv('APP_ORIGIN') ? config.appOrigin : undefined,
    editable: false,
  },
  webDevProxyUrl: {
    key: 'deployment_web_dev_proxy_url',
    group: 'deployment',
    label: 'Web Dev Proxy URL',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('WEB_DEV_PROXY_URL'),
    envValue: config.webDevProxyUrl,
    editable: false,
  },
  webDistRoot: {
    key: 'deployment_web_dist_dir',
    group: 'deployment',
    label: 'Web Dist Dir',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('WEB_DIST_DIR'),
    envValue: config.webDistRoot,
    editable: false,
  },
  migrationsDir: {
    key: 'deployment_migrations_dir',
    group: 'deployment',
    label: 'Migrations Dir',
    type: 'string',
    defaultValue: '',
    envName: agentEnvName('MIGRATIONS_DIR'),
    envValue: config.migrationsDir,
    editable: false,
  },
  nodeEnv: {
    key: 'deployment_node_env',
    group: 'deployment',
    label: 'Node Env',
    type: 'string',
    defaultValue: 'development',
    envName: agentEnvName('NODE_ENV'),
    envValue: hasAgentEnv('NODE_ENV') ? config.nodeEnv : undefined,
    editable: false,
  },
  debug: {
    key: 'deployment_debug',
    group: 'deployment',
    label: 'Debug',
    type: 'boolean',
    defaultValue: String(config.debug),
    envName: agentEnvName('DEBUG'),
    envValue: hasAgentEnv('DEBUG') ? String(config.debug) : undefined,
    editable: false,
  },
} as const satisfies Record<string, SettingDefinition>

export type SettingName = keyof typeof definitions

const definitionEntries = Object.entries(definitions) as Array<[SettingName, SettingDefinition]>

export const settingKeys = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, definition.key])) as Record<SettingName, string>

export const readSettingRaw = (key: string) => db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value.trim() ?? ''

const writeSettingRaw = (key: string, value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    db.delete(appSettings).where(eq(appSettings.key, key)).run()
    return
  }
  db.insert(appSettings)
    .values({ key, value: trimmed })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: trimmed, updatedAt: new Date() } })
    .run()
}

const validateNumberSetting = (definition: SettingDefinition, value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) throw badRequest('BAD_SETTING_VALUE', `${definition.label}必须是数字`)
  const normalized = definition.integer ? Math.floor(numeric) : numeric
  if (definition.min !== undefined && normalized < definition.min) {
    throw badRequest('BAD_SETTING_VALUE', `${definition.label}不能小于 ${definition.min}`)
  }
  if (definition.max !== undefined && normalized > definition.max) {
    throw badRequest('BAD_SETTING_VALUE', `${definition.label}不能大于 ${definition.max}`)
  }
  return String(normalized)
}

const validateBooleanSetting = (definition: SettingDefinition, value: unknown) => {
  if (typeof value === 'boolean') return String(value)
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return 'true'
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return 'false'
  throw badRequest('BAD_SETTING_VALUE', `${definition.label}必须是布尔值`)
}

const normalizeBaseUrl = (value: unknown, label: string) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw badRequest('BAD_BASE_URL', `${label}必须是合法 URL`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('BAD_BASE_URL', `${label}只支持 http 或 https`)
  }
  if (url.search || url.hash) {
    throw badRequest('BAD_BASE_URL', `${label}不能包含查询参数或 hash`)
  }
  return url.toString().replace(/\/+$/, '')
}

const parseEndpointList = (value: unknown) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  let entries: unknown[]
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) throw badRequest('BAD_LINK_PROXY_V2_ENDPOINTS', 'Worker v2 代理端点列表格式不正确')
      entries = parsed
    } catch {
      throw badRequest('BAD_LINK_PROXY_V2_ENDPOINTS', 'Worker v2 代理端点列表格式不正确')
    }
  } else {
    entries = raw
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return Array.from(new Set(entries.map((item) => normalizeBaseUrl(item, 'Worker v2 代理端点')))).join('\n')
}

const validateLinkProxyVersion = (value: unknown) => {
  const version = String(value ?? '').trim() || 'none'
  if (version !== 'none' && version !== 'v1' && version !== 'v2') throw badRequest('BAD_LINK_PROXY_VERSION', 'Worker 代理加密方式只支持无、v1 或 v2')
  return version
}

const normalizeSettingValue = (definition: SettingDefinition, value: unknown) => {
  if (definition.editable === false) throw badRequest('SETTING_READONLY', `${definition.label}不能在页面中修改`)
  if (value === null || value === undefined || String(value).trim() === '') return ''
  if (definition.key === settingKeys.linkProxyVersion) return validateLinkProxyVersion(value)
  if (definition.key === settingKeys.linkProxyV2Endpoints) return parseEndpointList(value)
  if (definition.key === settingKeys.linkProxyBaseUrl || definition.key === settingKeys.brokerBaseUrl) {
    return normalizeBaseUrl(value, definition.label)
  }
  if (definition.type === 'number') return validateNumberSetting(definition, value)
  if (definition.type === 'boolean') return validateBooleanSetting(definition, value)
  const normalized = String(value ?? '').trim()
  if (!normalized && !definition.allowEmpty) throw badRequest('BAD_SETTING_VALUE', `${definition.label}不能为空`)
  return normalized
}

const valueWithSource = (definition: SettingDefinition) => {
  const adminValue = readSettingRaw(definition.key)
  if (adminValue) return { value: adminValue, source: 'database' as SettingSource }
  if (definition.envValue) return { value: definition.envValue, source: 'env' as SettingSource }
  return { value: definition.defaultValue, source: 'default' as SettingSource }
}

const publicValue = (definition: SettingDefinition, value: string) => (definition.sensitive && value ? '' : value)

const displayValue = (definition: SettingDefinition, value: string) => {
  if (!definition.sensitive) return value
  return value ? '已设置' : '未设置'
}

const legacyV1ProxyFromEnv = () => {
  const version = valueWithSource(definitions.linkProxyVersion)
  if (version.value !== 'none' || version.source !== 'default') return false
  const baseUrl = valueWithSource(definitions.linkProxyBaseUrl)
  const secret = valueWithSource(definitions.linkProxySecret)
  return baseUrl.source === 'env' && secret.source === 'env' && Boolean(baseUrl.value && secret.value)
}

const effectiveSettingValue = (name: SettingName, current: { value: string; source: SettingSource }) => {
  if (name === 'linkProxyVersion' && legacyV1ProxyFromEnv()) return 'v1'
  return current.value
}

const publicDefinition = (name: SettingName, definition: SettingDefinition) => {
  const current = valueWithSource(definition)
  const value = effectiveSettingValue(name, current)
  return {
    name,
    key: definition.key,
    group: definition.group,
    label: definition.label,
    type: definition.type,
    envName: definition.envName,
    value: publicValue(definition, value),
    displayValue: displayValue(definition, value),
    source: current.source,
    sensitive: definition.sensitive === true,
    editable: definition.editable !== false,
    min: definition.min,
    max: definition.max,
    integer: definition.integer === true,
    allowEmpty: definition.allowEmpty === true,
    placeholder: definition.placeholder,
  }
}

export const getSettingWithSource = (name: SettingName) => valueWithSource(definitions[name])

export const getSettingString = (name: SettingName) => valueWithSource(definitions[name]).value

export const getSettingNumber = (name: SettingName) => {
  const definition = definitions[name]
  const value = Number(valueWithSource(definition).value)
  const fallback = Number(definition.defaultValue)
  return Number.isFinite(value) ? value : fallback
}

export const getSettingBoolean = (name: SettingName) => valueWithSource(definitions[name]).value === 'true'

export const setSetting = (name: SettingName, value: unknown) => {
  const definition = definitions[name]
  const normalized = normalizeSettingValue(definition, value)
  writeSettingRaw(definition.key, normalized)
  return normalized
}

const validateV2PublicKey = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64').length === 32
}

const publicKeyFingerprint = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return createHash('sha256').update(Buffer.from(padded, 'base64')).digest('hex').slice(0, 16)
}

const normalizedWorkerRuntime = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

const normalizedWorkerVersion = (value: unknown) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

const verifyV2Endpoint = async (endpoint: string) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${endpoint}/lc/v2.auto`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as {
      version?: unknown
      kid?: unknown
      publicKey?: unknown
      tokenPrefix?: unknown
      workerRuntime?: unknown
      workerVersion?: unknown
      maxTokenTtlSeconds?: unknown
    }
    if (data.version !== 'v2' || data.kid !== 'x1') throw new Error('版本或 key id 不匹配')
    if (typeof data.publicKey !== 'string' || !validateV2PublicKey(data.publicKey)) throw new Error('publicKey 无效')
    const maxTokenTtlSeconds = Number(data.maxTokenTtlSeconds)
    const workerRuntime = normalizedWorkerRuntime(data.workerRuntime)
    const workerVersion = normalizedWorkerVersion(data.workerVersion)
    return {
      endpoint,
      kid: data.kid,
      publicKey: data.publicKey,
      publicKeyPreview: `${data.publicKey.slice(0, 12)}...${data.publicKey.slice(-8)}`,
      publicKeyFingerprint: publicKeyFingerprint(data.publicKey),
      tokenPrefix: typeof data.tokenPrefix === 'string' && data.tokenPrefix.trim() ? data.tokenPrefix.trim() : `${endpoint}/lc/v2.x1.`,
      ...(workerRuntime ? { workerRuntime } : {}),
      ...(workerVersion ? { workerVersion } : {}),
      ...(Number.isFinite(maxTokenTtlSeconds) && maxTokenTtlSeconds > 0 ? { maxTokenTtlSeconds: Math.floor(maxTokenTtlSeconds) } : {}),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export const verifyLinkProxyV2Endpoints = async (input: unknown) => {
  const endpointText = parseEndpointList(Array.isArray(input) ? input.join('\n') : input)
  const endpoints = endpointText
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
  if (endpoints.length === 0) throw badRequest('BAD_LINK_PROXY_V2_ENDPOINTS', 'Worker v2 至少需要填写一个代理端点')
  const results = []
  const failures: Array<{ endpoint: string; message: string }> = []
  for (const endpoint of endpoints) {
    try {
      results.push(await verifyV2Endpoint(endpoint))
    } catch (error) {
      failures.push({ endpoint, message: error instanceof Error && error.message ? error.message : '验证失败' })
    }
  }
  return {
    ok: failures.length === 0,
    endpoints,
    results,
    failures,
  }
}

const validateV2Settings = async (values: Partial<Record<SettingName, string>>) => {
  const nextVersion = values.linkProxyVersion ?? getSettingWithSource('linkProxyVersion').value
  if (nextVersion !== 'v2') return
  const endpointText = values.linkProxyV2Endpoints ?? getSettingWithSource('linkProxyV2Endpoints').value
  const endpoints = endpointText
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
  if (endpoints.length === 0) throw badRequest('BAD_LINK_PROXY_V2_ENDPOINTS', 'Worker v2 至少需要填写一个代理端点')
  const failures: Array<{ endpoint: string; message: string }> = []
  for (const endpoint of endpoints) {
    try {
      await verifyV2Endpoint(endpoint)
    } catch (error) {
      failures.push({ endpoint, message: error instanceof Error && error.message ? error.message : '验证失败' })
    }
  }
  if (failures.length > 0) {
    throw badRequest('LINK_PROXY_V2_VALIDATE_FAILED', `Worker v2 代理端点验证失败: ${failures.map((item) => `${item.endpoint} ${item.message}`).join('；')}`, {
      failures,
    })
  }
}

export const setSettings = async (values: Record<string, unknown>) => {
  const normalizedValues: Partial<Record<SettingName, string>> = {}
  for (const [inputName, value] of Object.entries(values)) {
    const name = inputName in definitions ? (inputName as SettingName) : definitionEntries.find(([, definition]) => definition.key === inputName)?.[0]
    if (!name) throw badRequest('UNKNOWN_SETTING', `未知设置项: ${inputName}`)
    normalizedValues[name] = normalizeSettingValue(definitions[name], value)
  }
  await validateV2Settings(normalizedValues)
  for (const [name, value] of Object.entries(normalizedValues) as Array<[SettingName, string]>) {
    writeSettingRaw(definitions[name].key, value)
  }
  return getSettingsSnapshot()
}

export const getSettingsSnapshot = () => {
  const values = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => {
      const current = valueWithSource(definition)
      const value = effectiveSettingValue(name as SettingName, current)
      return [name, publicValue(definition, value)]
    }),
  ) as Record<SettingName, string>
  const sources = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => {
      const current = valueWithSource(definition)
      return [name, current.source]
    }),
  ) as Record<SettingName, SettingSource>
  const items = Object.fromEntries(definitionEntries.map(([name, definition]) => [name, publicDefinition(name, definition)])) as Record<
    SettingName,
    ReturnType<typeof publicDefinition>
  >

  return {
    groups: {
      desktop: definitionEntries.filter(([, item]) => item.group === 'desktop').map(([name, item]) => publicDefinition(name, item)),
      broker: definitionEntries.filter(([, item]) => item.group === 'broker').map(([name, item]) => publicDefinition(name, item)),
      account: definitionEntries.filter(([, item]) => item.group === 'account').map(([name, item]) => publicDefinition(name, item)),
      download: definitionEntries.filter(([, item]) => item.group === 'download').map(([name, item]) => publicDefinition(name, item)),
      parse: definitionEntries.filter(([, item]) => item.group === 'parse').map(([name, item]) => publicDefinition(name, item)),
      health: definitionEntries.filter(([, item]) => item.group === 'health').map(([name, item]) => publicDefinition(name, item)),
      baidu: definitionEntries.filter(([, item]) => item.group === 'baidu').map(([name, item]) => publicDefinition(name, item)),
      deployment: definitionEntries.filter(([, item]) => item.group === 'deployment').map(([name, item]) => publicDefinition(name, item)),
    },
    items,
    values,
    sources,
  }
}

export const getAccountPolicy = () => ({
  accountLockSeconds: Math.max(10, getSettingNumber('accountLockSeconds')),
  accountCooldownSeconds: Math.max(60, getSettingNumber('accountCooldownSeconds')),
  maxAccountAttempts: Math.max(1, getSettingNumber('maxAccountAttempts')),
})

export const getParseLimits = () => ({
  requestTimeoutMs: Math.max(1000, getSettingNumber('requestTimeoutMs')),
  transferDelayMs: Math.max(0, getSettingNumber('transferDelayMs')),
  parseConcurrency: Math.max(1, getSettingNumber('parseConcurrency')),
})

export const getDownloadSettings = () => ({
  directDownloadUA: getSettingString('directDownloadUA'),
  transferDownloadUA: getSettingString('transferDownloadUA'),
  pcsUA: getSettingString('pcsUA'),
  linkCacheTtlSeconds: Math.max(60, getSettingNumber('linkCacheTtlSeconds')),
  tempCleanupIntervalSeconds: Math.max(60, getSettingNumber('tempCleanupIntervalSeconds')),
})

export const getBaiduSettings = () => ({
  baiduCookie: getSettingString('baiduCookie'),
  baiduFakeWebUA: getSettingString('baiduFakeWebUA'),
  baiduFakeWxUA: getSettingString('baiduFakeWxUA'),
  baiduFakeCookie: getSettingString('baiduFakeCookie'),
  tempDir: getSettingString('tempDir'),
})

export const getAccountHealthSettings = () => ({
  accountHealthIntervalSeconds: Math.max(60, getSettingNumber('accountHealthIntervalSeconds')),
  accountHealthLowSpaceBytes: Math.max(0, getSettingNumber('accountHealthLowSpaceBytes')),
  accountHealthHistoryTtlDays: Math.max(1, getSettingNumber('accountHealthHistoryTtlDays')),
  accountHealthTransientFailureThreshold: Math.max(1, getSettingNumber('accountHealthTransientFailureThreshold')),
})
