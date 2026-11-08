// DSH 数据源：~/.dsh/sessions/<bucket>/<session-id>/session.v4.jsonl.zstd
//
// 难点：文件不是单个 zstd stream，而是多段独立 zstd 帧首尾拼接（每帧带 magic 28 b5 2f fd）。
// 解法：按 magic 切帧，逐帧 zlib.zstdDecompressSync，拼回 JSONL；坏帧/截断帧直接跳过。
// 事件形如 {type, seq, time, data}，常用类型：session、session/title、user/message、
// assistant/message、tool/call、tool/result、step/start、turn/start、turn/end、request/header。
//
// 会话选择：
// - 「当前进度」优先看主会话（origin 不是 subagent，即用户直接开的那个）；
// - 但状态/活跃时间看所有会话里最新的写入（子 agent 也在代表 DSH 干活）；
// - 若只有子会话（或读不到 session 事件），退回按 mtime 最新的那个。

import { homedir } from 'node:os'
import path from 'node:path'

import {
  ageSecFrom,
  decompressZstdFrames,
  isoFrom,
  normalizeSteps,
  parseJsonLines,
  pickStepSummary,
  readRange,
  readdirOrEmpty,
  statOrNull,
  statusFromAge,
  textFromBlocks,
  truncate,
  WORKING_AGE_SEC,
} from '../util.js'

const ROOT = path.join(homedir(), '.dsh', 'sessions')
const NAME = 'DSH'
const KIND = 'code'

const SESSION_FILES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']
const HEAD_BYTES = 96 * 1024
const SUMMARY_TAIL_BYTES = 768 * 1024
const STEPS_TAIL_BYTES = 2 * 1024 * 1024
const MAX_HEAD_CANDIDATES = 10

const memo = new Map()
const headMemo = new Map()

/** 扫描所有 DSH 会话文件，按 mtime 倒序。 */
export function scanSessions() {
  const found = []
  for (const bucket of readdirOrEmpty(ROOT)) {
    if (!bucket.isDirectory() || bucket.name.startsWith('._')) continue
    const bucketPath = path.join(ROOT, bucket.name)
    for (const entry of readdirOrEmpty(bucketPath)) {
      if (!entry.isDirectory() || entry.name.startsWith('._')) continue
      const dir = path.join(bucketPath, entry.name)
      for (const fileName of SESSION_FILES) {
        const file = path.join(dir, fileName)
        const stat = statOrNull(file)
        if (stat && stat.isFile() && stat.size > 0) {
          found.push({
            file,
            dir,
            id: entry.name.replace(/^session-/, ''),
            bucket: bucket.name,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          })
          break
        }
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

function readHeadEvents(candidate) {
  const cached = headMemo.get(candidate.file)
  if (cached && cached.key === `${candidate.mtimeMs}:${candidate.size}`) return cached.data
  const length = Math.min(candidate.size, HEAD_BYTES)
  const text = decompressZstdFrames(readRange(candidate.file, 0, length))
  const events = parseJsonLines(text, { dropLastPartial: true })
  const data = {
    events,
    session: events.find((ev) => ev && ev.type === 'session') || null,
    title: '',
  }
  for (const ev of events) {
    if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.trim()) {
      data.title = ev.data.title.trim()
    }
  }
  headMemo.set(candidate.file, { key: `${candidate.mtimeMs}:${candidate.size}`, data })
  if (headMemo.size > 16) {
    const oldest = headMemo.keys().next().value
    if (oldest !== undefined) headMemo.delete(oldest)
  }
  return data
}

function readTailEvents(candidate, tailBytes) {
  const key = `${candidate.mtimeMs}:${candidate.size}:${tailBytes}`
  const cached = memo.get(candidate.file)
  if (cached && cached.key === key) return cached.events
  let text = ''
  if (candidate.size <= tailBytes) {
    text = decompressZstdFrames(readRange(candidate.file, 0, candidate.size))
  } else {
    const start = candidate.size - tailBytes
    const buffer = readRange(candidate.file, start, tailBytes)
    // 读取区段不一定落在帧边界：从第一个 magic 开始切帧，前面那截不完整帧丢弃。
    const magic = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    const slice = magic > 0 ? buffer.subarray(magic) : buffer
    text = decompressZstdFrames(slice)
  }
  const events = parseJsonLines(text, { dropLastPartial: true })
  memo.set(candidate.file, { key, events })
  if (memo.size > 10) {
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  return events
}

function mergeEvents(headEvents, tailEvents) {
  const bySeq = new Map()
  const merged = []
  let sessionEvent = null
  for (const ev of [...headEvents, ...tailEvents]) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'session') {
      if (!sessionEvent) sessionEvent = ev
      continue
    }
    const seq = Number(ev.seq)
    if (!Number.isFinite(seq)) {
      merged.push(ev)
      continue
    }
    if (bySeq.has(seq)) continue
    bySeq.set(seq, ev)
  }
  const sorted = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, ev]) => ev)
  return sessionEvent ? [sessionEvent, ...merged, ...sorted] : [...merged, ...sorted]
}

