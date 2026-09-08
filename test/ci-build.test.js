import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Regression: `CI=true tsdown` used to exit 1 with
// "ERROR We recommend using the ESM format instead of CommonJS" because tsdown
// inferred target node22.15.0 from this package's `engines.node` and its default
// `failOnWarn: 'ci-only'` escalated warnLegacyCJS into a CI failure. The client
// half pins an explicit es2022 target (see tsdown.config.ts); this test guards
// the whole contract: CI mode must build cleanly, the legacy-CJS notice must be
// gone at the source, and dist/client.cjs (the DSH ModuleLoader CJS contract)
// must still be produced.
const pkgDir = resolve(import.meta.dirname, '..')
const tsdownCli = resolve(pkgDir, 'node_modules/tsdown/dist/run.mjs')

describe('cI build (tsdown failOnWarn: ci-only)', () => {
  it('builds with CI=true without the legacy-CJS error and keeps client.cjs', () => {
    const result = spawnSync(process.execPath, [tsdownCli], {
      cwd: pkgDir,
      env: { ...process.env, CI: 'true' },
      encoding: 'utf8',
      timeout: 90_000,
      windowsHide: true,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('We recommend using the ESM format')
    expect(result.stdout).toContain('Build complete')
    expect(existsSync(resolve(pkgDir, 'dist/client.cjs'))).toBe(true)
  }, 120_000)
})
