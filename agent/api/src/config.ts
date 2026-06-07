export type AppConfig = {
  baiduCookie: string
  directDownloadUA: string
  transferDownloadUA: string
  pcsUA: string
  baiduFakeWebUA: string
  baiduFakeWxUA: string
  baiduFakeCookie: string
  tempDir: string
  parseConcurrency: number
  requestTimeoutMs: number
  transferDelayMs: number
  databaseUrl: string
  port: number
  appOrigin: string
  accountLockSeconds: number
  accountCooldownSeconds: number
  maxAccountAttempts: number
  showCookieAccountAddButton: boolean
  linkCacheTtlSeconds: number
  tempCleanupIntervalSeconds: number
  accountHealthIntervalSeconds: number
  accountHealthLowSpaceBytes: number
  accountHealthHistoryTtlDays: number
  accountHealthTransientFailureThreshold: number
  linkProxyBaseUrl: string
  linkProxySecret: string
  linkProxyVersion: string
  linkProxyV2Endpoints: string
  downloadersJson: string
  brokerBaseUrl: string
  brokerAgentToken: string
  brokerEnabled: boolean
  brokerHeartbeatIntervalSeconds: number
  brokerPollIntervalSeconds: number
  brokerMaxConcurrentRuns: number
  webDevProxyUrl: string
  webDistRoot: string
  migrationsDir: string
  desktopMode: boolean
  desktopExternalAccess: boolean
  nodeEnv: string
  debug: boolean
}

export const agentEnvName = (name: string) => `LC_AGENT_${name}`

export const agentEnvRaw = (name: string) => Bun.env[agentEnvName(name)]?.trim() ?? ''

export const hasAgentEnv = (name: string) => agentEnvRaw(name) !== ''

