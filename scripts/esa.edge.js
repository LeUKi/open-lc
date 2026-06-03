// scripts/esa.edge.js
//
// 适配阿里云 ESA 边缘函数 (Edge Functions) - 纯脚本配置版
//
// 支持的路径：
//   /lc/v1.k1.<encrypted-token>   旧版，对称加密，保持向前兼容
//   /lc/v2.x1.<encrypted-token>   新版，X25519 非对称加密
//   /lc/v2.auto                   返回当前 x1 公钥
//   /lc/v2.keys                   返回公钥列表，目前只有 x1
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

// ==========================================
// ⚙️ 核心配置区域 (请在此处修改你的配置)
// ==========================================
const CONFIG = {
  // 必需：用于派生密钥的加密根。请务必修改为一个高强度的随机字符串。
  URL_ENCRYPTION_KEY: "your_secret_key_here",

  // 可选：允许代理的上游 host，逗号分隔。默认为 "*" 允许所有。
  // 例如: "example.com, download.example.com"
  ALLOWED_HOSTS: "*",

  // 可选：v2 token 最大有效期（秒）。默认 86400 秒 (24小时)。
  MAX_TOKEN_TTL_SECONDS: 86400,
};
// ==========================================

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const LC_PREFIX = "/lc/";

const V1_VERSION = "v1";
const V1_KID = "k1";

const V2_VERSION = "v2";
const V2_KID = "x1";
const V2_AAD = "v2.x1";
const V2_ALG = "X25519-HKDF-SHA256-AES-256-GCM";
const WORKER_RUNTIME = "esa";
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
// ESA Edge Routine Isolate 被复用时，避免重复派生密钥和指纹。
let cachedV2KeyMaterialCacheKey = null;
let cachedV2KeyMaterialPromise = null;

