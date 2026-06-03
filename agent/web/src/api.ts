import { hc } from 'hono/client'
import { ApiError, HonoReactQuery } from 'hono-tanstack-query'
import type { ClientAppType, ApiErrorResponse } from '@lc-agent/api'
import { queryClient } from './query'

export const agentPasswordStorageKey = 'lc-agent.security.password.v1'

export const getStoredAgentPassword = () => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(agentPasswordStorageKey) ?? ''
}

export const setStoredAgentPassword = (password: string) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(agentPasswordStorageKey, password)
}

export const clearStoredAgentPassword = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(agentPasswordStorageKey)
}

export const honoClient = hc<ClientAppType>('/', {
  init: {
    credentials: 'include',
  },
  headers: () => {
    const password = getStoredAgentPassword()
    const headers: Record<string, string> = {}
    if (password) headers['X-LC-Agent-Password'] = password
    return headers
  },
})

export const api = HonoReactQuery(honoClient, {
  queryClient,
  invalidation: 'none',
})

export const localAccountApi = api.api.local.accounts[':id']
export const localHistoryApi = api.api.local.history[':id']
export const localHistoryReparseApi = api.api.local.history[':id'].reparse
export const localDiskBrowserApi = api.api.local.browser.disk[':id']
export const localShareCookieTemplateApi = api.api.local.browser['share-cookie-template']
export const brokerRunApi = api.api.broker.runs[':id']
export const updateCheckApi = api.api.system['update-check']
export const localAccountExportCredentialsApi = api.api.local.accounts[':id']['export-credentials']
export const workerV2VerifyApi = api.api.settings['link-proxy'].v2.verify
export const brokerVerifyApi = api.api.broker.verify
export const tempFilesCleanupApi = api.api.maintenance['temp-files'].cleanup
export const tempFilesCleanupStatusApi = api.api.maintenance['temp-files'].cleanup.status

export type HealthResponse = (typeof api.health.$get.$infer)['data']
export type LocalMeResponse = (typeof api.api.local.me.$get.$infer)['data']
export type LocalMeData = LocalMeResponse['data']
export type LocalAccountListResponse = (typeof api.api.local.accounts.$get.$infer)['data']
export type LocalAccount = LocalAccountListResponse['data'][number]
export type LocalAccountDetailResponse = (typeof localAccountApi.$get.$infer)['data']
export type LocalAccountDetail = LocalAccountDetailResponse['data']
export type LocalAccountCredentialExportResponse = (typeof localAccountExportCredentialsApi.$post.$infer)['data']
export type LocalAccountCredentialExport = LocalAccountCredentialExportResponse['data']
export type ShareFilesResponse = (typeof api.api.local.browser.share.$post.$infer)['data']
export type ShareFile = ShareFilesResponse['data']['list'][number]
export type ShareCookieTemplateResponse = (typeof localShareCookieTemplateApi.$get.$infer)['data']
export type ShareCookieTemplate = ShareCookieTemplateResponse['data']
export type DiskBrowserResponse = (typeof localDiskBrowserApi.$get.$infer)['data']
export type DiskBrowserData = DiskBrowserResponse['data']
export type LocalParseResponse = (typeof api.api.local.parse.$post.$infer)['data']
export type ParsedLink = LocalParseResponse['data'][number]
export type LocalParseJobResponse = (typeof api.api.local.parse.jobs.$post.$infer)['data']
export type ParseJob = LocalParseJobResponse['data']
export type LocalHistoryResponse = (typeof api.api.local.history.$get.$infer)['data']
export type LocalHistoryRecord = LocalHistoryResponse['data']['records'][number]
export type LocalHistoryDetailResponse = (typeof localHistoryApi.$get.$infer)['data']
export type LocalHistoryDetail = LocalHistoryDetailResponse['data']
export type BrokerConfigResponse = (typeof api.api.broker.config.$get.$infer)['data']
export type BrokerConfig = BrokerConfigResponse['data']
export type BrokerRuntimeResponse = (typeof api.api.broker.runtime.$get.$infer)['data']
export type BrokerRuntime = BrokerRuntimeResponse['data']
export type BrokerHistoryResponse = (typeof api.api.broker.history.$get.$infer)['data']
export type BrokerRun = BrokerHistoryResponse['data']['records'][number]
export type BrokerRunDetailResponse = (typeof brokerRunApi.$get.$infer)['data']
export type BrokerRunDetail = BrokerRunDetailResponse['data']
export type SecurityStatusResponse = (typeof api.api.security.status.$get.$infer)['data']
export type SecurityStatus = SecurityStatusResponse['data']
export type RiskConsentType = keyof SecurityStatus['riskConsents']
export type DesktopRuntimeResponse = (typeof api.api.desktop.runtime.$get.$infer)['data']
export type DesktopRuntime = DesktopRuntimeResponse['data']
export type UpdateCheckResponse = (typeof updateCheckApi.$get.$infer)['data']
export type UpdateCheck = UpdateCheckResponse['data']
export type SettingsResponse = (typeof api.api.settings.$get.$infer)['data']
export type AgentSettings = SettingsResponse['data']
export type AgentSetting = AgentSettings['groups'][keyof AgentSettings['groups']][number]
export type WorkerV2VerifyResponse = (typeof workerV2VerifyApi.$post.$infer)['data']
export type WorkerV2VerifyResult = WorkerV2VerifyResponse['data']
export type BrokerVerifyResponse = (typeof brokerVerifyApi.$post.$infer)['data']
export type BrokerVerifyResult = BrokerVerifyResponse['data']
export type TempFilesCleanupResponse = (typeof tempFilesCleanupApi.$post.$infer)['data']
export type TempFilesCleanupResult = TempFilesCleanupResponse['data']
export type TempFilesCleanupStatusResponse = (typeof tempFilesCleanupStatusApi.$get.$infer)['data']
export type TempFilesCleanupStatus = TempFilesCleanupStatusResponse['data']

export const errorMessage = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as ApiErrorResponse | null
  return body?.message || body?.code || '请求失败'
}

export const messageFromError = (error: unknown, fallback = '请求失败') => {
  if (error instanceof ApiError) {
    const body = error.body as ApiErrorResponse | null
    return body?.message || body?.code || error.message || fallback
  }
  if (error instanceof Error) return error.message
  return fallback
}

export { ApiError }
