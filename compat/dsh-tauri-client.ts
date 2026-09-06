/**
 * compat/dsh-tauri-client.ts — 独立发布仓库的 `dsh-tauri/client` 垫片。
 *
 * 桌面开发仓库里这些能力由 dsh-tauri/client（workspace 包，0.10.x）提供；
 * npm 上的 dsh-tauri@0.6.7 的 client.cjs 是 ModuleLoader 浏览器脚本（首行
 * 即 window），Node 下的 typecheck/测试无法 import。本垫片只覆盖 src/client
 * 在模块加载与单测中触达的面：CssRender（真实 css-render）、compat（恒等，
 * apply() 不在单测中执行）、createLifecycleController（与桌面实现同构）。
 * 桌面运行时仍使用注入的真实模块，本文件不参与构建产物（tsdown 的
 * external 列表保持 dsh-tauri/client 不变）。
 */

import type { Context } from '@deepseek-ai/cordis'
// 触发 @deepseek-ai/dsh-client-runtime 的类型加载：它的 .d.ts 对 cordis
// Context 做了 slots 增强（command-view 的 ctx.slots 依赖）。type-only，
// 运行时零开销。
import type {} from '@deepseek-ai/dsh-client-runtime'
// 垫片面向独立编译/测试，宽松 any 是有意的（严格类型在桌面仓库）。

import CssRender from 'css-render'

import { createHooks } from 'hookable'

// import type {} 会被 TS 整体擦除（增强不生效），这里显式声明 command-view
// 实际用到的 slots 面；桌面运行时提供真实实现。
declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      inject: (name: string, factory: () => unknown) => () => void
      register: (options: Record<string, unknown>, component: unknown) => unknown
    }
  }
}

export { CssRender }

/** 运行时形状适配（桌面版做更细的字段桥接；单测不执行 apply，恒等即可）。 */
export function compat<T extends object>(ctx: T): T {
  return ctx
}

/** 受控生命周期（与桌面 dsh-tauri/src/client/controller 同构的最小实现）。 */
export interface LifecycleHooks {
  dispose: () => void
}

export interface LifecycleController {
  add: (disposer: () => void) => void
  timeout: (fn: () => void, ms: number) => () => void
  interval: (fn: () => void, ms: number) => () => void
  listen: <K extends keyof DocumentEventMap>(
    type: K,
    fn: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => () => void
  observe: (target: Node, options: MutationObserverInit, onMutate: () => void) => MutationObserver
  isDisposed: () => boolean
  dispose: () => void
}

export function createLifecycleController(): LifecycleController {
  const hooks = createHooks<LifecycleHooks>()
  let disposedState = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const intervals = new Set<ReturnType<typeof setInterval>>()
  const observers = new Set<MutationObserver>()
  const removes = new Set<() => void>()

  const api: LifecycleController = {
    add(disposer) {
      if (disposedState)
        return
      hooks.hook('dispose', disposer)
    },
    timeout(fn, ms) {
      if (disposedState)
        return () => {}
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!disposedState)
          fn()
      }, ms)
      timers.add(timer)
      return () => {
        timers.delete(timer)
        clearTimeout(timer)
      }
    },
    interval(fn, ms) {
      if (disposedState)
        return () => {}
      const timer = setInterval(() => {
        if (!disposedState)
          fn()
      }, ms)
      intervals.add(timer)
      return () => {
        intervals.delete(timer)
        clearInterval(timer)
      }
    },
    listen(type, fn, options = {}) {
      const handler = fn as EventListener
      document.addEventListener(type, handler, options)
      const remove = () => {
        document.removeEventListener(type, handler, options)
        removes.delete(remove)
      }
      removes.add(remove)
      return remove
    },
    observe(target, options, onMutate) {
      const observer = new MutationObserver(() => {
        if (!disposedState)
          onMutate()
      })
      observer.observe(target, options)
      observers.add(observer)
      return observer
    },
    isDisposed() {
      return disposedState
    },
    dispose() {
      if (disposedState)
        return
      disposedState = true
      for (const timer of timers)
        clearTimeout(timer)
      timers.clear()
      for (const timer of intervals)
        clearInterval(timer)
      intervals.clear()
      for (const observer of observers)
        observer.disconnect()
      observers.clear()
      for (const remove of removes) {
        try {
          remove()
        }
        catch {
          /* 监听已由目标主动移除时忽略 */
        }
      }
      removes.clear()
      void hooks.callHook('dispose')
      hooks.removeAllHooks()
    },
  }
  return api
}

/**
 * 客户端上下文形状：扩展 cordis Context（registerCommandView 等签名按
 * Context 接收），effect/sessions/locale 等由桌面运行时注入，单测不执行
 * apply——保持宽松索引以独立可编译；严格类型在桌面开发仓库的 ClientContext。
 */
export interface ClientContext extends Omit<Context, 'effect'> {
  effect: (factory: (...args: any[]) => unknown, label?: string) => any
  [key: string]: any
}
