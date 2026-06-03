// scripts/worker.js
//
// 支持的路径：
//   /lc/v1.k1.<encrypted-token>   旧版，对称加密，保持向前兼容
//   /lc/v2.x1.<encrypted-token>   新版，X25519 非对称加密
//   /lc/v2.auto                   返回当前 x1 公钥
//   /lc/v2.keys                   返回公钥列表，目前只有 x1
//
// 推荐设置的环境变量：
//   URL_ENCRYPTION_KEY
//
// 如果没有设置 URL_ENCRYPTION_KEY：
//   会自动 fallback 到 CF_VERSION_METADATA.id
//
// 注意：
//   CF_VERSION_METADATA.id 不是 secret，且重新部署后可能变化。
//   如果要启用 CF_VERSION_METADATA，需要在 wrangler.toml 中配置：
//     [version_metadata]
//     binding = "CF_VERSION_METADATA"
//
// 可选环境变量：
//   MAX_TOKEN_TTL_SECONDS   v2 token 最大有效期，默认 86400 秒
//   ALLOWED_HOSTS           允许代理的上游 host，逗号分隔，默认 *
//
// v1：
//   SHA-256(encryptionRoot) -> AES-GCM key
//   保持原逻辑，不破坏旧链接
//
// v2：
//   encryptionRoot
//     -> HKDF-SHA256(info="open-lc:v2:x25519:x1")
//     -> 32 bytes
//     -> X25519 private key
//
//   X25519 sharedSecret
//     -> HKDF-SHA256(info="open-lc:v2:aes-gcm:v2.x1")
//     -> AES-256-GCM key
//
// v2 token 格式：
//   base64url(ephemeralPublicKey[32] || nonce[12] || ciphertextAndTag)
//
// v2 AAD：
//   "v2.x1"

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const LC_PREFIX = "/lc/";

const V1_VERSION = "v1";
const V1_KID = "k1";

const V2_VERSION = "v2";
const V2_KID = "x1";
const V2_AAD = "v2.x1";
const V2_ALG = "X25519-HKDF-SHA256-AES-256-GCM";
const WORKER_RUNTIME = "cloudflare";
const WORKER_VERSION = 2;

const V2_X25519_INFO = "open-lc:v2:x25519:x1";
const V2_AES_INFO = "open-lc:v2:aes-gcm:v2.x1";
const V2_X25519_SALT = "open-lc:v2:x25519:salt";
const V2_AES_SALT = "open-lc:v2:aes-gcm:salt";

const DEFAULT_MAX_TOKEN_TTL_SECONDS = 86400;

// X25519 base point，固定为 u = 9
const X25519_BASE_POINT = new Uint8Array(32);
X25519_BASE_POINT[0] = 9;

