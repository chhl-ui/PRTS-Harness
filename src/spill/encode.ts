/**
 * 把一个任意字符串编码成**单个安全路径段**。
 *
 * 映射是注入式的：不同输入编码后一定不同，因此可以安全地拿会话 id 或
 * 调用方建议的文件名当路径成分。规则：
 *
 * - `[A-Za-z0-9._-]` 里除 `~` 之外的字符原样保留；
 * - 其余每个 UTF-16 码元转义成 `~XXXX`（大写十六进制，定长 4）；
 * - `~` 自身也转义，所以映射可逆、不会与转义序列碰撞；
 * - 整个字符串恰为 `.` 或 `..` 时也转义，避免构成穿越；
 * - 空串编码成 `~`，永不产生空路径段。
 *
 * 于是 `../x` 里的 `/`、`C:\` 里的 `:` 与 `\`、NUL、中文、代理对全部被中和。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}
