/**
 * 天枢 design 插件直调通道（绕过宿主）。
 *
 * 为什么要它：天枢宿主进程加载插件时，插件里的 bare specifier
 * （`import('puppeteer-core')` / `pngjs`）解析不到插件目录的 node_modules，
 * 四个 ui_* 工具经宿主调用一律报「依赖缺失」。而插件目录的依赖是齐的：
 * 系统 node v24.19.0 与天枢运行时 v24.22.1 在该目录下 import 均成功，
 * 直接 import impl.js 调 tools[i].execute 四个工具也全部正常。
 * 本脚本走同一份实现，只是绕开宿主的模块解析。
 *
 * 插件默认取 %LOCALAPPDATA%\Tianshu\plugins\design，用 PLUGIN_DIR 覆盖。
 * 插件升级后若工具签名变化，本脚本需同步。
 *
 * 用法：
 *   node scripts/design-plugin.mjs preview <input.html> [outputDir]
 *   node scripts/design-plugin.mjs audit   <input.html> [outputDir]
 *   node scripts/design-plugin.mjs palette <image.png> [maxColors]
 *   node scripts/design-plugin.mjs diff    <reference.png> <actual.png> [output.png]
 *
 * 输出照抄工具原样返回的 content；isError 为真时退出码 1。
 */
import { pathToFileURL } from 'node:url'
import { join, dirname, basename, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const PLUGIN_DIR =
  process.env.PLUGIN_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Tianshu', 'plugins', 'design')

async function loadTools() {
  const entry = join(PLUGIN_DIR, 'impl.js')
  if (!existsSync(entry)) {
    throw new Error(`插件入口不存在：${entry}\n用 PLUGIN_DIR 指向 tianshu-design 插件目录`)
  }
  const mod = await import(pathToFileURL(entry).href)
  return mod.tools ?? []
}

function pick(tools, name) {
  const tool = tools.find((t) => t.definition?.name === name)
  if (!tool) throw new Error(`插件未导出工具 ${name}`)
  return tool
}

/** 默认输出目录与输入同级的 <name>-out，避免写进只读位。 */
function defaultOut(input) {
  return join(dirname(resolve(input)), `${basename(input).replace(/\.[^.]+$/, '')}-out`)
}

async function run(name, params) {
  const tools = await loadTools()
  const result = await pick(tools, name).execute(params)
  console.log(result.content)
  if (result.isError === true) process.exitCode = 1
}

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case 'preview': {
    const [input, out] = rest
    if (!input) throw new Error('用法：preview <input.html> [outputDir]')
    await run('ui_preview', { file_path: input, output_path: out ?? defaultOut(input), viewports: ['mobile', 'tablet', 'desktop'] })
    break
  }
  case 'audit': {
    const [input, out] = rest
    if (!input) throw new Error('用法：audit <input.html> [outputDir]')
    await run('ui_responsive_audit', { file_path: input, output_path: out ?? defaultOut(input) })
    break
  }
  case 'palette': {
    const [input, max] = rest
    if (!input) throw new Error('用法：palette <image.png> [maxColors]')
    await run('ui_palette', { file_path: input, max_colors: max ? Number(max) : 8 })
    break
  }
  case 'diff': {
    const [ref, actual, out] = rest
    if (!ref || !actual) throw new Error('用法：diff <reference.png> <actual.png> [output.png]')
    await run('ui_diff', { reference_path: ref, actual_path: actual, output_path: out })
    break
  }
  default:
    console.log(
      [
        '天枢 design 插件直调通道',
        '',
        '  preview <input.html> [outputDir]      三视口截图（mobile/tablet/desktop）',
        '  audit   <input.html> [outputDir]      响应式审计（溢出/小目标/小字体）',
        '  palette <image.png> [maxColors]       主色提取 → CSS/Tailwind 令牌',
        '  diff    <ref.png> <actual.png> [out]  像素级比对',
        '',
        'PLUGIN_DIR 可覆盖插件目录。',
      ].join('\n'),
    )
    process.exitCode = 2
}