// 模块级缓存。
// Cloudflare Worker isolate 被复用时，可以避免重复派生 x1 私钥、公钥、指纹。
// 注意：缓存 key 里包含 source/value，避免不同 env 场景下误复用。
let cachedV2KeyMaterialCacheKey = null;
let cachedV2KeyMaterialPromise = null;

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    // 公钥发现接口支持浏览器跨域预检。
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // 只允许 GET / HEAD。
    if (request.method !== "GET" && request.method !== "HEAD") {
      return helpResponse("Error: Only GET and HEAD are supported.", 405);
    }

    // 获取加密根：
    // 1. 优先使用 URL_ENCRYPTION_KEY
    // 2. 如果没有 URL_ENCRYPTION_KEY，则自动 fallback 到 CF_VERSION_METADATA.id
    // 3. 如果两者都不存在，才返回帮助文本
    const encryptionRoot = getEncryptionRoot(env);

    if (!encryptionRoot.value) {
      return helpResponse(
        [
          "Error: URL_ENCRYPTION_KEY is not configured.",
          "Error: CF_VERSION_METADATA.id is also missing, so fallback is unavailable.",
        ].join("\n"),
        500,
        encryptionRoot,
      );
    }

    // 返回当前 x1 公钥。
    if (requestUrl.pathname === "/lc/v2.auto") {
      return handleV2Auto(requestUrl, env, encryptionRoot);
    }

    // 返回所有公钥。目前只有 x1。
    if (requestUrl.pathname === "/lc/v2.keys") {
      return handleV2Keys(requestUrl, env, encryptionRoot);
    }

    // 解析 /lc/v1.k1.<token> 或 /lc/v2.x1.<token>
    const tokenInfo = getTokenInfoFromPath(requestUrl.pathname);
    if (!tokenInfo) {
      return helpResponse("Error: Invalid request path.", 400, encryptionRoot);
    }

    let payload;

    try {
      if (tokenInfo.version === V1_VERSION && tokenInfo.keyId === V1_KID) {
        // v1：保持旧版 AES-GCM 逻辑，保证旧链接继续可用。
        payload = await decryptV1Token(
          tokenInfo.token,
          encryptionRoot.value,
          `${tokenInfo.version}.${tokenInfo.keyId}`,
        );
      } else if (tokenInfo.version === V2_VERSION && tokenInfo.keyId === V2_KID) {
        // v2：X25519 + HKDF-SHA256 + AES-256-GCM。
        payload = await decryptV2Token(tokenInfo.token, encryptionRoot.value);
      } else {
        return helpResponse(
          "Error: Unsupported token version or key id.",
          400,
          encryptionRoot,
        );
      }
    } catch {
      // 统一模糊化错误，不暴露到底是密钥错、tag 错、nonce 错还是 JSON 错。
      return textError("invalid token", 403);
    }

    // v2 强制要求 exp。
    // v1 为了兼容旧链接，不强制 exp；但如果 v1 payload 中有 exp，也会检查是否过期。
    const validation = validatePayload(payload, {
      requireExp: tokenInfo.version === V2_VERSION,
      maxTokenTtlSeconds: getMaxTokenTtlSeconds(env),
    });

    if (!validation.ok) {
      return textError(validation.message, validation.status);
    }

    let upstreamUrl;
    try {
      upstreamUrl = new URL(payload.url);
    } catch {
      return textError("invalid request", 400);
    }

    if (!isAllowedUpstreamUrl(upstreamUrl, env)) {
      return textError("forbidden", 403);
    }

    const upstreamHeaders = copyRequestHeadersForUpstream(request);

    let upstream;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      });
    } catch {
      return textError("upstream error", 502);
    }

    const responseHeaders = cleanResponseHeaders(
      upstream.headers,
      payload,
      requestUrl,
    );

    // 流式返回上游响应，避免大文件占用 Worker 内存。
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

/**
 * /lc/v2.auto
 *
 * 返回当前推荐使用的 x1 公钥。
 * 客户端拿到 publicKey 后，应生成 /lc/v2.x1.<token>。
 */
async function handleV2Auto(requestUrl, env, encryptionRoot) {
  const material = await getV2KeyMaterial(encryptionRoot);
  const maxTokenTtlSeconds = getMaxTokenTtlSeconds(env);

  return jsonResponse({
    ok: true,
    version: V2_VERSION,
    kid: V2_KID,
    alg: V2_ALG,
    publicKey: material.publicKeyText,
    fingerprint: material.fingerprint,
    tokenPrefix: `${requestUrl.origin}/lc/v2.x1.`,
    keySource: encryptionRoot.source,
    secure: encryptionRoot.secure,
    warning: encryptionRoot.warning,
    workerRuntime: WORKER_RUNTIME,
    workerVersion: WORKER_VERSION,
    maxTokenTtlSeconds,
  });
}

/**
 * /lc/v2.keys
 *
 * 返回所有公开公钥。
 * 目前固定只有 x1。
 */
