import crypto from 'node:crypto'
import { getDownloadSettings, getSettingWithSource, setSetting } from '../settings/service'
import { badRequest, unavailable, unknownErrorMessage } from './errors'

export type LinkProxyVersion = 'none' | 'v1' | 'v2'

type V2Discovery = {
  version: string
  kid: string
  publicKey: string
  tokenPrefix?: string
  workerRuntime?: string
  workerVersion?: number
  maxTokenTtlSeconds?: number
}

export type LinkProxyContext = {
  v2DiscoveryCache: Map<string, Promise<V2KeyInfo>>
}

type V2KeyInfo = {
  endpoint: string
  publicKey: Uint8Array
  tokenPrefix: string
  workerRuntime?: string
  workerVersion?: number
  maxTokenTtlSeconds?: number
}

const v1Version = 'v1'
const v1KeyId = 'k1'
const v1Aad = `${v1Version}.${v1KeyId}`

const v2Version = 'v2'
const v2KeyId = 'x1'
const v2Aad = 'v2.x1'
const v2AesInfo = 'open-lc:v2:aes-gcm:v2.x1'
const v2AesSalt = 'open-lc:v2:aes-gcm:salt'
const v2DiscoveryTimeoutMs = 5000

const x25519BasePoint = new Uint8Array(32)
x25519BasePoint[0] = 9

export const createLinkProxyContext = (): LinkProxyContext => ({
  v2DiscoveryCache: new Map(),
})

const base64url = (buffer: Buffer | Uint8Array) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

const base64urlToBytes = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return new Uint8Array(Buffer.from(padded, 'base64'))
}

const deriveV1Key = (secret: string) => crypto.createHash('sha256').update(secret).digest()

const encryptV1Payload = (payload: Record<string, unknown>, secret: string) => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveV1Key(secret), iv)
  cipher.setAAD(Buffer.from(v1Aad, 'utf8'))
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return base64url(Buffer.concat([iv, ciphertext, tag]))
}

const encryptV2Payload = (payload: Record<string, unknown>, receiverPublicKey: Uint8Array) => {
  const ephemeralPrivateKey = crypto.randomBytes(32)
  const ephemeralPublicKey = x25519(ephemeralPrivateKey, x25519BasePoint)
  const sharedSecret = x25519(ephemeralPrivateKey, receiverPublicKey)
  const aesKey = hkdfSha256({
    inputKeyMaterial: sharedSecret,
    salt: Buffer.from(v2AesSalt, 'utf8'),
    info: Buffer.from(v2AesInfo, 'utf8'),
    lengthBytes: 32,
  })
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce)
  cipher.setAAD(Buffer.from(v2Aad, 'utf8'))
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return base64url(Buffer.concat([Buffer.from(ephemeralPublicKey), nonce, ciphertext, tag]))
}

const hkdfSha256 = ({
  inputKeyMaterial,
  salt,
  info,
  lengthBytes,
}: {
  inputKeyMaterial: Uint8Array
  salt: Buffer
  info: Buffer
  lengthBytes: number
}) => {
  const prk = crypto.createHmac('sha256', salt).update(Buffer.from(inputKeyMaterial)).digest()
  const blocks: Buffer[] = []
  let previous = Buffer.alloc(0)
  let counter = 1

  while (Buffer.concat(blocks).length < lengthBytes) {
    const hmac = crypto.createHmac('sha256', prk)
    hmac.update(previous)
    hmac.update(info)
    hmac.update(Buffer.from([counter]))
    previous = hmac.digest()
    blocks.push(previous)
    counter += 1
    if (counter > 255) throw new Error('HKDF output is too long')
  }

  return Buffer.concat(blocks).subarray(0, lengthBytes)
}

const x25519 = (scalarBytes: Uint8Array, uBytes: Uint8Array) => {
  const p = (1n << 255n) - 19n
  const kBytes = new Uint8Array(scalarBytes)
  kBytes[0] &= 248
  kBytes[31] &= 127
  kBytes[31] |= 64

  const k = decodeLittleEndian(kBytes)
  const u = decodeLittleEndian(uBytes)
  let x1 = u
  let x2 = 1n
  let z2 = 0n
  let x3 = u
  let z3 = 1n
  let swap = 0n

  for (let t = 254; t >= 0; t -= 1) {
    const kt = (k >> BigInt(t)) & 1n
    swap ^= kt
    if (swap === 1n) {
      ;[x2, x3] = [x3, x2]
      ;[z2, z3] = [z3, z2]
    }
    swap = kt

    const a = mod(x2 + z2, p)
    const aa = mod(a * a, p)
    const b = mod(x2 - z2, p)
    const bb = mod(b * b, p)
    const e = mod(aa - bb, p)
    const c = mod(x3 + z3, p)
    const d = mod(x3 - z3, p)
    const da = mod(d * a, p)
    const cb = mod(c * b, p)

    x3 = mod((da + cb) * (da + cb), p)
    z3 = mod(x1 * mod((da - cb) * (da - cb), p), p)
    x2 = mod(aa * bb, p)
    z2 = mod(e * mod(aa + 121665n * e, p), p)
  }

  if (swap === 1n) {
    ;[x2, x3] = [x3, x2]
    ;[z2, z3] = [z3, z2]
  }

  return encodeLittleEndian(mod(x2 * modInverse(z2, p), p), 32)
}