function extractSteps(events) {
  const steps = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const at = isoFrom(ev.time)
    if (ev.type === 'user/message') {
      const text = textFromBlocks(ev.data && ev.data.content)
      if (text.trim()) steps.push({ at, role: 'user', text })
    } else if (ev.type === 'assistant/message') {
      const message = ev.data && ev.data.message
      const blocks = message && message.content
      if (typeof blocks === 'string') {
        if (blocks.trim()) steps.push({ at, role: 'assistant', text: blocks })
        continue
      }
      if (!Array.isArray(blocks)) continue
      let pushed = false
      for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          steps.push({ at, role: 'assistant', text: block.text })
          pushed = true
        }
      }
      // 工具轮里模型常只产出 reasoning + tool-call 块、没有最终文本。
      // 把最近一段 reasoning 当作 assistant 步骤，steps 里才有「它在想什么」而不只是清一色工具调用。
      if (!pushed) {
        for (let i = blocks.length - 1; i >= 0; i -= 1) {
          const block = blocks[i]
          if (!block || block.type !== 'reasoning' || typeof block.text !== 'string' || !block.text.trim()) continue
          steps.push({ at, role: 'assistant', text: block.text, meta: { kind: 'reasoning' } })
          break
        }
      }
    } else if (ev.type === 'tool/call') {
      const name = ev.data && typeof ev.data.name === 'string' ? ev.data.name : ''
      steps.push({
        at,
        role: 'tool',
        text: `调用工具 ${name || '（未知）'}`,
        meta: {
          name,
          callId: ev.data && typeof ev.data.callId === 'string' ? ev.data.callId : undefined,
        },
      })
    }
  }
  return steps
}

function extractModel(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (!ev || ev.type !== 'request/header') continue
    const config = ev.data && ev.data.header && ev.data.header.config
    if (config && typeof config.model === 'string' && config.model) return config.model
  }
  return ''
}

/**
 * 读主会话 + 统计并行子会话。
 * 返回 {primary, subagentCount, newest}。
 */
function pickPrimary(candidates) {
  let primary = null
  let subagentCount = 0
  for (let i = 0; i < candidates.length && i < MAX_HEAD_CANDIDATES; i += 1) {
    const candidate = candidates[i]
    let head
    try {
      head = readHeadEvents(candidate)
    } catch {
      continue
    }
    const origin = head.session && typeof head.session.origin === 'string' ? head.session.origin : ''
    const isSubagent = origin === 'subagent'
    if (isSubagent) {
      if (Date.now() - candidate.mtimeMs <= WORKING_AGE_SEC * 1000) subagentCount += 1
      continue
    }
    if (!primary) primary = candidate
  }
  if (!primary) primary = candidates[0] || null
  return { primary, subagentCount }
}

export async function collect() {
  const candidates = scanSessions()
  if (candidates.length === 0) {
    return {
      running: true,
      status: 'offline',
      lastActivityAt: null,
      ageSec: null,
      session: null,
      step: '没有找到 DSH 会话文件',
      detail: '~/.dsh/sessions 下没有可读的会话',
    }
  }

  const newest = candidates[0]
  const { primary, subagentCount } = pickPrimary(candidates)
  const head = readHeadEvents(primary)
  const tail = readTailEvents(primary, SUMMARY_TAIL_BYTES)
  const events = mergeEvents(head.events, tail)
  const steps = extractSteps(events)
  const title = head.title || ''
  const sessionEvent = head.session || {}
  const sessionCwd = typeof sessionEvent.cwd === 'string' ? sessionEvent.cwd : ''
  const model = extractModel(events) || ''
  const lastActivityAt = new Date(newest.mtimeMs).toISOString()
  const ageSec = ageSecFrom(lastActivityAt)
  const step = pickStepSummary(steps, 140) || '（等待第一步）'
  const subagentNote = subagentCount > 0 ? ` · 并行子会话 ${subagentCount} 个` : ''

  return {
    running: true,
    status: statusFromAge(ageSec),
    lastActivityAt,
    ageSec,
    session: {
      id: (sessionEvent.id && String(sessionEvent.id)) || primary.id,
      title: title || (sessionCwd ? path.basename(sessionCwd) : primary.id),
      cwd: sessionCwd,
      model: model || null,
    },
    step,
    detail: `${NAME} 桌面端 · 主会话「${truncate(title || primary.id, 40)}」${subagentNote}`,
  }
}

export async function getSteps(limit) {
  const candidates = scanSessions()
  if (candidates.length === 0) return { name: NAME, steps: [] }
  const { primary } = pickPrimary(candidates)
  const head = readHeadEvents(primary)
  const tail = readTailEvents(primary, STEPS_TAIL_BYTES)
  const events = mergeEvents(head.events, tail)
  return { name: NAME, steps: normalizeSteps(extractSteps(events), limit) }
}

export const meta = { id: 'dsh', name: NAME, kind: KIND }