async function handleV2Keys(requestUrl, env, encryptionRoot) {
  const material = await getV2KeyMaterial(encryptionRoot);
  const maxTokenTtlSeconds = getMaxTokenTtlSeconds(env);

  return jsonResponse({
    ok: true,
    version: V2_VERSION,
    current: V2_KID,
    keySource: encryptionRoot.source,
    secure: encryptionRoot.secure,
    warning: encryptionRoot.warning,
    workerRuntime: WORKER_RUNTIME,
    workerVersion: WORKER_VERSION,
    maxTokenTtlSeconds,
    keys: [
      {
        kid: V2_KID,
        alg: V2_ALG,
        publicKey: material.publicKeyText,
        fingerprint: material.fingerprint,
        status: "active",
        tokenPrefix: `${requestUrl.origin}/lc/v2.x1.`,
        maxTokenTtlSeconds,
      },
    ],
  });
}

/**
 * 获取加密根。
 *
 * 优先级：
 *   1. env.URL_ENCRYPTION_KEY
 *   2. env.CF_VERSION_METADATA.id
 *
 * 注意：
 *   CF_VERSION_METADATA.id 不是 secret。
 *   这里只是按你的要求作为零配置 fallback。
 *   重新部署 Worker 后，version id 可能变化，旧 token 也可能失效。
 */
function getEncryptionRoot(env) {
  if (env.URL_ENCRYPTION_KEY) {
    return {
      value: env.URL_ENCRYPTION_KEY,
      source: "URL_ENCRYPTION_KEY",
      secure: true,
      warning: null,
    };
  }

  const versionId = env.CF_VERSION_METADATA?.id;

  if (versionId) {
    return {
      value: versionId,
      source: "CF_VERSION_METADATA.id",
      secure: false,
      warning:
        "URL_ENCRYPTION_KEY is not configured. Falling back to CF_VERSION_METADATA.id.",
    };
  }

  return {
    value: null,
    source: "none",
    secure: false,
    warning:
      "URL_ENCRYPTION_KEY is not configured. CF_VERSION_METADATA.id is also missing, so fallback is unavailable.",
  };
}

/**
 * 从路径中解析 version、keyId、token。
 *
 * 支持：
 *   /lc/v1.k1.<token>
 *   /lc/v2.x1.<token>
 */
function getTokenInfoFromPath(pathname) {
  if (!pathname.startsWith(LC_PREFIX)) {
    return null;
  }

  const tokenWithMeta = pathname.slice(LC_PREFIX.length);

  // token 是 base64url，不包含 "."，所以可以用 "." 切分。
  const parts = tokenWithMeta.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [version, keyId, token] = parts;

  if (!version || !keyId || !token) {
    return null;
  }

  return { version, keyId, token };
}

/**
 * 解密 v1 token。
 *
 * v1 token 格式沿用旧逻辑：
 *   base64url(nonce[12] || ciphertextAndTag)
 *
 * AES-GCM AAD：
 *   "v1.k1"
 */
async function decryptV1Token(token, encryptionRootValue, aadText) {
  const raw = base64urlToBytes(token);

  if (raw.length < 12 + 16) {
    throw new Error("token too short");
  }

  const nonce = raw.slice(0, 12);
  const ciphertextAndTag = raw.slice(12);

  const key = await importV1AesKeyFromSecret(encryptionRootValue);

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: TEXT_ENCODER.encode(aadText),
    },
    key,
    ciphertextAndTag,
  );

  return JSON.parse(TEXT_DECODER.decode(plaintext));
}

/**
 * v1 AES key 派生。
 *
 * 这里必须保持旧逻辑：
 *   SHA-256(encryptionRoot) -> AES-256-GCM key
 *
 * 如果使用 URL_ENCRYPTION_KEY，完全兼容旧 token。
 * 如果 fallback 到 CF_VERSION_METADATA.id，则只能解由同一个 fallback 根生成的 token。
 */
