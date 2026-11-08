// Agent 观察台 lite — 采集编排层
//
// 只监控 3 个 code agent，全部读本地会话文件（纯文件采集，不截图、不 OCR）：
//   claude → ~/.claude/projects/<bucket>/<session>.jsonl
//   codex  → ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//   dsh    → ~/.dsh/sessions/<bucket>/<session>/session.v4.jsonl.zstd
// 每个 agent 独立 try/catch：单个失败降级为 status:'error'，不影响其他。

import { ObserverError, nowIso, truncate } from '../util.js'
import * as claude from './claude.js'
import * as codex from './codex.js'
import * as dsh from './dsh.js'

/** 3 个 agent 的静态定义（顺序即面板展示顺序）。 */
export const AGENTS = [
  { id: 'claude', name: 'Claude', kind: 'code' },
  { id: 'codex', name: 'Codex', kind: 'code' },
  { id: 'dsh', name: 'DSH', kind: 'code' },
]

export const AGENT_IDS = AGENTS.map((agent) => agent.id)

export function getAgent(id) {
  const key = String(id || '').trim().toLowerCase()
  return AGENTS.find((agent) => agent.id === key) || null
}

const COLLECTORS = {
  claude: claude.collect,
  codex: codex.collect,
  dsh: dsh.collect,
}

const SOURCES = {
  claude,
  codex,
  dsh,
}

function finalize(def, partial) {
  const value = partial && typeof partial === 'object' ? partial : {}
  const lastActivityAt = typeof value.lastActivityAt === 'string' ? value.lastActivityAt : null
  let ageSec = Number.isFinite(value.ageSec) ? value.ageSec : null
  if (ageSec === null && lastActivityAt) {
    const at = Date.parse(lastActivityAt)
    if (Number.isFinite(at)) ageSec = Math.max(0, Math.round((Date.now() - at) / 1000))
  }
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    running: Boolean(value.running),
    status: typeof value.status === 'string' && value.status ? value.status : 'error',
    lastActivityAt,
    ageSec,
    session: value.session && typeof value.session === 'object' ? value.session : null,
    step: truncate(value.step || '', 220),
    detail: truncate(value.detail || '', 260),
  }
}

function errorAgent(def, error) {
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    running: false,
    status: 'error',
    lastActivityAt: null,
    ageSec: null,
    session: null,
    step: '',
    detail: `采集失败：${truncate((error && error.message) || String(error), 180)}`,
  }
}

/** GET /agents/summary 的数据体。只读文件，目标 <500ms。 */
export async function collectSummary() {
  const agents = await Promise.all(
    AGENTS.map(async (def) => {
      try {
        const partial = await COLLECTORS[def.id]()
        return finalize(def, partial)
      } catch (error) {
        return errorAgent(def, error)
      }
    }),
  )
  return { generatedAt: nowIso(), agents }
}

/** GET /agents/:id/steps 的数据体。 */
export async function getSteps(id, limit) {
  const def = getAgent(id)
  if (!def) throw new ObserverError('UNKNOWN_AGENT', `未知的 agent：${id}`)
  const data = await SOURCES[def.id].getSteps(limit)
  return { agent: { id: def.id, name: def.name }, steps: data.steps }
}
