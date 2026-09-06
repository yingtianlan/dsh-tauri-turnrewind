import assert from 'node:assert/strict'
import { CssRender } from 'dsh-tauri/client'
import { it } from 'vitest'
import { buildDialogStyleNodes } from '../src/client/styles'
import { buildCommandViewStyleNodes } from '../src/client/styles/command-view'

/** css-render 不给数字补 px：裸数字会生成非法声明并被浏览器静默丢弃。 */
const UNITLESS = new Set([
  'flex',
  'opacity',
  'font-weight',
  'line-height',
  'z-index',
  'order',
  'zoom',
  'min-width',
  'column-count',
  'inset',
])

function assertNoBareNumbers(css, label) {
  for (const match of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const prop = match[1]
    const value = match[2].trim()
    if (UNITLESS.has(prop))
      continue
    assert.doesNotMatch(
      value,
      /^\d+(\.\d+)?$/,
      `${label}: ${prop}: ${value} is a bare number — css-render will not append px and the browser drops the declaration`,
    )
  }
}

it('renders command-view styles with explicit px units', () => {
  const css = buildCommandViewStyleNodes(CssRender()).render()
  assertNoBareNumbers(css, 'command-view')
  // The dimensional properties that silently failed before the fix.
  assert.match(css, /gap:\s*8px/u)
  assert.match(css, /border-radius:\s*10px/u)
  assert.match(css, /font-size:\s*12px/u)
  assert.match(css, /max-height:\s*260px/u)
  // Hint text stays high-contrast across themes (black on light, white on dark).
  assert.match(css, /\.dsh-turnrewind-card-hint\s*\{[^}]*--dsw-alias-label-primary/u)
})

it('renders dialog styles with explicit px units', () => {
  const css = buildDialogStyleNodes(CssRender()).render()
  assertNoBareNumbers(css, 'dialog')
  assert.match(css, /border-radius:\s*12px/u)
  assert.match(css, /max-height:\s*160px/u)
})