const numberFromEnv = (name: string, fallback: number) => {
  const raw = agentEnvRaw(name)
  if (!raw) return fallback

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

const stringFromEnv = (name: string, fallback: string) => {
  const raw = agentEnvRaw(name)
  return raw || fallback
}

const booleanFromEnv = (name: string, fallback: boolean) => {
  const raw = agentEnvRaw(name).toLowerCase()
  if (!raw) return fallback
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return fallback
}

const defaultDatabaseUrl = new URL('../../../data/agent.sqlite', import.meta.url).pathname
const defaultFakeWebUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const defaultFakeWxUA =
  'Mozilla/5.0 (Linux; Android 7.1.1; MI 6 Build/NMF26X; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/6.2 TBS/043807 Mobile Safari/537.36 MicroMessenger/6.6.1.1220(0x26060135) NetType/4G Language/zh_CN miniProgram'
const defaultFakeCookie = 'BAIDUID=A4FDFAE43DDBF7E6956B02F6EF715373:FG=1; BAIDUID_BFESS=A4FDFAE43DDBF7E6956B02F6EF715373:FG=1; newlogin=1'

export const config: AppConfig = {
  baiduCookie: agentEnvRaw('BAIDU_COOKIE'),
  directDownloadUA: stringFromEnv('BAIDU_DIRECT_DOWNLOAD_UA', 'pan.baidu.com'),
  transferDownloadUA: stringFromEnv('BAIDU_TRANSFER_DOWNLOAD_UA', 'netdisk;P2SP;3.0.20.138'),
  pcsUA: stringFromEnv('BAIDU_PCS_UA', 'netdisk;P2SP;3.0.20.138'),
  baiduFakeWebUA: stringFromEnv('BAIDU_FAKE_WEB_UA', defaultFakeWebUA),
  baiduFakeWxUA: stringFromEnv('BAIDU_FAKE_WX_UA', defaultFakeWxUA),
  baiduFakeCookie: stringFromEnv('BAIDU_FAKE_COOKIE', defaultFakeCookie),
  tempDir: stringFromEnv('BAIDU_TEMP_DIR', '/我的资源/下载'),
  parseConcurrency: Math.max(1, numberFromEnv('PARSE_CONCURRENCY', 1)),
  requestTimeoutMs: Math.max(1000, numberFromEnv('BAIDU_REQUEST_TIMEOUT_MS', 20_000)),
  transferDelayMs: numberFromEnv('BAIDU_TRANSFER_DELAY_MS', 800),
  databaseUrl: stringFromEnv('DATABASE_URL', defaultDatabaseUrl),
  port: Math.max(1, numberFromEnv('PORT', 3100)),
  appOrigin: stringFromEnv('APP_ORIGIN', 'http://localhost:3100'),
  accountLockSeconds: Math.max(10, numberFromEnv('ACCOUNT_LOCK_SECONDS', 90)),
  accountCooldownSeconds: Math.max(60, numberFromEnv('ACCOUNT_COOLDOWN_SECONDS', 30 * 60)),
  maxAccountAttempts: Math.max(1, numberFromEnv('MAX_ACCOUNT_ATTEMPTS', 5)),
  showCookieAccountAddButton: booleanFromEnv('SHOW_COOKIE_ACCOUNT_ADD_BUTTON', false),
  linkCacheTtlSeconds: Math.max(60, numberFromEnv('LINK_CACHE_TTL_SECONDS', 6 * 60 * 60)),
  tempCleanupIntervalSeconds: Math.max(60, numberFromEnv('TEMP_CLEANUP_INTERVAL_SECONDS', 60 * 60)),
  accountHealthIntervalSeconds: Math.max(60, numberFromEnv('ACCOUNT_HEALTH_INTERVAL_SECONDS', 2 * 60 * 60)),
  accountHealthLowSpaceBytes: Math.max(0, numberFromEnv('ACCOUNT_HEALTH_LOW_SPACE_BYTES', 50 * 1024 * 1024 * 1024)),
  accountHealthHistoryTtlDays: Math.max(1, numberFromEnv('ACCOUNT_HEALTH_HISTORY_TTL_DAYS', 7)),
  accountHealthTransientFailureThreshold: Math.max(1, numberFromEnv('ACCOUNT_HEALTH_TRANSIENT_FAILURE_THRESHOLD', 3)),
  linkProxyBaseUrl: stringFromEnv('PUBLIC_BASE_URL', ''),
  linkProxySecret: stringFromEnv('URL_ENCRYPTION_KEY', ''),
  linkProxyVersion: stringFromEnv('LINK_PROXY_VERSION', 'none'),
  linkProxyV2Endpoints: stringFromEnv('LINK_PROXY_V2_ENDPOINTS', ''),
  downloadersJson: stringFromEnv('DOWNLOADERS_JSON', ''),
  brokerBaseUrl: stringFromEnv('BROKER_BASE_URL', ''),
  brokerAgentToken: agentEnvRaw('BROKER_AGENT_TOKEN'),
  brokerEnabled: booleanFromEnv('BROKER_ENABLED', false),
  brokerHeartbeatIntervalSeconds: Math.max(5, numberFromEnv('BROKER_HEARTBEAT_INTERVAL_SECONDS', 30)),
  brokerPollIntervalSeconds: Math.max(3, numberFromEnv('BROKER_POLL_INTERVAL_SECONDS', 10)),
  brokerMaxConcurrentRuns: Math.max(1, numberFromEnv('BROKER_MAX_CONCURRENT_RUNS', 2)),
  webDevProxyUrl: stringFromEnv('WEB_DEV_PROXY_URL', ''),
  webDistRoot: stringFromEnv('WEB_DIST_DIR', ''),
  migrationsDir: stringFromEnv('MIGRATIONS_DIR', ''),
  desktopMode: booleanFromEnv('DESKTOP', false),
  desktopExternalAccess: booleanFromEnv('DESKTOP_EXTERNAL_ACCESS', false),
  nodeEnv: stringFromEnv('NODE_ENV', 'development'),
  debug: booleanFromEnv('DEBUG', false),
}
