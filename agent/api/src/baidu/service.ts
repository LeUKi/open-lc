import { and, asc, desc, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm'
import { db, lastInsertId } from '../db'
import {
  baiduAccounts,
  baiduTempFiles,
  tempFileCleanupRuns,
  parseAttempts,
  parseEvents,
  parseJobs,
  parseRecords,
  users,
  type BaiduAccount,
  type ParseJob,
  type ParseRecord,
  type TempFileCleanupRun,
  type User,
} from '../db/schema'
import { badRequest, forbidden, notFound, upstreamError, unknownErrorMessage } from '../lib/errors'
import { createLinkProxyContext, createProxiedDownloadUrl, type LinkProxyContext } from '../lib/linkProxy'
import { getAccountPolicy, getBaiduSettings, getDownloadSettings } from '../settings/service'
import {
  acquireLocalAccount,
  acquireAccountById,
  hasLocalAccountCandidate,
  isFileLevelFailure,
  markAccountFailure,
  markAccountSuccess,
  releaseAccount,
} from './accounts'
import { BaiduClient } from './client'
import { setOpenPlatformReimportRequired, verifyOpenPlatformToken } from './openPlatformToken'
import { parseSharePwd, parseShareUrl } from './share'
import type { CredentialSource, ParsedLink, ParseRoute, ShareFile } from './types'

const client = new BaiduClient()
const MIB = 1024 ** 2
const directFirstMaxBytes = 50 * MIB
const accountWaitRetryMs = 1000
const autoTempDeleteRetryLimit = 2
const manualTempDeleteRetryLimit = 5
const localAccountParseFailedMessage = '本地账号未能解析该文件。若这是该账号自己分享的文件，请换其他账号解析。'

type FileListInput = {
  shareUrl: string
  cookie?: string
  pwd?: string
  dir?: string
  page?: number
  num?: number
  order?: 'time' | 'filename'
}

type ParseInput = Omit<FileListInput, 'cookie'> & {
  fsIds: unknown
}

type ParseExecutionResult = {
  recordId: number
  credentialSource: CredentialSource
  parseRoute: ParseRoute
  accountId?: number | null
  accountOwnerUserId?: number | null
  url: string
  ua: string
  linkExpiresAt: Date
  md5?: string
  filename: string
  fsId: number
}

type ParseExecutionError = {
  code: string
  message: string
  status?: 'failed'
  attempts?: Array<{ accountId: number; code: string; message: string }>
}

type AccountWaitOptions = {
  deadline?: Date
  onWait?: (context: { waitMs: number }) => void
}

export type TempFileCleanupResult = {
  attempted: number
  deleted: number
  failed: number
  skipped: number
  orphan: number
  waitingForExpiry: number
  firstError: string | null
}

export type TempFileCleanupRunSnapshot = {
  id: number
  trigger: 'auto' | 'manual'
  status: 'running' | 'success' | 'failed'
  startedAt: string
  finishedAt: string | null
  totalCandidates: number
  processed: number
  currentTempFileId: number | null
  result: TempFileCleanupResult
}

export type TempFileCleanupSummary = {
  active: number
  deletePending: number
  deleteFailed: number
  deleted: number
  orphan: number
  recentOrphans: Array<{
    id: number
    tempDir: string
    path: string
    status: string
    createdAt: string
    errorMessage: string | null
  }>
  recentErrors: Array<{
    id: number
    tempDir: string
    path: string
    status: string
    errorMessage: string | null
    retryCount: number
    updatedAt: string
  }>
  lastRun: {
    id: number
    startedAt: string
    finishedAt: string | null
    trigger: 'auto' | 'manual'
    status: 'running' | 'success' | 'failed'
    totalCandidates: number
    processed: number
    result: TempFileCleanupResult
  } | null
  recentRuns: Array<{
    id: number
    trigger: 'auto' | 'manual'
    status: 'running' | 'success' | 'failed'
    startedAt: string
    finishedAt: string | null
    totalCandidates: number
    processed: number
    result: TempFileCleanupResult
  }>
}

export type TempFileCleanupStatus = {
  running: TempFileCleanupRunSnapshot | null
  recentRuns: TempFileCleanupSummary['recentRuns']
}

type ShareDirFallbackInfo = {
  requestedDir: string
  resolvedDir: string
  fsIds: number[]
  matchedFsId: number
  filename: string
}

const ensureNumberArray = (value: unknown) => {
  if (!Array.isArray(value)) throw badRequest('BAD_FS_IDS', 'fsIds 必须是数组')

  const fsIds = value.map((item) => Number(item)).filter((item) => Number.isFinite(item))
  if (fsIds.length === 0) throw badRequest('BAD_FS_IDS', 'fsIds 至少包含一个有效 fs_id')
  return fsIds
}

const validateFiles = (files: ShareFile[], fsIds: number[]) => {
  const byId = new Map(files.map((file) => [file.fs_id, file]))
  const selected = fsIds.map((fsId) => byId.get(fsId))

  if (selected.some((file) => !file)) {
    throw badRequest('FS_ID_NOT_FOUND', '部分 fs_id 不在当前分享目录中')
  }

  const typed = selected as ShareFile[]
  const dir = typed.find((file) => file.is_dir)
  if (dir) {
    throw badRequest('FOLDER_NOT_SUPPORTED', `MVP 暂不支持文件夹，请进入目录选择文件: ${dir.server_filename}`)
  }

  return typed
}

const validateSingleFile = (files: ShareFile[], fsIds: number[]) => {
  if (fsIds.length !== 1) {
    throw badRequest('ONLY_ONE_FILE', '后端单次只支持解析一个文件，请由前端顺序调度多文件')
  }
  return validateFiles(files, fsIds)[0]
}

const isSharePathError = (error: unknown) => {
  const info = appErrorInfo(error)
  return info.code === 'GET_FILE_LIST_FAILED' && info.message.includes('路径错误')
}

const getShareForParse = async (params: { surl: string; pwd?: string; dir?: string; fsIds: number[]; jobId?: number }) => {
  const requestedDir = params.dir?.trim() || '/'
  try {
    const share = await client.getFileList({
      surl: params.surl,
      pwd: params.pwd,
      dir: requestedDir,
      num: 100,
    })
    return { share, file: validateSingleFile(share.list, params.fsIds), dir: requestedDir }
  } catch (error) {
    if (requestedDir === '/' || !isSharePathError(error)) throw error

    const rootShare = await client.getFileList({
      surl: params.surl,
      pwd: params.pwd,
      dir: '/',
      num: 100,
    })
    try {
      const file = validateSingleFile(rootShare.list, params.fsIds)
      const fallback: ShareDirFallbackInfo = {
        requestedDir,
        resolvedDir: '/',
        fsIds: params.fsIds,
        matchedFsId: file.fs_id,
        filename: file.server_filename,
      }
      if (params.jobId) recordShareDirFallbackEvent(params.jobId, fallback)
      return { share: rootShare, file, dir: '/', fallback }
    } catch {
      throw error
    }
  }
}

const recordShareDirFallbackEvent = (jobId: number, fallback: ShareDirFallbackInfo) => {
  recordParseEvent({
    type: 'share_dir_fallback',
    jobId,
    status: 'warning',
    code: 'SHARE_DIR_FALLBACK_TO_ROOT',
    message: '分享目录路径错误，已回退到根目录并命中文件',
    details: fallback,
  })
}

export const getShareFileList = async (input: FileListInput) => {
  const surl = parseShareUrl(input.shareUrl)
  return client.getFileList({
    surl,
    cookie: input.cookie,
    pwd: input.pwd || parseSharePwd(input.shareUrl),
    dir: input.dir,
    page: input.page,
    num: input.num,
    order: input.order,
  })
}

const downloadUaForRoute = (route?: string | null, credentialSource: CredentialSource = 'cookie') => {
  const download = getDownloadSettings()
  if (route === 'transfer') {
    return credentialSource === 'open_platform' ? download.directDownloadUA : download.transferDownloadUA
  }
  return download.directDownloadUA
}

const resolveUaForRoute = (route: ParseRoute) => downloadUaForRoute(route)

const serializeJob = async (job: ParseJob, context: LinkProxyContext = createLinkProxyContext()) => {
  const aheadCount = getAheadCount(job)
  const record = job.parseRecordId
    ? db.select({ accountId: parseRecords.accountId }).from(parseRecords).where(eq(parseRecords.id, job.parseRecordId)).get()
    : null
  const { route: _legacyRoute, accountOwnerUserId: _accountOwnerUserId, ...publicJob } = job
  return {
    ...publicJob,
    position: job.status === 'queued' ? aheadCount + 1 : 0,
    ahead_count: aheadCount,
    result: job.resultUrl
      ? {
          message: 'success',
          filename: job.filename,
          fs_id: Number(job.fsId),
          ua: job.resultUa ?? getDownloadSettings().directDownloadUA,
          account_id: String(record?.accountId ?? ''),
          urls: [await createProxiedDownloadUrl(job.resultUrl, { filename: job.filename, expiresAt: job.linkExpiresAt, context })],
          credentialSource: job.credentialSource,
          parseRoute: job.parseRoute,
          record_id: job.parseRecordId,
          link_expires_at: job.linkExpiresAt?.toISOString(),
        }
      : null,
  }
}

const serializeRecord = async (record: ParseRecord, context: LinkProxyContext = createLinkProxyContext()) => {
  const { route: _legacyRoute, accountOwnerUserId: _accountOwnerUserId, ...publicRecord } = record
  return {
    ...publicRecord,
    routeLabel: record.shareSurl.startsWith('disk:')
      ? `${record.credentialSource}.disk`
      : record.parseRoute
        ? `${record.credentialSource}.${record.parseRoute}`
        : '-',
    resultUrl: record.resultUrl
      ? await createProxiedDownloadUrl(record.resultUrl, { filename: record.filename, expiresAt: record.linkExpiresAt, context })
      : record.resultUrl,
    linkExpired: record.linkExpiresAt ? record.linkExpiresAt.getTime() <= Date.now() : true,
  }
}

const parseEventDetails = (details: string | null) => {
  if (!details) return null
  try {
    return JSON.parse(details) as unknown
  } catch {
    return details
  }
}

const serializeEvent = (event: typeof parseEvents.$inferSelect) => ({
  ...event,
  details: parseEventDetails(event.details),
})

const serializeTempFileDetail = (item: typeof baiduTempFiles.$inferSelect & { accountExists?: boolean | number | null }) => ({
  id: item.id,
  status: item.status,
  tempDir: item.tempDir,
  path: item.path,
  retryCount: item.retryCount,
  errorMessage: item.errorMessage,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
  deletedAt: item.deletedAt?.toISOString() ?? null,
  autoCleanupSkipped: item.retryCount > autoTempDeleteRetryLimit,
  manualCleanupSkipped: item.retryCount > manualTempDeleteRetryLimit,
  orphan: !item.accountId || item.accountExists === false || item.accountExists === 0,
})

const getAheadCount = (job: ParseJob) => {
  if (job.status !== 'queued') return 0
  const [row] = db
    .select({ value: sql<number>`COUNT(*)` })
    .from(parseJobs)
    .where(or(eq(parseJobs.status, 'running'), and(eq(parseJobs.status, 'queued'), sql`${parseJobs.queueSeq} < ${job.queueSeq}`)))
    .all()
  return row.value
}

const nextQueueSeq = () => {
  const [{ value }] = db
    .select({ value: sql<number>`COALESCE(MAX(${parseJobs.queueSeq}), 0)` })
    .from(parseJobs)
    .all()
  return Number(value) + 1
}

export const recordParseEvent = (input: {
  type: string
  message: string
  status?: 'info' | 'success' | 'failed' | 'warning'
  code?: string | null
  recordId?: number | null
  jobId?: number | null
  accountId?: number | null
  tempFileId?: number | null
  details?: Record<string, unknown> | null
  createdAt?: Date
}) => {
  db.insert(parseEvents)
    .values({
      parseRecordId: input.recordId ?? null,
      parseJobId: input.jobId ?? null,
      accountId: input.accountId ?? null,
      tempFileId: input.tempFileId ?? null,
      type: input.type,
      status: input.status ?? 'info',
      code: input.code ?? null,
      message: input.message,
      details: input.details ? JSON.stringify(input.details) : null,
      createdAt: input.createdAt,
    })
    .run()
}

const parentDirOfPath = (path: string) => {
  const normalized = path.trim()
  if (!normalized || normalized === '/') return '/'
  const slash = normalized.lastIndexOf('/')
  return slash <= 0 ? '/' : normalized.slice(0, slash)
}

const filenameFromPath = (path: string) => {
  const normalized = path.trim().replace(/\/+$/, '')
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(slash + 1) : normalized
}

const createRecord = (input: {
  userId: number
  accountId?: number | null
  accountOwnerUserId?: number | null
  shareSurl: string
  shareUrl: string
  pwd?: string | null
  dir?: string | null
  file: Pick<ShareFile, 'fs_id' | 'server_filename' | 'size' | 'md5'>
  status: 'success' | 'failed'
  credentialSource?: CredentialSource | null
  parseRoute?: ParseRoute | null
  resultUrl?: string | null
  resultUa?: string | null
  linkExpiresAt?: Date | null
  errorCode?: string | null
  errorMessage?: string | null
  attemptCount?: number
}) => {
  db.insert(parseRecords)
    .values({
      userId: input.userId,
      accountId: input.accountId ?? null,
      accountOwnerUserId: input.accountOwnerUserId ?? null,
      shareSurl: input.shareSurl,
      shareUrl: input.shareUrl,
      pwd: input.pwd,
      dir: input.dir,
      fsId: String(input.file.fs_id),
      filename: input.file.server_filename,
      sizeBytes: input.file.size,
      md5: input.file.md5,
      status: input.status,
      credentialSource: input.credentialSource ?? 'cookie',
      parseRoute: input.parseRoute ?? null,
      resultUrl: input.resultUrl ?? null,
      resultUa: input.resultUa ?? null,
      linkExpiresAt: input.linkExpiresAt ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      attemptCount: input.attemptCount ?? 0,
    })
    .run()
  return lastInsertId()
}

const createAttempt = (input: {
  recordId?: number
  jobId?: number
  userId: number
  accountId?: number | null
  fsId: string
  status: 'success' | 'failed'
  errorCode?: string | null
  message?: string | null
}) => {
  db.insert(parseAttempts)
    .values({
      parseRecordId: input.recordId,
      parseJobId: input.jobId,
      userId: input.userId,
      accountId: input.accountId,
      fsId: input.fsId,
      status: input.status,
      errorCode: input.errorCode,
      message: input.message,
    })
    .run()
}

const attachExecutionArtifacts = (recordId: number, jobId?: number) => {
  if (!jobId) return
  db.update(parseAttempts).set({ parseRecordId: recordId }).where(eq(parseAttempts.parseJobId, jobId)).run()
  db.update(baiduTempFiles).set({ parseRecordId: recordId, updatedAt: new Date() }).where(eq(baiduTempFiles.parseJobId, jobId)).run()
  db.update(parseEvents).set({ parseRecordId: recordId }).where(eq(parseEvents.parseJobId, jobId)).run()
}

const appErrorInfo = (error: unknown) => {
  if (error && typeof error === 'object') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null
    const message = 'message' in error && typeof error.message === 'string' ? error.message : null
    if (code || message) return { code: code ?? 'UNKNOWN', message: message ?? code ?? '未知错误' }
  }
  const appError = error instanceof Error ? error : new Error(unknownErrorMessage(error))
  const code = 'code' in appError && typeof appError.code === 'string' ? appError.code : 'UNKNOWN'
  return { code, message: appError.message }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const tempRoot = () => {
  const tempDir = getBaiduSettings().tempDir
  const root = tempDir.startsWith('/') ? tempDir : `/${tempDir}`
  return root.replace(/\/+$/, '') || '/我的资源/下载'
}

const tempDirFor = (jobId: number) => `${tempRoot()}/${Date.now()}-${jobId}`

const parentDirsFor = (path: string) => {
  const parts = path.split('/').filter(Boolean)
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
}

const isLikelyDuplicateTempRoot = (requested: string, created?: string) => {
  if (!created || requested === created) return false
  const root = tempRoot()
  return requested === root && created.startsWith(`${root}_`)
}

const ensureDiskDirectory = async (account: BaiduAccount, path: string) => {
  const normalizedRoot = tempRoot()
  if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}/`)) {
    throw upstreamError('BAD_TEMP_DIR', '临时目录不在平台配置的根目录内')
  }

  const bdstoken = await client.getBdstoken(account.cookie)
  for (const dir of parentDirsFor(path)) {
    const exists = await client
      .diskPathExists({
        path: dir,
        cookie: account.cookie,
      })
      .catch(() => false)
    if (exists) continue

    const created = await client.createDiskDirectory({
      path: dir,
      cookie: account.cookie,
      bdstoken,
    })
    if (isLikelyDuplicateTempRoot(dir, created.createdPath)) {
      await client.deleteDiskPaths({ paths: [created.createdPath!], cookie: account.cookie }).catch(() => {})
      const existsAfterDuplicate = await client.diskPathExists({ path: dir, cookie: account.cookie }).catch(() => false)
      if (!existsAfterDuplicate) {
        throw upstreamError('CREATE_TEMP_DIR_DUPLICATED', `创建转存临时目录生成了重复目录: ${created.createdPath}`)
      }
      continue
    }
    if (created.createdPath && created.createdPath !== dir) {
      throw upstreamError('CREATE_TEMP_DIR_MISMATCH', `创建转存临时目录返回了非预期路径: ${created.createdPath}`)
    }
  }
  return bdstoken
}

const ensureDiskDirectoryByAccessToken = async (account: BaiduAccount, path: string) => {
  const normalizedRoot = tempRoot()
  if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}/`)) {
    throw upstreamError('BAD_TEMP_DIR', '临时目录不在平台配置的根目录内')
  }

  const accessToken = account.accessToken
  if (!accessToken) throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_MISSING', '开放平台账号缺少 access_token')

  for (const dir of parentDirsFor(path)) {
    const exists = await client.diskPathExistsByAccessToken({ path: dir, accessToken }).catch(() => false)
    if (exists) continue

    const created = await client.createDiskDirectoryByAccessToken({ path: dir, accessToken })
    if (isLikelyDuplicateTempRoot(dir, created.createdPath)) {
      await client.deleteDiskPathsByAccessToken({ paths: [created.createdPath!], accessToken }).catch(() => {})
      const existsAfterDuplicate = await client.diskPathExistsByAccessToken({ path: dir, accessToken }).catch(() => false)
      if (!existsAfterDuplicate) {
        throw upstreamError('CREATE_TEMP_DIR_DUPLICATED', `创建转存临时目录生成了重复目录: ${created.createdPath}`)
      }
      continue
    }
    if (created.createdPath && created.createdPath !== dir) {
      throw upstreamError('CREATE_TEMP_DIR_MISMATCH', `创建转存临时目录返回了非预期路径: ${created.createdPath}`)
    }
  }
}

