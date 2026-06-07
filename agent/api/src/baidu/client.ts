import { requestHeadLocation, requestJson } from '../lib/http'
import { getBaiduSettings, getDownloadSettings } from '../settings/service'
import { AppError, upstreamError } from '../lib/errors'
import { decodeSecKey } from './share'
import type { DiskListResult, SavedFile, ShareFile, ShareListResult, ShareSignResult } from './types'

type WxListResponse = {
  errno?: number
  errtype?: number | string
  data?: {
    uk: number
    shareid: number
    seckey: string
    uname: string
    list: Array<Record<string, unknown>>
  }
}

type TransferResponse = {
  errno?: number
  show_msg?: string
  info?: unknown
  errmsg?: string
  error_msg?: string
  bdstoken?: string
  extra?: {
    list?: SavedFile[]
  }
}

type DownloadResponse = {
  error_code?: number | string
  error_msg?: unknown
  errno?: number | string
  urls?: Array<{ url: string }>
}

type FileManagerResponse = {
  errno?: number
  info?: unknown
  errmsg?: string
  show_msg?: string
  request_id?: number | string
  authwidget?: {
    saferand?: string
    safesign?: string
    safetpl?: string
  }
  verify_scene?: number
}

type TemplateVariableResponse = {
  errno?: number
  result?: {
    username?: string
    bdstoken?: string
    loginstate?: number
    is_vip?: number
    is_svip?: number
    is_evip?: number
  }
  show_msg?: unknown
  errmsg?: unknown
  error_msg?: unknown
  info?: unknown
  error_code?: unknown
}

type UInfoResponse = {
  errno?: number
  uk?: number | string
  baidu_name?: string
  netdisk_name?: string
  avatar_url?: string
  vip_type?: number
  errmsg?: unknown
  show_msg?: unknown
  error_msg?: unknown
  info?: unknown
  error_code?: unknown
}

type QuotaResponse = {
  errno?: number
  errmsg?: unknown
  error_msg?: unknown
  show_msg?: unknown
  info?: unknown
  error_code?: unknown
  total?: number | string
  used?: number | string
  free?: number | string
}

type MembershipResponse = {
  error_code?: number | string
  error_msg?: unknown
  errmsg?: unknown
  show_msg?: unknown
  info?: unknown
  currenttime?: number
  current_product_v2?: {
    detail_cluster?: string
  }
  reminder?: {
    serverTime?: number
    svip?: { leftseconds?: number }
    vip?: { leftseconds?: number }
  }
}

type CreateDirectoryResponse = {
  errno?: number
  info?: unknown
  errmsg?: string
  show_msg?: string
  error_msg?: string
  path?: string
  data?: {
    path?: string
  }
}

type FileMetasResponse = {
  errno?: number
  errmsg?: unknown
  error_msg?: unknown
  show_msg?: unknown
  info?: unknown
  error_code?: unknown
  list?: Array<{
    fs_id?: number | string
    dlink?: string
    md5?: string
    path?: string
    filename?: string
    server_filename?: string
    size?: number | string
  }>
}

type DiskListResponse = {
  errno?: number
  errmsg?: string
  error_msg?: string
  info?: unknown
  show_msg?: string
  list?: Array<{
    category?: number | string
    fs_id?: number | string
    local_ctime?: number | string
    local_mtime?: number | string
    md5?: string
    server_filename?: string
    path?: string
    isdir?: number | string
    server_ctime?: number | string
    server_mtime?: number | string
    size?: number | string
    dlink?: string
  }>
}

type SignResponse = {
  errno?: number
  show_msg?: unknown
  errmsg?: unknown
  error_msg?: unknown
  info?: unknown
  error_code?: unknown
  data?: {
    sign: string
    timestamp: number
  }
}

type ShareDownloadResponse = {
  errno?: number
  error_msg?: unknown
  show_msg?: unknown
  errmsg?: unknown
  info?: unknown
  error_code?: unknown
  list?:
    | string
    | Array<{
        dlink?: string
        fs_id?: number | string
        md5?: string
        server_filename?: string
        size?: number | string
        path?: string
      }>
}

type SharedDownloadClientType = 0 | 12

