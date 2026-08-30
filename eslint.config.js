// ESLint 扁平配置：基于 @antfu/eslint-config 预设（与桌面主仓库同一套规则，
// 保证两处的插件代码风格一致）。插件为纯 JS ESM，无 TS/React 编译层。
import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: [
    'node_modules',
    'coverage',
  ],
})