const withOpenPlatformAccessToken = async <T>(params: {
  account: BaiduAccount
  jobId?: number | null
  trigger: 'parse_runtime' | 'cleanup'
  action: (input: { accessToken: string; account: BaiduAccount }) => Promise<T>
}) => {
  const verified = await verifyOpenPlatformToken(params.account, {
    trigger: params.trigger,
    parseJobId: params.jobId,
    allowRefreshFallback: true,
  })
  try {
    return await params.action({ accessToken: verified.accessToken, account: verified.account })
  } catch (error) {
    const info = appErrorInfo(error)
    if (info.code === 'OPEN_PLATFORM_ACCESS_TOKEN_INVALID' && verified.action === 'validated') {
      const refreshed = await verifyOpenPlatformToken(verified.account, {
        trigger: params.trigger,
        parseJobId: params.jobId,
        allowRefreshFallback: true,
      })
      return params.action({ accessToken: refreshed.accessToken, account: refreshed.account })
    }
    if (info.code === 'OPEN_PLATFORM_REIMPORT_REQUIRED') {
      setOpenPlatformReimportRequired({
        accountId: params.account.id,
        code: info.code,
        message: info.message,
      })
    }
    throw error
  }
}

const parseDirect = async (params: { share: Awaited<ReturnType<BaiduClient['getFileList']>>; file: ShareFile; account: BaiduAccount; jobId?: number }) => {
  recordParseEvent({
    type: 'direct_started',
    jobId: params.jobId,
    accountId: params.account.id,
    message: `${params.account.credentialSource}.sharedownload 开始取链`,
    details: { fsId: params.file.fs_id, filename: params.file.server_filename },
  })
  const sign = await client.getSign({
    shareid: params.share.shareid,
    uk: params.share.uk,
    cookie: params.account.cookie,
  })
  const dlink = await client.getSharedDownload({
    fsId: params.file.fs_id,
    timestamp: sign.timestamp,
    sign: sign.sign,
    randsk: params.share.randsk,
    shareid: params.share.shareid,
    uk: params.share.uk,
    cookie: params.account.cookie,
  })
  const realUrl = await client.resolveRealLink({
    dlink: dlink.dlink,
    cookie: params.account.cookie,
    userAgent: resolveUaForRoute('sharedownload'),
  })
  recordParseEvent({
    type: 'real_link_resolved',
    jobId: params.jobId,
    accountId: params.account.id,
    status: 'success',
    message: '真实链接解析成功',
    details: { credentialSource: params.account.credentialSource, parseRoute: 'sharedownload', ua: resolveUaForRoute('sharedownload') },
  })
  return {
    url: realUrl,
    md5: dlink.md5 || params.file.md5,
  }
}

