import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  abdmDownloadTaskUrl,
  defaultDownloaderForPreset,
  defaultDownloaderForType,
  downloaderRequestOptions,
  downloaderTargetDir,
  parseDownloaders,
  safeRelativeSourceDir,
  sendToDownloader,
  serializeDownloaders,
  type DownloaderConfig,
} from './downloaders'

const downloader = (input: Partial<DownloaderConfig>): DownloaderConfig => ({
  id: 'test',
  name: 'Test',
  type: 'aria2',
  rpcUrl: 'http://127.0.0.1:6800/jsonrpc',
  token: '',
  downloadDir: '',
  preserveSourceDir: false,
  enabled: true,
  isDefault: true,
  ...input,
})

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('downloader target directories', () => {
  test('ignores source directory when preservation is disabled', () => {
    expect(downloaderTargetDir(downloader({ downloadDir: '/downloads' }), { sourceDir: '/A/B' })).toBe('/downloads')
  })

  test('appends source directory under configured download directory', () => {
    expect(downloaderTargetDir(downloader({ downloadDir: '/downloads', preserveSourceDir: true }), { sourceDir: '/A/B' })).toBe('/downloads/A/B')
  })

  test('keeps base directory for empty or root source directory', () => {
    const config = downloader({ downloadDir: '/downloads', preserveSourceDir: true })
    expect(downloaderTargetDir(config, { sourceDir: '/' })).toBe('/downloads')
    expect(downloaderTargetDir(config, { sourceDir: '' })).toBe('/downloads')
    expect(downloaderTargetDir(config, { sourceDir: null })).toBe('/downloads')
  })

  test('uses relative source directory in output when no download directory is configured', () => {
    const config = downloader({ preserveSourceDir: true })
    expect(downloaderTargetDir(config, { sourceDir: '/A/B' })).toBe('')
    expect(downloaderRequestOptions(config, { filename: '05.mp4', sourceDir: '/影视分享2026/剧集更新/ZHIDUAN' })).toEqual({
      dir: '',
      out: '影视分享2026/剧集更新/ZHIDUAN/05.mp4',
    })
  })

  test('cleans unsafe or noisy source directory segments', () => {
    expect(safeRelativeSourceDir('/A//../B/./C')).toBe('A/B/C')
    expect(downloaderTargetDir(downloader({ downloadDir: '/downloads/', preserveSourceDir: true }), { sourceDir: '\\A\\B' })).toBe('/downloads/A/B')
    expect(downloaderRequestOptions(downloader({ preserveSourceDir: true }), { filename: 'demo.bin', sourceDir: '/A//../B/./C' })).toEqual({
      dir: '',
      out: 'A/B/C/demo.bin',
    })
  })
})

