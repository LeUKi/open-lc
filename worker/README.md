# Open LC Worker

This directory is an independent Cloudflare Worker project for the Open LC download proxy.

The Worker source is generated during the Open LC export from the monorepo script:

```txt
scripts/worker.js -> worker/src/index.js
```

For manual code inspection, use `scripts/worker.js` in the repository root. The ESA entry script is `scripts/esa.edge.js`.

## Cloudflare Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LeUKi/open-lc/tree/main/worker)

LC Agent has three result-link proxy modes. The Worker itself supports the two encrypted proxy modes:

- `v2` public-key discovery, recommended for new setups. The Worker keeps the encryption root, and LC Agent only stores one or more Worker proxy endpoints.
- `v1` shared secret, kept for compatibility. LC Agent and the Worker must use the same encryption key.
- `none` disables the Worker proxy. It is the default for new local setups and returns the real download link directly, so it does not hide the original URL.

After Cloudflare deployment, set the `URL_ENCRYPTION_KEY` secret in Cloudflare Dashboard before using the Worker.

```txt
Workers & Pages
-> Select your deployed Worker
-> Settings
-> Variables and Secrets
-> Add
-> Secret
```

```txt
Name: URL_ENCRYPTION_KEY
Value: your encryption key
```

In LC Agent Settings:

- For `none`, choose `无`; no Worker endpoint or key is required.
- For `v2`, choose `v2 公钥发现` and enter the Worker proxy endpoint. Multiple endpoints are supported, one per line. LC Agent validates each endpoint through `/lc/v2.auto` and does not store the Worker secret.
- For `v1`, choose `v1 共享密钥`; the Agent-side Worker encryption key must match `URL_ENCRYPTION_KEY`.

`MAX_TOKEN_TTL_SECONDS` controls the maximum lifetime accepted by the Worker for v2 encrypted links. The LC Agent setting `链接有效期秒数` must not be greater than this value. The default is `86400` seconds; if Agent generates a v2 link with a longer `exp`, the Worker will return `forbidden`.

New Worker discovery responses also declare `workerRuntime` (`cloudflare` or `esa`) and numeric `workerVersion` metadata. See `../docs/WORKER_PROXY.md` for the discovery fields and version differences.

`ALLOWED_HOSTS` defaults to `*`. To restrict upstream hosts, set `ALLOWED_HOSTS` in Worker Variables to a comma-separated host list.

Do not commit this secret to the repository.

## Alibaba Cloud ESA

ESA uses the repository root script:

```txt
scripts/esa.edge.js
```

ESA is generally friendlier for access from mainland China and can reduce cross-border access instability.

Deploy from `https://esa.console.aliyun.com/edge/pages`, create an Edge Function / Edge Routine, and paste the script content into the editor.

Before deployment, change `CONFIG.URL_ENCRYPTION_KEY` at the top of `scripts/esa.edge.js` to a strong random string. `ALLOWED_HOSTS` defaults to `*` and usually does not need changes.

To verify v2 discovery, open:

```txt
https://your-worker.example.com/lc/v2.auto
```

It should return JSON containing `version: "v2"`, `kid: "x1"`, and `publicKey`. New Worker endpoints also return `workerRuntime`, `workerVersion`, and `maxTokenTtlSeconds`.

## Manual Deploy

```sh
npm install
npx wrangler secret put URL_ENCRYPTION_KEY
npm run deploy
```

## Local Development

```sh
npm install
npm run dev
```

For local development, create a `.dev.vars` file in this directory. This value is the local Worker's encryption root for both v1 and v2:

```txt
URL_ENCRYPTION_KEY=your-local-key
```

Do not commit `.dev.vars`.

## Git Deployment

When connecting this repository to Cloudflare Git deployment, set the project root directory to:

```txt
worker
```

This keeps Worker deployment dependencies isolated from the rest of the Open LC repository.