const mapShareError = (errno: number | string, errtype: number | string) => {
  if (errno === -130) {
    const message = new Map<number | string, string>([
      [0, '分享的文件已经被删除'],
      [1, '分享已经被取消'],
      [2, '分享内容暂时不可访问'],
      [3, '分享内容违规，无法访问'],
      [5, '链接错误或未找到文件'],
      [10, '分享文件已过期'],
      [11, '访问次数过多，分享链接已失效'],
      [15, '系统升级，链接暂时无法查看'],
      [17, '该链接访问范围受限'],
      [123, '分享链接已超过访问人数上限'],
      [124, '分享链接已被冻结'],
      ['mis_105', 'surl 错误'],
      ['mispw_9', '提取码错误'],
      ['mispwd-9', '提取码错误'],
      ['mis_2', '路径错误'],
      ['mis_4', '路径错误'],
    ]).get(errtype)

    return message ?? `获取文件列表失败: ${errtype}`
  }

  if (errno === 2) return 'surl 错误'
  if (errno === -6) return '请不要使用私密链接'
  return `获取文件列表失败: errno ${errno}, errtype ${errtype}`
}

const toNumber = (value: unknown) => Number(value ?? 0)
const toString = (value: unknown) => String(value ?? '')
const diskListOrder = (order?: 'time' | 'filename') => (order === 'time' ? 'time' : 'name')

