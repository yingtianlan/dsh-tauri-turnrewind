# AGENTS.md

## 项目概览

`dsh-tauri-turnrewind` 是 DeepSeek Harness（dsh）的 turn 级工作区撤销插件，采用
host half / client half 架构：

- `lib/index.js`：宿主侧入口（cordis 插件）——turn 快照、pending plan、`/undo`
  命令、`/api/turnrewind/*` HTTP 路由、会话投影注册。
- `lib/client.js`：浏览器侧入口（`window.__ModuleLoader__.load` 手写包装）——
  不可用弹窗 + `/undo` 卡片的红绿 diff 渲染与 ✓/✗ 按钮。
- `lib/core/`：纯逻辑模块（git-snapshot 快照、ledger 账本、guard 守卫、
  dialog-projection 投影单元、planner、maintenance）。
- `lib/purge-workspace.js`：按工作区清理快照仓库与账本记录的维护 CLI。
- `test/`：vitest 测试；`pnpm test` 运行。

## 硬性约定

- 纯 JS ESM，无构建步骤；`lib/` 即发布物（package.json `files` 限定）。
- 宿主侧注释用中文（`//!` 模块头、`///` 函数），client.js 面向浏览器保持英文。
- 错误信息统一大写前缀：`TURNREWIND_*`。
- client 模块 id 必须归一化为包名（模块系统剥 `/client` 后缀）；启动清单按包名
  import，**不要注册第二个顶层模块**——插件多能力合并进同一 factory 的 apply()。
- 金额敏感操作（确认执行）必须：先校验 pending plan 状态/过期/冲突，失败可回滚
  （pre-operation snapshot），并回写 plan 状态供卡片轮询。
- 快照操作禁止触碰用户项目的 HEAD、分支、index、stash、提交历史。

## 开发流

- 功能开发在桌面主仓库 checkout（link: 安装、真机验证）。
- `node scripts/sync.mjs <桌面仓库路径>` 把 lib/test/README 等同步进本仓库；
  package.json 的 version/repository/devDependencies 以本仓库为准不被覆盖。
- 发布：`pnpm lint && pnpm test` 通过 → 升版本 → tag `v<version>` → push。

## 已知边界（发布时如实声明）

- 容量治理/GC 未做（快照仓库长期增长；purge-workspace 可手动清）。
- mutation 路由仅接受 loopback 调用：远程浏览器只能手动输入确认命令。
- 家目录/盘根/超预算工作区一律拒绝快照（`TURNREWIND_MAX_FILES` /
  `TURNREWIND_MAX_BYTES` 可调）。
