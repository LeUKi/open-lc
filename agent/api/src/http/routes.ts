import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { ApplyGlobalResponse } from 'hono/client'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  getShareFileList,
  getParseHistoryDetail,
  getParseJob,
  getTempFileCleanupStatus,
  getTempFileCleanupSummary,
  listParseHistory,
  parseLinks,
  recordParseEvent,
  reparseHistory,
  runManualTempFileCleanup,
  submitParseJob,
} from '../baidu/service'
import {
  createOwnedAccount,
  deleteOwnedAccount,
  exportOwnedAccountCredentials,
  getOwnedAccountDetail,
  listOwnedAccounts,
  probeOwnedAccount,
  setOwnedAccountStatus,
} from '../baidu/accounts'
import { runAccountHealthCheckById } from '../baidu/health'
import { verifyOpenPlatformToken } from '../baidu/openPlatformToken'
import { db, sqlite } from '../db'
import { baiduAccounts, parseAttempts, parseRecords, type BaiduAccount, type User } from '../db/schema'
import { ensureSystemUser } from '../localUser'
import {
  brokerLoop,
  getBrokerConfig,
  getBrokerRunDetail,
  getPublicBrokerConfig,
  getBrokerRuntimeSnapshot,
  heartbeatBroker,
  listBrokerRunEvents,
  listBrokerRuns,
  appErrorInfo,
  updateBrokerConfig,
  verifyBrokerDraftConfig,
} from '../broker/runtime'
import { badRequest, notFound, unauthorized, unknownErrorMessage } from '../lib/errors'
import { createLinkProxyContext, createProxiedDownloadUrl } from '../lib/linkProxy'
import { BaiduClient } from '../baidu/client'
import {
  acceptRiskConsent,
  getSecurityStatus,
  isRiskConsentType,
  loginWithAgentPassword,
  requireRiskConsent,
  updateSecuritySettings,
  verifyAgentPassword,
  type RiskConsentType,
} from '../security/service'
import { getBaiduSettings, getDownloadSettings, getSettingsSnapshot, setSettings, verifyLinkProxyV2Endpoints } from '../settings/service'
import { getDesktopRuntime, openDesktopExternalBrowser, setDesktopExternalAccess } from '../desktop/runtime'
import { cleanupRuntimeData, factoryResetAgentData, getMaintenanceSummary } from '../maintenance/service'
import { getUpdateCheck } from '../update/service'

const client = new BaiduClient()

type AgentEnv = {
  Variables: {
    user: User
  }
}

const withSystemUser: MiddlewareHandler<AgentEnv> = async (c, next) => {
  const user = ensureSystemUser()
  c.set('user', user)
  await next()
}

const requireAgentPassword: MiddlewareHandler<AgentEnv> = async (c, next) => {
  await verifyAgentPassword(c.req.header('X-LC-Agent-Password'))
  await next()
}

const requireLocalUser = (c: Context<AgentEnv>) => {
  const user = c.get('user')
  if (!user) throw unauthorized('LOCAL_AGENT_NOT_READY', '本地 Agent 尚未初始化')
  return user
}

const emptyJsonSchema = z.object({}).optional()

const linkProxyV2VerifySchema = z.object({
  endpoints: z.union([z.string(), z.array(z.string())]),
})

const accountSchema = z.object({
  credentialSource: z.enum(['cookie', 'open_platform']).optional(),
  label: z.string().optional(),
  cookie: z.string().optional(),
  refreshToken: z.string().optional(),
  openPlatformClientKey: z.string().optional(),
  openPlatformSecretKey: z.string().optional(),
  openPlatformServerUse: z.boolean().optional(),
  weight: z.union([z.number(), z.string()]).optional(),
})

const accountProbeSchema = z.object({
  credentialSource: z.enum(['cookie', 'open_platform']).optional(),
  cookie: z.string().optional(),
  refreshToken: z.string().optional(),
  openPlatformClientKey: z.string().optional(),
  openPlatformSecretKey: z.string().optional(),
  openPlatformServerUse: z.boolean().optional(),
})

