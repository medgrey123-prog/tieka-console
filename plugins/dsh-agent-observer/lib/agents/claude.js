// Claude 数据源：~/.claude/projects/<bucket>/<session>.jsonl
//
// 每行一个事件：{type, timestamp, cwd, sessionId, message, entrypoint, ...}
// type 常见 user / assistant / custom-title / agent-name / attachment / system / 各种状态行。
//
// 会话选择（两步，避免被「打开过但没在干活」的会话误导）：
//  1) 先按文件 mtime 取最近的一批候选（最多 12 个，便宜）；
//  2) 再读每个候选的尾部，按「最后一条 user/assistant 消息的时间」挑真正最近在干活的那个。
//     同时跳过 entrypoint 以 sdk- 开头的后台 SDK 会话（如 claude-mem 观察器），它们不是「Claude 当前进度」。
// 会话文件可能几 MB：小文件整读；大文件读头 128KB（标题/model/cwd）+ 尾部 2MB（最近步骤）。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  ageSecFrom,
  isoFrom,
  normalizeSteps,
  parseJsonLines,
  pickStepSummary,
  readHeadText,
  readTailText,
  readdirOrEmpty,
  statOrNull,
  statusFromAge,
  textFromBlocks,
  truncate,
} from '../util.js'

const ROOT = path.join(homedir(), '.claude', 'projects')
const NAME = 'Claude'
const KIND = 'code'

const FULL_READ_MAX = 768 * 1024
const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 2 * 1024 * 1024
const PROBE_BYTES = 64 * 1024
const PROBE_COUNT = 12

/** 进程内 memo：同一文件同一 mtime 只解析一次（面板会轮询摘要）。 */
const memo = new Map()
const probeMemo = new Map()

function scanCandidates() {
  const candidates = []
  for (const bucket of readdirOrEmpty(ROOT)) {
    if (!bucket.isDirectory() || bucket.name.startsWith('._')) continue
    const bucketPath = path.join(ROOT, bucket.name)
    for (const entry of readdirOrEmpty(bucketPath)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('._')) continue
      const file = path.join(bucketPath, entry.name)
      const stat = statOrNull(file)
      if (!stat || !stat.isFile()) continue
      candidates.push({
        file,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        bucket: bucket.name,
        sessionId: entry.name.slice(0, -'.jsonl'.length),
      })
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates
}

/** 读候选文件尾部，拿到最后一条消息时间与 entrypoint（用于选会话）。 */
function probeCandidate(candidate) {
  const key = `${candidate.mtimeMs}:${candidate.size}`
  const cached = probeMemo.get(candidate.file)
  if (cached && cached.key === key) return cached.data
  const lines = parseJsonLines(readTailText(candidate.file, PROBE_BYTES), { dropLastPartial: true })
  let lastMessageAt = null
  let entrypoint = ''
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    if (typeof line.entrypoint === 'string' && line.entrypoint) entrypoint = line.entrypoint
    if ((line.type === 'user' || line.type === 'assistant') && line.timestamp) {
      const iso = isoFrom(line.timestamp)
      if (iso) lastMessageAt = iso
    }
  }
  const data = { lastMessageAt, entrypoint }
  probeMemo.set(candidate.file, { key, data })
  if (probeMemo.size > 64) {
    const oldest = probeMemo.keys().next().value
    if (oldest !== undefined) probeMemo.delete(oldest)
  }
  return data
}

function pickSession(candidates) {
  let best = null
  for (const candidate of candidates.slice(0, PROBE_COUNT)) {
    const probe = probeCandidate(candidate)
    // 后台 SDK 会话（claude-mem 观察器之类）不是用户面前的 Claude，跳过
    if (probe.entrypoint.startsWith('sdk-')) continue
    const score = probe.lastMessageAt ? Date.parse(probe.lastMessageAt) : candidate.mtimeMs
    if (!best || score > best.score) best = { candidate, lastMessageAt: probe.lastMessageAt, score }
  }
  if (best) return best
  // 极端情况：候选全是 SDK 会话，退回按 mtime 最新的一个（至少给出真实状态）
  const fallback = candidates[0]
  return fallback ? { candidate: fallback, lastMessageAt: null, score: fallback.mtimeMs } : null
}

