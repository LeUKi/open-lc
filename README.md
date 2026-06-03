# Open LC

## 重要声明

本项目仅供学习、研究和个人技术参考使用。

本项目涉及的能力均基于网盘服务提供方的官方开放接口，不包含破坏、绕过、破解官方接口或服务限制的行为。当前项目仅面向已拥有正版 SVIP 会员权益的账号使用者，用于在合法、合规、符合服务条款的前提下进行本地化管理和调用。

使用者应自行确认其账号、接口调用、数据处理和使用场景符合相关法律法规、平台服务协议以及授权范围。任何超出个人学习研究范围的使用，尤其是未经授权的商业用途、批量化调用、转售、共享账号权益或其他违反平台规则的行为，均可能导致账号限制、封禁、IP 限制、权益回收或其他法律及商业风险。

因使用者违反法律法规、平台规则、服务协议或授权范围而产生的任何后果，包括但不限于限速、封号、数据损失、权益损失、纠纷、索赔或其他风险，均由使用者自行承担，与本项目作者无关。

## Overview

Open LC is the open-source LC Agent package exported from the LC monorepo.

It provides a local Agent API, a web console, desktop builds, Docker deployment, and the public LC v0 Broker protocol documents needed to build compatible Broker services.

## Features

- Local Agent API powered by Bun and Hono
- Web console built with Vite and React
- Desktop packaging through Electrobun
- Docker image for local or server deployment
- SQLite storage with Drizzle migrations
- Agent-facing Broker protocol documentation

## Download

Release assets are published when a `vX.Y.Z` tag is pushed.

| Target | Asset |
| --- | --- |
| macOS Apple Silicon | `stable-macos-arm64-LCAgent.dmg` |
| macOS Intel | `stable-macos-x64-LCAgent.dmg` |
| Windows x64 | `stable-win-x64-LCAgent-Setup.zip` |
| Linux x64 | `stable-linux-x64-LCAgent-Setup.tar.gz` |
| Docker | `ghcr.io/leuki/open-lc:latest` |

Docker images are built for `linux/amd64` and `linux/arm64`.

If macOS reports that LC Agent cannot be opened, remove the downloaded app quarantine attribute after installing it:

```sh
sudo xattr -r -d com.apple.quarantine /Applications/LC\ Agent.app
```

## Quick Start

### Docker

```sh
docker run --rm -p 3100:3100 -v open-lc-data:/data ghcr.io/leuki/open-lc:latest
```

The Docker image runs the Agent API and serves the built web console from the same process.

Docker Compose example:

```yaml
services:
  open-lc:
    image: ghcr.io/leuki/open-lc:latest
    container_name: open-lc
    restart: unless-stopped
    ports:
      - "3100:3100"
    volumes:
      - open-lc-data:/data

volumes:
  open-lc-data:
```

### Local Development

```sh
bun install
bun run dev:agent-api
bun run dev:agent-web
```

Defaults:

- Agent API: http://localhost:3100
- Agent Web: http://localhost:5174/#/
- SQLite database: `data/agent.sqlite`

### Desktop Development

```sh
bun run dev:agent-desktop
```

## Configuration

Agent settings can be configured from the local web console. `LC_AGENT_*` environment variables are also read as fallbacks.

Common runtime paths:

- Database: `LC_AGENT_DATABASE_URL`
- Web console build: `LC_AGENT_WEB_DIST_DIR`
- Database migrations: `LC_AGENT_MIGRATIONS_DIR`
- Net-disk transfer temporary root: `LC_AGENT_BAIDU_TEMP_DIR` (default: `/我的资源/下载`)

Do not commit real cookies, generated direct links, local SQLite files, or local environment files.

## Deploy Worker Proxy

The optional download proxy can be deployed to Cloudflare Workers or Alibaba Cloud ESA.

The Cloudflare Worker lives in `worker/` as an independent project. The shared script source is also available at `scripts/worker.js`.

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

New Worker discovery responses also declare `workerRuntime` (`cloudflare` or `esa`) and numeric `workerVersion` metadata. See `docs/WORKER_PROXY.md` for the discovery fields and version differences.

`ALLOWED_HOSTS` defaults to `*`. To restrict upstream hosts, set `ALLOWED_HOSTS` in Worker Variables to a comma-separated host list.

Alibaba Cloud ESA deploy:

ESA is generally friendlier for access from mainland China and can reduce cross-border access instability.

- Open `https://esa.console.aliyun.com/edge/pages`.
- Create an Edge Function / Edge Routine.
- Use `scripts/esa.edge.js` as the entry script.
- Change `CONFIG.URL_ENCRYPTION_KEY` at the top of the script to a strong random string.
- `ALLOWED_HOSTS` defaults to `*` and usually does not need changes.

Manual deploy:

```sh
cd worker
npm install
npx wrangler secret put URL_ENCRYPTION_KEY
npm run deploy
```

To verify v2 discovery, open:

```txt
https://your-worker.example.com/lc/v2.auto
```

It should return JSON containing `version: "v2"`, `kid: "x1"`, and `publicKey`. New Worker endpoints also return `workerRuntime`, `workerVersion`, and `maxTokenTtlSeconds`.

When using Cloudflare Git deployment, set the root directory to `worker` so only Worker deployment dependencies are installed.

## Broker Protocol

Open LC includes the public Agent-facing LC v0 Broker protocol so that third-party Broker implementations can be built without copying the official Broker service.

Start with:

- `docs/broker-protocol/README.md`
- `docs/broker-protocol/AGENT_API.md`
- `docs/broker-protocol/STATE_MACHINE.md`
- `docs/broker-protocol/ERROR_CODES.md`
- `docs/broker-protocol/POLLING_LEASE.md`

A compatible Broker must keep the Agent-facing HTTP contract and state behavior compatible. It does not need to copy the official Broker database schema, admin console, user frontend, or settlement implementation.

## LC Agent Open Platform Technical and Risk Whitepaper

To understand how LC Agent uses official open-platform APIs, what account operations are involved, and how the local Agent design reduces account and operational risk, see:

- `docs/OPEN_PLATFORM_TECH_AND_RISK_WHITEPAPER.md`

## Acknowledgements

Thanks to the [LinuxDo community](https://linux.do/) for the discussions and feedback that inspired this project.

## License

MIT License. See `LICENSE`.