const accountStatusSchema = z.object({
  status: z.enum(['active', 'disabled', 'cooldown']),
})

const shareFilesSchema = z.object({
  shareUrl: z.string().min(1),
  cookie: z.string().trim().min(1).optional(),
  pwd: z.string().optional(),
  dir: z.string().optional(),
  page: z.number().optional(),
  num: z.number().optional(),
  order: z.enum(['time', 'filename']).optional(),
})

const localParseSchema = shareFilesSchema.omit({ cookie: true }).extend({
  fsIds: z.array(z.union([z.number(), z.string()])),
})

const localHistoryQuerySchema = z.object({
  status: z.string().optional(),
  credentialSource: z.string().optional(),
  parseRoute: z.string().optional(),
  q: z.string().optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
})

const brokerHistoryQuerySchema = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
})

const localReparseSchema = z.object({}).optional()

const localDiskBrowserQuerySchema = z.object({
  dir: z.string().optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
  order: z.enum(['time', 'filename']).optional(),
})

const localDiskResolveSchema = z.object({
  accountId: z.union([z.number(), z.string()]),
  fsId: z.union([z.number(), z.string()]),
  path: z.string().min(1),
  filename: z.string().min(1),
  sizeBytes: z.union([z.number(), z.string()]).optional(),
})

const brokerConfigSchema = z.object({
  baseUrl: z.string().url(),
  agentToken: z.string(),
  enabled: z.boolean().optional(),
  heartbeatIntervalSeconds: z.number().optional(),
  pollIntervalSeconds: z.number().optional(),
  maxConcurrentRuns: z.number().optional(),
})

const brokerVerifySchema = z.object({
  baseUrl: z.string().url(),
  agentToken: z.string().min(1),
  heartbeatIntervalSeconds: z.number().optional(),
  pollIntervalSeconds: z.number().optional(),
  maxConcurrentRuns: z.number().optional(),
})

const heartbeatSchema = z.object({
  available: z.boolean().optional(),
})

const securityLoginSchema = z.object({
  password: z.string(),
})

const securitySettingsSchema = z.object({
  enabled: z.boolean(),
  password: z.string().optional(),
})

const riskConsentSchema = z.object({
  accepted: z.boolean(),
})

const settingsUpdateSchema = z
  .object({
    values: z.record(z.string(), z.unknown()).optional(),
  })
  .optional()

const desktopExternalAccessSchema = z.object({
  enabled: z.boolean(),
})

const consentTypeForCredentialSource = (credentialSource?: string): RiskConsentType =>
  credentialSource === 'open_platform' ? 'open_platform_account' : 'cookie_account'

const resolveDiskFile = async (
  account: BaiduAccount,
  input: {
    fsId: number
    path: string
    filename: string
    sizeBytes?: number
  },
) => {
  const download = getDownloadSettings()
  const expiresAt = new Date(Date.now() + download.linkCacheTtlSeconds * 1000)
  if (account.credentialSource === 'open_platform') {
    const token = await verifyOpenPlatformToken(account, {
      trigger: 'parse_runtime',
      allowRefreshFallback: true,
    })
    const url = client.buildOpenPlatformDownloadUrl(input.path, token.accessToken)
    return {
      message: 'success',
      filename: input.filename,
      fs_id: input.fsId,
      ua: download.directDownloadUA,
      account_id: String(account.id),
      urls: [url],
      credentialSource: account.credentialSource,
      parseRoute: 'disk',
      link_expires_at: expiresAt.toISOString(),
    }
  }

  const urls = await client.downloadByDiskWithCookie(input.path, account.cookie)
  return {
    message: 'success',
    filename: input.filename,
    fs_id: input.fsId,
    ua: download.pcsUA,
    account_id: String(account.id),
    urls,
    credentialSource: account.credentialSource,
    parseRoute: 'disk',
    link_expires_at: expiresAt.toISOString(),
  }
}

