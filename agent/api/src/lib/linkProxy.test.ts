import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../db'
import { appSettings } from '../db/schema'
import { buildCapabilities, buildClientInfo } from '../broker/runtime'
import { settingKeys, setSettings } from '../settings/service'
import { createProxiedDownloadUrl, getLinkProxyConfig, setLinkProxyConfig } from './linkProxy'

const clearLinkProxySettings = () => {
  for (const key of [settingKeys.linkProxyVersion, settingKeys.linkProxyBaseUrl, settingKeys.linkProxySecret, settingKeys.linkProxyV2Endpoints]) {
    db.delete(appSettings).where(eq(appSettings.key, key)).run()
  }
}

describe('link proxy configuration', () => {
  beforeAll(() => {
    initDb()
  })

  afterEach(() => {
    clearLinkProxySettings()
  })

  test('none mode disables proxying and returns raw urls', async () => {
    await setSettings({ linkProxyVersion: 'none' })

    const config = getLinkProxyConfig()
    expect(config.version).toBe('none')
    expect(config.enabled).toBe(false)
    await expect(createProxiedDownloadUrl('https://pcs.baidu.com/file/demo.bin')).resolves.toBe('https://pcs.baidu.com/file/demo.bin')
  })

  test('none mode reports no link proxy feature in broker capabilities', async () => {
    await setSettings({ linkProxyVersion: 'none' })

    const capabilities = buildCapabilities()
    expect(capabilities.features).toEqual([])
    expect(capabilities.providerCapabilities.baidu.features).toEqual([])
  })

  test('broker heartbeat client_info reports daemon runtime by default', () => {
    expect(buildClientInfo()).toEqual({
      name: 'lc-agent',
      version: '0.0.0',
      runtime: 'daemon',
      platform: process.platform,
      arch: process.arch,
    })
  })

  test('broker heartbeat client_info reports desktop runtime in desktop mode', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'open-lc-agent-client-info-'))
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `
          const { buildClientInfo } = await import('./agent/api/src/broker/runtime.ts');
          console.log(JSON.stringify(buildClientInfo()));
        `,
      ],
      cwd: new URL('../../../..', import.meta.url).pathname,
      env: {
        ...Bun.env,
        LC_AGENT_DATABASE_URL: join(tmpDir, 'agent.sqlite'),
        LC_AGENT_DESKTOP: 'true',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const output = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    const exitCode = await child.exited

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(JSON.parse(output.trim())).toEqual({
      name: 'lc-agent',
      version: '0.0.0',
      runtime: 'desktop',
      platform: process.platform,
      arch: process.arch,
    })
  })

  test('v1 mode keeps generating proxy urls when endpoint and secret are configured', () => {
    setLinkProxyConfig({
      version: 'v1',
      baseUrl: 'https://worker.example.com',
      secret: 'test-secret',
    })

    const config = getLinkProxyConfig()
    expect(config.version).toBe('v1')
    expect(config.enabled).toBe(true)
  })

  test('v2 mode is enabled when endpoints are configured', () => {
    setLinkProxyConfig({
      version: 'v2',
      v2Endpoints: 'https://worker-a.example.com\nhttps://worker-b.example.com',
    })

    const config = getLinkProxyConfig()
    expect(config.version).toBe('v2')
    expect(config.enabled).toBe(true)
    expect(config.v2Endpoints).toEqual(['https://worker-a.example.com', 'https://worker-b.example.com'])
  })

  test('invalid proxy versions are rejected', async () => {
    await expect(setSettings({ linkProxyVersion: 'v3' })).rejects.toMatchObject({
      code: 'BAD_LINK_PROXY_VERSION',
    })
  })

  test('legacy v1 env config works without explicit LINK_PROXY_VERSION', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'open-lc-agent-link-proxy-'))
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `
          const { initDb } = await import('./agent/api/src/db/index.ts');
          const { getSettingsSnapshot, getSettingWithSource } = await import('./agent/api/src/settings/service.ts');
          const { getLinkProxyConfig } = await import('./agent/api/src/lib/linkProxy.ts');
          initDb();
          const config = getLinkProxyConfig();
          const settings = getSettingsSnapshot();
          console.log(JSON.stringify({
            version: config.version,
            enabled: config.enabled,
            legacyV1FromEnv: config.legacyV1FromEnv,
            settingValue: settings.items.linkProxyVersion.value,
            settingSource: settings.items.linkProxyVersion.source,
            versionSource: getSettingWithSource('linkProxyVersion').source,
            baseUrlSource: getSettingWithSource('linkProxyBaseUrl').source,
            secretSource: getSettingWithSource('linkProxySecret').source
          }));
        `,
      ],
      cwd: new URL('../../../..', import.meta.url).pathname,
      env: {
        ...Bun.env,
        LC_AGENT_DATABASE_URL: join(tmpDir, 'agent.sqlite'),
        LC_AGENT_PUBLIC_BASE_URL: 'https://worker.example.com',
        LC_AGENT_URL_ENCRYPTION_KEY: 'legacy-secret',
        LC_AGENT_LINK_PROXY_VERSION: '',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const output = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    const exitCode = await child.exited

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(JSON.parse(output.trim())).toEqual({
      version: 'v1',
      enabled: true,
      legacyV1FromEnv: true,
      settingValue: 'v1',
      settingSource: 'default',
      versionSource: 'default',
      baseUrlSource: 'env',
      secretSource: 'env',
    })
  })
})