const resolveCookieTransferUrl = async (params: { path: string; account: BaiduAccount; jobId?: number; tempId?: number }) => {
  recordParseEvent({
    type: 'pcs_dlink_started',
    jobId: params.jobId,
    accountId: params.account.id,
    tempFileId: params.tempId,
    message: '开始获取网盘文件 dlink',
    details: { path: params.path },
  })
  const urls = await client.downloadByDiskWithCookie(params.path, params.account.cookie)
  if (!urls[0]) throw upstreamError('DLINK_FAILED', '转存后未获取到下载链接')
  const realUrl = await client.resolveRealLink({
    dlink: urls[0],
    cookie: params.account.cookie,
    userAgent: resolveUaForRoute('transfer'),
  })
  recordParseEvent({
    type: 'real_link_resolved',
    jobId: params.jobId,
    accountId: params.account.id,
    tempFileId: params.tempId,
    status: 'success',
    message: '真实链接解析成功',
    details: { credentialSource: params.account.credentialSource, parseRoute: 'transfer', ua: resolveUaForRoute('transfer') },
  })
  return {
    url: realUrl,
  }
}

const resolveOpenPlatformTransferUrl = async (params: {
  account: BaiduAccount
  accessToken: string
  jobId?: number
  tempId?: number
  path: string
  file: ShareFile
}) => {
  recordParseEvent({
    type: 'pcs_dlink_started',
    jobId: params.jobId,
    accountId: params.account.id,
    tempFileId: params.tempId,
    message: '开始生成开放平台下载链接',
    details: { path: params.path },
  })
  const downloadUrl = client.buildOpenPlatformDownloadUrl(params.path, params.accessToken)
  recordParseEvent({
    type: 'real_link_resolved',
    jobId: params.jobId,
    accountId: params.account.id,
    tempFileId: params.tempId,
    status: 'success',
    message: '开放平台下载链接生成成功',
    details: { credentialSource: params.account.credentialSource, parseRoute: 'transfer', ua: resolveUaForRoute('transfer') },
  })
  return {
    url: downloadUrl,
    md5: params.file.md5,
  }
}

const markTempDeleteFailure = (tempId: number, message: string, code?: string) => {
  const current = db.select({ retryCount: baiduTempFiles.retryCount }).from(baiduTempFiles).where(eq(baiduTempFiles.id, tempId)).get()
  const nextRetryCount = (current?.retryCount ?? 0) + 1
  db.update(baiduTempFiles)
    .set({
      status: code === 'TEMP_DELETE_NEEDS_VERIFY' ? 'delete_failed' : 'delete_pending',
      errorMessage: message.slice(0, 300),
      retryCount: nextRetryCount,
      updatedAt: new Date(),
    })
    .where(eq(baiduTempFiles.id, tempId))
    .run()
}

