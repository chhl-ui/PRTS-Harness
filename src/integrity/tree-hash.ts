import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { IntegrityError } from './errors.ts'

/**
 * 目录树的确定性哈希：递归全部普通文件（含嵌套 node_modules），
 * 相对路径以 / 分隔按 JS 默认字符串比较排序，
 * sha256(对每个文件拼接 relpath + '\0' + sha256hex(内容) + '\n')。
 * 与 mtime、遍历顺序无关。符号链接/junction → LINK_IN_TREE，不跟随。
 */
export function treeHash(dir: string): string {
  const files: string[] = []
  const walk = (rel: string) => {
    const abs = rel === '' ? dir : join(dir, rel)
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`
      const st = lstatSync(join(dir, childRel))
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
        throw new IntegrityError('LINK_IN_TREE', `${dir}/${childRel}`)
      }
      if (st.isDirectory()) walk(childRel)
      else files.push(childRel)
    }
  }
  walk('')
  files.sort()
  const h = createHash('sha256')
  for (const rel of files) {
    const content = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex')
    h.update(rel).update('\0').update(content).update('\n')
  }
  return h.digest('hex')
}
