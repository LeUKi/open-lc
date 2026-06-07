import { eq } from 'drizzle-orm'
import { agentEnvRaw } from '../config'
import { db } from '../db'
import { appSettings } from '../db/schema'
import { unknownErrorMessage } from '../lib/errors'
import { agentVersion } from '../version'

const defaultUpdateRepo = 'LeUKi/open-lc'
const updateCheckTtlMs = 24 * 60 * 60 * 1000
const cacheKey = 'system_update_check_cache_v1'

export type UpdateCheckResult = {
  currentVersion: string
  latestVersion: string | null
  latestTag: string | null
  releaseUrl: string | null
  hasUpdate: boolean
  checkedAt: string | null
  nextCheckAt: string | null
  source: 'github' | 'cache'
  errorCode: string | null
  errorMessage: string | null
}

type GitHubRelease = {
  tag_name?: unknown
  html_url?: unknown
}

type CachedUpdateCheck = Omit<UpdateCheckResult, 'source'> & {
  cachedAt: string
}

export const normalizeVersion = (value: string) => {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
  }
}

export const compareVersions = (left: string, right: string) => {
  const leftVersion = normalizeVersion(left)
  const rightVersion = normalizeVersion(right)
  if (!leftVersion || !rightVersion) return null

  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.parts[index] > rightVersion.parts[index]) return 1
    if (leftVersion.parts[index] < rightVersion.parts[index]) return -1
  }
  return 0
}

export const releaseFromGitHubResponse = (release: GitHubRelease) => {
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : ''
  const htmlUrl = typeof release.html_url === 'string' ? release.html_url.trim() : ''
  const normalized = normalizeVersion(tag)
  if (!tag || !normalized || !htmlUrl) {
    return null
  }
  return {
    latestTag: tag,
    latestVersion: normalized.version,
    releaseUrl: htmlUrl,
  }
}

export const releaseFromGitHubLatestUrl = (url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const match = parsed.pathname.match(/^\/[^/]+\/[^/]+\/releases\/tag\/([^/]+)$/)
  const tag = match?.[1] ? decodeURIComponent(match[1]) : ''
  const normalized = normalizeVersion(tag)
  if (!tag || !normalized) {
    return null
  }

  return {
    latestTag: tag,
    latestVersion: normalized.version,
    releaseUrl: parsed.toString(),
  }
}

export const buildUpdateCheckResult = (input: {
  checkedAt: string
  latestTag: string
  latestVersion: string
  releaseUrl: string
  nextCheckAt: string
}): CachedUpdateCheck => {
  const comparison = compareVersions(agentVersion, input.latestVersion)
  return {
    currentVersion: agentVersion,
    latestVersion: input.latestVersion,
    latestTag: input.latestTag,
    releaseUrl: input.releaseUrl,
    hasUpdate: comparison === null ? false : comparison < 0,
    checkedAt: input.checkedAt,
    nextCheckAt: input.nextCheckAt,
    errorCode: null,
    errorMessage: null,
    cachedAt: input.checkedAt,
  }
}

export const buildFailedUpdateCheckResult = (input: {
  cached: CachedUpdateCheck | null
  checkedAt: string
  nextCheckAt: string
  errorMessage: string
}): UpdateCheckResult => ({
  currentVersion: agentVersion,
  latestVersion: input.cached?.latestVersion ?? null,
  latestTag: input.cached?.latestTag ?? null,
  releaseUrl: input.cached?.releaseUrl ?? null,
  hasUpdate: false,
  checkedAt: input.checkedAt,
  nextCheckAt: input.nextCheckAt,
  source: 'github',
  errorCode: 'UPDATE_CHECK_FAILED',
  errorMessage: input.errorMessage,
})

export const getUpdateRepo = () => {
  const repo = agentEnvRaw('UPDATE_REPO') || defaultUpdateRepo
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : defaultUpdateRepo
}

export const getUpdateCheck = async (options: { force?: boolean } = {}): Promise<UpdateCheckResult> => {
  const cached = readCachedUpdateCheck()
  if (!options.force && cached && !isExpired(cached)) {
    return { ...cached, source: 'cache' }
  }

  const now = new Date()
  const checkedAt = now.toISOString()
  const nextCheckAt = new Date(now.getTime() + updateCheckTtlMs).toISOString()

  try {
    const release = await fetchLatestReleaseWithFallback(getUpdateRepo())

    const result = buildUpdateCheckResult({
      ...release,
      checkedAt,
      nextCheckAt,
    })
    writeCachedUpdateCheck(result)
    return { ...result, source: 'github' }
  } catch (error) {
    return buildFailedUpdateCheckResult({ cached, checkedAt, nextCheckAt, errorMessage: unknownErrorMessage(error) })
  }
}

const fetchLatestReleaseWithFallback = async (repo: string) => {
  let restError: unknown = null
  try {
    const release = releaseFromGitHubResponse(await fetchLatestRelease(repo))
    if (release) return release
    restError = new Error('GitHub Release 版本格式不是 vX.Y.Z')
  } catch (error) {
    restError = error
  }

  try {
    return await fetchLatestReleaseFromWebRedirect(repo)
  } catch (fallbackError) {
    throw new Error(`GitHub Release 检测失败: REST ${unknownErrorMessage(restError)}；网页 ${unknownErrorMessage(fallbackError)}`)
  }
}

const fetchLatestRelease = async (repo: string) => {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `LC-Agent/${agentVersion}`,
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub Release 请求失败: HTTP ${response.status}`)
  }
  try {
    return JSON.parse(text) as GitHubRelease
  } catch {
    throw new Error('GitHub Release 返回不是 JSON')
  }
}

const fetchLatestReleaseFromWebRedirect = async (repo: string) => {
  const response = await fetch(`https://github.com/${repo}/releases/latest`, {
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`GitHub Release 网页请求失败: HTTP ${response.status}`)
  }

  const release = releaseFromGitHubLatestUrl(response.url)
  if (!release) {
    throw new Error('GitHub Release 网页跳转版本格式不是 vX.Y.Z')
  }
  return release
}

const readCachedUpdateCheck = (): CachedUpdateCheck | null => {
  const raw = db.select().from(appSettings).where(eq(appSettings.key, cacheKey)).get()?.value
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as CachedUpdateCheck
    if (!value || typeof value !== 'object') return null
    if (!value.cachedAt || !value.currentVersion) return null
    return value
  } catch {
    return null
  }
}

const writeCachedUpdateCheck = (value: CachedUpdateCheck) => {
  const serialized = JSON.stringify(value)
  db.insert(appSettings)
    .values({ key: cacheKey, value: serialized })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized, updatedAt: new Date() } })
    .run()
}

const isExpired = (value: CachedUpdateCheck) => {
  const time = new Date(value.cachedAt).getTime()
  return !Number.isFinite(time) || Date.now() - time >= updateCheckTtlMs
}