const decodeLittleEndian = (bytes: Uint8Array) => {
  let value = 0n
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) + BigInt(bytes[index])
  return value
}

const encodeLittleEndian = (value: bigint, length: number) => {
  const bytes = new Uint8Array(length)
  let current = value
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number(current & 0xffn)
    current >>= 8n
  }
  return bytes
}

const mod = (value: bigint, p: bigint) => {
  const result = value % p
  return result >= 0n ? result : result + p
}

const modPow = (base: bigint, exponent: bigint, p: bigint) => {
  let result = 1n
  let currentBase = mod(base, p)
  let currentExponent = exponent
  while (currentExponent > 0n) {
    if (currentExponent & 1n) result = mod(result * currentBase, p)
    currentBase = mod(currentBase * currentBase, p)
    currentExponent >>= 1n
  }
  return result
}

const modInverse = (value: bigint, p: bigint) => modPow(value, p - 2n, p)

const isPcsUrl = (value: string) => {
  try {
    return new URL(value).hostname === 'pcs.baidu.com'
  } catch {
    return false
  }
}

const contentTypeForFilename = (filename?: string | null) => {
  const lower = (filename ?? '').toLowerCase()
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.mkv')) return 'video/x-matroska'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  return undefined
}

const normalizedWorkerRuntime = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

const normalizedWorkerVersion = (value: unknown) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

