import { describe, expect, test } from 'bun:test'
import { isAppError } from '../lib/errors'
import { BaiduClient, formatUpstreamErrorMessage } from './client'

describe('formatUpstreamErrorMessage', () => {
  test('formats object info without object placeholder', () => {
    const message = formatUpstreamErrorMessage({
      errno: 12,
      info: { errno: 12, path: '/我的资源/下载' },
    })

    expect(message).toContain('"path":"/我的资源/下载"')
    expect(message).not.toContain('[object Object]')
  })

  test('formats array info without object placeholder', () => {
    const message = formatUpstreamErrorMessage({
      errno: 12,
      info: [{ errno: 12, path: '/a' }],
    })

    expect(message).toContain('"path":"/a"')
    expect(message).not.toContain('[object Object]')
  })

  test('prefers show_msg over structured info', () => {
    expect(
      formatUpstreamErrorMessage({
        show_msg: '上游明确错误',
        info: { errno: 12 },
        errno: 12,
      }),
    ).toBe('上游明确错误')
  })

  test('falls back to errno label', () => {
    expect(formatUpstreamErrorMessage({ errno: 31066 })).toBe('errno=31066')
  })

  test('supports error_code and explicit fallback', () => {
    expect(formatUpstreamErrorMessage({ error_code: 9019 })).toBe('9019')
    expect(formatUpstreamErrorMessage({}, '需要验证码或触发风控')).toBe('需要验证码或触发风控')
  })
})

describe('BaiduClient share file list errors', () => {
  test('maps wxlist path errors to path error message', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ errno: -130, errtype: 'mis_2', data: null })) as unknown as typeof fetch

    try {
      await new BaiduClient().getFileList({
        surl: '1abcDEF_123',
        cookie: 'BDUSS=test',
      })
      throw new Error('expected getFileList to throw')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) {
        expect(error.code).toBe('GET_FILE_LIST_FAILED')
        expect(error.message).toBe('路径错误')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
