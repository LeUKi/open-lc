# Worker Proxy

Open LC Worker is an optional encrypted download proxy for LC Agent result links.

## Discovery

LC Agent verifies Worker v2 endpoints through:

```txt
GET /lc/v2.auto
```

The response uses `version` for the encrypted link protocol version. It is not the Worker script version.

Current v2 discovery response:

```json
{
  "ok": true,
  "version": "v2",
  "kid": "x1",
  "alg": "X25519-HKDF-SHA256-AES-256-GCM",
  "publicKey": "...",
  "fingerprint": "...",
  "tokenPrefix": "https://your-worker.example.com/lc/v2.x1.",
  "workerRuntime": "cloudflare",
  "workerVersion": 2,
  "maxTokenTtlSeconds": 86400
}
```

`/lc/v2.keys` returns the same top-level Worker metadata and a `keys` list. `workerRuntime` and `workerVersion` describe the whole Worker script, so they are top-level fields rather than per-key fields. Individual key entries still describe key-specific data such as `kid`, `alg`, `publicKey`, `fingerprint`, `status`, and `tokenPrefix`.

## Worker Discovery Versions

| Worker version | Meaning |
| --- | --- |
| 1 | Legacy discovery response. It may only declare `version`, `kid`, `publicKey`, `tokenPrefix`, and key metadata. It does not declare `workerRuntime`, `workerVersion`, or `maxTokenTtlSeconds`. |
| 2 | Declares `workerRuntime`, `workerVersion`, and `maxTokenTtlSeconds` in v2 discovery responses. |

`workerVersion` must be a positive integer. LC Agent treats missing or invalid `workerVersion` as legacy version 1 for display and troubleshooting only. Missing or invalid Worker metadata must not make an otherwise valid v2 endpoint fail validation.

## Runtime Values

Current `workerRuntime` values:

| Value | Runtime |
| --- | --- |
| `cloudflare` | Cloudflare Workers |
| `esa` | Alibaba Cloud ESA |

Unknown runtime strings are allowed and should be displayed as-is by compatible clients.

## Token TTL

`maxTokenTtlSeconds` controls the maximum `exp` accepted by the Worker for v2 encrypted links. LC Agent's `链接有效期秒数` must not be greater than this value. If Agent generates a v2 link with a longer `exp`, the Worker returns `forbidden`.

Old Worker endpoints may not declare `maxTokenTtlSeconds`. In that case, LC Agent keeps the endpoint compatible and uses the default `86400` seconds as a conservative user-facing hint.
