// Agent 观察台 — 共用小工具（只用 node: 内置模块）
//
// 这里只放跨 agent 复用的东西：路径常量、JSONL 读取（含大文件尾部读取）、
// DSH 会话的多段 zstd 解压、文本截断、时间格式化。

import { closeSync, openSync, readFileSync, readSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

/** 提醒配置/状态文件目录（~/.cache/dsh-agent-observer）。 */
export const CACHE_DIR = path.join(homedir(), '.cache', 'dsh-agent-observer')

/** 带 code 的插件内错误，路由层据此返回 {ok:false,error:{code,message}}。 */
export class ObserverError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ObserverError'
    this.code = code
  }
}

export function nowIso() {
  return new Date().toISOString()
}

export function statOrNull(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}

/** readdirSync withFileTypes 的安全版：目录不存在/无权限时返回 []。 */
export function readdirOrEmpty(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 读文件的一段（不移动文件指针之外的副作用）。 */
export function readRange(file, offset, length) {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, length))
    const read = readSync(fd, buffer, 0, buffer.length, offset)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * 只读文件尾部 maxBytes 字节，并丢掉可能被截断的第一行。
 * 用于几十 MB 的 Codex rollout 与几 MB 的 Claude transcript。
 */
export function readTailText(file, maxBytes) {
  const stat = statOrNull(file)
  if (!stat) return ''
  if (stat.size <= maxBytes) return readFileSync(file, 'utf8')
  const text = readRange(file, stat.size - maxBytes, maxBytes).toString('utf8')
  const newline = text.indexOf('\n')
  return newline === -1 ? '' : text.slice(newline + 1)
}

/** 只读文件头部 maxBytes 字节，调用方可选择丢掉最后一行（可能被截断）。 */
export function readHeadText(file, maxBytes) {
  const stat = statOrNull(file)
  if (!stat) return ''
  if (stat.size <= maxBytes) return readFileSync(file, 'utf8')
  return readRange(file, 0, maxBytes).toString('utf8')
}

/**
 * 解析 JSONL 文本。坏行（半行、非 JSON）直接忽略，不抛。
 * dropLastPartial=true 时无条件丢掉最后一行（读取区段不一定落在换行边界）。
 */
export function parseJsonLines(text, { dropLastPartial = false } = {}) {
  const lines = String(text || '').split('\n')
  if (dropLastPartial && lines.length > 0) lines.pop()
  const events = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* 截断/坏行：跳过 */
    }
  }
  return events
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * DSH 的 session.*.jsonl.zstd 是多段独立 zstd 帧首尾拼接（不是单个 zstd stream）。
 * 按 magic 28 b5 2f fd 切帧，逐帧解压后拼成 JSONL。解压失败的帧直接跳过，不抛。
 */
export function decompressZstdFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return ''
  const starts = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (
      buffer[i] === ZSTD_MAGIC[0] &&
      buffer[i + 1] === ZSTD_MAGIC[1] &&
      buffer[i + 2] === ZSTD_MAGIC[2] &&
      buffer[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i)
      i += 3
    }
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      /* 末尾帧可能正写到一半：跳过 */
    }
  }
  return text
}

/** 单行化 + 截断（用于 summary 里的 step/detail）。 */
export function truncate(value, max) {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  if (!Number.isFinite(max) || max <= 0) return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 保留换行的截断（步骤文本用）。 */
export function truncateRaw(value, max) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'
}

/** 把毫秒/ISO 时间统一成 ISO 字符串；无效值给 null。 */
export function isoFrom(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return null
}

export function ageSecFrom(iso, now = Date.now()) {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.round((now - at) / 1000))
}

export function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** 状态判定的统一阈值：3 分钟内有写入算 working，24 小时内算 idle，否则 offline。 */
export const WORKING_AGE_SEC = 180
export const IDLE_AGE_SEC = 24 * 60 * 60

export function statusFromAge(ageSec) {
  if (ageSec === null || ageSec === undefined) return 'offline'
  if (ageSec <= WORKING_AGE_SEC) return 'working'
  if (ageSec <= IDLE_AGE_SEC) return 'idle'
  return 'offline'
}

/** 从步骤列表里挑一句最能代表「当前进度」的文本：优先最近几条里的助手文本。 */
export function pickStepSummary(steps, maxLen = 140) {
  const list = Array.isArray(steps) ? steps : []
  if (list.length === 0) return ''
  // 工具调用往往连续成串（bash / wait_agent…），往前多找几步助手文本，摘要更好读
  for (let i = list.length - 1; i >= Math.max(0, list.length - 12); i -= 1) {
    if (list[i].role === 'assistant' && list[i].text) return truncate(list[i].text, maxLen)
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].text) return truncate(list[i].text, maxLen)
  }
  return ''
}

/** 统一把步骤字段压到契约形状：{at, role, text, meta?}，text ≤ 600 字；相邻重复步骤去掉。 */
export function normalizeSteps(steps, limit) {
  const source = (Array.isArray(steps) ? steps : []).filter((step) => step && step.text)
  const deduped = []
  for (const step of source) {
    const previous = deduped[deduped.length - 1]
    if (previous && previous.role === step.role && previous.text === step.text) continue
    deduped.push(step)
  }
  const capped = Number.isFinite(limit) && limit > 0 ? deduped.slice(-limit) : deduped
  return capped.map((step) => {
    const normalized = {
      at: isoFrom(step.at),
      role: step.role === 'user' || step.role === 'assistant' || step.role === 'tool' || step.role === 'system'
        ? step.role
        : 'system',
      text: truncateRaw(step.text, 600),
    }
    if (step.meta && typeof step.meta === 'object') normalized.meta = step.meta
    return normalized
  })
}

/** 从任意内容块数组里抽纯文本（Claude/Codex/DSH 的内容块形状略有差异）。 */
export function textFromBlocks(blocks, { includeToolResult = true } = {}) {
  const parts = []
  const walk = (block) => {
    if (!block || typeof block !== 'object') return
    if (typeof block.text === 'string' && block.text) parts.push(block.text)
    else if (includeToolResult && typeof block.content === 'string' && block.content) parts.push(block.content)
    else if (includeToolResult && Array.isArray(block.content)) for (const inner of block.content) walk(inner)
  }
  if (typeof blocks === 'string') return blocks
  if (Array.isArray(blocks)) for (const block of blocks) walk(block)
  return parts.join('\n')
}
