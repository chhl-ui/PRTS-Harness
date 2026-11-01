/**
 * 记忆模块：最小时间解析器。
 *
 * 设计稿 §6.3 要求「原始串与解析值双存」——解析失败时调用方保留 `occurred_raw`，
 * 只是 `occurred_at_ms` 为 null。**不做自然语言时间解析**：那是另一个模块，
 * 且猜错会污染双时间。
 *
 * 支持的形态全部来自**实测**，不是猜的：
 * - LoCoMo `locomo10.json` 的 `session_N_date_time`：`"1:56 pm on 8 May, 2023"`
 * - LongMemEval `longmemeval_oracle.json` 的 `haystack_dates`：`"2023/04/10 (Mon) 17:50"`
 *
 * 第二种是 2026-11-01 用真实数据导入时才发现的——首轮 `unparsedTime` 是 948/948，
 * fixture 里的假设格式与真实数据不一致。
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

function utcValid(y: number, m: number, d: number): boolean {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false
  if (m < 0 || m > 11 || d < 1 || d > 31) return false
  // 排除 "2023-02-31" 这类：回读一次看是否回绕
  const dt = new Date(Date.UTC(y, m, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d
}

/**
 * 解析为 UTC 毫秒。解析不了返回 `null`——**不抛错，不猜**。
 */
export function parseTime(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null

  // 1. ISO 8601：2023-05-08 / 2023-05-08T13:56:00Z / 2023-05-08T13:56:00(+08:00)
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s)
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]) - 1, d = Number(iso[3])
    if (!utcValid(y, m, d)) return null
    let ms = Date.UTC(y, m, d, Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0))
    const tz = iso[7]
    if (tz && tz !== 'Z') {
      const sign = tz.startsWith('-') ? -1 : 1
      const digits = tz.slice(1).replace(':', '')
      const hh = Number(digits.slice(0, 2))
      const mm = Number(digits.slice(2, 4) || 0)
      ms -= sign * (hh * 60 + mm) * 60_000
    }
    return ms
  }

  // 2. "<h>:<mm> <am|pm> on <D> <Mon>, <YYYY>" —— LoCoMo 的实际形态
  const locomo = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i.exec(s)
  if (locomo) {
    const month = MONTHS[locomo[5].toLowerCase()]
    if (month === undefined) return null
    const y = Number(locomo[6]), d = Number(locomo[4])
    if (!utcValid(y, month, d)) return null
    let hour = Number(locomo[1]) % 12
    if (locomo[3].toLowerCase() === 'pm') hour += 12
    return Date.UTC(y, month, d, hour, Number(locomo[2]))
  }

  // 3. "<YYYY>/<MM>/<DD> (Day) <HH>:<mm>" —— LongMemEval 的 haystack_dates
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*\([^)]*\))?\s*(\d{1,2}):(\d{2})$/.exec(s)
  if (slash) {
    const y = Number(slash[1]), m = Number(slash[2]) - 1, d = Number(slash[3])
    if (!utcValid(y, m, d)) return null
    return Date.UTC(y, m, d, Number(slash[4]), Number(slash[5]))
  }

  // 4. "<D> <Mon> <YYYY>"
  const dmy = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s)
  if (dmy) {
    const month = MONTHS[dmy[2].toLowerCase()]
    if (month === undefined) return null
    const y = Number(dmy[3]), d = Number(dmy[1])
    if (!utcValid(y, month, d)) return null
    return Date.UTC(y, month, d)
  }

  // 5. "<Mon> <D>, <YYYY>"
  const mdy = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase()]
    if (month === undefined) return null
    const y = Number(mdy[3]), d = Number(mdy[2])
    if (!utcValid(y, month, d)) return null
    return Date.UTC(y, month, d)
  }

  return null
}