export default {
  async fetch(request) {
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

    // 从顶部的 CONFIG 中获取加密根
    const encryptionRoot = getEncryptionRoot();

    if (!encryptionRoot.value) {
      return helpResponse(
        "Error: URL_ENCRYPTION_KEY is not properly configured in the script CONFIG.",
        500,
        encryptionRoot,
      );
    }

    // 返回当前 x1 公钥。
    if (requestUrl.pathname === "/lc/v2.auto") {
      return handleV2Auto(requestUrl, encryptionRoot);
    }

    // 返回所有公钥。目前只有 x1。
    if (requestUrl.pathname === "/lc/v2.keys") {
      return handleV2Keys(requestUrl, encryptionRoot);
    }

    // 解析 /lc/v1.k1.<token> 或 /lc/v2.x1.<token>
    const tokenInfo = getTokenInfoFromPath(requestUrl.pathname);
    if (!tokenInfo) {
      return helpResponse("Error: Invalid request path.", 400, encryptionRoot);
    }

    let payload;

    try {
      if (tokenInfo.version === V1_VERSION && tokenInfo.keyId === V1_KID) {
        payload = await decryptV1Token(
          tokenInfo.token,
          encryptionRoot.value,
          `${tokenInfo.version}.${tokenInfo.keyId}`,
        );
      } else if (tokenInfo.version === V2_VERSION && tokenInfo.keyId === V2_KID) {
        payload = await decryptV2Token(tokenInfo.token, encryptionRoot.value);
      } else {
        return helpResponse(
          "Error: Unsupported token version or key id.",
          400,
          encryptionRoot,
        );
      }
    } catch {
      // 统一模糊化错误
      return textError("invalid token", 403);
    }

    // v2 强制要求 exp。
    const validation = validatePayload(payload, {
      requireExp: tokenInfo.version === V2_VERSION,
      maxTokenTtlSeconds: getMaxTokenTtlSeconds(),
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

    if (!isAllowedUpstreamUrl(upstreamUrl)) {
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

    // 流式返回上游响应
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

/**
 * /lc/v2.auto
 */
async function handleV2Auto(requestUrl, encryptionRoot) {
  const material = await getV2KeyMaterial(encryptionRoot);
  const maxTokenTtlSeconds = getMaxTokenTtlSeconds();

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
 */
async function handleV2Keys(requestUrl, encryptionRoot) {
  const material = await getV2KeyMaterial(encryptionRoot);
  const maxTokenTtlSeconds = getMaxTokenTtlSeconds();

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
 * 从脚本顶部的 CONFIG 获取加密根
 */
function getEncryptionRoot() {
  if (CONFIG.URL_ENCRYPTION_KEY && CONFIG.URL_ENCRYPTION_KEY !== "your_secret_key_here") {
    return {
      value: CONFIG.URL_ENCRYPTION_KEY,
      source: "SCRIPT_CONFIG",
      secure: true,
      warning: null,
    };
  }

  return {
    value: null,
    source: "none",
    secure: false,
    warning:
      "URL_ENCRYPTION_KEY is not properly configured in the script CONFIG object.",
  };
}

/**
 * 从路径中解析 version、keyId、token
 */
function getTokenInfoFromPath(pathname) {
  if (!pathname.startsWith(LC_PREFIX)) {
    return null;
  }

  const tokenWithMeta = pathname.slice(LC_PREFIX.length);
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
 * 解密 v1 token (AES-GCM)
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
 * 解密 v2 token (X25519 -> AES-GCM)
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
 * 获取 v2 x1 密钥材料
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
 * 派生 v2 x1 私钥 seed，并计算公钥和指纹
 */
async function deriveV2KeyMaterial(encryptionRootValue) {
  const privateSeed = await hkdfSha256({
    inputKeyMaterial: TEXT_ENCODER.encode(encryptionRootValue),
    salt: TEXT_ENCODER.encode(V2_X25519_SALT),
    info: TEXT_ENCODER.encode(V2_X25519_INFO),
    lengthBytes: 32,
  });

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
 * HKDF-SHA256
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
 * 使用 WebCrypto 原生派生共享密钥
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
 * 内置 X25519 Fallback 实现
 */
function x25519(scalarBytes, uBytes) {
  const p = (1n << 255n) - 19n;
  const kBytes = new Uint8Array(scalarBytes);

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
 * 校验 payload
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
 * 上游代理校验
 */
function isAllowedUpstreamUrl(upstreamUrl) {
  if (upstreamUrl.protocol !== "https:" && upstreamUrl.protocol !== "http:") {
    return false;
  }
  const allowedHosts = getAllowedHosts();
  if (allowedHosts === "*") {
    return true;
  }
  return allowedHosts.has(upstreamUrl.hostname);
}

function getAllowedHosts() {
  const raw = String(CONFIG.ALLOWED_HOSTS || "*").trim();
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

function getMaxTokenTtlSeconds() {
  const n = Number(CONFIG.MAX_TOKEN_TTL_SECONDS);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_MAX_TOKEN_TTL_SECONDS;
  }
  return Math.floor(n);
}

/**
 * Header 处理
 */
function copyRequestHeadersForUpstream(request) {
  const headers = new Headers();
  const userAgent = request.headers.get("User-Agent");
  if (userAgent) headers.set("User-Agent", userAgent);
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  const ifRange = request.headers.get("If-Range");
  if (ifRange) headers.set("If-Range", ifRange);
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);
  const ifModifiedSince = request.headers.get("If-Modified-Since");
  if (ifModifiedSince) headers.set("If-Modified-Since", ifModifiedSince);
  return headers;
}

function cleanResponseHeaders(upstreamHeaders, payload, requestUrl) {
  const headers = new Headers(upstreamHeaders);
  headers.delete("Set-Cookie");
  headers.delete("Server");
  headers.delete("X-Powered-By");

  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  const filename = getFilenameFromPayloadOrUrl(payload);
  const disposition =
    requestUrl.searchParams.get("download") === "1" ? "attachment" : "inline";

  headers.set(
    "Content-Disposition",
    `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );

  if (payload.contentType && !headers.get("Content-Type")) {
    headers.set("Content-Type", payload.contentType);
  }

  return headers;
}

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
      if (name) return sanitizeFilename(name);
    }
    const pathname = decodeURIComponent(upstreamUrl.pathname);
    const parts = pathname.split("/");
    const name = parts[parts.length - 1];
    if (name) return sanitizeFilename(name);
  } catch {
    // 忽略推断失败
  }
  return "download";
}

function sanitizeFilename(filename) {
  return String(filename || "download")
    .replace(/["\r\n]/g, "_")
    .replace(/[\\/:*?<>|]/g, "_");
}

/**
 * 帮助信息
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
  lines.push("Configuration (Hardcoded in Script):");
  lines.push("  URL_ENCRYPTION_KEY is required in the CONFIG object.");
  lines.push("  MAX_TOKEN_TTL_SECONDS is optional. Default: 86400.");
  lines.push("  v2 discovery returns workerRuntime, workerVersion, and maxTokenTtlSeconds.");
  lines.push("  Agent link TTL must not exceed maxTokenTtlSeconds.");
  lines.push("  ALLOWED_HOSTS is optional. Default: *.");
  lines.push("");
  lines.push("Notes:");
  lines.push("  v1 uses legacy symmetric AES-GCM tokens.");
  lines.push("  v2 uses X25519 + HKDF-SHA256 + AES-256-GCM tokens.");

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

function textError(message, status) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function base64urlToBytes(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + pad);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

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
