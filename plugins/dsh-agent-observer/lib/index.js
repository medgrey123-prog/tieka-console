// Agent 观察台 lite — Host 入口
//
// 只做三件事：
//  1) 在 DSH 自带 HTTP server 上注册同源路由 /agents/*，给铁卡老弟面板的 Agents tab 取数；
//  2) 注册一个只读工具 agents_status，让 DSH 里的 Agent 也能问「其他 agent 干到哪了」；
//  3) 后台定时判定异常并推飞书提醒（经 agent-autoloop 中台 /v1/tell，见 lib/notify.js）。
// 只监控 Claude / Codex / DSH 三个 code agent，数据全部来自本机会话文件（纯文件采集，
// 不截图、不 OCR）；提醒失败只降级，不影响读取。

import { clampInt, truncate } from './util.js'
import {
  AGENTS,
  collectSummary,
  getAgent,
  getSteps,
} from './agents/index.js'
import { notifyStateView, readNotifyConfig, sendManualReport, sendTestTell, watchTick } from './notify.js'

export const name = 'agent-observer'
export const inject = []

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function sendError(response, error, status = 200) {
  const code = error && typeof error.code === 'string' ? error.code : 'INTERNAL'
  const message = String((error && error.message) || error || '未知错误')
  sendJson(response, status, { ok: false, error: { code, message } })
}

function methodNotAllowed(response, allow) {
  sendJson(response, 405, { ok: false, error: { code: 'METHOD', message: `只接受 ${allow}` } })
}

function notFound(response) {
  sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个路由' } })
}

function parseUrl(request) {
  return new URL(request.url || '/', 'http://127.0.0.1')
}

// ---------------------------------------------------------------------------
// 路由 handler
// ---------------------------------------------------------------------------

async function routeSummary(request, response, url) {
  if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
  try {
    const data = await collectSummary()
    sendJson(response, 200, { ok: true, data })
  } catch (error) {
    sendError(response, error)
  }
  return undefined
}

async function routeSteps(request, response, url, id) {
  if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
  try {
    if (!getAgent(id)) return sendError(response, { code: 'UNKNOWN_AGENT', message: `未知的 agent：${id}` })
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 20)
    const data = await getSteps(id, limit)
    sendJson(response, 200, { ok: true, data })
  } catch (error) {
    sendError(response, error)
  }
  return undefined
}

/**
 * GET /agents/notify/state：提醒相关的只读快照（配置 + 上次 tick 的状态 + 最近推送）。
 * 读配置/状态文件全部降级，没有中台也返回 {hub:{configured:false}}。
 */
function routeNotifyState(request, response) {
  if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
  try {
    sendJson(response, 200, { ok: true, data: notifyStateView() })
  } catch (error) {
    sendError(response, error)
  }
  return undefined
}

/** POST /agents/notify/test：真发一条测试 tell（DRY_RUN=1 时不真发）。 */
async function routeNotifyTest(request, response) {
  if (request.method !== 'POST') return methodNotAllowed(response, 'POST')
  try {
    request.resume() // 不需要请求体，排空以免挂住连接
    const data = await sendTestTell()
    sendJson(response, 200, { ok: true, data })
  } catch (error) {
    sendError(response, error)
  }
  return undefined
}

/**
 * POST /agents/notify/report：立即发一次周期汇报（忽略免打扰，用于验证/手动触发）。
 * DRY_RUN=1 时不真发；返回 {sent, duplicate, key, at, text}。
 */
async function routeNotifyReport(request, response) {
  if (request.method !== 'POST') return methodNotAllowed(response, 'POST')
  try {
    request.resume() // 不需要请求体，排空以免挂住连接
    const data = await sendManualReport()
    sendJson(response, 200, { ok: true, data })
  } catch (error) {
    sendError(response, error)
  }
  return undefined
}

/**
 * /agents/ 前缀路由的分发器：
 *   GET  /agents/summary
 *   GET  /agents/notify/state
 *   POST /agents/notify/test
 *   POST /agents/notify/report
 *   GET  /agents/:id/steps?limit=20
 *
 * lite 版没有截图/OCR，所以不再有 POST /agents/:id/snapshot 与 GET /agents/:id/snapshot.png。
 */
