/**
 * 模型后端 profile：选择持久化 + env 翻译。
 *
 * 这些用例钉的是「选错/文件坏也不能让系统起不来」这条边界——profile 是启动路径上的
 * 读操作，它抛错等于 serve 起不来，比选错后端严重得多。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  MODEL_PROFILE_FILE,
  MODEL_PROFILES,
  listProfiles,
  profileEnv,
  readProfile,
  readProfileIfPresent,
  resolveProfile,
  writeProfile,
} from '../../src/runtime/model-profile.ts'
import { makeTmp } from '../support/tmp.ts'

test('MP1 没有 profile 文件时用默认（deepseek，1M）', () => {
  const t = makeTmp('prts-model-profile-')
  try {
    const p = readProfile(t.dir)
    assert.equal(p.id, 'deepseek')
    assert.equal(p.contextWindow, 1_000_000)
  } finally { t.cleanup() }
})

test('MP2 坏 JSON / 未知 id 一律回落默认，不抛', () => {
  const t = makeTmp('prts-model-profile-')
  try {
    writeFileSync(join(t.dir, MODEL_PROFILE_FILE), '{ not json', 'utf8')
    assert.equal(readProfile(t.dir).id, 'deepseek', '坏 JSON 应回落默认而不是抛')

    writeFileSync(join(t.dir, MODEL_PROFILE_FILE), JSON.stringify({ profile: 'nope' }), 'utf8')
    assert.equal(readProfile(t.dir).id, 'deepseek', '未知 id 应回落默认')
  } finally { t.cleanup() }
})

test('MP3 写入后读回同一个预设（strata）', () => {
  const t = makeTmp('prts-model-profile-')
  try {
    const written = writeProfile(t.dir, 'strata')
    assert.equal(written.id, 'strata')
    assert.equal(written.baseUrl, 'http://127.0.0.1:8080')
    assert.equal(written.model, 'qwen3.8-flash-next-iq3_xxs')
    assert.equal(readProfile(t.dir).id, 'strata')
  } finally { t.cleanup() }
})

test('MP4 写入非法 id 抛错（写入路径要大声失败）', () => {
  const t = makeTmp('prts-model-profile-')
  try {
    assert.throws(() => writeProfile(t.dir, 'llama'), /未知的模型预设/)
    assert.throws(() => writeProfile(t.dir, 42), /未知的模型预设/)
  } finally { t.cleanup() }
})

test('MP5 contextWindow 可在 profile 文件里覆盖（以实测为准）', () => {
  const t = makeTmp('prts-model-profile-')
  try {
    writeProfile(t.dir, 'strata', 32_768)
    assert.equal(readProfile(t.dir).contextWindow, 32_768, '覆盖值应生效')

    // 非法的窗口值被忽略，回落预设默认——不能变成 0（0 会让装配预算归零）
    writeFileSync(join(t.dir, MODEL_PROFILE_FILE), JSON.stringify({ profile: 'strata', contextWindow: 0 }), 'utf8')
    assert.equal(readProfile(t.dir).contextWindow, 262_144)
    writeFileSync(join(t.dir, MODEL_PROFILE_FILE), JSON.stringify({ profile: 'strata', contextWindow: -5 }), 'utf8')
    assert.equal(readProfile(t.dir).contextWindow, 262_144)
  } finally { t.cleanup() }
})

test('MP6 写入非法 contextWindow 抛错', () => {
  const t = makeTmp('prts-model-profile-')
  try {
    assert.throws(() => writeProfile(t.dir, 'strata', 0), /上下文窗口必须是正整数/)
    assert.throws(() => writeProfile(t.dir, 'strata', Number.NaN), /上下文窗口必须是正整数/)
  } finally { t.cleanup() }
})

test('MP7 profileEnv：官方清空本地专属变量，本地设齐四个', () => {
  const t = makeTmp('prts-model-profile-')
  try {
    mkdirSync(t.dir, { recursive: true })
    const official = profileEnv(resolveProfile('deepseek'))
    assert.equal(official.DEEPSEEK_BASE_URL, undefined, '官方必须清掉 baseURL，否则切回时会残留本地端点')
    assert.ok(
      !('DEEPSEEK_API_KEY' in official),
      '官方预设不得出现在 key 变更里——用户手动 export 的 key 不该被一个预设选择清掉',
    )
    assert.equal(official.PRTS_LLM_MODEL, undefined, '官方用适配器默认模型名')
    assert.equal(official.DSH_CONTEXT_WINDOW, '1000000')

    const local = profileEnv(resolveProfile('strata'))
    assert.equal(local.DEEPSEEK_BASE_URL, 'http://127.0.0.1:8080')
    assert.equal(local.DEEPSEEK_API_KEY, 'strata-local')
    assert.equal(local.PRTS_LLM_MODEL, 'qwen3.8-flash-next-iq3_xxs')
    assert.equal(local.DSH_CONTEXT_WINDOW, '262144')
  } finally { t.cleanup() }
})

test('MP8 预设清单稳定（两个，id 不重复）', () => {
  const ids = listProfiles().map((p) => p.id)
  assert.deepEqual(ids, ['deepseek', 'strata'])
  assert.equal(MODEL_PROFILES.length, 2)
})

test('MP9 readProfileIfPresent：文件不存在返回 undefined（不接管 env）', () => {
  // 这条保证手动启动（`DEEPSEEK_BASE_URL=... node src/cli/chat-serve.ts`）不会被
  // 默认预设默默覆盖。端到端已用真 serve 验过：无 profile 文件时启动日志不打模型行。
  const t = makeTmp('prts-model-profile-')
  try {
    assert.equal(readProfileIfPresent(t.dir), undefined, '没有 profile 文件时不得接管环境变量')
    writeProfile(t.dir, 'strata')
    assert.equal(readProfileIfPresent(t.dir)?.id, 'strata', '文件存在时应返回选择')
  } finally { t.cleanup() }
})