export const formatUpstreamErrorMessage = (
  response: {
    show_msg?: unknown
    errmsg?: unknown
    error_msg?: unknown
    error_code?: unknown
    info?: unknown
    errno?: unknown
  },
  fallback?: string,
) => {
  const formatValue = (value: unknown) => {
    if (value === undefined || value === null || value === '') return null
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  return (
    formatValue(response.show_msg) ??
    formatValue(response.errmsg) ??
    formatValue(response.error_msg) ??
    formatValue(response.error_code) ??
    formatValue(response.info) ??
    fallback ??
    (response.errno === undefined || response.errno === null || response.errno === '' ? '未知' : `errno=${response.errno}`)
  )
}

const isRetryablePcsError = (error: AppError) => {
  if (error.code === 'BAIDU_HTTP_FAILED') {
    const status = typeof error.details === 'object' && error.details !== null && 'status' in error.details ? Number(error.details.status) : 0
    return status === 403
  }
  return error.code === 'DLINK_FAILED'
}

export class BaiduClient {
  async getFileList(params: {
    surl: string
    cookie?: string
    pwd?: string
    dir?: string
    page?: number
    num?: number
    order?: 'time' | 'filename'
  }): Promise<ShareListResult> {
    const surl = `1${params.surl.replace(/^1/, '')}`
    const dir = params.dir ?? '/'
    const response = await requestJson<WxListResponse>('https://pan.baidu.com/share/wxlist', {
      label: 'share_wxlist',
      method: 'POST',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWxUA,
        Cookie: params.cookie?.trim() || getBaiduSettings().baiduFakeCookie,
      },
      query: {
        channel: 'weixin',
        version: '2.9.6',
        clienttype: 25,
        web: 1,
        'qq-pf-to': 'pcqq.c2c',
      },
      form: {
        shorturl: surl,
        pwd: params.pwd ?? '',
        dir,
        root: dir === '/' ? 1 : 0,
        page: params.page ?? 1,
        num: Math.min(params.num ?? 100, 100),
        order: params.order ?? 'filename',
      },
    })

    if (response.errno !== 0 || !response.data) {
      throw upstreamError('GET_FILE_LIST_FAILED', mapShareError(response.errno ?? '未知', response.errtype ?? '未知'), response)
    }

    return {
      uk: response.data.uk,
      shareid: response.data.shareid,
      randsk: decodeSecKey(response.data.seckey),
      uname: response.data.uname,
      list: response.data.list.map(
        (item): ShareFile => ({
          category: toNumber(item.category),
          fs_id: toNumber(item.fs_id),
          is_dir: toNumber(item.isdir) === 1,
          local_ctime: toNumber(item.local_ctime),
          local_mtime: toNumber(item.local_mtime),
          md5: toString(item.md5),
          path: toString(item.path),
          server_ctime: toNumber(item.server_ctime),
          server_mtime: toNumber(item.server_mtime),
          server_filename: toString(item.server_filename),
          size: toNumber(item.size),
          dlink: toString(item.dlink),
        }),
      ),
    }
  }

  async saveToDiskWeb(params: {
    shareid: number
    fsIds: number[]
    uk: number
    randsk: string
    referer: string
    cookie: string
    path: string
    bdstoken: string
  }): Promise<SavedFile[]> {
    const response = await requestJson<TransferResponse>('https://pan.baidu.com/share/transfer', {
      label: 'share_transfer',
      method: 'POST',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: params.cookie,
        Referer: params.referer,
        Origin: 'https://pan.baidu.com',
        'X-Requested-With': 'XMLHttpRequest',
      },
      query: {
        shareid: params.shareid,
        from: params.uk,
        sekey: params.randsk,
        bdstoken: params.bdstoken,
        ondup: 'newcopy',
        async: 0,
        channel: 'chunlei',
        web: 1,
        app_id: 250528,
        clienttype: 0,
      },
      form: {
        fsidlist: JSON.stringify(params.fsIds),
        path: params.path,
      },
    })

    if (response.errno !== 0) {
      throw upstreamError('SAVE_TO_DISK_FAILED', `转存失败: ${formatUpstreamErrorMessage(response)}`, response)
    }

    if (!response.extra?.list) {
      throw upstreamError('SAVE_TO_DISK_FAILED', '转存成功但百度未返回文件列表', response)
    }

    return response.extra.list
  }

  async getBdstoken(cookie: string) {
    const response = await requestJson<TemplateVariableResponse>('https://pan.baidu.com/api/gettemplatevariable', {
      label: 'get_bdstoken',
      method: 'POST',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: cookie,
        Referer: 'https://pan.baidu.com/disk/home',
        Origin: 'https://pan.baidu.com',
      },
      query: {
        channel: 'chunlei',
        web: 1,
        app_id: 250528,
        clienttype: 0,
      },
      form: {
        fields: '["bdstoken","loginstate"]',
      },
    })

    if (response.errno !== 0 || !response.result?.bdstoken) {
      throw upstreamError('GET_BDSTOKEN_FAILED', `获取 bdstoken 失败: ${formatUpstreamErrorMessage(response)}`, response)
    }
    if (response.result.loginstate !== undefined && response.result.loginstate !== 1) {
      throw upstreamError('BAIDU_COOKIE_OR_ACCOUNT_RESTRICTED', 'Cookie 未登录或登录态异常', response)
    }
    return response.result.bdstoken
  }

  async getAccountTemplate(cookie: string) {
    const response = await requestJson<TemplateVariableResponse>('https://pan.baidu.com/api/gettemplatevariable', {
      label: 'get_account_template',
      method: 'POST',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: cookie,
        Referer: 'https://pan.baidu.com/disk/home',
        Origin: 'https://pan.baidu.com',
      },
      query: {
        channel: 'chunlei',
        web: 1,
        app_id: 250528,
        clienttype: 0,
      },
      form: {
        fields: '["username","loginstate","is_vip","is_svip","is_evip","bdstoken"]',
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('COOKIE_INVALID', 'Cookie 格式异常、登录态不完整，或已被百度拒绝', response)
    }
    if (response.errno !== 0 || !response.result) {
      throw upstreamError('GET_ACCOUNT_TEMPLATE_FAILED', `获取账号模板变量失败: ${formatUpstreamErrorMessage(response)}`, response)
    }
    return response
  }

  async getAccountUInfo(cookie: string) {
    const response = await requestJson<UInfoResponse>('https://pan.baidu.com/rest/2.0/xpan/nas', {
      label: 'xpan_uinfo',
      method: 'GET',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: cookie,
        Referer: 'https://pan.baidu.com/disk/home',
      },
      query: {
        method: 'uinfo',
        vip_version: 'v2',
      },
    })

    if (response.errmsg === 'Invalid Bduss') {
      throw upstreamError('COOKIE_INVALID', 'BDUSS 无效', response)
    }
    if (response.errno !== undefined && response.errno !== 0) {
      throw upstreamError('GET_ACCOUNT_UINFO_FAILED', `获取账号信息失败: ${formatUpstreamErrorMessage(response)}`, response)
    }
    return response
  }

  async getAccountUInfoByAccessToken(accessToken: string) {
    const response = await requestJson<UInfoResponse>('https://pan.baidu.com/rest/2.0/xpan/nas', {
      label: 'xpan_uinfo_open_platform',
      method: 'GET',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Referer: 'https://pan.baidu.com',
      },
      query: {
        method: 'uinfo',
        vip_version: 'v2',
        access_token: accessToken,
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    if (response.errno !== undefined && response.errno !== 0) {
      throw upstreamError('GET_ACCOUNT_UINFO_FAILED', `获取开放平台账号信息失败: ${formatUpstreamErrorMessage(response)}`, response)
    }
    return response
  }

  async getQuota(cookie: string) {
    const response = await requestJson<QuotaResponse>('https://pan.baidu.com/api/quota', {
      label: 'quota',
      method: 'GET',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: cookie,
        Referer: 'https://pan.baidu.com/disk/home',
      },
      query: {
        checkfree: 1,
        checkexpire: 1,
        channel: 'chunlei',
        web: 1,
        app_id: 250528,
        clienttype: 0,
      },
    })

    if (response.errno !== undefined && response.errno !== 0) {
      throw upstreamError('GET_QUOTA_FAILED', `获取空间信息失败: ${formatUpstreamErrorMessage(response)}`, response)
    }
    const total = Number(response.total ?? 0)
    const used = Number(response.used ?? 0)
    const free = Math.max(0, total - used)
    if (response.free !== undefined && Number(response.free) !== free) {
      console.warn(`[quota] API free mismatch: api=${response.free}, computed=${free}`)
    }
    return { total, used, free }
  }

  async getQuotaByAccessToken(accessToken: string) {
    const response = await requestJson<QuotaResponse>('https://pan.baidu.com/api/quota', {
      label: 'quota_open_platform',
      method: 'GET',
      headers: {
        'User-Agent': 'pan.baidu.com',
        Referer: 'https://pan.baidu.com',
      },
      query: {
        checkfree: 1,
        checkexpire: 1,
        access_token: accessToken,
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    if (response.errno !== undefined && response.errno !== 0) {
      throw upstreamError('GET_QUOTA_FAILED', `获取开放平台空间信息失败: ${formatUpstreamErrorMessage(response)}`, response)
    }

    const total = Number(response.total ?? 0)
    const used = Number(response.used ?? 0)
    const free = Math.max(0, total - used)
    return { total, used, free }
  }

  async getMembershipByAccessToken(accessToken: string) {
    const response = await requestJson<MembershipResponse>('https://pan.baidu.com/rest/2.0/membership/user', {
      label: 'membership_open_platform',
      method: 'GET',
      headers: {
        'User-Agent': 'pan.baidu.com',
        Referer: 'https://pan.baidu.com',
      },
      query: {
        method: 'query',
        clienttype: 0,
        app_id: 250528,
        web: 1,
        access_token: accessToken,
      },
    })

    if (Number(response.error_code ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    if (response.error_code !== undefined && Number(response.error_code) !== 0) {
      throw upstreamError('GET_MEMBERSHIP_FAILED', `获取开放平台会员信息失败: ${formatUpstreamErrorMessage(response)}`, response)
    }
    return response
  }

  async createDiskDirectory(params: { path: string; cookie: string; bdstoken: string }): Promise<{ path: string; createdPath?: string }> {
    const response = await requestJson<CreateDirectoryResponse>('https://pan.baidu.com/api/create', {
      label: 'create_temp_dir',
      method: 'POST',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: params.cookie,
        Referer: 'https://pan.baidu.com/disk/home',
        Origin: 'https://pan.baidu.com',
        'X-Requested-With': 'XMLHttpRequest',
      },
      query: {
        a: 'commit',
        channel: 'chunlei',
        web: 1,
        app_id: 250528,
        bdstoken: params.bdstoken,
        clienttype: 0,
      },
      form: {
        path: params.path,
        isdir: 1,
        block_list: '[]',
      },
    })

    const createdPath = response.path ?? response.data?.path
    if (response.errno === 0 || response.errno === -8) return { path: params.path, createdPath }

    throw upstreamError('CREATE_TEMP_DIR_FAILED', `创建转存临时目录失败: ${formatUpstreamErrorMessage(response)}`, response)
  }

  async createDiskDirectoryByAccessToken(params: { path: string; accessToken: string }): Promise<{ path: string; createdPath?: string }> {
    const response = await requestJson<CreateDirectoryResponse>('https://pan.baidu.com/rest/2.0/xpan/file', {
      label: 'create_temp_dir_open_platform',
      method: 'POST',
      headers: {
        'User-Agent': 'pan.baidu.com',
        Referer: 'pan.baidu.com',
      },
      query: {
        method: 'create',
        access_token: params.accessToken,
      },
      form: {
        path: params.path,
        size: 0,
        isdir: 1,
        block_list: '[]',
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    const createdPath = response.path ?? response.data?.path
    if (response.errno === 0 || response.errno === -8) return { path: params.path, createdPath }

    throw upstreamError('CREATE_TEMP_DIR_FAILED', `创建开放平台临时目录失败: ${formatUpstreamErrorMessage(response)}`, response)
  }

  async diskPathExists(params: { path: string; cookie: string }) {
    if (params.path === '/') return true
    const normalized = params.path.replace(/\/+$/, '')
    const slash = normalized.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : normalized.slice(0, slash)
    const name = normalized.slice(slash + 1)
    const response = await requestJson<DiskListResponse>('https://pan.baidu.com/rest/2.0/xpan/file', {
      label: 'disk_list_dir',
      method: 'GET',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: params.cookie,
        Referer: 'https://pan.baidu.com/disk/home',
      },
      query: {
        method: 'list',
        showempty: 1,
        dir: parent,
        app_id: 250528,
        web: 1,
      },
    })

    if (response.errno === 0) {
      return Boolean(
        response.list?.some((item) => Number(item.isdir ?? 0) === 1 && (String(item.path ?? '') === normalized || String(item.server_filename ?? '') === name)),
      )
    }
    if (response.errno === 12 || response.errno === 31066) return false

    throw upstreamError('DISK_PATH_CHECK_FAILED', `检查网盘目录失败: ${formatUpstreamErrorMessage(response)}`, response)
  }

  async listDiskFiles(params: { dir?: string; page?: number; pageSize?: number; order?: 'time' | 'filename'; cookie: string }): Promise<DiskListResult> {
    const dir = params.dir || '/'
    const response = await requestJson<DiskListResponse>('https://pan.baidu.com/rest/2.0/xpan/file', {
      label: 'disk_list_files',
      method: 'GET',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: params.cookie,
        Referer: 'https://pan.baidu.com/disk/home',
      },
      query: {
        method: 'list',
        showempty: 1,
        dir,
        page: params.page ?? 1,
        num: Math.min(params.pageSize ?? 50, 100),
        order: params.order ?? 'filename',
        app_id: 250528,
        web: 1,
      },
    })

    if (response.errno !== 0) {
      throw upstreamError('DISK_LIST_FAILED', `获取网盘文件列表失败: ${formatUpstreamErrorMessage(response)}`, response)
    }

    return {
      dir,
      list: mapDiskFiles(response.list ?? []),
    }
  }

  async diskPathExistsByAccessToken(params: { path: string; accessToken: string }) {
    if (params.path === '/') return true
    const normalized = params.path.replace(/\/+$/, '')
    const slash = normalized.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : normalized.slice(0, slash)
    const name = normalized.slice(slash + 1)
    const response = await requestJson<DiskListResponse>('https://pan.baidu.com/rest/2.0/xpan/file', {
      label: 'disk_list_dir_open_platform',
      method: 'GET',
      headers: {
        'User-Agent': 'pan.baidu.com',
        Referer: 'pan.baidu.com',
      },
      query: {
        method: 'list',
        showempty: 1,
        dir: parent,
        access_token: params.accessToken,
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    if (response.errno === 0) {
      return Boolean(
        response.list?.some((item) => Number(item.isdir ?? 0) === 1 && (String(item.path ?? '') === normalized || String(item.server_filename ?? '') === name)),
      )
    }
    if (response.errno === 12 || response.errno === 31066) return false

    throw upstreamError('DISK_PATH_CHECK_FAILED', `检查开放平台网盘目录失败: ${formatUpstreamErrorMessage(response)}`, response)
  }

  async listDiskFilesByAccessToken(params: {
    dir?: string
    page?: number
    pageSize?: number
    order?: 'time' | 'filename'
    accessToken: string
  }): Promise<DiskListResult> {
    const dir = params.dir || '/'
    const pageSize = Math.min(params.pageSize ?? 50, 100)
    const start = Math.max(0, ((params.page ?? 1) - 1) * pageSize)
    const response = await requestJson<DiskListResponse>('https://pan.baidu.com/rest/2.0/xpan/file', {
      label: 'disk_list_files_open_platform',
      method: 'GET',
      headers: {
        'User-Agent': 'pan.baidu.com',
        Referer: 'pan.baidu.com',
      },
      query: {
        method: 'list',
        showempty: 1,
        dir,
        start,
        limit: pageSize,
        order: diskListOrder(params.order),
        access_token: params.accessToken,
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    if (response.errno !== 0) {
      throw upstreamError('DISK_LIST_FAILED', `获取开放平台网盘文件列表失败: ${formatUpstreamErrorMessage(response)}`, response)
    }

    return {
      dir,
      list: mapDiskFiles(response.list ?? []),
    }
  }

  async getSign(params: { shareid: number; uk: number; cookie: string }): Promise<ShareSignResult> {
    const response = await requestJson<SignResponse>('https://pan.baidu.com/share/tplconfig', {
      label: 'share_tplconfig',
      method: 'GET',
      headers: {
        'User-Agent': 'netdisk;pan.baidu.com',
        Cookie: params.cookie,
      },
      query: {
        shareid: params.shareid,
        uk: params.uk,
        fields: 'sign,timestamp',
        channel: 'chunlei',
        web: 1,
        app_id: 250528,
        clienttype: 0,
      },
    })

    if (response.errno !== 0 || !response.data?.sign || !response.data.timestamp) {
      throw upstreamError('GET_SIGN_FAILED', `获取 sign 失败: ${formatUpstreamErrorMessage(response)}`, response)
    }

    return {
      sign: response.data.sign,
      timestamp: Number(response.data.timestamp),
    }
  }

  async getSharedDownload(params: { fsId: number; timestamp: number; sign: string; randsk: string; shareid: number; uk: number; cookie: string }) {
    let response = await this.requestSharedDownload(params, 12)
    if (response.errno === 9019) {
      response = await this.requestSharedDownload(params, 0)
    }

    if (response.errno === 112) {
      throw upstreamError('BAIDU_PAGE_EXPIRED', `获取 dlink 失败: ${formatUpstreamErrorMessage(response, '页面已过期')}`, response)
    }
    if (typeof response.list === 'string') {
      throw upstreamError('SHARED_DOWNLOAD_UNSUPPORTED', '获取 dlink 失败: 百度返回了非直链格式，当前 sharedownload 路线不支持该文件', response)
    }
    if (response.errno === 9019) {
      throw upstreamError(
        'BAIDU_COOKIE_OR_ACCOUNT_RESTRICTED',
        `获取 dlink 失败: ${formatUpstreamErrorMessage(response, 'Cookie 状态异常或账号受限')}`,
        response,
      )
    }
    if (response.errno === 8001) {
      throw upstreamError('BAIDU_COOKIE_OR_ACCOUNT_RESTRICTED', `获取 dlink 失败: ${formatUpstreamErrorMessage(response, '账号状态异常或环境受限')}`, response)
    }
    if (response.errno === -20) {
      throw upstreamError('BAIDU_CAPTCHA_OR_RISK_CONTROL', `获取 dlink 失败: ${formatUpstreamErrorMessage(response, '需要验证码或触发风控')}`, response)
    }
    if (response.errno !== 0 || !response.list?.[0]?.dlink) {
      throw upstreamError('SHARED_DOWNLOAD_FAILED', `获取 dlink 失败: ${formatUpstreamErrorMessage(response)}`, response)
    }

    const file = response.list[0]
    return {
      dlink: String(file.dlink),
      fs_id: Number(file.fs_id ?? params.fsId),
      md5: String(file.md5 ?? ''),
      server_filename: String(file.server_filename ?? ''),
      size: Number(file.size ?? 0),
      path: String(file.path ?? ''),
    }
  }

  async saveToDiskByAccessToken(params: {
    shareid: number
    fsIds: number[]
    uk: number
    randsk: string
    path: string
    accessToken: string
  }): Promise<SavedFile[]> {
    const response = await requestJson<TransferResponse>('https://pan.baidu.com/rest/2.0/xpan/share', {
      label: 'share_transfer_open_platform',
      method: 'POST',
      headers: {
        'User-Agent': 'pan.baidu.com',
        Referer: 'pan.baidu.com',
      },
      query: {
        method: 'transfer',
        access_token: params.accessToken,
        shareid: params.shareid,
        from: params.uk,
        sekey: params.randsk,
      },
      form: {
        fsidlist: JSON.stringify(params.fsIds),
        path: params.path,
        async: 0,
        ondup: 'newcopy',
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    if (response.errno !== 0) {
      throw upstreamError('SAVE_TO_DISK_FAILED', `开放平台转存失败: ${formatUpstreamErrorMessage(response)}`, response)
    }
    if (!response.extra?.list) {
      throw upstreamError('SAVE_TO_DISK_FAILED', '开放平台转存成功但未返回文件列表', response)
    }
    return response.extra.list
  }

  private requestSharedDownload(
    params: {
      fsId: number
      timestamp: number
      sign: string
      randsk: string
      shareid: number
      uk: number
      cookie: string
    },
    clienttype: SharedDownloadClientType,
  ) {
    return requestJson<ShareDownloadResponse>('https://pan.baidu.com/api/sharedownload', {
      label: 'share_download',
      method: 'POST',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: params.cookie,
        Referer: 'https://pan.baidu.com/disk/home',
        Origin: 'https://pan.baidu.com',
        'X-Requested-With': 'XMLHttpRequest',
        Host: 'pan.baidu.com',
      },
      query: {
        app_id: 250528,
        channel: 'chunlei',
        clienttype,
        sign: params.sign,
        timestamp: params.timestamp,
        web: 1,
      },
      form: {
        encrypt: 0,
        extra: JSON.stringify({ sekey: params.randsk }),
        fid_list: `[${params.fsId}]`,
        primaryid: params.shareid,
        uk: params.uk,
        product: 'share',
        type: 'nolimit',
      },
    })
  }

  async resolveRealLink(params: { dlink: string; cookie: string; userAgent: string }) {
    return requestHeadLocation(params.dlink, {
      'User-Agent': params.userAgent,
      Cookie: params.cookie,
    })
  }

  buildOpenPlatformDownloadUrl(path: string, accessToken: string) {
    return `https://pcs.baidu.com/rest/2.0/pcs/file?${new URLSearchParams({
      app_id: '250528',
      method: 'download',
      access_token: accessToken,
      path,
    }).toString()}`
  }

  async downloadByDisk(path: string): Promise<string[]> {
    return this.downloadByDiskWithCookie(path, getBaiduSettings().baiduCookie)
  }

  async downloadByDiskWithCookie(path: string, cookie: string): Promise<string[]> {
    const userAgents = [getDownloadSettings().pcsUA, getBaiduSettings().baiduFakeWebUA, 'pan.baidu.com'].filter(
      (item, index, items) => item && items.indexOf(item) === index,
    )

    let lastError: unknown
    for (const userAgent of userAgents) {
      try {
        return await this.downloadByDiskWithUa(path, cookie, userAgent)
      } catch (error) {
        lastError = error
        if (!(error instanceof AppError) || !isRetryablePcsError(error)) throw error
      }
    }
    throw lastError
  }

  async downloadByDiskWithAccessToken(fsId: number, accessToken: string) {
    const response = await requestJson<FileMetasResponse>('https://pan.baidu.com/rest/2.0/xpan/multimedia', {
      label: 'xpan_filemetas_dlink',
      method: 'GET',
      headers: {
        'User-Agent': 'pan.baidu.com',
        Referer: 'pan.baidu.com',
      },
      query: {
        method: 'filemetas',
        dlink: 1,
        fsids: JSON.stringify([fsId]),
        access_token: accessToken,
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    if (response.errno !== undefined && response.errno !== 0) {
      throw upstreamError('DLINK_FAILED', `开放平台获取直链失败: ${formatUpstreamErrorMessage(response)}`, response)
    }
    const dlink = response.list?.[0]?.dlink
    if (!dlink) {
      throw upstreamError('DLINK_FAILED', '开放平台未返回 dlink', response)
    }
    return {
      dlink,
      md5: String(response.list?.[0]?.md5 ?? ''),
      path: String(response.list?.[0]?.path ?? ''),
    }
  }

  private async downloadByDiskWithUa(path: string, cookie: string, userAgent: string): Promise<string[]> {
    const response = await requestJson<DownloadResponse>('https://pcs.baidu.com/rest/2.0/pcs/file', {
      label: 'pcs_locatedownload',
      method: 'POST',
      headers: {
        'User-Agent': userAgent,
        Cookie: cookie,
        Referer: 'https://pan.baidu.com/disk/home',
      },
      query: {
        method: 'locatedownload',
        app_id: 250528,
        path,
        ver: 2,
        time: 1732106564,
        rand: '9b696564418ae5ab758d60cbc96c199c4679f772',
        rand2: 'd76e889b6aafd3087ac3bd56f4d4053a',
        devuid: 'BDIMXV2-O_0B5DF5389B5D4775946635E4E18D8314-C_0-D_5CDF_B803_70B0_42BC.-M_BCECA007D4F6-V_0D274B62',
        version: '7.44.6.1',
      },
    })

    if (response.error_code || response.error_msg || !response.urls) {
      throw upstreamError(
        'DLINK_FAILED',
        `获取直链失败: ${formatUpstreamErrorMessage({ ...response, errno: response.error_code ?? response.errno })}`,
        response,
      )
    }

    return response.urls
      .map((item) => item.url)
      .reverse()
      .map((url) => `${url}&origin=dlna`)
  }

  async deleteDiskPaths(params: { paths: string[]; cookie: string; bdstoken?: string }) {
    if (params.paths.length === 0) return
    const bdstoken = params.bdstoken ?? (await this.getBdstoken(params.cookie))
    const response = await requestJson<FileManagerResponse>('https://pan.baidu.com/api/filemanager', {
      label: 'filemanager_delete',
      method: 'POST',
      headers: {
        'User-Agent': getBaiduSettings().baiduFakeWebUA,
        Cookie: params.cookie,
        Referer: 'https://pan.baidu.com/disk/home',
        Origin: 'https://pan.baidu.com',
        'X-Requested-With': 'XMLHttpRequest',
      },
      query: {
        opera: 'delete',
        async: 2,
        onnest: 'fail',
        bdstoken,
        channel: 'chunlei',
        web: 1,
        app_id: 250528,
        clienttype: 0,
      },
      form: {
        filelist: JSON.stringify(params.paths),
      },
    })
    if (response.errno !== 0) {
      if (response.errno === 132 && response.authwidget?.safetpl === 'filemanager') {
        throw upstreamError(
          'TEMP_DELETE_NEEDS_VERIFY',
          '删除临时文件失败: 百度要求完成 filemanager 安全验证，请用该账号在百度网盘网页端手动删除任意无用文件并完成验证后再重试',
          sanitizeFileManagerResponse(response),
        )
      }
      throw upstreamError('TEMP_DELETE_FAILED', `删除临时文件失败: ${formatFileManagerError(response)}`, sanitizeFileManagerResponse(response))
    }
  }

  async deleteDiskPathsByAccessToken(params: { paths: string[]; accessToken: string }) {
    if (params.paths.length === 0) return
    const response = await requestJson<FileManagerResponse>('https://pan.baidu.com/rest/2.0/xpan/file', {
      label: 'filemanager_delete_open_platform',
      method: 'POST',
      headers: {
        'User-Agent': 'pan.baidu.com',
        Referer: 'pan.baidu.com',
      },
      query: {
        method: 'filemanager',
        opera: 'delete',
        access_token: params.accessToken,
      },
      form: {
        async: 0,
        filelist: JSON.stringify(params.paths),
      },
    })

    if (Number(response.errno ?? 0) === -6) {
      throw upstreamError('OPEN_PLATFORM_ACCESS_TOKEN_INVALID', 'access_token 无效或已过期', response)
    }
    if (response.errno !== 0) {
      throw upstreamError('TEMP_DELETE_FAILED', `删除开放平台临时文件失败: ${formatFileManagerError(response)}`, sanitizeFileManagerResponse(response))
    }
  }
}

const mapDiskFiles = (list: NonNullable<DiskListResponse['list']>): ShareFile[] =>
  list.map((item) => ({
    category: toNumber(item.category),
    fs_id: toNumber(item.fs_id),
    is_dir: toNumber(item.isdir) === 1,
    local_ctime: toNumber(item.local_ctime),
    local_mtime: toNumber(item.local_mtime),
    md5: toString(item.md5),
    path: toString(item.path),
    server_ctime: toNumber(item.server_ctime),
    server_mtime: toNumber(item.server_mtime),
    server_filename: toString(item.server_filename),
    size: toNumber(item.size),
    dlink: toString(item.dlink),
  }))

const formatFileManagerError = (response: FileManagerResponse) => {
  const requestId = response.request_id ? `，request_id=${response.request_id}` : ''
  const verify = response.authwidget?.safetpl ? `，需要验证=${response.authwidget.safetpl}` : ''
  return `${formatUpstreamErrorMessage(response)}${requestId}${verify}`
}

const sanitizeFileManagerResponse = (response: FileManagerResponse) => ({
  errno: response.errno,
  errmsg: response.errmsg,
  show_msg: response.show_msg,
  info: response.info,
  request_id: response.request_id,
  verify_scene: response.verify_scene,
  authwidget: response.authwidget
    ? {
        safetpl: response.authwidget.safetpl,
        saferand: response.authwidget.saferand,
        safesign: response.authwidget.safesign ? '[redacted]' : undefined,
      }
    : undefined,
})