async function importV1AesKeyFromSecret(encryptionRootValue) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(encryptionRootValue),
  );

  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
}

/**
 * 解密 v2 token。
 *
 * v2 token 格式：
 *   base64url(ephemeralPublicKey[32] || nonce[12] || ciphertextAndTag)
 *
 * 解密流程：
 *   1. 从 encryptionRoot 派生 x1 私钥 seed
 *   2. X25519(x1 private, ephemeralPublicKey) 得到 sharedSecret
 *   3. HKDF-SHA256(sharedSecret) 得到 AES-256-GCM key
 *   4. AES-GCM 解密 payload JSON
 */
async function decryptV2Token(token, encryptionRootValue) {
  const raw = base64urlToBytes(token);

  if (raw.length < 32 + 12 + 16) {
    throw new Error("token too short");
  }

  const ephemeralPublicKey = raw.slice(0, 32);
  const nonce = raw.slice(32, 44);
  const ciphertextAndTag = raw.slice(44);

  const material = await getV2KeyMaterial({
    value: encryptionRootValue,
    source: "direct",
  });

  // 优先尝试 Worker 原生 WebCrypto X25519。
  // 如果运行环境对 raw X25519 import 支持不一致，则 fallback 到内置 BigInt X25519。
  let sharedSecret;
  try {
    sharedSecret = await deriveX25519SharedSecretNative(
      material.privateSeed,
      ephemeralPublicKey,
    );
  } catch {
    sharedSecret = x25519(material.privateSeed, ephemeralPublicKey);
  }

  const aesKeyBytes = await hkdfSha256({
    inputKeyMaterial: sharedSecret,
    salt: TEXT_ENCODER.encode(V2_AES_SALT),
    info: TEXT_ENCODER.encode(V2_AES_INFO),
    lengthBytes: 32,
  });

  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesKeyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: TEXT_ENCODER.encode(V2_AAD),
    },
    aesKey,
    ciphertextAndTag,
  );

  return JSON.parse(TEXT_DECODER.decode(plaintext));
}

/**
 * 获取 v2 x1 密钥材料。
 *
 * x1 是固定 key id。
 * x1 私钥不需要额外保存，而是从 encryptionRoot 确定性派生。
 *
 * 只要 encryptionRoot 不变：
 *   x1 private key 不变
 *   x1 public key 不变
 *   旧 v2.x1 token 能继续解密
 */
async function getV2KeyMaterial(encryptionRoot) {
  const cacheKey = `${encryptionRoot.source}:${encryptionRoot.value}`;

  if (
    cachedV2KeyMaterialPromise &&
    cachedV2KeyMaterialCacheKey === cacheKey
  ) {
    return cachedV2KeyMaterialPromise;
  }

  cachedV2KeyMaterialCacheKey = cacheKey;
  cachedV2KeyMaterialPromise = deriveV2KeyMaterial(encryptionRoot.value);

  return cachedV2KeyMaterialPromise;
}

/**
 * 派生 v2 x1 私钥 seed，并计算公钥和指纹。
 */
async function deriveV2KeyMaterial(encryptionRootValue) {
  const privateSeed = await hkdfSha256({
    inputKeyMaterial: TEXT_ENCODER.encode(encryptionRootValue),
    salt: TEXT_ENCODER.encode(V2_X25519_SALT),
    info: TEXT_ENCODER.encode(V2_X25519_INFO),
    lengthBytes: 32,
  });

  // publicKey = X25519(privateSeed, basePoint)
  const publicKey = x25519(privateSeed, X25519_BASE_POINT);
  const publicKeyText = bytesToBase64url(publicKey);

  const fingerprintBytes = await crypto.subtle.digest("SHA-256", publicKey);
  const fingerprint = `sha256:${bytesToBase64url(
    new Uint8Array(fingerprintBytes),
  )}`;

  return {
    privateSeed,
    publicKey,
    publicKeyText,
    fingerprint,
  };
}

