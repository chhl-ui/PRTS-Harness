import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { raise } from './errors.ts'

const IS_WIN = process.platform === 'win32'

/**
 * 规范化绝对路径：resolve 掉 ./..、统一分隔符、去末尾分隔符（盘符根目录除外）。
 * 非绝对路径 → INVALID_INPUT。返回原始大小写形式；比较用 compareKey。
 */
export function normalizePath(p: string): string {
  let raw = p
  if (IS_WIN && typeof raw === 'string') {
    // 先去掉 \\?\ 与 \\?\UNC\ 前缀（Win32 命名空间别名）
    if (raw.startsWith('\\\\?\\UNC\\')) raw = '\\\\' + raw.slice('\\\\?\\UNC\\'.length)
    else if (raw.startsWith('\\\\?\\')) raw = raw.slice('\\\\?\\'.length)
  }
  if (typeof raw !== 'string' || !isAbsolute(raw)) {
    raise('INVALID_INPUT', `path must be absolute: ${String(p)}`)
  }
  let n = normalize(resolve(raw))
  if (IS_WIN) {
    // Win32 会裁掉路径段末尾的 . 与空格：C:\data.\x == C:\data \x == C:\data\x
    // 逐段剥离防止别名绕过 protectedRoot 判定；纯 . / .. 段已由 resolve 消掉
    n = n.split('\\').map((seg, i) => {
      if (i === 0) return seg // 盘符
      const s = seg.replace(/[. ]+$/, '')
      return s === '' ? seg : s
    }).join('\\')
  }
  // 去掉末尾分隔符，但保留盘符/UNC 根（'C:\'、'\\'）
  const root = isWinRoot(n)
  while (!root && n.length > 1 && (n.endsWith('\\') || n.endsWith('/'))) {
    n = n.slice(0, -1)
  }
  return n
}

function isWinRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(p) || p === '\\\\' || p === sep
}

/** 比较键：Windows 下大小写不敏感；POSIX 保原样。 */
function compareKey(p: string): string {
  return IS_WIN ? p.toLowerCase() : p
}

/**
 * 尽力取真实路径：存在则 realpath；不存在则对最近存在的父目录取 realpath 再拼回。
 * 防止借 junction/符号链接逃出授予范围。
 */
/** realpathSync.native 在 Windows 上可能返回 \\?\C:\ 形式，去掉该前缀再归一。 */
function stripUncPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice('\\\\?\\UNC\\'.length)
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length)
  return p
}

export function realpathBestEffort(p: string): string {
  const norm = normalizePath(p)
  if (existsSync(norm)) {
    try {
      return normalizePath(stripUncPrefix(realpathSync.native(norm)))
    } catch { /* 落到下面父目录路径 */ }
  }
  // 逐层向上找存在的祖先
  const missing: string[] = []
  let cur = norm
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return norm // 连根都不存在，返回规范化原值
    missing.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ''))
    cur = parent
    if (existsSync(cur)) {
      let base: string
      try {
        base = normalizePath(stripUncPrefix(realpathSync.native(cur)))
      } catch {
        base = cur
      }
      return normalizePath(join(base, ...missing))
    }
  }
}

/** 段边界判断：child 在 root 内或等于 root 时 true。 */
export function isWithin(child: string, root: string): boolean {
  const c = compareKey(normalizePath(child))
  const r = compareKey(normalizePath(root))
  if (c === r) return true
  const rootWithSep = r.endsWith('\\') || r.endsWith('/') ? r : r + sep
  return c.startsWith(rootWithSep)
}