const parentDirOf = (path: string) => {
  const normalized = path.trim()
  if (!normalized || normalized === '/') return '/'
  const slash = normalized.lastIndexOf('/')
  return slash <= 0 ? '/' : normalized.slice(0, slash)
}

const listDiskFilesForAccount = async (
  account: BaiduAccount,
  query: {
    dir?: string
    page?: number
    pageSize?: number
    order?: 'time' | 'filename'
  },
) => {
  const dir = query.dir || '/'
  const page = Math.max(1, Math.floor(Number(query.page ?? 1) || 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize ?? 50) || 50)))
  const order = query.order === 'time' ? 'time' : 'filename'
  if (account.credentialSource === 'open_platform') {
    const token = await verifyOpenPlatformToken(account, {
      trigger: 'parse_runtime',
      allowRefreshFallback: true,
    })
    return client.listDiskFilesByAccessToken({
      dir,
      page,
      pageSize,
      order,
      accessToken: token.accessToken,
    })
  }
  return client.listDiskFiles({
    dir,
    page,
    pageSize,
    order,
    cookie: account.cookie,
  })
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
})

export const typedRoutes = new Hono<AgentEnv>()
  .use('*', withSystemUser)
  .get('/health', (c) => {
    const broker = getBrokerConfig()
    return c.json({
      status: 'ok',
      mode: 'lc-agent',
      broker_configured: Boolean(broker.baseUrl && broker.agentToken),
      docs_root: 'docs/lc_v0',
    })
  })
  .get('/api/security/status', (c) => {
    return c.json({ code: 'OK', data: getSecurityStatus() })
  })
  .post('/api/security/login', zValidator('json', securityLoginSchema), async (c) => {
    const body = c.req.valid('json')
    const data = await loginWithAgentPassword(body.password)
    return c.json({ code: 'OK', data })
  })
  .put('/api/security/settings', zValidator('json', securitySettingsSchema), requireAgentPassword, async (c) => {
    const body = c.req.valid('json')
    const data = await updateSecuritySettings(body)
    return c.json({ code: 'OK', data })
  })
  .post('/api/security/risk-consents/:type', zValidator('json', riskConsentSchema), requireAgentPassword, (c) => {
    const type = c.req.param('type')
    if (!isRiskConsentType(type)) throw badRequest('UNKNOWN_RISK_CONSENT', `未知风险同意类型: ${type}`)
    const body = c.req.valid('json')
    if (!body.accepted) throw badRequest('RISK_CONSENT_NOT_ACCEPTED', '必须明确同意风险提示与责任声明')
    const data = acceptRiskConsent(type)
    return c.json({ code: 'OK', data })
  })
  .get('/api/settings', requireAgentPassword, (c) => {
    return c.json({ code: 'OK', data: getSettingsSnapshot() })
  })
  .put('/api/settings', requireAgentPassword, zValidator('json', settingsUpdateSchema), async (c) => {
    const body = c.req.valid('json')
    const values = body?.values ?? {}
    if (
      values.showCookieAccountAddButton === true ||
      String(values.showCookieAccountAddButton ?? '')
        .trim()
        .toLowerCase() === 'true'
    ) {
      requireRiskConsent('cookie_account')
    }
    if (
      values.brokerEnabled === true ||
      String(values.brokerEnabled ?? '')
        .trim()
        .toLowerCase() === 'true'
    ) {
      requireRiskConsent('broker_execution')
    }
    const data = await setSettings(values)
    return c.json({ code: 'OK', data })
  })
  .post('/api/settings/link-proxy/v2/verify', requireAgentPassword, zValidator('json', linkProxyV2VerifySchema), async (c) => {
    const body = c.req.valid('json')
    const data = await verifyLinkProxyV2Endpoints(body.endpoints)
    return c.json({ code: 'OK', data })
  })
  .use('/api/maintenance/*', requireAgentPassword)
  .get('/api/maintenance/summary', (c) => {
    return c.json({ code: 'OK', data: getMaintenanceSummary() })
  })
  .post('/api/maintenance/cleanup', zValidator('json', emptyJsonSchema), (c) => {
    const data = cleanupRuntimeData()
    return c.json({ code: 'OK', data })
  })
  .post('/api/maintenance/temp-files/cleanup', zValidator('json', emptyJsonSchema), async (c) => {
    const data = await runManualTempFileCleanup()
    return c.json({ code: 'OK', data })
  })
  .get('/api/maintenance/temp-files/cleanup/status', (c) => {
    return c.json({ code: 'OK', data: getTempFileCleanupStatus() })
  })
  .get('/api/maintenance/temp-files/summary', (c) => {
    return c.json({ code: 'OK', data: getTempFileCleanupSummary() })
  })
  .post('/api/maintenance/factory-reset', zValidator('json', emptyJsonSchema), (c) => {
    const data = factoryResetAgentData()
    return c.json({ code: 'OK', data })
  })
  .use('/api/desktop/*', requireAgentPassword)
  .get('/api/desktop/runtime', (c) => {
    return c.json({ code: 'OK', data: getDesktopRuntime() })
  })
  .put('/api/desktop/external-access', zValidator('json', desktopExternalAccessSchema), async (c) => {
    const body = c.req.valid('json')
    const data = await setDesktopExternalAccess(body.enabled)
    return c.json({ code: 'OK', data })
  })
  .post('/api/desktop/open-external-browser', zValidator('json', emptyJsonSchema), async (c) => {
    const data = await openDesktopExternalBrowser()
    return c.json({ code: 'OK', data })
  })
  .use('/api/system/*', requireAgentPassword)
  .get('/api/system/update-check', async (c) => {
    const data = await getUpdateCheck({ force: c.req.query('force') === 'true' })
    return c.json({ code: 'OK', data })
  })
  .use('/api/local/*', requireAgentPassword)
  .use('/api/broker/*', requireAgentPassword)
  .get('/api/local/me', (c) => {
    const user = requireLocalUser(c)
    const accounts = listOwnedAccounts(user)
    const broker = getBrokerConfig()
    return c.json({
      code: 'OK',
      data: {
        user,
        accountCount: accounts.length,
        activeAccountCount: accounts.filter((item) => item.status === 'active').length,
        broker: getPublicBrokerConfig(broker),
      },
    })
  })
  .get('/api/local/accounts', (c) => {
    const user = requireLocalUser(c)
    return c.json({ code: 'OK', data: listOwnedAccounts(user) })
  })
  .post('/api/local/accounts/probe', zValidator('json', accountProbeSchema), async (c) => {
    const user = requireLocalUser(c)
    const body = c.req.valid('json')
    requireRiskConsent(consentTypeForCredentialSource(body.credentialSource))
    const data = await probeOwnedAccount({ ...body, owner: user })
    return c.json({ code: 'OK', data })
  })
  .post('/api/local/accounts', zValidator('json', accountSchema), async (c) => {
    const user = requireLocalUser(c)
    const body = c.req.valid('json')
    requireRiskConsent(consentTypeForCredentialSource(body.credentialSource))
    const data = await createOwnedAccount({
      ...body,
      weight: body.weight === undefined ? undefined : Number(body.weight),
      owner: user,
    })
    return c.json({ code: 'OK', data })
  })
  .get('/api/local/accounts/:id', (c) => {
    const user = requireLocalUser(c)
    const data = getOwnedAccountDetail(Number(c.req.param('id')), user)
    return c.json({ code: 'OK', data })
  })
  .patch('/api/local/accounts/:id/status', zValidator('json', accountStatusSchema), async (c) => {
    const user = requireLocalUser(c)
    const body = c.req.valid('json')
    const data = await setOwnedAccountStatus(Number(c.req.param('id')), body.status, user)
    return c.json({ code: 'OK', data })
  })
  .delete('/api/local/accounts/:id', (c) => {
    const user = requireLocalUser(c)
    deleteOwnedAccount(Number(c.req.param('id')), user)
    return c.json({ code: 'OK' })
  })
  .post('/api/local/accounts/:id/health-check', zValidator('json', emptyJsonSchema), async (c) => {
    const data = await runAccountHealthCheckById(Number(c.req.param('id')))
    return c.json({ code: 'OK', data })
  })
  .post('/api/local/accounts/:id/token-check', zValidator('json', emptyJsonSchema), async (c) => {
    const account = db
      .select()
      .from(baiduAccounts)
      .where(eq(baiduAccounts.id, Number(c.req.param('id'))))
      .get()
    if (!account) throw notFound('ACCOUNT_NOT_FOUND', '账号不存在')
    if (account.credentialSource !== 'open_platform') throw badRequest('TOKEN_CHECK_NOT_SUPPORTED', '只有开放平台账号支持 token 校验')
    const result = await verifyOpenPlatformToken(account, {
      trigger: 'parse_runtime',
      allowRefreshFallback: true,
    })
    return c.json({ code: 'OK', data: result })
  })
  .post('/api/local/accounts/:id/export-credentials', zValidator('json', emptyJsonSchema), (c) => {
    const user = requireLocalUser(c)
    const data = exportOwnedAccountCredentials(Number(c.req.param('id')), user)
    return c.json({ code: 'OK', data })
  })
  .post('/api/local/browser/share', zValidator('json', shareFilesSchema), async (c) => {
    const body = c.req.valid('json')
    const data = await getShareFileList(body)
    return c.json({ code: 'OK', data })
  })
  .get('/api/local/browser/share-cookie-template', (c) => {
    return c.json({ code: 'OK', data: { fakeCookie: getBaiduSettings().baiduFakeCookie } })
  })
  .get('/api/local/browser/disk/:id', zValidator('query', localDiskBrowserQuerySchema), async (c) => {
    const account = db
      .select()
      .from(baiduAccounts)
      .where(eq(baiduAccounts.id, Number(c.req.param('id'))))
      .get()
    if (!account) throw notFound('ACCOUNT_NOT_FOUND', '账号不存在')
    const data = await listDiskFilesForAccount(account, c.req.valid('query'))
    return c.json({
      code: 'OK',
      data: {
        account: accountSnapshot(account),
        dir: data.dir,
        list: data.list,
        page: Number(c.req.valid('query').page ?? 1),
        pageSize: Number(c.req.valid('query').pageSize ?? 50),
        hasMore: data.list.length === Number(c.req.valid('query').pageSize ?? 50),
      },
    })
  })
  .post('/api/local/browser/disk/resolve', zValidator('json', localDiskResolveSchema), async (c) => {
    const body = c.req.valid('json')
    const user = requireLocalUser(c)
    const account = db
      .select()
      .from(baiduAccounts)
      .where(eq(baiduAccounts.id, Number(body.accountId)))
      .get()
    if (!account) throw notFound('ACCOUNT_NOT_FOUND', '账号不存在')
    const fsId = Number(body.fsId)
    const sizeBytes = body.sizeBytes === undefined ? 0 : Number(body.sizeBytes)
    const startedAt = new Date()
    const eventDetails = {
      accountId: account.id,
      credentialSource: account.credentialSource,
      fsId,
      path: body.path,
      filename: body.filename,
      sizeBytes,
    }
    try {
      const data = await resolveDiskFile(account, {
        fsId,
        path: body.path,
        filename: body.filename,
        sizeBytes,
      })
      db.insert(parseRecords)
        .values({
          userId: user.id,
          accountId: account.id,
          accountOwnerUserId: account.ownerUserId ?? user.id,
          shareSurl: `disk:${account.id}`,
          shareUrl: `disk://${account.id}${body.path}`,
          pwd: null,
          dir: parentDirOf(body.path),
          fsId: String(fsId),
          filename: body.filename,
          sizeBytes,
          md5: null,
          status: 'success',
          route: 'disk',
          credentialSource: account.credentialSource,
          parseRoute: null,
          resultUrl: data.urls[0] ?? null,
          resultUa: data.ua,
          linkExpiresAt: data.link_expires_at ? new Date(data.link_expires_at) : null,
          errorCode: null,
          errorMessage: null,
          attemptCount: 1,
        })
        .run()
      const recordId = sqlite.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()?.id ?? 0
      db.insert(parseAttempts)
        .values({
          parseRecordId: Number(recordId),
          userId: user.id,
          accountId: account.id,
          fsId: String(fsId),
          status: 'success',
          message: 'disk resolve success',
        })
        .run()
      recordParseEvent({
        type: 'disk_resolve_started',
        recordId: Number(recordId),
        accountId: account.id,
        message: '网盘文件解析开始',
        details: eventDetails,
        createdAt: startedAt,
      })
      recordParseEvent({
        type: 'disk_resolve_success',
        recordId: Number(recordId),
        accountId: account.id,
        status: 'success',
        message: '网盘文件解析成功',
        details: eventDetails,
      })
      const context = createLinkProxyContext()
      return c.json({
        code: 'OK',
        data: {
          ...data,
          urls: await Promise.all(data.urls.map((url) => createProxiedDownloadUrl(url, { filename: body.filename, expiresAt: data.link_expires_at ? new Date(data.link_expires_at) : null, context }))),
          record_id: Number(recordId),
        },
      })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'DISK_RESOLVE_FAILED'
      const message = unknownErrorMessage(error)
      db.insert(parseRecords)
        .values({
          userId: user.id,
          accountId: account.id,
          accountOwnerUserId: account.ownerUserId ?? user.id,
          shareSurl: `disk:${account.id}`,
          shareUrl: `disk://${account.id}${body.path}`,
          pwd: null,
          dir: parentDirOf(body.path),
          fsId: String(fsId),
          filename: body.filename,
          sizeBytes,
          md5: null,
          status: 'failed',
          route: 'disk',
          credentialSource: account.credentialSource,
          parseRoute: null,
          resultUrl: null,
          resultUa: null,
          linkExpiresAt: null,
          errorCode: code,
          errorMessage: message,
          attemptCount: 1,
        })
        .run()
      const recordId = sqlite.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()?.id ?? 0
      db.insert(parseAttempts)
        .values({
          parseRecordId: Number(recordId),
          userId: user.id,
          accountId: account.id,
          fsId: String(fsId),
          status: 'failed',
          errorCode: code,
          message,
        })
        .run()
      recordParseEvent({
        type: 'disk_resolve_started',
        recordId: Number(recordId),
        accountId: account.id,
        message: '网盘文件解析开始',
        details: eventDetails,
        createdAt: startedAt,
      })
      recordParseEvent({
        type: 'disk_resolve_failed',
        recordId: Number(recordId),
        accountId: account.id,
        status: 'failed',
        code,
        message,
        details: eventDetails,
      })
      throw error
    }
  })
  .post('/api/local/parse', zValidator('json', localParseSchema), async (c) => {
    const body = c.req.valid('json')
    const user = requireLocalUser(c)
    const data = await parseLinks(body, user)
    return c.json({
      code: 'OK',
      data,
    })
  })
  .post('/api/local/parse/jobs', zValidator('json', localParseSchema), async (c) => {
    const body = c.req.valid('json')
    const user = requireLocalUser(c)
    const data = await submitParseJob(body, user)
    return c.json({ code: 'OK', data })
  })
  .get('/api/local/parse/jobs/:id', async (c) => {
    const user = requireLocalUser(c)
    const data = await getParseJob(Number(c.req.param('id')), user)
    return c.json({ code: 'OK', data })
  })
  .get('/api/local/history', zValidator('query', localHistoryQuerySchema), async (c) => {
    const user = requireLocalUser(c)
    const data = await listParseHistory(c.req.valid('query'), user)
    return c.json({ code: 'OK', data })
  })
  .get('/api/local/history/:id', async (c) => {
    const user = requireLocalUser(c)
    const data = await getParseHistoryDetail(Number(c.req.param('id')), user)
    return c.json({ code: 'OK', data })
  })
  .post('/api/local/history/:id/reparse', zValidator('json', localReparseSchema), async (c) => {
    const user = requireLocalUser(c)
    const data = await reparseHistory(Number(c.req.param('id')), user)
    return c.json({ code: 'OK', data })
  })
  .get('/api/broker/config', (c) => {
    return c.json({ code: 'OK', data: getPublicBrokerConfig() })
  })
  .put('/api/broker/config', zValidator('json', brokerConfigSchema), (c) => {
    const body = c.req.valid('json')
    if (body.enabled ?? true) requireRiskConsent('broker_execution')
    const nextConfig = updateBrokerConfig({
      baseUrl: body.baseUrl,
      agentToken: body.agentToken,
      enabled: body.enabled ?? true,
      heartbeatIntervalSeconds: body.heartbeatIntervalSeconds,
      pollIntervalSeconds: body.pollIntervalSeconds,
      maxConcurrentRuns: body.maxConcurrentRuns,
    })
    return c.json({ code: 'OK', data: getPublicBrokerConfig(nextConfig) })
  })
  .post('/api/broker/verify', zValidator('json', brokerVerifySchema), async (c) => {
    const body = c.req.valid('json')
    try {
      const result = await verifyBrokerDraftConfig({
        baseUrl: body.baseUrl,
        agentToken: body.agentToken,
      })
      return c.json({ code: 'OK', data: result })
    } catch (error) {
      const info = appErrorInfo(error)
      return c.json({
        code: 'OK',
        data: {
          ok: false,
          error: info.message || unknownErrorMessage(error, 'Broker 连接检测失败'),
          errorCode: info.code,
          httpStatus: info.httpStatus,
          targetUrl: info.targetUrl,
        },
      })
    }
  })
  .post('/api/broker/heartbeat', zValidator('json', heartbeatSchema), async (c) => {
    await heartbeatBroker()
    return c.json({ code: 'OK', data: getPublicBrokerConfig() })
  })
  .post('/api/broker/poll', zValidator('json', emptyJsonSchema), async (c) => {
    const data = await brokerLoop()
    return c.json({ code: 'OK', data })
  })
  .get('/api/broker/history', zValidator('query', brokerHistoryQuerySchema), (c) => {
    return c.json({ code: 'OK', data: listBrokerRuns(c.req.valid('query')) })
  })
  .get('/api/broker/runs/:id', (c) => {
    const data = getBrokerRunDetail(c.req.param('id'))
    if (!data) throw notFound('BROKER_RUN_NOT_FOUND', 'Broker run 不存在')
    return c.json({ code: 'OK', data })
  })
  .get('/api/broker/runs/:id/events', (c) => {
    return c.json({ code: 'OK', data: listBrokerRunEvents(c.req.param('id')) })
  })
  .get('/api/broker/runtime', (c) => {
    return c.json({ code: 'OK', data: getBrokerRuntimeSnapshot() })
  })

export type AppType = typeof typedRoutes

export { startAgentBrokerRuntime, stopAgentBrokerRuntime } from '../broker/runtime'

export type ApiErrorResponse = {
  code: string
  message: string
  details?: unknown
}

export type ClientAppType = ApplyGlobalResponse<
  AppType,
  {
    400: { json: ApiErrorResponse }
    401: { json: ApiErrorResponse }
    403: { json: ApiErrorResponse }
    404: { json: ApiErrorResponse }
    409: { json: ApiErrorResponse }
    502: { json: ApiErrorResponse }
    503: { json: ApiErrorResponse }
  }
>