export const normalizeWorkerBaseUrl = (value: unknown, label = 'Worker 代理端点') => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw badRequest('BAD_BASE_URL', `${label}必须是合法 URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('BAD_BASE_URL', `${label}只支持 http 或 https`)
  if (url.search || url.hash) throw badRequest('BAD_BASE_URL', `${label}不能包含查询参数或 hash`)
  return url.toString().replace(/\/+$/, '')
}

export const parseV2Endpoints = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return []
  let values: unknown[]
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      values = Array.isArray(parsed) ? parsed : []
    } catch {
      throw badRequest('BAD_LINK_PROXY_V2_ENDPOINTS', 'Worker v2 代理端点列表格式不正确')
    }
  } else {
    values = trimmed
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  const endpoints = values.map((item) => normalizeWorkerBaseUrl(item, 'Worker v2 代理端点'))
  return Array.from(new Set(endpoints))
}

export const serializeV2Endpoints = (endpoints: string[]) => endpoints.join('\n')

const payloadFor = (
  rawUrl: string,
  input?: {
    filename?: string | null
    expiresAt?: Date | null
  },
) => ({
  url: rawUrl,
  exp: input?.expiresAt ? Math.floor(input.expiresAt.getTime() / 1000) : Math.floor(Date.now() / 1000) + getDownloadSettings().linkCacheTtlSeconds,
  filename: input?.filename ?? undefined,
  contentType: contentTypeForFilename(input?.filename),
})

export const getLinkProxyConfig = () => {
  const version = getSettingWithSource('linkProxyVersion')
  const baseUrl = getSettingWithSource('linkProxyBaseUrl')
  const secret = getSettingWithSource('linkProxySecret')
  const v2Endpoints = getSettingWithSource('linkProxyV2Endpoints')
  const configuredVersion: LinkProxyVersion = version.value === 'v2' ? 'v2' : version.value === 'v1' ? 'v1' : 'none'
  const legacyV1FromEnv = configuredVersion === 'none' && version.source === 'default' && baseUrl.source === 'env' && secret.source === 'env' && Boolean(baseUrl.value && secret.value)
  const resolvedVersion: LinkProxyVersion = legacyV1FromEnv ? 'v1' : configuredVersion
  const endpoints = resolvedVersion === 'v2' ? parseV2Endpoints(v2Endpoints.value) : []
  return {
    version: resolvedVersion,
    configuredVersion,
    legacyV1FromEnv,
    baseUrl: baseUrl.value,
    secret: secret.value,
    v2Endpoints: endpoints,
    baseUrlSource: baseUrl.source === 'database' ? 'admin' : baseUrl.source === 'default' ? 'none' : baseUrl.source,
    secretSource: secret.source === 'database' ? 'admin' : secret.source === 'default' ? 'none' : secret.source,
    v2EndpointsSource: v2Endpoints.source === 'database' ? 'admin' : v2Endpoints.source === 'default' ? 'none' : v2Endpoints.source,
    enabled: resolvedVersion === 'v2' ? endpoints.length > 0 : resolvedVersion === 'v1' ? Boolean(baseUrl.value && secret.value) : false,
  }
}

export const setLinkProxyConfig = (input: { baseUrl?: unknown; secret?: unknown; version?: unknown; v2Endpoints?: unknown }) => {
  if (Object.hasOwn(input, 'version')) setSetting('linkProxyVersion', input.version)
  if (Object.hasOwn(input, 'baseUrl')) setSetting('linkProxyBaseUrl', input.baseUrl)
  if (Object.hasOwn(input, 'secret')) setSetting('linkProxySecret', input.secret)
  if (Object.hasOwn(input, 'v2Endpoints')) setSetting('linkProxyV2Endpoints', input.v2Endpoints)
  return getLinkProxyConfig()
}

const validateDiscovery = (endpoint: string, data: unknown): V2KeyInfo => {
  if (!data || typeof data !== 'object') throw new Error('返回不是有效 JSON 对象')
  const discovery = data as Partial<V2Discovery>
  if (discovery.version !== v2Version || discovery.kid !== v2KeyId) throw new Error('返回的版本或 key id 不匹配')
  if (typeof discovery.publicKey !== 'string' || !discovery.publicKey.trim()) throw new Error('缺少 publicKey')
  const publicKey = base64urlToBytes(discovery.publicKey)
  if (publicKey.length !== 32) throw new Error('publicKey 必须是 32 字节 base64url')
  const tokenPrefix = typeof discovery.tokenPrefix === 'string' && discovery.tokenPrefix.trim() ? discovery.tokenPrefix.trim() : `${endpoint}/lc/v2.x1.`
  const maxTokenTtlSeconds = Number(discovery.maxTokenTtlSeconds)
  const workerRuntime = normalizedWorkerRuntime(discovery.workerRuntime)
  const workerVersion = normalizedWorkerVersion(discovery.workerVersion)
  return {
    endpoint,
    publicKey,
    tokenPrefix,
    ...(workerRuntime ? { workerRuntime } : {}),
    ...(workerVersion ? { workerVersion } : {}),
    ...(Number.isFinite(maxTokenTtlSeconds) && maxTokenTtlSeconds > 0 ? { maxTokenTtlSeconds: Math.floor(maxTokenTtlSeconds) } : {}),
  }
}

export const discoverV2Endpoint = async (endpoint: string) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), v2DiscoveryTimeoutMs)
  try {
    const response = await fetch(`${endpoint}/lc/v2.auto`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return validateDiscovery(endpoint, await response.json())
  } finally {
    clearTimeout(timeout)
  }
}

export const validateV2Endpoints = async (endpoints: string[]) => {
  if (endpoints.length === 0) throw badRequest('BAD_LINK_PROXY_V2_ENDPOINTS', 'Worker v2 至少需要填写一个代理端点')
  const failures: Array<{ endpoint: string; message: string }> = []
  for (const endpoint of endpoints) {
    try {
      await discoverV2Endpoint(endpoint)
    } catch (error) {
      failures.push({ endpoint, message: unknownErrorMessage(error, '验证失败') })
    }
  }
  if (failures.length > 0) {
    throw badRequest('LINK_PROXY_V2_VALIDATE_FAILED', `Worker v2 代理端点验证失败: ${failures.map((item) => `${item.endpoint} ${item.message}`).join('；')}`, {
      failures,
    })
  }
}

const discoverV2EndpointWithContext = (endpoint: string, context: LinkProxyContext) => {
  const cached = context.v2DiscoveryCache.get(endpoint)
  if (cached) return cached
  const promise = discoverV2Endpoint(endpoint)
  context.v2DiscoveryCache.set(endpoint, promise)
  return promise
}

export const createProxiedDownloadUrl = async (
  rawUrl: string,
  input?: {
    filename?: string | null
    expiresAt?: Date | null
    context?: LinkProxyContext
  },
) => {
  const proxy = getLinkProxyConfig()
  if (!proxy.enabled || !isPcsUrl(rawUrl)) return rawUrl

  const payload = payloadFor(rawUrl, input)

  if (proxy.version === 'v1') {
    try {
      const token = encryptV1Payload(payload, proxy.secret)
      return `${proxy.baseUrl}/lc/${v1Version}.${v1KeyId}.${token}?download=1`
    } catch {
      return rawUrl
    }
  }

  const context = input?.context ?? createLinkProxyContext()
  const failures: Array<{ endpoint: string; message: string }> = []
  for (const endpoint of proxy.v2Endpoints) {
    try {
      const keyInfo = await discoverV2EndpointWithContext(endpoint, context)
      const token = encryptV2Payload(payload, keyInfo.publicKey)
      return `${keyInfo.tokenPrefix.replace(/\.*$/, '.')}${token}?download=1`
    } catch (error) {
      failures.push({ endpoint, message: unknownErrorMessage(error, '生成失败') })
    }
  }

  throw unavailable('LINK_PROXY_V2_UNAVAILABLE', 'Worker v2 代理端点均不可用，无法生成代理下载链接', { failures })
}