async function routeAgentsPrefix(request, response) {
  let url
  try {
    url = parseUrl(request)
  } catch {
    return sendError(response, { code: 'BAD_URL', message: '请求 URL 不合法' })
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  if (pathname === '/agents/summary') return routeSummary(request, response, url)

  const rest = pathname.startsWith('/agents/') ? pathname.slice('/agents/'.length) : ''
  let parts
  try {
    parts = rest.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  } catch {
    return sendError(response, { code: 'BAD_URL', message: '路径编码不合法' })
  }
  // 调试路由先分流，避免被当成 :id/action（notify 不是 agent id）。
  if (parts.length === 2 && parts[0] === 'notify') {
    if (parts[1] === 'state') return routeNotifyState(request, response)
    if (parts[1] === 'test') return routeNotifyTest(request, response)
    if (parts[1] === 'report') return routeNotifyReport(request, response)
    return notFound(response)
  }
  if (parts.length !== 2) return notFound(response)
  const [id, action] = parts
  if (action === 'steps') return routeSteps(request, response, url, id)
  return notFound(response)
}

function registerRoutes(ctx) {
  ctx.inject(
    ['webServer'],
    (host) => {
      const disposers = []
      disposers.push(host.webServer.register({ kind: 'exact', path: '/agents/summary', handler: routeSummary }))
      disposers.push(host.webServer.register({ kind: 'prefix', path: '/agents', handler: routeAgentsPrefix }))
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
    'agent-observer: http routes',
  )
}

/**
 * 后台提醒循环：默认 120s 一次（notify.json 的 intervalSec 可改，需 reload 生效）。
 * 启动 5s 后先跑一次，避免和插件启动抢 I/O；unref 后不阻止进程退出；
 * ctx.effect 清理时停止定时器。任何异常都在这里吞掉，不能影响路由/工具。
 * 周期汇报默认 30 分钟一条（notify.js 的 DEFAULT_CONFIG.reportIntervalSec=1800）。
 */
function registerNotifyLoop(ctx) {
  ctx.effect(() => {
    let intervalSec = 120
    try {
      intervalSec = readNotifyConfig().intervalSec
    } catch {
      /* 配置读失败用默认 120s */
    }
    const intervalMs = Math.max(15, Math.round(intervalSec)) * 1000
    const timer = setInterval(() => {
      watchTick().catch(() => {})
    }, intervalMs)
    timer.unref?.()
    const kickoff = setTimeout(() => {
      watchTick().catch(() => {})
    }, 5000)
    kickoff.unref?.()
    return () => {
      clearInterval(timer)
      clearTimeout(kickoff)
    }
  }, 'agent-observer: notify')
}

// ---------------------------------------------------------------------------
// 只读工具 agents_status
// ---------------------------------------------------------------------------

function agoText(ageSec) {
  if (!Number.isFinite(ageSec)) return '时间未知'
  if (ageSec < 60) return '刚刚'
  if (ageSec < 3600) return `${Math.round(ageSec / 60)} 分钟前`
  if (ageSec < 86400) return `${(ageSec / 3600).toFixed(1)} 小时前`
  return `${Math.round(ageSec / 86400)} 天前`
}

function roleLabel(role) {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'tool') return '工具'
  return '系统'
}

function statusLine(agent) {
  const parts = [`${agent.name}：${agent.status}`]
  if (Number.isFinite(agent.ageSec)) parts.push(agoText(agent.ageSec))
  if (agent.session && agent.session.title) {
    parts.push(`会话「${truncate(agent.session.title, 30)}」`)
  }
  parts.push(`最近：${truncate(agent.step || agent.detail || '—', 70)}`)
  return parts.join('，')
}

const STATUS_TOOL = {
  name: 'agents_status',
  description:
    '查看本机 3 个 Agent（Claude / Codex / DSH）的当前工作进度：状态、多久前活动、在做什么、最近步骤摘要。全部读本地会话文件，只读；不能操作、不能替用户回话、不能改任何东西。',
  parameters: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'summary（默认）每个 agent 一行；full 额外带上最近 3 步（text 截断）。',
      },
      agent: {
        type: 'string',
        enum: AGENTS.map((agent) => agent.id),
        description: '只看某一个 agent；省略则看全部 3 个。',
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: String((value && value.summary) || '') }],
  },
  timeoutMs: 20000,
  isConcurrencySafe: () => true,
  async execute(args) {
    const options = args && typeof args === 'object' ? args : {}
    const full = options.detail === 'full'
    const wanted = options.agent ? getAgent(options.agent) : null
    if (options.agent && !wanted) {
      return { summary: `没有这个 agent：${options.agent}。可选：${AGENTS.map((agent) => agent.id).join(' / ')}` }
    }
    const data = await collectSummary()
    const agents = wanted ? data.agents.filter((agent) => agent.id === wanted.id) : data.agents
    const lines = []
    for (const agent of agents) {
      lines.push(statusLine(agent))
      if (!full) continue
      try {
        const steps = await getSteps(agent.id, 3)
        for (const step of steps.steps) {
          lines.push(`  · ${roleLabel(step.role)}：${truncate(step.text, 90)}`)
        }
      } catch (error) {
        lines.push(`  · 读步骤失败：${truncate((error && error.message) || String(error), 60)}`)
      }
    }
    if (lines.length === 0) lines.push('现在没有任何 agent 数据。')
    return { summary: lines.join('\n') }
  },
}

export function apply(ctx) {
  try {
    ctx.tools.register(STATUS_TOOL)
  } catch (error) {
    console.warn(`[agent-observer] 只读工具注册失败：${(error && error.message) || error}`)
  }

  try {
    registerRoutes(ctx)
  } catch (error) {
    console.warn(`[agent-observer] HTTP 路由注册失败：${(error && error.message) || error}`)
  }

  try {
    registerNotifyLoop(ctx)
  } catch (error) {
    console.warn(`[agent-observer] 飞书提醒循环注册失败：${(error && error.message) || error}`)
  }
}