/**
 * HKDF-SHA256。
 *
 * 用途：
 *   1. encryptionRoot -> v2 x1 private seed
 *   2. X25519 sharedSecret -> AES-256-GCM key
 */
async function hkdfSha256({ inputKeyMaterial, salt, info, lengthBytes }) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    inputKeyMaterial,
    "HKDF",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    baseKey,
    lengthBytes * 8,
  );

  return new Uint8Array(bits);
}

/**
 * 使用 Worker 原生 WebCrypto 做 X25519 ECDH。
 *
 * 说明：
 *   这条路径性能更好。
 *   如果运行环境不支持 raw private import，会自动 fallback 到内置 x25519()。
 */
async function deriveX25519SharedSecretNative(privateSeed, peerPublicKeyBytes) {
  const privateKey = await crypto.subtle.importKey(
    "raw",
    privateSeed,
    { name: "X25519" },
    false,
    ["deriveBits"],
  );

  const peerPublicKey = await crypto.subtle.importKey(
    "raw",
    peerPublicKeyBytes,
    { name: "X25519" },
    false,
    [],
  );

  const sharedBits = await crypto.subtle.deriveBits(
    {
      name: "X25519",
      public: peerPublicKey,
    },
    privateKey,
    256,
  );

  return new Uint8Array(sharedBits);
}

/**
 * 内置 X25519 实现。
 *
 * 用途：
 *   1. 计算 x1 公钥：X25519(privateSeed, basePoint)
 *   2. 原生 WebCrypto X25519 不可用时，作为 fallback 做 sharedSecret
 *
 * 这是 RFC 7748 Montgomery ladder 的核心流程。
 * 不依赖外部库。
 */
function x25519(scalarBytes, uBytes) {
  const p = (1n << 255n) - 19n;

  const kBytes = new Uint8Array(scalarBytes);

  // X25519 scalar clamping
  kBytes[0] &= 248;
  kBytes[31] &= 127;
  kBytes[31] |= 64;

  const k = decodeLittleEndian(kBytes);
  const u = decodeLittleEndian(uBytes);

  let x1 = u;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = u;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t--) {
    const kt = (k >> BigInt(t)) & 1n;
    swap ^= kt;

    if (swap === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }

    swap = kt;

    const a = mod(x2 + z2, p);
    const aa = mod(a * a, p);
    const b = mod(x2 - z2, p);
    const bb = mod(b * b, p);
    const e = mod(aa - bb, p);
    const c = mod(x3 + z3, p);
    const d = mod(x3 - z3, p);
    const da = mod(d * a, p);
    const cb = mod(c * b, p);

    x3 = mod((da + cb) * (da + cb), p);
    z3 = mod(x1 * mod((da - cb) * (da - cb), p), p);
    x2 = mod(aa * bb, p);
    z2 = mod(e * mod(aa + 121665n * e, p), p);
  }

  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  const result = mod(x2 * modPow(z2, p - 2n, p), p);
  return encodeLittleEndian(result, 32);
}

function mod(a, p) {
  const r = a % p;
  return r >= 0n ? r : r + p;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;

  while (e > 0n) {
    if (e & 1n) {
      result = mod(result * b, modulus);
    }

    b = mod(b * b, modulus);
    e >>= 1n;
  }

  return result;
}

function decodeLittleEndian(bytes) {
  let n = 0n;

  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) + BigInt(bytes[i]);
  }

  return n;
}

function encodeLittleEndian(num, length) {
  const out = new Uint8Array(length);
  let n = num;

  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }

  return out;
}

/**
 * 校验解密后的 payload。
 *
 * payload 至少需要：
 *   {
 *     "url": "https://example.com/file",
 *     "exp": 1760000000
 *   }
 *
 * v2 强制 exp。
 * v1 为兼容旧链接，不强制 exp。
 */
