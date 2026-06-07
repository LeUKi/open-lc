#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]?.trim()

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: bun run scripts/inject-open-lc-version.js <X.Y.Z>')
  process.exit(1)
}

const versionFiles = [
  {
    path: 'package.json',
    replacements: [
      { from: '"version": "0.0.0"', to: `"version": "${version}"` },
    ],
  },
  {
    path: 'agent/api/package.json',
    replacements: [
      { from: '"version": "0.0.0"', to: `"version": "${version}"` },
    ],
  },
  {
    path: 'agent/web/package.json',
    replacements: [
      { from: '"version": "0.0.0"', to: `"version": "${version}"` },
    ],
  },
  {
    path: 'agent/electrobun/package.json',
    replacements: [
      { from: '"version": "0.0.0"', to: `"version": "${version}"` },
    ],
  },
  {
    path: 'agent/api/src/version.ts',
    replacements: [
      { from: "agentVersion = '0.0.0'", to: `agentVersion = '${version}'` },
    ],
  },
  {
    path: 'agent/web/src/version.ts',
    replacements: [
      { from: "agentVersion = '0.0.0'", to: `agentVersion = '${version}'` },
    ],
  },
  {
    path: 'agent/electrobun/electrobun.config.ts',
    replacements: [
      { from: "version: '0.0.0'", to: `version: '${version}'` },
    ],
  },
  {
    path: 'docs/broker-protocol/AGENT_API.md',
    replacements: [
      { from: '"client_version": "0.0.0"', to: `"client_version": "${version}"` },
    ],
  },
]

for (const file of versionFiles) {
  const filePath = join(repoRoot, file.path)
  let content = readFileSync(filePath, 'utf8')
  for (const replacement of file.replacements) {
    if (!content.includes(replacement.from)) {
      throw new Error(`${file.path} does not contain expected version placeholder: ${replacement.from}`)
    }
    content = content.replace(replacement.from, replacement.to)
  }
  writeFileSync(filePath, content)
}

console.log(`Injected Open LC version ${version}`)
