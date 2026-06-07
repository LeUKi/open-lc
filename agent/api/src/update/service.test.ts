import { describe, expect, test } from 'bun:test'
import {
  buildFailedUpdateCheckResult,
  buildUpdateCheckResult,
  compareVersions,
  normalizeVersion,
  releaseFromGitHubLatestUrl,
  releaseFromGitHubResponse,
} from './service'

describe('update service version parsing', () => {
  test('normalizes v-prefixed semver tags', () => {
    expect(normalizeVersion('v1.2.3')?.version).toBe('1.2.3')
    expect(normalizeVersion('1.2.3')?.version).toBe('1.2.3')
  })

  test('rejects unsupported tag shapes', () => {
    expect(normalizeVersion('v1.2')).toBeNull()
    expect(normalizeVersion('v1.2.3-beta.1')).toBeNull()
    expect(normalizeVersion('release-1.2.3')).toBeNull()
  })

  test('compares numeric semver parts', () => {
    expect(compareVersions('1.0.1', '1.0.2')).toBe(-1)
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0)
    expect(compareVersions('bad', '1.0.0')).toBeNull()
  })

  test('extracts release metadata from GitHub latest release response', () => {
    expect(
      releaseFromGitHubResponse({
        tag_name: 'v1.0.2',
        html_url: 'https://github.com/LeUKi/open-lc/releases/tag/v1.0.2',
      }),
    ).toEqual({
      latestTag: 'v1.0.2',
      latestVersion: '1.0.2',
      releaseUrl: 'https://github.com/LeUKi/open-lc/releases/tag/v1.0.2',
    })
  })

  test('rejects incomplete release metadata', () => {
    expect(releaseFromGitHubResponse({ tag_name: 'v1.0.2' })).toBeNull()
    expect(releaseFromGitHubResponse({ tag_name: 'v1.0.2-beta.1', html_url: 'https://example.com' })).toBeNull()
  })

  test('extracts release metadata from GitHub latest redirect URL', () => {
    expect(releaseFromGitHubLatestUrl('https://github.com/LeUKi/open-lc/releases/tag/v1.0.23')).toEqual({
      latestTag: 'v1.0.23',
      latestVersion: '1.0.23',
      releaseUrl: 'https://github.com/LeUKi/open-lc/releases/tag/v1.0.23',
    })
  })

  test('rejects unsupported GitHub latest redirect URL shapes', () => {
    expect(releaseFromGitHubLatestUrl('https://github.com/LeUKi/open-lc/releases')).toBeNull()
    expect(releaseFromGitHubLatestUrl('https://github.com/LeUKi/open-lc/releases/tag/v1.0.23-beta.1')).toBeNull()
    expect(releaseFromGitHubLatestUrl('not a url')).toBeNull()
  })

  test('successful update check result is cacheable', () => {
    expect(
      buildUpdateCheckResult({
        latestTag: 'v1.0.23',
        latestVersion: '1.0.23',
        releaseUrl: 'https://github.com/LeUKi/open-lc/releases/tag/v1.0.23',
        checkedAt: '2026-06-03T16:00:00.000Z',
        nextCheckAt: '2026-06-04T16:00:00.000Z',
      }),
    ).toMatchObject({
      latestVersion: '1.0.23',
      latestTag: 'v1.0.23',
      releaseUrl: 'https://github.com/LeUKi/open-lc/releases/tag/v1.0.23',
      errorCode: null,
      errorMessage: null,
      cachedAt: '2026-06-03T16:00:00.000Z',
    })
  })

  test('failed update check result keeps old record without cache renewal or update claim', () => {
    const result = buildFailedUpdateCheckResult({
      checkedAt: '2026-06-03T16:00:00.000Z',
      nextCheckAt: '2026-06-04T16:00:00.000Z',
      errorMessage: 'GitHub Release 请求失败: HTTP 403',
      cached: {
        currentVersion: '0.0.0',
        latestVersion: '1.0.21',
        latestTag: 'v1.0.21',
        releaseUrl: 'https://github.com/LeUKi/open-lc/releases/tag/v1.0.21',
        hasUpdate: true,
        checkedAt: '2026-06-01T16:00:00.000Z',
        nextCheckAt: '2026-06-02T16:00:00.000Z',
        errorCode: null,
        errorMessage: null,
        cachedAt: '2026-06-01T16:00:00.000Z',
      },
    })

    expect(result).toEqual({
      currentVersion: '0.0.0',
      latestVersion: '1.0.21',
      latestTag: 'v1.0.21',
      releaseUrl: 'https://github.com/LeUKi/open-lc/releases/tag/v1.0.21',
      hasUpdate: false,
      checkedAt: '2026-06-03T16:00:00.000Z',
      nextCheckAt: '2026-06-04T16:00:00.000Z',
      source: 'github',
      errorCode: 'UPDATE_CHECK_FAILED',
      errorMessage: 'GitHub Release 请求失败: HTTP 403',
    })
    expect('cachedAt' in result).toBe(false)
  })
})
