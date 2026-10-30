import { raise } from './errors.ts'
import { cap } from './capability.ts'
import { normalizePath } from './paths.ts'
import type { Capability } from './types.ts'

function absFilePath(args: unknown, tool: string): string {
  if (args === null || typeof args !== 'object') {
    raise('INVALID_INPUT', `${tool}: args must be an object`)
  }
  const p = (args as { file_path?: unknown }).file_path
  if (typeof p !== 'string' || p.trim() === '') {
    raise('INVALID_INPUT', `${tool}: file_path must be a non-empty string`)
  }
  return normalizePath(p) // 非绝对路径在这里抛 INVALID_INPUT
}

/**
 * DSH rc.2 工具参数名（已核实，见 PR/AGENTS 报告）：
 * read/read_image/write/edit → file_path；pwsh → command；working_directory → 可选 cd。
 */
export function classify(tool: string, args: unknown): Capability[] {
  switch (tool) {
    case 'read':
    case 'read_image':
      return [cap.fsRead(absFilePath(args, tool))]
    case 'write':
    case 'edit':
      return [cap.fsWrite(absFilePath(args, tool))]
    case 'pwsh':
      if (args === null || typeof args !== 'object'
        || typeof (args as { command?: unknown }).command !== 'string'
        || (args as { command: string }).command.trim() === '') {
        raise('INVALID_INPUT', 'pwsh: command must be a non-empty string')
      }
      return [cap.execShell()]
    case 'working_directory':
      // 只改变会话 cwd 状态，不产生文件系统副作用（可切任意已存在目录，见报告说明）
      return []
    default:
      if (typeof tool !== 'string' || tool === '') raise('INVALID_INPUT', 'tool must be a non-empty string')
      return [cap.tool(tool)]
  }
}