const markTempDeleted = (tempId: number) => {
  db.update(baiduTempFiles)
    .set({
      status: 'deleted',
      errorMessage: null,
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(baiduTempFiles.id, tempId))
    .run()
}

const markTempDeletePending = (tempId: number, message: string) => {
  db.update(baiduTempFiles)
    .set({
      status: 'delete_pending',
      errorMessage: message,
      updatedAt: new Date(),
    })
    .where(eq(baiduTempFiles.id, tempId))
    .run()
}

const tempPathStillExists = async (params: { account: BaiduAccount; tempDir: string; path: string }) => {
  if (params.account.credentialSource === 'open_platform' && params.account.accessToken) {
    const tempDirExists = await client
      .diskPathExistsByAccessToken({
        path: params.tempDir,
        accessToken: params.account.accessToken,
      })
      .catch(() => true)
    if (tempDirExists) return true
    if (!params.path || params.path === params.tempDir) return false
    return client
      .diskPathExistsByAccessToken({
        path: params.path,
        accessToken: params.account.accessToken,
      })
      .catch(() => true)
  }

  const tempDirExists = await client
    .diskPathExists({
      path: params.tempDir,
      cookie: params.account.cookie,
    })
    .catch(() => true)
  if (tempDirExists) return true
  if (!params.path || params.path === params.tempDir) return false
  return client
    .diskPathExists({
      path: params.path,
      cookie: params.account.cookie,
    })
    .catch(() => true)
}

const deleteTempPaths = async (params: {
  tempId: number
  tempDir: string
  path: string
  account: BaiduAccount
  bdstoken?: string
  jobId?: number | null
  recordId?: number | null
}) => {
  recordParseEvent({
    type: 'temp_delete_started',
    jobId: params.jobId,
    recordId: params.recordId,
    accountId: params.account.id,
    tempFileId: params.tempId,
    message: '开始删除转存临时目录',
    details: { tempDir: params.tempDir, path: params.path },
  })
  try {
    await client.deleteDiskPaths({ paths: [params.tempDir], cookie: params.account.cookie, bdstoken: params.bdstoken })
    markTempDeleted(params.tempId)
    recordParseEvent({
      type: 'temp_delete_success',
      jobId: params.jobId,
      recordId: params.recordId,
      accountId: params.account.id,
      tempFileId: params.tempId,
      status: 'success',
      message: '转存临时目录删除成功',
      details: { tempDir: params.tempDir },
    })
  } catch (error) {
    if (params.path && params.path !== params.tempDir) {
      try {
        await client.deleteDiskPaths({ paths: [params.path], cookie: params.account.cookie, bdstoken: params.bdstoken })
        markTempDeleted(params.tempId)
        recordParseEvent({
          type: 'temp_delete_success',
          jobId: params.jobId,
          recordId: params.recordId,
          accountId: params.account.id,
          tempFileId: params.tempId,
          status: 'success',
          message: '转存文件删除成功，目录删除失败',
          details: { tempDir: params.tempDir, path: params.path },
        })
        return
      } catch (fallbackError) {
        const info = appErrorInfo(fallbackError)
        markTempDeleteFailure(params.tempId, info.message, info.code)
        recordParseEvent({
          type: 'temp_delete_failed',
          jobId: params.jobId,
          recordId: params.recordId,
          accountId: params.account.id,
          tempFileId: params.tempId,
          status: 'failed',
          code: info.code,
          message: info.message,
          details: { tempDir: params.tempDir, path: params.path },
        })
        return
      }
    }
    const info = appErrorInfo(error)
    markTempDeleteFailure(params.tempId, info.message, info.code)
    recordParseEvent({
      type: 'temp_delete_failed',
      jobId: params.jobId,
      recordId: params.recordId,
      accountId: params.account.id,
      tempFileId: params.tempId,
      status: 'failed',
      code: info.code,
      message: info.message,
      details: { tempDir: params.tempDir, path: params.path },
    })
  }
}

const deleteTempPathsByAccessToken = async (params: {
  tempId: number
  tempDir: string
  path: string
  account: BaiduAccount
  jobId?: number | null
  recordId?: number | null
}) => {
  recordParseEvent({
    type: 'temp_delete_started',
    jobId: params.jobId,
    recordId: params.recordId,
    accountId: params.account.id,
    tempFileId: params.tempId,
    message: '开始删除开放平台转存临时目录',
    details: { tempDir: params.tempDir, path: params.path },
  })

  try {
    await withOpenPlatformAccessToken({
      account: params.account,
      jobId: params.jobId,
      trigger: 'cleanup',
      action: ({ accessToken }) => client.deleteDiskPathsByAccessToken({ paths: [params.tempDir], accessToken }),
    })
    markTempDeleted(params.tempId)
    recordParseEvent({
      type: 'temp_delete_success',
      jobId: params.jobId,
      recordId: params.recordId,
      accountId: params.account.id,
      tempFileId: params.tempId,
      status: 'success',
      message: '开放平台转存临时目录删除成功',
      details: { tempDir: params.tempDir },
    })
  } catch (error) {
    if (params.path && params.path !== params.tempDir) {
      try {
        await withOpenPlatformAccessToken({
          account: params.account,
          jobId: params.jobId,
          trigger: 'cleanup',
          action: ({ accessToken }) => client.deleteDiskPathsByAccessToken({ paths: [params.path], accessToken }),
        })
        markTempDeleted(params.tempId)
        recordParseEvent({
          type: 'temp_delete_success',
          jobId: params.jobId,
          recordId: params.recordId,
          accountId: params.account.id,
          tempFileId: params.tempId,
          status: 'success',
          message: '开放平台转存文件删除成功，目录删除失败',
          details: { tempDir: params.tempDir, path: params.path },
        })
        return
      } catch (fallbackError) {
        const info = appErrorInfo(fallbackError)
        markTempDeleteFailure(params.tempId, info.message, info.code)
        recordParseEvent({
          type: 'temp_delete_failed',
          jobId: params.jobId,
          recordId: params.recordId,
          accountId: params.account.id,
          tempFileId: params.tempId,
          status: 'failed',
          code: info.code,
          message: info.message,
          details: { tempDir: params.tempDir, path: params.path },
        })
        return
      }
    }

    const info = appErrorInfo(error)
    markTempDeleteFailure(params.tempId, info.message, info.code)
    recordParseEvent({
      type: 'temp_delete_failed',
      jobId: params.jobId,
      recordId: params.recordId,
      accountId: params.account.id,
      tempFileId: params.tempId,
      status: 'failed',
      code: info.code,
      message: info.message,
      details: { tempDir: params.tempDir, path: params.path },
    })
  }
}

const deleteTempFileWithAccount = async (params: { item: typeof baiduTempFiles.$inferSelect; account: BaiduAccount; bdstoken?: string }) => {
  if (params.account.credentialSource === 'open_platform') {
    await deleteTempPathsByAccessToken({
      tempId: params.item.id,
      tempDir: params.item.tempDir,
      path: params.item.path,
      account: params.account,
      jobId: params.item.parseJobId,
      recordId: params.item.parseRecordId,
    })
    return
  }
  await deleteTempPaths({
    tempId: params.item.id,
    tempDir: params.item.tempDir,
    path: params.item.path,
    account: params.account,
    bdstoken: params.bdstoken,
    jobId: params.item.parseJobId,
    recordId: params.item.parseRecordId,
  })
}

const scheduleOpenPlatformTempCleanup = (params: {
  tempId: number
  tempDir: string
  path: string
  account: BaiduAccount
  jobId?: number | null
  recordId?: number | null
}) => {
  markTempDeletePending(params.tempId, '开放平台下载链接依赖转存文件，等待链接过期后再清理')
  recordParseEvent({
    type: 'temp_delete_started',
    jobId: params.jobId,
    recordId: params.recordId,
    accountId: params.account.id,
    tempFileId: params.tempId,
    status: 'warning',
    message: '开放平台转存文件保留到链接过期后再清理',
    details: { tempDir: params.tempDir, path: params.path },
  })
}

const cleanupKnownTempFiles = async (account: BaiduAccount) => {
  const pending = db
    .select()
    .from(baiduTempFiles)
    .where(or(eq(baiduTempFiles.status, 'active'), eq(baiduTempFiles.status, 'delete_pending')))
    .all()
    .filter((item) => item.accountId === account.id)

  for (const item of pending) {
    try {
      await deleteTempFileWithAccount({ item, account })
    } catch (error) {
      const info = appErrorInfo(error)
      markTempDeleteFailure(item.id, info.message, info.code)
    }
  }
}

const cleanupTempRoot = async (account: BaiduAccount) => {
  try {
    if (account.credentialSource === 'open_platform') {
      await withOpenPlatformAccessToken({
        account,
        trigger: 'cleanup',
        action: ({ accessToken }) => client.deleteDiskPathsByAccessToken({ paths: [tempRoot()], accessToken }),
      })
    } else {
      await client.deleteDiskPaths({ paths: [tempRoot()], cookie: account.cookie })
    }
  } catch {
    // 百度在目录不存在时也可能报错；清理根目录失败不单独中断当前账号尝试。
  }
}

const parseTransfer = async (params: {
  jobId?: number
  recordId?: number
  share: Awaited<ReturnType<BaiduClient['getFileList']>>
  file: ShareFile
  account: BaiduAccount
  shareUrl: string
}) => {
  const tempDir = tempDirFor(params.jobId ?? 0)
  recordParseEvent({
    type: 'transfer_started',
    jobId: params.jobId,
    accountId: params.account.id,
    message: '开始转存取链路线',
    details: { tempDir, fsId: params.file.fs_id, filename: params.file.server_filename },
  })
  const bdstoken = await ensureDiskDirectory(params.account, tempDir)
  recordParseEvent({
    type: 'temp_dir_ready',
    jobId: params.jobId,
    accountId: params.account.id,
    message: '转存临时目录已就绪',
    details: { tempDir },
  })
  const transfer = async () =>
    client.saveToDiskWeb({
      shareid: params.share.shareid,
      fsIds: [params.file.fs_id],
      uk: params.share.uk,
      randsk: params.share.randsk,
      referer: params.shareUrl,
      cookie: params.account.cookie,
      path: tempDir,
      bdstoken,
    })

  let saved = await transfer().catch(async (error) => {
    const info = appErrorInfo(error)
    if (info.message.includes('空间') || info.message.toLowerCase().includes('quota') || info.message.includes('容量')) {
      await cleanupKnownTempFiles(params.account)
      await cleanupTempRoot(params.account)
      return transfer()
    }
    throw error
  })

  const first = saved[0]
  if (!first?.to) throw upstreamError('SAVE_TO_DISK_FAILED', '转存成功但未返回目标路径')

  db.insert(baiduTempFiles)
    .values({
      parseRecordId: params.recordId,
      parseJobId: params.jobId,
      accountId: params.account.id,
      tempDir,
      path: first.to,
      fsId: String(first.to_fs_id ?? ''),
      sizeBytes: params.file.size,
      status: 'active',
    })
    .run()
  const tempId = lastInsertId()
  recordParseEvent({
    type: 'saved_to_disk',
    jobId: params.jobId,
    accountId: params.account.id,
    tempFileId: tempId,
    status: 'success',
    message: '文件已转存到临时目录',
    details: { tempDir, path: first.to },
  })

  try {
    const resolved = await resolveCookieTransferUrl({
      path: first.to,
      account: params.account,
      jobId: params.jobId,
      tempId,
    })
    return {
      url: resolved.url,
      md5: params.file.md5,
      tempId,
    }
  } finally {
    await deleteTempPaths({
      tempId,
      tempDir,
      path: first.to,
      account: params.account,
      bdstoken,
      jobId: params.jobId,
      recordId: params.recordId,
    })
  }
}

const parseTransferOpenPlatform = async (params: {
  jobId?: number
  recordId?: number
  share: Awaited<ReturnType<BaiduClient['getFileList']>>
  file: ShareFile
  account: BaiduAccount
}) => {
  const tempDir = tempDirFor(params.jobId ?? 0)
  return withOpenPlatformAccessToken({
    account: params.account,
    jobId: params.jobId,
    trigger: 'parse_runtime',
    action: async ({ accessToken, account }) => {
      recordParseEvent({
        type: 'transfer_started',
        jobId: params.jobId,
        accountId: account.id,
        message: '开始开放平台转存取链路线',
        details: { tempDir, fsId: params.file.fs_id, filename: params.file.server_filename },
      })
      await ensureDiskDirectoryByAccessToken(account, tempDir)
      recordParseEvent({
        type: 'temp_dir_ready',
        jobId: params.jobId,
        accountId: account.id,
        message: '开放平台转存临时目录已就绪',
        details: { tempDir },
      })

      const transfer = async () =>
        client.saveToDiskByAccessToken({
          shareid: params.share.shareid,
          fsIds: [params.file.fs_id],
          uk: params.share.uk,
          randsk: params.share.randsk,
          path: tempDir,
          accessToken,
        })

      const saved = await transfer().catch(async (error) => {
        const info = appErrorInfo(error)
        if (info.message.includes('空间') || info.message.toLowerCase().includes('quota') || info.message.includes('容量')) {
          await cleanupKnownTempFiles(account)
          await cleanupTempRoot(account)
          return transfer()
        }
        throw error
      })

      const first = saved[0]
      if (!first?.to) throw upstreamError('SAVE_TO_DISK_FAILED', '开放平台转存成功但未返回目标路径')

      db.insert(baiduTempFiles)
        .values({
          parseRecordId: params.recordId,
          parseJobId: params.jobId,
          accountId: account.id,
          tempDir,
          path: first.to,
          fsId: String(first.to_fs_id ?? ''),
          sizeBytes: params.file.size,
          status: 'active',
        })
        .run()
      const tempId = lastInsertId()

      recordParseEvent({
        type: 'saved_to_disk',
        jobId: params.jobId,
        accountId: account.id,
        tempFileId: tempId,
        status: 'success',
        message: '文件已转存到开放平台临时目录',
        details: { tempDir, path: first.to },
      })

      try {
        const resolved = await resolveOpenPlatformTransferUrl({
          account,
          accessToken,
          jobId: params.jobId,
          tempId,
          path: first.to,
          file: params.file,
        })
        return {
          url: resolved.url,
          md5: resolved.md5,
          tempId,
        }
      } finally {
        scheduleOpenPlatformTempCleanup({
          tempId,
          tempDir,
          path: first.to,
          account,
          jobId: params.jobId,
          recordId: params.recordId,
        })
      }
    },
  })
}

const executeWithAccounts = async (params: {
  user: User
  share: Awaited<ReturnType<BaiduClient['getFileList']>>
  file: ShareFile
  shareUrl: string
  pwd?: string
  dir?: string
  jobId?: number
  accountWait?: AccountWaitOptions
}) => {
  const attemptedFailures: Array<{ accountId: number; code: string; message: string }> = []
  const preferDirect = params.file.size <= directFirstMaxBytes
  let attempts = 0
  let lastAccountWaitEventAt = 0

  while (attempts < getAccountPolicy().maxAccountAttempts) {
    const account = acquireLocalAccount(params.user.id)
    if (!account) {
      const deadlineMs = params.accountWait?.deadline?.getTime()
      const waitMs = deadlineMs ? Math.min(accountWaitRetryMs, Math.max(0, deadlineMs - Date.now())) : 0
      if (waitMs > 0 && hasLocalAccountCandidate(params.user.id)) {
        const now = Date.now()
        if (!lastAccountWaitEventAt || now - lastAccountWaitEventAt >= 5000) {
          lastAccountWaitEventAt = now
          params.accountWait?.onWait?.({ waitMs })
          recordParseEvent({
            type: 'account_waiting',
            jobId: params.jobId,
            message: '等待可用本地账号',
            details: { waitMs },
          })
        }
        await sleep(waitMs)
        continue
      }
      if (attempts === 0) {
        const noAccountCode = 'LOCAL_ACCOUNT_UNAVAILABLE'
        const noAccountMessage = '当前没有可用本地账号'
        const recordId = createRecord({
          userId: params.user.id,
          shareSurl: parseShareUrl(params.shareUrl),
          shareUrl: params.shareUrl,
          pwd: params.pwd,
          dir: params.dir,
          file: params.file,
          status: 'failed',
          errorCode: noAccountCode,
          errorMessage: noAccountMessage,
        })
        recordParseEvent({
          type: 'job_failed',
          jobId: params.jobId,
          recordId,
          status: 'failed',
          code: noAccountCode,
          message: noAccountMessage,
        })
        throw {
          code: noAccountCode,
          message: noAccountMessage,
          status: 'failed',
          recordId,
        } satisfies ParseExecutionError & { recordId: number }
      }
      break
    }

    attempts += 1
    const credentialSource = account.credentialSource ?? 'cookie'
    const sourceSupportsDirect = credentialSource === 'cookie'
    let parseRoute: ParseRoute = preferDirect && sourceSupportsDirect ? 'sharedownload' : 'transfer'
    try {
      recordParseEvent({
        type: 'account_acquired',
        jobId: params.jobId,
        accountId: account.id,
        message: `锁定账号 ${account.id}，开始第 ${attempts} 次尝试`,
        details: { attempt: attempts, credentialSource, preferredRoute: parseRoute },
      })
      let parsed: { url: string; md5?: string; tempId?: number }
      try {
        if (parseRoute === 'sharedownload') {
          parsed = await parseDirect({ share: params.share, file: params.file, account, jobId: params.jobId })
        } else if (credentialSource === 'open_platform') {
          parsed = await parseTransferOpenPlatform({ jobId: params.jobId, share: params.share, file: params.file, account })
        } else {
          parsed = await parseTransfer({ jobId: params.jobId, share: params.share, file: params.file, account, shareUrl: params.shareUrl })
        }
      } catch (error) {
        const info = appErrorInfo(error)
        if (parseRoute === 'sharedownload' && isFileLevelFailure(info.code, info.message)) {
          parseRoute = 'transfer'
          recordParseEvent({
            type: 'transfer_started',
            jobId: params.jobId,
            accountId: account.id,
            status: 'warning',
            code: info.code,
            message: '直链路线不可用，切换到转存路线',
          })
          parsed =
            credentialSource === 'open_platform'
              ? await parseTransferOpenPlatform({ jobId: params.jobId, share: params.share, file: params.file, account })
              : await parseTransfer({ jobId: params.jobId, share: params.share, file: params.file, account, shareUrl: params.shareUrl })
        } else {
          throw error
        }
      }

      const linkExpiresAt = new Date(Date.now() + getDownloadSettings().linkCacheTtlSeconds * 1000)
      const resultUa = downloadUaForRoute(parseRoute, credentialSource)
      const accountOwnerUserId = account.ownerUserId ?? null
      const recordId = createRecord({
        userId: params.user.id,
        accountId: account.id,
        accountOwnerUserId,
        shareSurl: parseShareUrl(params.shareUrl),
        shareUrl: params.shareUrl,
        pwd: params.pwd,
        dir: params.dir,
        file: { ...params.file, md5: parsed.md5 ?? params.file.md5 },
        status: 'success',
        credentialSource,
        parseRoute,
        resultUrl: parsed.url,
        resultUa,
        linkExpiresAt,
        attemptCount: attempts,
      })
      if (parsed.tempId) {
        db.update(baiduTempFiles)
          .set({
            parseRecordId: recordId,
            updatedAt: new Date(),
          })
          .where(eq(baiduTempFiles.id, parsed.tempId))
          .run()
      }
      attachExecutionArtifacts(recordId, params.jobId)
      markAccountSuccess(account.id, { parseJobId: params.jobId, parseRecordId: recordId })
      createAttempt({
        recordId,
        jobId: params.jobId,
        userId: params.user.id,
        accountId: account.id,
        fsId: String(params.file.fs_id),
        status: 'success',
        message: '获取成功',
      })
      recordParseEvent({
        type: 'job_success',
        jobId: params.jobId,
        recordId,
        accountId: account.id,
        tempFileId: parsed.tempId,
        status: 'success',
        message: '解析任务成功',
        details: {
          credentialSource,
          parseRoute,
        },
      })
      return {
        recordId,
        credentialSource,
        parseRoute,
        accountId: account.id,
        accountOwnerUserId,
        url: parsed.url,
        ua: resultUa,
        linkExpiresAt,
        md5: parsed.md5,
        filename: params.file.server_filename,
        fsId: params.file.fs_id,
      } satisfies ParseExecutionResult
    } catch (error) {
      const info = appErrorInfo(error)
      attemptedFailures.push({ accountId: account.id, code: info.code, message: info.message })
      markAccountFailure(account.id, info.code, info.message, { parseJobId: params.jobId })
      createAttempt({
        jobId: params.jobId,
        userId: params.user.id,
        accountId: account.id,
        fsId: String(params.file.fs_id),
        status: 'failed',
        errorCode: info.code,
        message: info.message,
      })
      recordParseEvent({
        type: 'account_failed',
        jobId: params.jobId,
        accountId: account.id,
        status: 'failed',
        code: info.code,
        message: info.message,
        details: { attempt: attempts, credentialSource, parseRoute },
      })
    } finally {
      releaseAccount(account.id)
    }
  }

  const lastFailure = attemptedFailures[attemptedFailures.length - 1]
  const recordId = createRecord({
    userId: params.user.id,
    shareSurl: parseShareUrl(params.shareUrl),
    shareUrl: params.shareUrl,
    pwd: params.pwd,
    dir: params.dir,
    file: params.file,
    status: 'failed',
    errorCode: lastFailure?.code ?? 'NO_ACCOUNT_SUCCEEDED',
    errorMessage: localAccountParseFailedMessage,
    attemptCount: attempts,
  })
  attachExecutionArtifacts(recordId, params.jobId)
  recordParseEvent({
    type: 'job_failed',
    jobId: params.jobId,
    recordId,
    status: 'failed',
    code: lastFailure?.code ?? 'NO_ACCOUNT_SUCCEEDED',
    message: localAccountParseFailedMessage,
    details: { attempts, failures: attemptedFailures },
  })
  throw {
    code: 'PARSE_FAILED',
    message: localAccountParseFailedMessage,
    status: 'failed',
    attempts: attemptedFailures,
    recordId,
  } satisfies ParseExecutionError & { recordId: number }
}

const executeParse = async (params: {
  user: User
  shareUrl: string
  pwd?: string
  dir?: string
  fsIds: unknown
  jobId?: number
  accountWait?: AccountWaitOptions
}) => {
  const fsIds = ensureNumberArray(params.fsIds)
  const surl = parseShareUrl(params.shareUrl)
  const pwd = params.pwd || parseSharePwd(params.shareUrl)
  const resolved = await getShareForParse({
    surl,
    pwd,
    dir: params.dir,
    fsIds,
    jobId: params.jobId,
  })
  return executeWithAccounts({
    user: params.user,
    share: resolved.share,
    file: resolved.file,
    shareUrl: params.shareUrl,
    pwd,
    dir: resolved.dir,
    jobId: params.jobId,
    accountWait: params.accountWait,
  })
}

export const parseLinks = async (input: ParseInput, user?: User) => {
  if (!user) throw badRequest('LOGIN_REQUIRED', '请先登录')
  const result = await executeParse({
    user,
    shareUrl: input.shareUrl,
    pwd: input.pwd,
    dir: input.dir,
    fsIds: input.fsIds,
  })
  return [await toParsedLink(result)]
}

export const parseLinksForBroker = async (
  input: ParseInput,
  user: User,
  options: {
    accountWait?: AccountWaitOptions
  },
) => {
  const result = await executeParse({
    user,
    shareUrl: input.shareUrl,
    pwd: input.pwd,
    dir: input.dir,
    fsIds: input.fsIds,
    accountWait: options.accountWait,
  })
  return [await toParsedLink(result)]
}

const toParsedLink = async (
  result: ParseExecutionResult,
  context: LinkProxyContext = createLinkProxyContext(),
): Promise<ParsedLink & Record<string, unknown>> => ({
  message: 'success',
  filename: result.filename,
  fs_id: result.fsId,
  ua: result.ua,
  account_id: String(result.accountId ?? ''),
  urls: [await createProxiedDownloadUrl(result.url, { filename: result.filename, expiresAt: result.linkExpiresAt, context })],
  credentialSource: result.credentialSource,
  parseRoute: result.parseRoute,
  record_id: result.recordId,
  link_expires_at: result.linkExpiresAt.toISOString(),
})

const resolveDiskRecord = async (
  account: BaiduAccount,
  input: {
    path: string
  },
) => {
  const download = getDownloadSettings()
  const linkExpiresAt = new Date(Date.now() + download.linkCacheTtlSeconds * 1000)
  if (account.credentialSource === 'open_platform') {
    const token = await verifyOpenPlatformToken(account, {
      trigger: 'parse_runtime',
      allowRefreshFallback: true,
    })
    return {
      url: client.buildOpenPlatformDownloadUrl(input.path, token.accessToken),
      ua: download.directDownloadUA,
      linkExpiresAt,
    }
  }

  const urls = await client.downloadByDiskWithCookie(input.path, account.cookie)
  return {
    url: urls[0] ?? '',
    ua: download.pcsUA,
    linkExpiresAt,
  }
}

const insertDiskReparseJob = async (input: {
  user: User
  record: ParseRecord
  account: BaiduAccount
  path: string
  result: Awaited<ReturnType<typeof resolveDiskRecord>>
  startedAt: Date
}) => {
  const { user, record, account, path, result, startedAt } = input
  const details = {
    accountId: account.id,
    credentialSource: account.credentialSource,
    fsId: Number(record.fsId),
    path,
    filename: record.filename,
    sizeBytes: record.sizeBytes,
    sourceRecordId: record.id,
  }
  db.insert(parseRecords)
    .values({
      userId: user.id,
      accountId: account.id,
      accountOwnerUserId: account.ownerUserId ?? user.id,
      shareSurl: `disk:${account.id}`,
      shareUrl: `disk://${account.id}${path}`,
      pwd: null,
      dir: parentDirOfPath(path),
      fsId: record.fsId,
      filename: record.filename,
      sizeBytes: record.sizeBytes,
      md5: record.md5,
      status: 'success',
      route: 'disk',
      credentialSource: account.credentialSource,
      parseRoute: null,
      resultUrl: result.url,
      resultUa: result.ua,
      linkExpiresAt: result.linkExpiresAt,
      errorCode: null,
      errorMessage: null,
      attemptCount: 1,
    })
    .run()
  const recordId = lastInsertId()
  db.insert(parseAttempts)
    .values({
      parseRecordId: recordId,
      userId: user.id,
      accountId: account.id,
      fsId: record.fsId,
      status: 'success',
      message: 'disk reparse success',
    })
    .run()
  recordParseEvent({
    type: 'disk_reparse_started',
    recordId,
    accountId: account.id,
    message: '网盘历史重新解析开始',
    details,
    createdAt: startedAt,
  })
  recordParseEvent({
    type: 'disk_reparse_success',
    recordId,
    accountId: account.id,
    status: 'success',
    message: '网盘历史重新解析成功',
    details,
  })
  db.insert(parseJobs)
    .values({
      userId: user.id,
      parseRecordId: recordId,
      accountId: account.id,
      shareUrl: `disk://${account.id}${path}`,
      shareSurl: `disk:${account.id}`,
      pwd: null,
      dir: parentDirOfPath(path),
      fsId: record.fsId,
      filename: record.filename,
      sizeBytes: record.sizeBytes,
      md5: record.md5,
      status: 'success',
      queueSeq: nextQueueSeq(),
      route: 'disk',
      credentialSource: account.credentialSource,
      parseRoute: null,
      accountOwnerUserId: account.ownerUserId ?? user.id,
      resultUrl: result.url,
      resultUa: result.ua,
      linkExpiresAt: result.linkExpiresAt,
      finishedAt: new Date(),
    })
    .run()
  const job = db.select().from(parseJobs).where(eq(parseJobs.id, lastInsertId())).get()
  if (!job) throw upstreamError('JOB_CREATE_FAILED', '任务创建失败')
  recordParseEvent({
    type: 'disk_reparse_job_success',
    jobId: job.id,
    recordId,
    accountId: account.id,
    status: 'success',
    message: '网盘历史重新解析任务完成',
    details,
  })
  return serializeJob(job)
}

const insertSuccessfulJob = async (input: {
  user: User
  shareUrl: string
  surl: string
  pwd?: string
  dir?: string
  file: ShareFile
  result: ParseExecutionResult
}) => {
  db.insert(parseJobs)
    .values({
      userId: input.user.id,
      parseRecordId: input.result.recordId,
      accountId: input.result.accountId ?? null,
      shareUrl: input.shareUrl,
      shareSurl: input.surl,
      pwd: input.pwd,
      dir: input.dir ?? '/',
      fsId: String(input.file.fs_id),
      filename: input.file.server_filename,
      sizeBytes: input.file.size,
      md5: input.result.md5 ?? input.file.md5,
      status: 'success',
      queueSeq: nextQueueSeq(),
      route: input.result.parseRoute,
      credentialSource: input.result.credentialSource,
      parseRoute: input.result.parseRoute,
      accountOwnerUserId: input.result.accountOwnerUserId ?? null,
      resultUrl: input.result.url,
      resultUa: input.result.ua,
      linkExpiresAt: input.result.linkExpiresAt,
      finishedAt: new Date(),
    })
    .run()
  const job = db.select().from(parseJobs).where(eq(parseJobs.id, lastInsertId())).get()
  if (!job) throw upstreamError('JOB_CREATE_FAILED', '任务创建失败')
  recordParseEvent({
    type: 'job_success',
    jobId: job.id,
    recordId: input.result.recordId,
    accountId: input.result.accountId,
    status: 'success',
    message: '任务创建即成功',
    details: { credentialSource: input.result.credentialSource, parseRoute: input.result.parseRoute },
  })
  return serializeJob(job)
}

const insertFailedJob = async (input: {
  user: User
  shareUrl: string
  surl: string
  pwd?: string
  dir?: string
  file: ShareFile
  recordId: number
  code: string
  message: string
}) => {
  db.insert(parseJobs)
    .values({
      userId: input.user.id,
      parseRecordId: input.recordId,
      shareUrl: input.shareUrl,
      shareSurl: input.surl,
      pwd: input.pwd,
      dir: input.dir ?? '/',
      fsId: String(input.file.fs_id),
      filename: input.file.server_filename,
      sizeBytes: input.file.size,
      md5: input.file.md5,
      status: 'failed',
      queueSeq: nextQueueSeq(),
      errorCode: input.code,
      errorMessage: input.message,
      finishedAt: new Date(),
    })
    .run()
  const job = db.select().from(parseJobs).where(eq(parseJobs.id, lastInsertId())).get()
  if (!job) throw upstreamError('JOB_CREATE_FAILED', '任务创建失败')
  recordParseEvent({
    type: 'job_failed',
    jobId: job.id,
    recordId: input.recordId,
    status: 'failed',
    code: input.code,
    message: input.message,
  })
  return serializeJob(job)
}

export const submitParseJob = async (input: ParseInput, user?: User) => {
  if (!user) throw badRequest('LOGIN_REQUIRED', '请先登录')
  const fsIds = ensureNumberArray(input.fsIds)
  const surl = parseShareUrl(input.shareUrl)
  const pwd = input.pwd || parseSharePwd(input.shareUrl)
  const resolved = await getShareForParse({
    surl,
    pwd,
    dir: input.dir,
    fsIds,
  })

  db.insert(parseJobs)
    .values({
      userId: user.id,
      shareUrl: input.shareUrl,
      shareSurl: surl,
      pwd,
      dir: resolved.dir,
      fsId: String(resolved.file.fs_id),
      filename: resolved.file.server_filename,
      sizeBytes: resolved.file.size,
      md5: resolved.file.md5,
      status: 'queued',
      queueSeq: nextQueueSeq(),
    })
    .run()
  const job = db.select().from(parseJobs).where(eq(parseJobs.id, lastInsertId())).get()
  if (!job) throw upstreamError('JOB_CREATE_FAILED', '任务创建失败')
  recordParseEvent({
    type: 'job_queued',
    jobId: job.id,
    message: '解析任务已入队',
    details: { queueSeq: job.queueSeq, fsId: job.fsId, filename: job.filename, dir: job.dir },
  })
  if (resolved.fallback) recordShareDirFallbackEvent(job.id, resolved.fallback)
  void processNextJob()
  return serializeJob(job)
}

let processing = false

export const hasActiveParseJobs = () => {
  if (processing) return true
  const row = db
    .select({ value: sql<number>`COUNT(*)` })
    .from(parseJobs)
    .where(or(eq(parseJobs.status, 'queued'), eq(parseJobs.status, 'running')))
    .get()
  return Number(row?.value ?? 0) > 0
}

const processNextJob = async () => {
  if (processing) return
  processing = true
  try {
    while (true) {
      const job = db.select().from(parseJobs).where(eq(parseJobs.status, 'queued')).orderBy(sql`${parseJobs.queueSeq} ASC`).get()
      if (!job) return

      db.update(parseJobs)
        .set({
          status: 'running',
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(parseJobs.id, job.id))
        .run()
      recordParseEvent({
        type: 'job_started',
        jobId: job.id,
        message: '解析任务开始执行',
        details: { fsId: job.fsId, filename: job.filename },
      })

      const typedUser = db.select().from(users).where(eq(users.id, job.userId)).get()
      if (!typedUser) {
        db.update(parseJobs)
          .set({
            status: 'failed',
            errorCode: 'USER_NOT_FOUND',
            errorMessage: '用户不存在',
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(parseJobs.id, job.id))
          .run()
        recordParseEvent({
          type: 'job_failed',
          jobId: job.id,
          status: 'failed',
          code: 'USER_NOT_FOUND',
          message: '用户不存在',
        })
        continue
      }

      try {
        const result = await executeParse({
          user: typedUser,
          shareUrl: job.shareUrl,
          pwd: job.pwd ?? undefined,
          dir: job.dir,
          fsIds: [Number(job.fsId)],
          jobId: job.id,
        })
        db.update(parseJobs)
          .set({
            status: 'success',
            parseRecordId: result.recordId,
            accountId: result.accountId ?? null,
            route: result.parseRoute,
            credentialSource: result.credentialSource,
            parseRoute: result.parseRoute,
            accountOwnerUserId: result.accountOwnerUserId ?? null,
            resultUrl: result.url,
            resultUa: result.ua,
            linkExpiresAt: result.linkExpiresAt,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(parseJobs.id, job.id))
          .run()
      } catch (error) {
        const info = appErrorInfo(error)
        const recordId = typeof error === 'object' && error !== null && 'recordId' in error && typeof error.recordId === 'number' ? error.recordId : null
        db.update(parseJobs)
          .set({
            status: 'failed',
            parseRecordId: recordId,
            errorCode: info.code,
            errorMessage: info.message,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(parseJobs.id, job.id))
          .run()
        recordParseEvent({
          type: 'job_failed',
          jobId: job.id,
          recordId,
          status: 'failed',
          code: info.code,
          message: info.message,
        })
      }
    }
  } finally {
    processing = false
  }
}

export const getParseJob = async (id: number, user?: User) => {
  if (!user) throw badRequest('LOGIN_REQUIRED', '请先登录')
  const job = db.select().from(parseJobs).where(eq(parseJobs.id, id)).get()
  if (!job) throw notFound('JOB_NOT_FOUND', '任务不存在')
  if (job.userId !== user.id && !user.isAdmin) throw forbidden('JOB_FORBIDDEN', '无权查看该任务')
  return serializeJob(job)
}

export const listParseHistory = async (
  input: {
    status?: string
    credentialSource?: string
    parseRoute?: string
    q?: string
    page?: number
    pageSize?: number
  },
  user?: User,
) => {
  if (!user) throw badRequest('LOGIN_REQUIRED', '请先登录')
  const page = Math.max(1, Number(input.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize ?? 20)))
  const filters = [eq(parseRecords.userId, user.id)]
  if (input.status && ['success', 'failed'].includes(input.status)) filters.push(eq(parseRecords.status, input.status as 'success' | 'failed'))
  if (input.credentialSource && ['cookie', 'open_platform'].includes(input.credentialSource)) {
    filters.push(eq(parseRecords.credentialSource, input.credentialSource as CredentialSource))
  }
  if (input.parseRoute === 'disk') {
    filters.push(like(parseRecords.shareSurl, 'disk:%'))
  } else if (input.parseRoute && ['sharedownload', 'transfer'].includes(input.parseRoute)) {
    filters.push(eq(parseRecords.parseRoute, input.parseRoute as ParseRoute))
  }
  if (input.q?.trim()) {
    const pattern = `%${input.q.trim()}%`
    filters.push(or(like(parseRecords.filename, pattern), like(parseRecords.fsId, pattern), like(parseRecords.errorCode, pattern))!)
  }
  const where = and(...filters)
  const [{ value: total }] = db.select({ value: sql<number>`COUNT(*)` }).from(parseRecords).where(where).all()
  const context = createLinkProxyContext()
  const rows = db
    .select()
    .from(parseRecords)
    .where(where)
    .orderBy(desc(parseRecords.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()
  const records = await Promise.all(rows.map((record) => serializeRecord(record, context)))

  return {
    records,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export const getParseHistoryDetail = async (id: number, user?: User) => {
  if (!user) throw badRequest('LOGIN_REQUIRED', '请先登录')
  const record = db.select().from(parseRecords).where(eq(parseRecords.id, id)).get()
  if (!record) throw notFound('HISTORY_NOT_FOUND', '解析记录不存在')
  if (record.userId !== user.id && !user.isAdmin) throw forbidden('HISTORY_FORBIDDEN', '无权查看该记录')
  const context = createLinkProxyContext()
  const events = db
    .select()
    .from(parseEvents)
    .where(eq(parseEvents.parseRecordId, id))
    .orderBy(asc(parseEvents.createdAt), asc(parseEvents.id))
    .all()
    .map(serializeEvent)
  const attempts = db.select().from(parseAttempts).where(eq(parseAttempts.parseRecordId, id)).orderBy(asc(parseAttempts.createdAt), asc(parseAttempts.id)).all()
  const tempFiles = db
    .select({
      id: baiduTempFiles.id,
      parseRecordId: baiduTempFiles.parseRecordId,
      parseJobId: baiduTempFiles.parseJobId,
      accountId: baiduTempFiles.accountId,
      tempDir: baiduTempFiles.tempDir,
      path: baiduTempFiles.path,
      fsId: baiduTempFiles.fsId,
      sizeBytes: baiduTempFiles.sizeBytes,
      status: baiduTempFiles.status,
      errorMessage: baiduTempFiles.errorMessage,
      retryCount: baiduTempFiles.retryCount,
      createdAt: baiduTempFiles.createdAt,
      deletedAt: baiduTempFiles.deletedAt,
      updatedAt: baiduTempFiles.updatedAt,
      accountExists: sql<boolean>`CASE WHEN ${baiduTempFiles.accountId} IS NULL THEN 0 WHEN ${baiduAccounts.id} IS NULL THEN 0 ELSE 1 END`,
    })
    .from(baiduTempFiles)
    .leftJoin(baiduAccounts, eq(baiduTempFiles.accountId, baiduAccounts.id))
    .where(eq(baiduTempFiles.parseRecordId, id))
    .orderBy(asc(baiduTempFiles.createdAt), asc(baiduTempFiles.id))
    .all()
    .map(serializeTempFileDetail)
  return {
    record: await serializeRecord(record, context),
    events,
    attempts,
    tempFiles,
  }
}

export const reparseHistory = async (id: number, user?: User) => {
  if (!user) throw badRequest('LOGIN_REQUIRED', '请先登录')
  const record = db.select().from(parseRecords).where(eq(parseRecords.id, id)).get()
  if (!record) throw notFound('HISTORY_NOT_FOUND', '解析记录不存在')
  if (record.userId !== user.id) throw forbidden('HISTORY_FORBIDDEN', '无权重新解析该记录')
  if (record.shareSurl.startsWith('disk:')) {
    if (!record.accountId) throw notFound('ACCOUNT_NOT_FOUND', '原网盘账号不存在')
    const account = db.select().from(baiduAccounts).where(eq(baiduAccounts.id, record.accountId)).get()
    if (!account) throw notFound('ACCOUNT_NOT_FOUND', '原网盘账号不存在')
    if (account.ownerUserId !== null && account.ownerUserId !== user.id && !user.isAdmin) {
      throw forbidden('ACCOUNT_FORBIDDEN', '无权使用该账号重新解析')
    }
    const rawPath = record.shareUrl?.startsWith(`disk://${account.id}`)
      ? record.shareUrl.slice(`disk://${account.id}`.length)
      : record.dir
        ? `${record.dir === '/' ? '' : record.dir}/${record.filename}`
        : `/${record.filename}`
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    const startedAt = new Date()
    try {
      const result = await resolveDiskRecord(account, { path })
      return await insertDiskReparseJob({ user, record, account, path, result, startedAt })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'DISK_REPARSE_FAILED'
      const message = unknownErrorMessage(error)
      const details = {
        accountId: account.id,
        credentialSource: account.credentialSource,
        fsId: Number(record.fsId),
        path,
        filename: record.filename,
        sizeBytes: record.sizeBytes,
        sourceRecordId: record.id,
      }
      db.insert(parseRecords)
        .values({
          userId: user.id,
          accountId: account.id,
          accountOwnerUserId: account.ownerUserId ?? user.id,
          shareSurl: `disk:${account.id}`,
          shareUrl: `disk://${account.id}${path}`,
          pwd: null,
          dir: parentDirOfPath(path),
          fsId: record.fsId,
          filename: record.filename,
          sizeBytes: record.sizeBytes,
          md5: record.md5,
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
      const recordId = lastInsertId()
      db.insert(parseAttempts)
        .values({
          parseRecordId: recordId,
          userId: user.id,
          accountId: account.id,
          fsId: record.fsId,
          status: 'failed',
          errorCode: code,
          message,
        })
        .run()
      recordParseEvent({
        type: 'disk_reparse_started',
        recordId,
        accountId: account.id,
        message: '网盘历史重新解析开始',
        details,
        createdAt: startedAt,
      })
      recordParseEvent({
        type: 'disk_reparse_failed',
        recordId,
        accountId: account.id,
        status: 'failed',
        code,
        message,
        details,
      })
      throw error
    }
  }
  return submitParseJob(
    {
      shareUrl: record.shareUrl || `https://pan.baidu.com/s/1${record.shareSurl}`,
      pwd: record.pwd ?? undefined,
      dir: record.dir ?? undefined,
      fsIds: [Number(record.fsId)],
    },
    user,
  )
}

const emptyTempCleanupResult = (): TempFileCleanupResult => ({
  attempted: 0,
  deleted: 0,
  failed: 0,
  skipped: 0,
  orphan: 0,
  waitingForExpiry: 0,
  firstError: null,
})

let tempCleanupRunning = false
let activeTempCleanupRun: TempFileCleanupRunSnapshot | null = null

const tempCleanupRunRetentionLimit = 50

const tempFileSnapshot = (item: typeof baiduTempFiles.$inferSelect) => ({
  id: item.id,
  tempDir: item.tempDir,
  path: item.path,
  status: item.status,
  createdAt: item.createdAt.toISOString(),
  errorMessage: item.errorMessage,
})

const serializeCleanupRunResult = (
  run: Pick<TempFileCleanupRun, 'attempted' | 'deleted' | 'failed' | 'skipped' | 'orphan' | 'waitingForExpiry' | 'firstError'>,
) => ({
  attempted: run.attempted,
  deleted: run.deleted,
  failed: run.failed,
  skipped: run.skipped,
  orphan: run.orphan,
  waitingForExpiry: run.waitingForExpiry,
  firstError: run.firstError,
})

const serializeCleanupRun = (run: TempFileCleanupRun): TempFileCleanupSummary['recentRuns'][number] => ({
  id: run.id,
  trigger: run.trigger,
  status: run.status,
  startedAt: run.startedAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
  totalCandidates: run.totalCandidates,
  processed: run.processed,
  result: serializeCleanupRunResult(run),
})

const listRecentCleanupRuns = () =>
  db.select().from(tempFileCleanupRuns).orderBy(desc(tempFileCleanupRuns.startedAt), desc(tempFileCleanupRuns.id)).limit(10).all().map(serializeCleanupRun)

const createTempCleanupRun = (trigger: 'auto' | 'manual', startedAt: Date) => {
  db.insert(tempFileCleanupRuns)
    .values({
      trigger,
      status: 'running',
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    .run()
  return lastInsertId()
}

const updateTempCleanupRunProgress = (runId: number, progress: Partial<Omit<TempFileCleanupRunSnapshot, 'id' | 'trigger' | 'startedAt' | 'finishedAt'>>) => {
  const patch: Partial<typeof tempFileCleanupRuns.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (typeof progress.status === 'string') patch.status = progress.status
  if (typeof progress.totalCandidates === 'number') patch.totalCandidates = progress.totalCandidates
  if (typeof progress.processed === 'number') patch.processed = progress.processed
  if (progress.result) {
    patch.attempted = progress.result.attempted
    patch.deleted = progress.result.deleted
    patch.failed = progress.result.failed
    patch.skipped = progress.result.skipped
    patch.orphan = progress.result.orphan
    patch.waitingForExpiry = progress.result.waitingForExpiry
    patch.firstError = progress.result.firstError
  }
  db.update(tempFileCleanupRuns).set(patch).where(eq(tempFileCleanupRuns.id, runId)).run()
}

const finishTempCleanupRun = (
  runId: number,
  status: 'success' | 'failed',
  result: TempFileCleanupResult,
  finishedAt: Date,
  processed: number,
  totalCandidates: number,
) => {
  db.update(tempFileCleanupRuns)
    .set({
      status,
      finishedAt,
      totalCandidates,
      processed,
      attempted: result.attempted,
      deleted: result.deleted,
      failed: result.failed,
      skipped: result.skipped,
      orphan: result.orphan,
      waitingForExpiry: result.waitingForExpiry,
      firstError: result.firstError,
      updatedAt: finishedAt,
    })
    .where(eq(tempFileCleanupRuns.id, runId))
    .run()
}

const pruneTempCleanupRuns = () => {
  const keepRows = db
    .select({ id: tempFileCleanupRuns.id })
    .from(tempFileCleanupRuns)
    .orderBy(desc(tempFileCleanupRuns.startedAt), desc(tempFileCleanupRuns.id))
    .limit(tempCleanupRunRetentionLimit)
    .all()
  const keepIds = keepRows.map((row) => row.id)
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000
  if (keepIds.length > 0) {
    db.delete(tempFileCleanupRuns)
      .where(and(notInArray(tempFileCleanupRuns.id, keepIds), sql`${tempFileCleanupRuns.startedAt} < ${cutoffMs}`))
      .run()
    return
  }
  db.delete(tempFileCleanupRuns).where(sql`${tempFileCleanupRuns.startedAt} < ${cutoffMs}`).run()
}

const markStaleActiveTempFilesPending = () => {
  const staleActiveCutoff = Date.now() - 30 * 60 * 1000
  db.update(baiduTempFiles)
    .set({
      status: 'delete_pending',
      errorMessage: '历史遗留临时文件，等待后台重试清理',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(baiduTempFiles.status, 'active'),
        or(
          and(sql`${baiduTempFiles.parseJobId} IS NULL`, sql`${baiduTempFiles.createdAt} < ${staleActiveCutoff}`),
          sql`${baiduTempFiles.parseJobId} IN (SELECT id FROM parse_jobs WHERE status IN ('success', 'failed', 'canceled'))`,
        )!,
      ),
    )
    .run()
}

const selectTempCleanupCandidates = (includeFailed: boolean, limit: number) =>
  db
    .select()
    .from(baiduTempFiles)
    .where(includeFailed ? inArray(baiduTempFiles.status, ['delete_pending', 'delete_failed']) : eq(baiduTempFiles.status, 'delete_pending'))
    .orderBy(asc(baiduTempFiles.updatedAt), asc(baiduTempFiles.id))
    .limit(limit)
    .all()

const runTempFileCleanup = async (input: {
  includeFailed: boolean
  maxRetryCount: number
  trigger: 'auto' | 'manual'
  limit?: number
}): Promise<TempFileCleanupResult> => {
  if (tempCleanupRunning) return { ...emptyTempCleanupResult(), skipped: 1, firstError: '中转文件清理正在运行' }
  tempCleanupRunning = true
  const startedAt = new Date()
  const runId = createTempCleanupRun(input.trigger, startedAt)
  const result = emptyTempCleanupResult()
  let processed = 0
  let totalCandidates = 0
  activeTempCleanupRun = {
    id: runId,
    trigger: input.trigger,
    status: 'running',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    totalCandidates,
    processed,
    currentTempFileId: null,
    result: { ...result },
  }
  try {
    markStaleActiveTempFilesPending()
    const openPlatformDeleteCutoff = Date.now() - getDownloadSettings().linkCacheTtlSeconds * 1000
    const pending = selectTempCleanupCandidates(input.includeFailed, input.limit ?? 20)
    totalCandidates = pending.length
    activeTempCleanupRun = activeTempCleanupRun
      ? {
          ...activeTempCleanupRun,
          totalCandidates,
        }
      : null
    updateTempCleanupRunProgress(runId, { totalCandidates, processed, result })
    for (const item of pending) {
      activeTempCleanupRun = activeTempCleanupRun
        ? {
            ...activeTempCleanupRun,
            currentTempFileId: item.id,
          }
        : null
      if (item.retryCount > input.maxRetryCount) {
        result.skipped += 1
      } else {
        const accountMeta = item.accountId
          ? db
              .select({
                credentialSource: baiduAccounts.credentialSource,
              })
              .from(baiduAccounts)
              .where(eq(baiduAccounts.id, item.accountId))
              .get()
          : null
        if (!item.accountId || !accountMeta) {
          result.orphan += 1
          result.skipped += 1
        } else if (accountMeta.credentialSource === 'open_platform' && item.createdAt.getTime() > openPlatformDeleteCutoff) {
          result.waitingForExpiry += 1
          result.skipped += 1
        } else {
          const account = acquireAccountById(item.accountId)
          if (!account) {
            result.skipped += 1
            if (!result.firstError) result.firstError = `账号 #${item.accountId} 当前不可用，已跳过中转文件 #${item.id}`
          } else {
            result.attempted += 1
            try {
              const stillExists = await tempPathStillExists({
                account,
                tempDir: item.tempDir,
                path: item.path,
              })
              if (!stillExists) {
                markTempDeleted(item.id)
                result.deleted += 1
                recordParseEvent({
                  type: 'temp_delete_success',
                  jobId: item.parseJobId,
                  recordId: item.parseRecordId,
                  accountId: account.id,
                  tempFileId: item.id,
                  status: 'success',
                  message: '转存临时路径已不存在，标记为已删除',
                  details: { tempDir: item.tempDir, path: item.path },
                })
              } else {
                await deleteTempFileWithAccount({ item, account })
                result.deleted += 1
              }
            } catch (error) {
              result.failed += 1
              const info = appErrorInfo(error)
              if (!result.firstError) result.firstError = info.message
              markTempDeleteFailure(item.id, info.message, info.code)
            } finally {
              releaseAccount(account.id)
            }
          }
        }
      }
      processed += 1
      activeTempCleanupRun = activeTempCleanupRun
        ? {
            ...activeTempCleanupRun,
            processed,
            currentTempFileId: null,
            result: { ...result },
          }
        : null
      updateTempCleanupRunProgress(runId, { processed, result })
    }
    return result
  } finally {
    const finishedAt = new Date()
    const status = result.failed > 0 || result.firstError ? 'failed' : 'success'
    finishTempCleanupRun(runId, status, result, finishedAt, processed, totalCandidates)
    if (activeTempCleanupRun?.id === runId) {
      activeTempCleanupRun = {
        ...activeTempCleanupRun,
        status,
        finishedAt: finishedAt.toISOString(),
        totalCandidates,
        processed,
        currentTempFileId: null,
        result: { ...result },
      }
    }
    pruneTempCleanupRuns()
    tempCleanupRunning = false
    activeTempCleanupRun = null
  }
}

export const retryPendingDeletes = async () =>
  runTempFileCleanup({
    includeFailed: false,
    maxRetryCount: autoTempDeleteRetryLimit,
    trigger: 'auto',
  })

export const runManualTempFileCleanup = async () =>
  runTempFileCleanup({
    includeFailed: true,
    maxRetryCount: manualTempDeleteRetryLimit,
    trigger: 'manual',
  })

export const getTempFileCleanupSummary = (): TempFileCleanupSummary => {
  const rows = db
    .select({
      status: baiduTempFiles.status,
      value: sql<number>`COUNT(*)`,
    })
    .from(baiduTempFiles)
    .groupBy(baiduTempFiles.status)
    .all()
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.value ?? 0)]))
  const orphanWhere = and(
    inArray(baiduTempFiles.status, ['active', 'delete_pending', 'delete_failed']),
    sql`(${baiduTempFiles.accountId} IS NULL OR ${baiduTempFiles.accountId} NOT IN (SELECT id FROM baidu_accounts))`,
  )
  const [{ value: orphanCount }] = db.select({ value: sql<number>`COUNT(*)` }).from(baiduTempFiles).where(orphanWhere).all()
  const recentOrphans = db
    .select()
    .from(baiduTempFiles)
    .where(orphanWhere)
    .orderBy(desc(baiduTempFiles.updatedAt), desc(baiduTempFiles.id))
    .limit(5)
    .all()
    .map(tempFileSnapshot)
  const recentErrors = db
    .select()
    .from(baiduTempFiles)
    .where(inArray(baiduTempFiles.status, ['delete_pending', 'delete_failed']))
    .orderBy(desc(baiduTempFiles.updatedAt), desc(baiduTempFiles.id))
    .limit(5)
    .all()
    .map((item) => ({
      ...tempFileSnapshot(item),
      retryCount: item.retryCount,
      updatedAt: item.updatedAt.toISOString(),
    }))
  const recentRuns = listRecentCleanupRuns()
  const lastRun = recentRuns[0] ?? null
  return {
    active: counts.active ?? 0,
    deletePending: counts.delete_pending ?? 0,
    deleteFailed: counts.delete_failed ?? 0,
    deleted: counts.deleted ?? 0,
    orphan: Number(orphanCount ?? 0),
    recentOrphans,
    recentErrors,
    lastRun,
    recentRuns,
  }
}

export const getTempFileCleanupStatus = (): TempFileCleanupStatus => ({
  running: activeTempCleanupRun,
  recentRuns: listRecentCleanupRuns(),
})
