#!/usr/bin/env node
// Sync plugin sources from the desktop development checkout into this
// publishing repo. Repo-only files (LICENSE, CI, this script, package.json
// repo fields) are never touched.
//
// Usage: node scripts/sync.mjs <path-to-desktop-checkout>
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const devRoot = resolve(process.argv[2] ?? '.')
const pluginRoot = join(devRoot, 'plugins', 'dsh-tauri-turnrewind')
if (!existsSync(join(pluginRoot, 'package.json'))) {
  console.error(`plugin not found under ${pluginRoot}`)
  process.exit(1)
}

// Copied wholesale from the dev checkout.
const trees = ['lib', 'test']
const files = ['cordis.patch.yml', 'vitest.config.js', 'README.md']
for (const tree of trees)
  cpSync(join(pluginRoot, tree), join(process.cwd(), tree), { recursive: true })
for (const file of files)
  cpSync(join(pluginRoot, file), join(process.cwd(), file))

// package.json: take the dev manifest, keep this repo's publishing fields.
// Keys are emitted in the order the repo's jsonc/sort-keys rule expects,
// otherwise CI lint fails on every sync.
const dev = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
const repoManifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
const merged = { ...dev, ...repoManifest }
const keyOrder = [
  'name',
  'type',
  'version',
  'description',
  'license',
  'repository',
  'keywords',
  'exports',
  'main',
  'files',
  'dsh',
  'engines',
  'scripts',
  'devDependencies',
]
const ordered = {}
for (const key of keyOrder) {
  if (merged[key] !== undefined)
    ordered[key] = merged[key]
}
for (const [key, value] of Object.entries(merged)) {
  if (ordered[key] === undefined)
    ordered[key] = value
}
writeFileSync(join(process.cwd(), 'package.json'), `${JSON.stringify(ordered, null, 2)}\n`)

console.log('synced from', pluginRoot)
console.log('next: pnpm lint && pnpm test, then bump version and push')
