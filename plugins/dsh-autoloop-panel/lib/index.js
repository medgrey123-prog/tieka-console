// Autoloop 面板 — Host 半
//
// 本机 agent-autoloop 中台没有 CORS，浏览器不能直连 127.0.0.1:3350。
// 所以这半只做三件事：
//  1) 读 ~/.agent-autoloop/config.json（地址 + 本人 owner 密钥，密钥不出 Host）；
//  2) 用同源路由 /autoloop/* 代理 state / action / rules 给面板；
//  3) 注册一个只读工具 autoloop_status，让 DSH 里的 Agent 也能看全局。
// 审批类动作（answer / resolve）只留给用户在面板里点，不做成工具。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'autoloop-panel'
export const inject = []

const HOME = path.join(homedir(), '.agent-autoloop')
const CONFIG_FILE = path.join(HOME, 'config.json')
const RULES_FILE = path.join(HOME, 'rules.json')
const MAX_BODY = 64 * 1024

class HubError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function sendError(response, error) {
  const code = error instanceof HubError ? error.code : 'INTERNAL'
  const message = String((error && error.message) || error || '未知错误')
  sendJson(response, 200, { ok: false, error: { code, message } })
}

function allow(request, response, method) {
  if (request.method === method) return true
  sendJson(response, 405, { ok: false, error: { code: 'METHOD', message: `只接受 ${method}` } })
  return false
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY) {
        fail(new HubError('TOO_LARGE', '请求体太大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new HubError('BAD_BODY', '请求体不是合法 JSON'))
      }
    })
    request.on('error', (error) => fail(error))
  })
}

/** What the panel needs to know before it can talk to the hub. Never includes the owner key. */
function hubMeta() {
  const meta = {
    installed: false,
    hasOwner: false,
    url: '',
    configPath: CONFIG_FILE,
    rulesPath: RULES_FILE,
  }
  let raw
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch {
    return meta
  }
  meta.installed = true
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.url === 'string') meta.url = parsed.url
    meta.hasOwner = Boolean(parsed && typeof parsed.owner === 'string' && parsed.owner.length > 0)
  } catch {
    meta.installed = false
  }
  return meta
}