function validatePayload(payload, { requireExp, maxTokenTtlSeconds }) {
  if (!payload || typeof payload !== "object" || !payload.url) {
    return { ok: false, status: 400, message: "invalid request" };
  }

  const now = Math.floor(Date.now() / 1000);

  if (requireExp && payload.exp == null) {
    return { ok: false, status: 400, message: "invalid request" };
  }

  if (payload.exp != null) {
    const exp = Number(payload.exp);

    if (!Number.isFinite(exp)) {
      return { ok: false, status: 400, message: "invalid request" };
    }

    if (exp < now) {
      return { ok: false, status: 410, message: "expired" };
    }

    if (requireExp && exp > now + maxTokenTtlSeconds) {
      return { ok: false, status: 403, message: "forbidden" };
    }
  }

  return { ok: true };
}

/**
 * 检查上游 URL 是否允许代理。
 */
function isAllowedUpstreamUrl(upstreamUrl, env) {
  if (upstreamUrl.protocol !== "https:" && upstreamUrl.protocol !== "http:") {
    return false;
  }

  const allowedHosts = getAllowedHosts(env);
  if (allowedHosts === "*") {
    return true;
  }

  return allowedHosts.has(upstreamUrl.hostname);
}

/**
 * 获取允许代理的 host。
 *
 * 默认：
 *   *
 *
 * 可通过环境变量配置：
 *   ALLOWED_HOSTS=*
 *   ALLOWED_HOSTS=example.com,download.example.com
 */
function getAllowedHosts(env) {
  const raw = String(env.ALLOWED_HOSTS || "*").trim();
  if (!raw || raw === "*") {
    return "*";
  }

  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * 获取 v2 token 最大有效期。
 *
 * 默认 86400 秒，即 24 小时。
 */
function getMaxTokenTtlSeconds(env) {
  const n = Number(env.MAX_TOKEN_TTL_SECONDS);

  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_MAX_TOKEN_TTL_SECONDS;
  }

  return Math.floor(n);
}

/**
 * 复制部分请求头给上游。
 *
 * 支持断点续传、视频拖动、下载器分片等场景。
 */
function copyRequestHeadersForUpstream(request) {
  const headers = new Headers();

  const userAgent = request.headers.get("User-Agent");
  if (userAgent) {
    headers.set("User-Agent", userAgent);
  }

  const range = request.headers.get("Range");
  if (range) {
    headers.set("Range", range);
  }

  const ifRange = request.headers.get("If-Range");
  if (ifRange) {
    headers.set("If-Range", ifRange);
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch) {
    headers.set("If-None-Match", ifNoneMatch);
  }

  const ifModifiedSince = request.headers.get("If-Modified-Since");
  if (ifModifiedSince) {
    headers.set("If-Modified-Since", ifModifiedSince);
  }

  return headers;
}

/**
 * 清理和补充响应头。
 */
