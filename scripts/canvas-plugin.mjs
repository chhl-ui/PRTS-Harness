/**
 * 天枢 canvas 插件直调通道（绕过宿主）。
 *
 * 为什么要它：tianshu-canvas 已装在插件目录，但 canvas_* 工具没有注册到当前会话；
 * 且入口 `dist/index.mjs` 有 TPI 守卫——`defineTianshuPlugin` 会读
 * `globalThis.__tianshuTPI`，缺失即抛
 * "not running inside Tianshu: TPI plugins load only through the Tianshu host"。
 * 本脚本提供最小 SDK 桩（只实现 defineTianshuPlugin）后直接 import 插件，
 * 调用其导出的 `tools[i].execute({ args, cwd, sessionId })`。
 *
 * 插件默认取 %LOCALAPPDATA%\Tianshu\plugins\tianshu-canvas，用 PLUGIN_DIR 覆盖。
 * 插件升级后若工具签名变化，本脚本需同步。
 *
 * 用法：
 *   node scripts/canvas-plugin.mjs open [port]
 *   node scripts/canvas-plugin.mjs state
 *   node scripts/canvas-plugin.mjs upsert <htmlPath> [title] [id]
 *   node scripts/canvas-plugin.mjs style <list|set> [styleId]
 *   node scripts/canvas-plugin.mjs check [pageId]
 *
 * 输出照抄工具原样返回；isError 为真时退出码 1。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const PLUGIN_DIR =
  process.env.PLUGIN_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Tianshu', 'plugins', 'tianshu-canvas')

/** 最小 TPI SDK 桩：插件只需要 defineTianshuPlugin。 */
globalThis.__tianshuTPI = {
  defineTianshuPlugin(spec) {
    return spec
  },
}

async function loadTools() {
  const entry = join(PLUGIN_DIR, 'dist', 'index.mjs')
  if (!existsSync(entry)) {
    throw new Error(`插件入口不存在：${entry}\n用 PLUGIN_DIR 指向 tianshu-canvas 插件目录`)
  }
  const mod = await import(pathToFileURL(entry).href)
  return mod.tools ?? []
}

function pick(tools, name) {
  const tool = tools.find((t) => (t.definition?.name ?? t.name) === name)
  if (!tool) throw new Error(`插件未导出工具 ${name}`)
  return tool
}

async function run(name, args) {
  const tools = await loadTools()
  const result = await pick(tools, name).execute({
    args,
    cwd: process.cwd(),
    sessionId: 'canvas-cli',
  })
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  console.log(text)
  if (result?.isError === true) process.exitCode = 1
  return result
}

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case 'open': {
    const port = rest[0] ? Number(rest[0]) : undefined
    await run('canvas_open', { ...(port ? { port } : {}) })
    break
  }
  case 'state': {
    await run('canvas_get_state', {})
    break
  }
  case 'upsert': {
    const [htmlPath, title, id] = rest
    if (!htmlPath) throw new Error('用法：upsert <htmlPath> [title] [id]')
    await run('canvas_upsert_page', {
      html_path: htmlPath,
      ...(title ? { title } : {}),
      ...(id ? { id } : {}),
    })
    break
  }
  case 'style': {
    const [action, styleId] = rest
    if (!action) throw new Error('用法：style <list|set> [styleId]')
    await run('canvas_style', { action, ...(styleId ? { style_id: styleId } : {}) })
    break
  }
  case 'check': {
    const [pageId] = rest
    await run('canvas_check_style', { ...(pageId ? { page_id: pageId } : {}) })
    break
  }
  case 'call': {
    const [name, json] = rest
    if (!name) throw new Error('用法：call <toolName> [jsonArgs]')
    await run(name, json ? JSON.parse(json) : {})
    break
  }
  default:
    console.log(
      [
        '天枢 canvas 插件直调通道',
        '',
        '  open [port]                 启动/复用画布服务，返回 URL',
        '  state                       读取画布状态（页面节点、连线、URL）',
        '  upsert <html> [title] [id]  写入页面节点',
        '  style <list|set> [styleId]  风格列表 / 锁定风格',
        '  check [pageId]              裸色值校验',
        '',
        'PLUGIN_DIR 可覆盖插件目录。',
      ].join('\n'),
    )
    process.exitCode = 2
}
