/**
 * 自主回合的工具面白名单（CT1—CT4）。
 *
 * 这一层的意义：自主回合「能做什么」从**提示词约束**变成**机制约束**。
 * 时钟会话经 `agents.create({ setup })` + `tools.restrict({ allow })` 只看见白名单，
 * 其余全局工具（pwsh / write / edit / prts_task_create …）对它不可见——
 * 模型即使被注入或判断失误，也调不到没人看着时不该调的工具。
 *
 * 判据是 fail-closed：名单漏了某个只读工具，最坏是她少一条信息；
 * 名单多了某个写工具，最坏是她真的动了手。两种错的代价不对称。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOCK_ALLOWED_TOOLS, clockToolPolicy } from '../../src/runtime/clock-tools.ts'

test('CT1 白名单：五个只读查询 + 一条提醒', () => {
  assert.deepEqual([...CLOCK_ALLOWED_TOOLS].sort(), [
    'prts_intent_create',
    'prts_intent_list',
    'prts_memory_recall',
    'prts_session_recall',
    'prts_skill_list',
    'prts_task_list',
  ])
})

test('CT2 危险工具一律不在白名单（逐一断言，不靠长度）', () => {
  const banned = [
    // DSH 内建：执行命令 / 读写文件 / 切目录——无人值守时副作用不可控
    'pwsh', 'write', 'edit', 'read', 'read_image', 'working_directory',
    // PRTS 写账本或派生会话
    'prts_task_create', 'prts_subtask',
    // 技能状态机与出站网络
    'prts_skill_adopt', 'prts_skill_evaluate', 'prts_skill_propose',
    'prts_web_fetch', 'prts_web_search',
    // 依赖冻结的本地生成 / 写档案
    'prts_memory_summarize', 'prts_session_archive',
  ]
  for (const name of banned) {
    assert.ok(
      !(CLOCK_ALLOWED_TOOLS as readonly string[]).includes(name),
      `${name} 不得出现在自主会话白名单——它属于 user 会话或 owner 通道`,
    )
  }
})

test('CT3 白名单里唯一的写是「记提醒」', () => {
  const writes = (CLOCK_ALLOWED_TOOLS as readonly string[]).filter((n) => n === 'prts_intent_create')
  assert.deepEqual(writes, ['prts_intent_create'])
})

test('CT4 PRTS_CLOCK_TOOLS=off 回退到不限制（旧行为可复现）', () => {
  assert.deepEqual(clockToolPolicy({}), { allow: [...CLOCK_ALLOWED_TOOLS] })
  assert.equal(clockToolPolicy({ PRTS_CLOCK_TOOLS: 'off' }), undefined)
  // 只有字面量 off 关闭；其他值（含空串）保持默认收紧，避免拼错就静默放开。
  assert.deepEqual(clockToolPolicy({ PRTS_CLOCK_TOOLS: '' }), { allow: [...CLOCK_ALLOWED_TOOLS] })
  assert.deepEqual(clockToolPolicy({ PRTS_CLOCK_TOOLS: 'on' }), { allow: [...CLOCK_ALLOWED_TOOLS] })
})