function hubConfig() {
  let raw
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch {
    throw new HubError('NOT_INSTALLED', `没找到 ${CONFIG_FILE}：这台机器还没装 agent-autoloop`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HubError('BAD_CONFIG', `${CONFIG_FILE} 不是合法 JSON`)
  }
  const url = parsed && typeof parsed.url === 'string' ? parsed.url.replace(/\/+$/, '') : ''
  if (!/^https?:\/\//.test(url)) throw new HubError('BAD_CONFIG', `${CONFIG_FILE} 里没有有效的中台地址 url`)
  const owner = parsed && typeof parsed.owner === 'string' ? parsed.owner.trim() : ''
  if (!owner) throw new HubError('NO_OWNER', '这台机器上没有本人密钥（config.json 的 owner 为空，可能只是接单端）')
  return { url, owner }
}

async function hubRequest(pathname, options = {}) {
  const { method = 'GET', body, timeout = 12000 } = options
  const { url, owner } = hubConfig()
  let response
  try {
    response = await fetch(`${url}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${owner}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new HubError('TIMEOUT', `中台 ${url} 超过 ${Math.round(timeout / 1000)} 秒没响应`)
    }
    throw new HubError('UNREACHABLE', `连不上中台 ${url}（agent-autoloop up 起了吗？）`)
  }
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!response.ok) {
    const message = data && typeof data.error === 'string' ? data.error : `中台返回 HTTP ${response.status}`
    throw new HubError('HUB_HTTP', message)
  }
  return data
}

async function routeMeta(_request, response) {
  sendJson(response, 200, { ok: true, data: hubMeta() })
}

async function routeState(request, response) {
  if (!allow(request, response, 'GET')) return
  try {
    const url = new URL(request.url || '/', 'http://localhost')
    const before = url.searchParams.get('before')
    if (before !== null && !/^[1-9][0-9]*$/.test(before)) throw new HubError('BAD_INPUT', 'before 不是有效编号')
    const data = await hubRequest(before === null ? '/v1/state' : `/v1/state?before=${before}`)
    sendJson(response, 200, { ok: true, data })
  } catch (error) {
    sendError(response, error)
  }
}

async function routeAction(request, response) {
  if (!allow(request, response, 'POST')) return
  try {
    const body = await readBody(request)
    const id = Number(body && body.id)
    if (!Number.isInteger(id) || id <= 0) throw new HubError('BAD_INPUT', '卡片或轮次编号不正确')
    const action = String((body && body.action) || '')
    let result
    if (action === 'answer') {
      const payload = {}
      if (Number.isInteger(body.choice) && body.choice >= 0) payload.choice = body.choice
      else if (typeof body.text === 'string' && body.text.trim()) payload.text = body.text.trim().slice(0, 20000)
      else throw new HubError('BAD_INPUT', '回答要带选项序号或一段文字')
      result = await hubRequest(`/v1/cards/${id}/answer`, { method: 'POST', body: payload })
    } else if (action === 'resolve') {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (!reason) throw new HubError('BAD_INPUT', '结案要写一句处理结果')
      result = await hubRequest(`/v1/cards/${id}/resolve`, { method: 'POST', body: { reason: reason.slice(0, 1000) } })
    } else if (action === 'cancel') {
      result = await hubRequest(`/v1/runs/${id}/cancel`, { method: 'POST', body: {} })
    } else {
      throw new HubError('BAD_INPUT', `不认识的操作 ${action || '(空)'}`)
    }
    sendJson(response, 200, { ok: true, data: result })
  } catch (error) {
    sendError(response, error)
  }
}

async function routeRules(_request, response) {
  try {
    let raw
    try {
      raw = readFileSync(RULES_FILE, 'utf8')
    } catch {
      throw new HubError('NOT_INSTALLED', `没找到 ${RULES_FILE}`)
    }
    let rules
    try {
      rules = JSON.parse(raw)
    } catch {
      throw new HubError('BAD_RULES', `${RULES_FILE} 不是合法 JSON（中台会继续用旧规则）`)
    }
    sendJson(response, 200, { ok: true, data: { path: RULES_FILE, rules } })
  } catch (error) {
    sendError(response, error)
  }
}

const fmtTokens = (n) => {
  const value = Number(n) || 0
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}
const fmtMoney = (n) => `$${(Number(n) || 0).toFixed(2)}`

const STATUS_TOOL = {
  name: 'autoloop_status',
  description:
    '查看本机 agent-autoloop 中台的实时状态：等用户拍板的卡片、在跑/排队的轮次、在线成员、今天的 Token 与费用。只读；回答卡片只能由用户在 Autoloop 面板里点。',
  parameters: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'summary（默认）只返回摘要；full 附带待办卡片全文与最近轮次明细。',
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { summary: { type: 'string' }, json: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: String(value.summary || '') }],
  },
  timeoutMs: 20000,
  isConcurrencySafe: () => true,
  async execute(args) {
    const full = Boolean(args && args.detail === 'full')
    const state = await hubRequest('/v1/state', { timeout: 15000 })
    const totals = (state && state.totals) || {}
    const spending = (state && state.spending && state.spending.today) || {}
    const cards = Array.isArray(state && state.cards) ? state.cards : []
    const runs = Array.isArray(state && state.runs) ? state.runs : []
    const agents = Array.isArray(state && state.agents) ? state.agents : []
    const channels = Array.isArray(state && state.channels) ? state.channels : []
    const active = runs.filter((run) => ['queued', 'claimed', 'unknown'].includes(run.state))
    const onlineAgents = agents.filter((agent) => agent.online).length
    const onlineChannels = channels.filter((channel) => channel.online).length

    const lines = []
    lines.push(
      `中台在线：今天 ${Number(spending.rounds) || 0} 轮 · ${fmtTokens(spending.tokens)} tokens · ${fmtMoney(spending.cost)}`,
    )
    lines.push(
      cards.length
        ? `等你拍板 ${cards.length} 张：${cards
            .slice(0, 5)
            .map((card) => `#${card.id} ${card.title}${Array.isArray(card.options) && card.options.length ? `（${card.options.join(' / ')}）` : ''}`)
            .join('；')}`
        : '没有等你拍板的卡片',
    )
    const running = Number(totals.running) || 0
    const queued = Number(totals.queued) || 0
    lines.push(
      active.length
        ? `在跑 ${running} / 排队 ${queued}：${active
            .slice(0, 5)
            .map((run) => `第 ${run.id} 轮「${run.rule}」${run.state}`)
            .join('；')}`
        : '现在没有在跑或排队的轮次',
    )
    lines.push(`在线：Agent ${onlineAgents}/${agents.length}，通道 ${onlineChannels}/${channels.length}`)
    if (full) {
      const details = []
      for (const card of cards.slice(0, 10)) {
        details.push(`卡片 #${card.id}（${card.kind === 'ask' ? '提问' : '通知'}·${card.rule || ''}）${card.title}\n${card.text || ''}`)
      }
      for (const run of active.slice(0, 10)) {
        details.push(
          `第 ${run.id} 轮：规则「${run.rule}」· agent ${run.agent} · ${run.state} · 第 ${Number(run.attempts) + 1} 次`,
        )
      }
      if (details.length) lines.push('', '明细：', ...details)
    }
    return { summary: lines.join('\n'), json: full ? JSON.stringify({ totals, spending, cards, runs: active }) : '' }
  },
}

function registerRoutes(ctx) {
  ctx.inject(
    ['webServer'],
    (host) => {
      const disposers = []
      const add = (path, handler) => {
        disposers.push(host.webServer.register({ kind: 'exact', path, handler }))
      }
      add('/autoloop/meta', routeMeta)
      add('/autoloop/state', routeState)
      add('/autoloop/action', routeAction)
      add('/autoloop/rules', routeRules)
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 路由已失效时忽略 */
          }
        }
      }
    },
    'autoloop: http routes',
  )
}

export function apply(ctx) {
  try {
    ctx.effect(() => {
      const dispose = ctx.tools.register(STATUS_TOOL)
      return () => {
        try {
          dispose()
        } catch {
          /* 工具已失效时忽略 */
        }
      }
    }, 'autoloop: status tool')
  } catch (error) {
    console.warn(`[autoloop-panel] 只读工具注册失败：${(error && error.message) || error}`)
  }

  try {
    registerRoutes(ctx)
  } catch (error) {
    console.warn(`[autoloop-panel] HTTP 路由注册失败：${(error && error.message) || error}`)
  }
}