function cleanResponseHeaders(upstreamHeaders, payload, requestUrl) {
  const headers = new Headers(upstreamHeaders);

  // 不把上游 cookie 透传给用户。
  headers.delete("Set-Cookie");

  // 减少上游细节暴露。
  headers.delete("Server");
  headers.delete("X-Powered-By");

  // 下载链接本身不建议被公共缓存。
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  const filename = getFilenameFromPayloadOrUrl(payload);

  // 默认 inline。
  // 如果访问时带 ?download=1，则强制 attachment 下载。
  const disposition =
    requestUrl.searchParams.get("download") === "1" ? "attachment" : "inline";

  headers.set(
    "Content-Disposition",
    `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );

  // 如果 payload 指定了 contentType，且上游没有给 Content-Type，则使用 payload 的。
  if (payload.contentType && !headers.get("Content-Type")) {
    headers.set("Content-Type", payload.contentType);
  }

  return headers;
}

/**
 * 从 payload 或 URL 里推断文件名。
 */
function getFilenameFromPayloadOrUrl(payload) {
  if (payload.filename) {
    return sanitizeFilename(payload.filename);
  }

  try {
    const upstreamUrl = new URL(payload.url);

    const pathParam = upstreamUrl.searchParams.get("path");
    if (pathParam) {
      const decodedPath = decodeURIComponent(pathParam);
      const parts = decodedPath.split("/");
      const name = parts[parts.length - 1];

      if (name) {
        return sanitizeFilename(name);
      }
    }

    const pathname = decodeURIComponent(upstreamUrl.pathname);
    const parts = pathname.split("/");
    const name = parts[parts.length - 1];

    if (name) {
      return sanitizeFilename(name);
    }
  } catch {
    // 忽略推断失败。
  }

  return "download";
}

/**
 * 简单清理文件名，避免响应头异常。
 */
function sanitizeFilename(filename) {
  return String(filename || "download")
    .replace(/["\r\n]/g, "_")
    .replace(/[\\/:*?<>|]/g, "_");
}

/**
 * 帮助文本。
 *
 * invalid request、URL_ENCRYPTION_KEY 缺失、CF_VERSION_METADATA 缺失时使用。
 */
function helpText(extraMessage = "", encryptionRoot = null) {
  const lines = [];

  if (extraMessage) {
    lines.push(extraMessage);
    lines.push("");
  }

  lines.push("Usage:");
  lines.push("  /lc/v1.k1.<encrypted-token>");
  lines.push("  /lc/v2.x1.<encrypted-token>");
  lines.push("");
  lines.push("Key discovery:");
  lines.push("  /lc/v2.auto");
  lines.push("  /lc/v2.keys");
  lines.push("");
  lines.push("Environment:");
  lines.push("  URL_ENCRYPTION_KEY is recommended.");
  lines.push("  If URL_ENCRYPTION_KEY is missing, CF_VERSION_METADATA.id will be used as fallback.");
  lines.push("  To enable CF_VERSION_METADATA, add this to wrangler.toml:");
  lines.push("    [version_metadata]");
  lines.push('    binding = "CF_VERSION_METADATA"');
  lines.push("  MAX_TOKEN_TTL_SECONDS is optional. Default: 86400.");
  lines.push("  v2 discovery returns workerRuntime, workerVersion, and maxTokenTtlSeconds.");
  lines.push("  Agent link TTL must not exceed maxTokenTtlSeconds.");
  lines.push("  ALLOWED_HOSTS is optional. Default: *.");
  lines.push("");
  lines.push("Notes:");
  lines.push("  v1 uses legacy symmetric AES-GCM tokens.");
  lines.push("  v2 uses X25519 + HKDF-SHA256 + AES-256-GCM tokens.");
  lines.push("  v2 public key is available from /lc/v2.auto or /lc/v2.keys.");
  lines.push("  CF_VERSION_METADATA.id fallback is not a secret and may change after deployment.");

  if (encryptionRoot) {
    lines.push("");
    lines.push("Runtime key source:");
    lines.push(`  source: ${encryptionRoot.source}`);
    lines.push(`  secure: ${encryptionRoot.secure ? "true" : "false"}`);

    if (encryptionRoot.warning) {
      lines.push(`  warning: ${encryptionRoot.warning}`);
    }
  }

  return lines.join("\n");
}

function helpResponse(extraMessage = "", status = 400, encryptionRoot = null) {
  return new Response(helpText(extraMessage, encryptionRoot), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * JSON 响应。
 *
 * /lc/v2.auto 和 /lc/v2.keys 使用。
 */
function jsonResponse(data) {
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

/**
 * 统一模糊化错误响应。
 */
function textError(message, status) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * 公钥发现接口支持跨域。
 */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * base64url no padding -> Uint8Array
 */
function base64urlToBytes(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + pad);

  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Uint8Array -> base64url no padding
 */
function bytesToBase64url(bytes) {
  let binary = "";

  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