function extractMeta(headLines, tailLines, candidate) {
  const lines = [...headLines, ...tailLines]
  let title = ''
  let agentName = ''
  let cwd = ''
  let sessionId = candidate.sessionId
  let model = ''
  let firstUserText = ''

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    if (line.type === 'custom-title' && typeof line.customTitle === 'string' && line.customTitle.trim()) {
      title = line.customTitle.trim()
    }
    if (line.type === 'agent-name' && typeof line.agentName === 'string' && line.agentName.trim()) {
      agentName = line.agentName.trim()
    }
    if (typeof line.cwd === 'string' && line.cwd.trim()) cwd = line.cwd.trim()
    if (typeof line.sessionId === 'string' && line.sessionId.trim()) sessionId = line.sessionId.trim()
    if (line.type === 'assistant' && line.message && typeof line.message.model === 'string') model = line.message.model
    if (!firstUserText && line.type === 'user' && line.message) {
      const text = textFromBlocks(line.message.content)
      if (text.trim()) firstUserText = text.trim()
    }
  }

  if (!title) title = agentName
  if (!title && firstUserText) title = truncate(firstUserText, 40)
  if (!title) title = cwd ? path.basename(cwd) : candidate.sessionId
  return { title, cwd, sessionId, model }
}

function extractSteps(lines) {
  const steps = []
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const at = isoFrom(line.timestamp)
    if (line.type === 'assistant' && line.message) {
      const blocks = line.message.content
      if (typeof blocks === 'string') {
        if (blocks.trim()) steps.push({ at, role: 'assistant', text: blocks })
        continue
      }
      if (!Array.isArray(blocks)) continue
      let pushed = false
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          steps.push({ at, role: 'assistant', text: block.text })
          pushed = true
        } else if (block.type === 'tool_use') {
          steps.push({
            at,
            role: 'tool',
            text: `调用工具 ${typeof block.name === 'string' ? block.name : '（未知）'}`,
            meta: { name: typeof block.name === 'string' ? block.name : '', id: typeof block.id === 'string' ? block.id : undefined },
          })
        }
      }
      // 只有 thinking 块（工具轮里常见）：把思考当 assistant 步骤展示，面板才看得到进度
      if (!pushed) {
        for (let i = blocks.length - 1; i >= 0; i -= 1) {
          const block = blocks[i]
          if (!block || typeof block !== 'object') continue
          if (block.type !== 'thinking' && block.type !== 'reasoning') continue
          const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''
          if (text.trim()) {
            steps.push({ at, role: 'assistant', text, meta: { kind: 'thinking' } })
            break
          }
        }
      }
      continue
    }
    if (line.type !== 'user' || !line.message) continue
    const content = line.message.content
    if (typeof content === 'string') {
      if (content.trim()) steps.push({ at, role: 'user', text: content })
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        steps.push({ at, role: 'user', text: block.text })
      } else if (block.type === 'tool_result') {
        const text = textFromBlocks(block.content)
        if (text.trim()) {
          steps.push({ at, role: 'tool', text, meta: { toolResult: true } })
        }
      }
    }
  }
  return steps
}

function loadSession(candidate) {
  const key = `${candidate.file}:${candidate.mtimeMs}:${candidate.size}`
  const cached = memo.get(candidate.file)
  if (cached && cached.key === key) return cached.data

  let headLines
  let tailLines
  if (candidate.size <= FULL_READ_MAX) {
    const all = parseJsonLines(readFileSync(candidate.file, 'utf8'))
    headLines = all
    tailLines = all
  } else {
    headLines = parseJsonLines(readHeadText(candidate.file, HEAD_BYTES), { dropLastPartial: true })
    tailLines = parseJsonLines(readTailText(candidate.file, TAIL_BYTES), { dropLastPartial: true })
  }

  const meta = extractMeta(headLines, tailLines, candidate)
  const data = { ...meta, steps: extractSteps(tailLines) }
  memo.set(candidate.file, { key, data })
  if (memo.size > 8) {
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  return data
}

export async function collect() {
  const picked = pickSession(scanCandidates())
  if (!picked) {
    return {
      running: false,
      status: 'offline',
      lastActivityAt: null,
      ageSec: null,
      session: null,
      step: '没有找到 Claude 会话文件',
      detail: '~/.claude/projects 下没有可读的会话',
    }
  }
  const data = loadSession(picked.candidate)
  const lastActivityAt = picked.lastMessageAt || new Date(picked.candidate.mtimeMs).toISOString()
  const ageSec = ageSecFrom(lastActivityAt)
  const status = statusFromAge(ageSec)
  const step = pickStepSummary(data.steps, 140) || '（最近没有可读步骤）'
  return {
    running: ageSec !== null && ageSec <= 120,
    status,
    lastActivityAt,
    ageSec,
    session: {
      id: data.sessionId,
      title: data.title,
      cwd: data.cwd,
      model: data.model || null,
    },
    step,
    detail: `${NAME} 桌面端 · 「${truncate(data.title, 40)}」${data.model ? ` · ${data.model}` : ''}`,
  }
}

export async function getSteps(limit) {
  const picked = pickSession(scanCandidates())
  if (!picked) return { name: NAME, steps: [] }
  const data = loadSession(picked.candidate)
  return { name: NAME, steps: normalizeSteps(data.steps, limit) }
}

export const meta = { id: 'claude', name: NAME, kind: KIND }