describe('downloader presets', () => {
  test('keeps empty or invalid storage empty', () => {
    expect(parseDownloaders(undefined)).toEqual([])
    expect(parseDownloaders('')).toEqual([])
    expect(parseDownloaders('[]')).toEqual([])
    expect(parseDownloaders('not-json')).toEqual([])
  })

  test('uses Motrix preset as aria2 protocol', () => {
    const config = defaultDownloaderForPreset('motrix')
    expect(config.name).toBe('Motrix')
    expect(config.type).toBe('aria2')
    expect(config.rpcUrl).toBe('http://127.0.0.1:16800/jsonrpc')
  })

  test('uses Motrix Next default RPC port', () => {
    const config = defaultDownloaderForPreset('motrix-next')
    expect(config.name).toBe('Motrix Next')
    expect(config.type).toBe('aria2')
    expect(config.rpcUrl).toBe('http://127.0.0.1:16801/jsonrpc')
  })

  test('uses Tauri Motrix default RPC port', () => {
    const config = defaultDownloaderForPreset('tauri-motrix')
    expect(config.name).toBe('Tauri Motrix')
    expect(config.type).toBe('aria2')
    expect(config.rpcUrl).toBe('http://127.0.0.1:16801/jsonrpc')
  })

  test('uses ABDM default local integration port', () => {
    const config = defaultDownloaderForPreset('abdm')
    expect(config.name).toBe('ABDM')
    expect(config.type).toBe('abdm')
    expect(config.rpcUrl).toBe('http://127.0.0.1:15151')
  })

  test('round trips Motrix Next preset through storage as aria2 protocol', () => {
    const config = {
      ...defaultDownloaderForPreset('motrix-next'),
      id: 'next-test',
      isDefault: true,
    }
    const serialized = serializeDownloaders([config])
    expect(JSON.parse(serialized)).toMatchObject([
      {
        id: 'next-test',
        name: 'Motrix Next',
        type: 'aria2',
        rpcUrl: 'http://127.0.0.1:16801/jsonrpc',
        isDefault: true,
      },
    ])
    expect(parseDownloaders(serialized)).toMatchObject([
      {
        id: 'next-test',
        name: 'Motrix Next',
        type: 'aria2',
        rpcUrl: 'http://127.0.0.1:16801/jsonrpc',
        isDefault: true,
      },
    ])
  })

  test('round trips ABDM through storage serialization', () => {
    const config = {
      ...defaultDownloaderForType('abdm'),
      id: 'abdm-test',
      isDefault: true,
    }
    expect(parseDownloaders(serializeDownloaders([config]))).toMatchObject([
      {
        id: 'abdm-test',
        name: 'ABDM',
        type: 'abdm',
        rpcUrl: 'http://127.0.0.1:15151',
        isDefault: true,
      },
    ])
  })

  test('normalizes legacy Motrix type to aria2 while preserving configured values', () => {
    const parsed = parseDownloaders(
      JSON.stringify([
        {
          id: 'motrix-legacy',
          name: 'Motrix',
          type: 'motrix',
          rpcUrl: 'http://127.0.0.1:16800/jsonrpc',
          token: 'secret',
          downloadDir: '/downloads',
          preserveSourceDir: true,
          enabled: true,
          isDefault: true,
        },
      ]),
    )
    expect(parsed[0]).toMatchObject({
      id: 'motrix-legacy',
      name: 'Motrix',
      type: 'aria2',
      rpcUrl: 'http://127.0.0.1:16800/jsonrpc',
      token: 'secret',
      downloadDir: '/downloads',
      preserveSourceDir: true,
    })
    expect(JSON.parse(serializeDownloaders(parsed))[0].type).toBe('aria2')
  })

  test('normalizes legacy Motrix Next type to aria2 while preserving configured values', () => {
    const parsed = parseDownloaders(
      JSON.stringify([
        {
          id: 'motrix-next-legacy',
          name: 'Motrix Next / Tauri Motrix',
          type: 'motrix-next',
          rpcUrl: 'http://127.0.0.1:16801/jsonrpc',
          enabled: true,
          isDefault: true,
        },
      ]),
    )
    expect(parsed[0]).toMatchObject({
      id: 'motrix-next-legacy',
      name: 'Motrix Next / Tauri Motrix',
      type: 'aria2',
      rpcUrl: 'http://127.0.0.1:16801/jsonrpc',
    })
    expect(JSON.parse(serializeDownloaders(parsed))[0].type).toBe('aria2')
  })

  test('normalizes legacy Tauri Motrix type to aria2 while preserving configured values', () => {
    const parsed = parseDownloaders(
      JSON.stringify([
        {
          id: 'tauri-motrix-legacy',
          name: 'Tauri Motrix',
          type: 'tauri-motrix',
          rpcUrl: 'http://127.0.0.1:16801/jsonrpc',
          enabled: true,
          isDefault: true,
        },
      ]),
    )
    expect(parsed[0]).toMatchObject({
      id: 'tauri-motrix-legacy',
      name: 'Tauri Motrix',
      type: 'aria2',
      rpcUrl: 'http://127.0.0.1:16801/jsonrpc',
    })
    expect(JSON.parse(serializeDownloaders(parsed))[0].type).toBe('aria2')
  })

  test('falls back unknown downloader types to aria2 protocol', () => {
    const parsed = parseDownloaders(
      JSON.stringify([
        {
          id: 'unknown',
          name: '',
          type: 'future-downloader',
          rpcUrl: 'http://127.0.0.1:16899/jsonrpc',
          enabled: true,
          isDefault: true,
        },
      ]),
    )
    expect(parsed[0]).toMatchObject({
      id: 'unknown',
      name: 'aria2',
      type: 'aria2',
      rpcUrl: 'http://127.0.0.1:16899/jsonrpc',
    })
  })

  test('builds ABDM headless download endpoint from base URL', () => {
    expect(abdmDownloadTaskUrl('http://127.0.0.1:15151')).toBe('http://127.0.0.1:15151/start-headless-download')
    expect(abdmDownloadTaskUrl('http://127.0.0.1:15151/')).toBe('http://127.0.0.1:15151/start-headless-download')
  })

  test('sends ABDM tasks through its headless REST endpoint', async () => {
    const fetchMock = mock(async () => new Response('OK'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      sendToDownloader(
        downloader({
          type: 'abdm',
          rpcUrl: 'http://127.0.0.1:15151/',
          downloadDir: '/downloads',
          preserveSourceDir: true,
        }),
        {
          id: '1',
          filename: 'demo.bin',
          url: 'https://example.com/demo.bin',
          sourceDir: '/A/B',
          ua: 'LC-UA',
        },
      ),
    ).resolves.toBe('OK')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const [url, init] = firstCall
    expect(url).toBe('http://127.0.0.1:15151/start-headless-download')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      downloadSource: {
        type: 'http',
        link: 'https://example.com/demo.bin',
        headers: {
          'User-Agent': 'LC-UA',
        },
        suggestedName: 'demo.bin',
      },
      folder: '/downloads/A/B',
      name: 'demo.bin',
    })
  })
})
