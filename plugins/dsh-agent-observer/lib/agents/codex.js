// Codex 数据源：~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl
//
// 每行 {timestamp, type, payload}。关注：
// - session_meta：cwd / id / originator（首个文件头）
// - response_item + payload.type=message：role user/assistant，content[].input_text/output_text/text
// - response_item + payload.type=function_call / custom_tool_call：工具调用
// - event_msg + payload.type=task_complete：一轮结束（last_agent_message）
// - turn_context：最新 cwd / model
//
// rollout 文件可能有几十 MB，所以一律只读头 64KB + 尾部 768KB(摘要) / 2MB(步骤)。

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

const ROOT = path.join(homedir(), '.codex', 'sessions')
const NAME = 'Codex'
const KIND = 'code'

const HEAD_BYTES = 64 * 1024
const SUMMARY_TAIL_BYTES = 768 * 1024
const STEPS_TAIL_BYTES = 2 * 1024 * 1024

const memo = new Map()

function walk(dir, out, depth = 0) {
  if (depth > 6) return out
  for (const entry of readdirOrEmpty(dir)) {
    if (entry.name.startsWith('._')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out, depth + 1)
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      const stat = statOrNull(full)
      if (!stat || !stat.isFile()) continue
      out.push({
        file: full,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        fallbackId: (entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/) || [])[1] || entry.name,
      })
    }
  }
  return out
}

function scanLatest() {
  const candidates = walk(ROOT, [])
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0] || null
}

function extractMeta(headLines, tailLines, candidate) {
  let cwd = ''
  let sessionId = candidate.fallbackId
  let originator = ''
  let model = ''
  let lastAgentMessage = ''

  const headMeta = headLines.find((line) => line && line.type === 'session_meta')
  if (headMeta && headMeta.payload && typeof headMeta.payload === 'object') {
    if (typeof headMeta.payload.cwd === 'string') cwd = headMeta.payload.cwd
    if (typeof headMeta.payload.id === 'string') sessionId = headMeta.payload.id
    if (typeof headMeta.payload.originator === 'string') originator = headMeta.payload.originator
  }

  for (const line of tailLines) {
    if (!line || typeof line !== 'object' || !line.payload || typeof line.payload !== 'object') continue
    if (line.type === 'turn_context') {
      if (typeof line.payload.cwd === 'string' && line.payload.cwd) cwd = line.payload.cwd
      if (typeof line.payload.model === 'string' && line.payload.model) model = line.payload.model
    } else if (line.type === 'event_msg' && line.payload.type === 'task_complete') {
      if (typeof line.payload.last_agent_message === 'string') lastAgentMessage = line.payload.last_agent_message
    }
  }

  return { cwd, sessionId, originator, model, lastAgentMessage }
}

function extractSteps(lines) {
  const steps = []
  for (const line of lines) {
    if (!line || typeof line !== 'object' || !line.payload || typeof line.payload !== 'object') continue
    const at = isoFrom(line.timestamp)
    const payload = line.payload
    if (line.type === 'response_item' && payload.type === 'message') {
      const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
      if (!role) continue
      const text = textFromBlocks(payload.content)
      if (text.trim()) steps.push({ at, role, text })
    } else if (line.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
      const name = typeof payload.name === 'string' ? payload.name : ''
      steps.push({ at, role: 'tool', text: `调用 ${name || '工具'}`, meta: { name } })
    } else if (line.type === 'event_msg' && payload.type === 'task_complete') {
      if (typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
        steps.push({ at, role: 'assistant', text: payload.last_agent_message, meta: { taskComplete: true } })
      }
    }
  }
  return steps
}

function loadSession(candidate, tailBytes) {
  const key = `${candidate.file}:${candidate.mtimeMs}:${candidate.size}:${tailBytes}`
  const cached = memo.get(candidate.file)
  if (cached && cached.key === key) return cached.data

  const headLines = parseJsonLines(readHeadText(candidate.file, HEAD_BYTES), { dropLastPartial: true })
  const tailLines = parseJsonLines(readTailText(candidate.file, tailBytes), { dropLastPartial: true })
  const data = {
    ...extractMeta(headLines, tailLines, candidate),
    steps: extractSteps(tailLines),
  }
  memo.set(candidate.file, { key, data })
  if (memo.size > 8) {
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  return data
}

export async function collect() {
  const candidate = scanLatest()
  if (!candidate) {
    return {
      running: false,
      status: 'offline',
      lastActivityAt: null,
      ageSec: null,
      session: null,
      step: '没有找到 Codex 会话文件',
      detail: '~/.codex/sessions 下没有可读的 rollout',
    }
  }
  const data = loadSession(candidate, SUMMARY_TAIL_BYTES)
  const lastActivityAt = new Date(candidate.mtimeMs).toISOString()
  const ageSec = ageSecFrom(lastActivityAt)
  const title = data.cwd ? path.basename(data.cwd) : 'Codex 会话'
  return {
    running: ageSec !== null && ageSec <= 120,
    status: statusFromAge(ageSec),
    lastActivityAt,
    ageSec,
    session: {
      id: data.sessionId,
      title,
      cwd: data.cwd,
      model: data.model || null,
    },
    step: pickStepSummary(data.steps, 140) || truncate(data.lastAgentMessage, 140) || '（最近没有可读步骤）',
    detail: `${NAME} 桌面端${data.originator ? `（${truncate(data.originator, 24)}）` : ''} · 「${truncate(title, 40)}」${data.model ? ` · ${data.model}` : ''}`,
  }
}

export async function getSteps(limit) {
  const candidate = scanLatest()
  if (!candidate) return { name: NAME, steps: [] }
  const data = loadSession(candidate, STEPS_TAIL_BYTES)
  return { name: NAME, steps: normalizeSteps(data.steps, limit) }
}

export const meta = { id: 'codex', name: NAME, kind: KIND }
