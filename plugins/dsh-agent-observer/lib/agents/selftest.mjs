// Agent 观察台 lite — 自测（不经 DSH，直接 import 采集模块跑）
//
//   DRY_RUN=1 node lib/agents/selftest.mjs
//
// 只打印截断后的内容（每段文本 ≤100 字），避免把私有会话全文输出到终端/日志。
// 提醒相关测试永远走 DRY_RUN=1：不真发飞书，状态文件用 /tmp 临时目录。
// lite 版只监控 Claude / Codex / DSH 三个 code agent：没有截图、没有 OCR、
// 没有 /agents/:id/snapshot* 路由，测试里也会断言这些路由确实不存在。

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AGENTS, collectSummary, getSteps } from './index.js'
import { apply } from '../index.js'
import {
  DEFAULT_CONFIG,
  buildAlertText,
  buildReportText,
  collectProblems,
  isQuietHour,
  notifyKey,
  notifyStateView,
  readHubConfig,
  readNotifyConfig,
  readNotifyState,
  reportKey,
  sendManualReport,
  sendTell,
  watchTick,
} from '../notify.js'

// 自测绝不自真发：notify 函数在调用时读这个变量（import 本身无副作用）。
process.env.DRY_RUN = '1'

const clip = (value, max = 100) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

const results = []
const report = { summary: null, steps: {}, notify: null }

function record(name, ok, detail = '', ms = 0) {
  results.push({ name, ok, detail, ms })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${Number.isFinite(ms) ? `  ${ms}ms` : ''}${detail ? `\n      ${detail}` : ''}`)
}

async function main() {
  // ---- 1) summary：只应有 Claude / Codex / DSH 三个 ----
  const summaryStarted = Date.now()
  let summary
  try {
    summary = await collectSummary()
    const ms = Date.now() - summaryStarted
    console.log(`\n== summary（${ms}ms）generatedAt=${summary.generatedAt} ==`)
    for (const agent of summary.agents) {
      console.log(
        [
          `${agent.id.padEnd(8)} ${agent.status.padEnd(8)} running=${String(agent.running).padEnd(5)}`,
          `age=${agent.ageSec === null ? 'null' : `${agent.ageSec}s`}`,
          `session=${clip(agent.session && agent.session.title, 28) || '—'}`,
          `step=${clip(agent.step, 60)}`,
        ].join(' | '),
      )
    }
    report.summary = {
      generatedAt: summary.generatedAt,
      tookMs: ms,
      agents: summary.agents.map((agent) => ({
        id: agent.id,
        status: agent.status,
        running: agent.running,
        ageSec: agent.ageSec,
        session: agent.session
          ? { title: clip(agent.session.title, 30), cwd: clip(agent.session.cwd, 40), model: agent.session.model }
          : null,
        step: clip(agent.step, 100),
      })),
    }
    const ids = summary.agents.map((agent) => agent.id).join(',')
    // lite 契约：只读会话文件，不再带 window / snapshotAt / outputs 这些 GUI 字段。
    const noGuiFields = summary.agents.every(
      (agent) => !('window' in agent) && !('snapshotAt' in agent) && !('outputs' in agent),
    )
    record(
      'summary',
      summary.agents.length === 3 && ids === 'claude,codex,dsh' && noGuiFields,
      `${summary.agents.length} agents [${ids}]，无 GUI 字段；${ms}ms`,
      ms,
    )
    record(
      'agent-registry',
      AGENTS.length === 3 && AGENTS.every((agent) => agent.kind === 'code'),
      AGENTS.map((agent) => `${agent.id}:${agent.kind}`).join(' '),
    )
  } catch (error) {
    record('summary', false, String((error && error.message) || error))
    return
  }

  // ---- 2) steps ----
  for (const agent of summary.agents) {
    const started = Date.now()
    try {
      const data = await getSteps(agent.id, 3)
      const ms = Date.now() - started
      const brief = data.steps.map((step) => `${step.role}:${clip(step.text, 40)}`).join(' / ')
      console.log(`\n== steps ${agent.id}（${ms}ms，${data.steps.length} 条）==\n      ${brief || '（空）'}`)
      report.steps[agent.id] = data.steps.map((step) => ({ at: step.at, role: step.role, text: clip(step.text, 100) }))
      record(`steps:${agent.id}`, Array.isArray(data.steps) && data.steps.length <= 3, `${data.steps.length} steps, ${ms}ms`, ms)
    } catch (error) {
      record(`steps:${agent.id}`, false, String((error && error.message) || error))
    }
  }

  // ---- 3) 未知 agent 的错误形状 ----
  try {
    await getSteps('nobody', 3)
    record('unknown-agent', false, '本应抛 UNKNOWN_AGENT，却没有')
  } catch (error) {
    record('unknown-agent', error && error.code === 'UNKNOWN_AGENT', `code=${error && error.code}`)
  }
  try {
    await getSteps('grokbot', 3)
    record('removed-agent', false, 'grokbot 本应已被移除')
  } catch (error) {
    record('removed-agent', error && error.code === 'UNKNOWN_AGENT', `grokbot 已移除：code=${error && error.code}`)
  }

  // ---- 4) 飞书提醒：中台配置 / 默认阈值 / DRY_RUN ----
  try {
    try {
      const hub = readHubConfig()
      record('notify:hub-config', /^https?:\/\//.test(hub.url), `url=${clip(hub.url, 40)} source=已配置（不打印）`)
    } catch (error) {
      // 没装 agent-autoloop 的机器上，按预期降级（不抛到插件启动）
      record('notify:hub-config', ['NOT_INSTALLED', 'NO_SOURCE'].includes(error.code), `降级 code=${error.code}`)
    }
    const defaults = readNotifyConfig('/tmp/__agent_observer_no_such_notify.json')
    record(
      'notify:defaults',
      defaults.enabled === true &&
        defaults.intervalSec === 120 &&
        defaults.cooldownSec === 3600 &&
        defaults.reportEnabled === true &&
        defaults.reportIntervalSec === 1800 &&
        defaults.quietHours.start === 23 &&
        defaults.quietHours.end === 8,
      `enabled=${defaults.enabled} interval=${defaults.intervalSec}s cooldown=${defaults.cooldownSec}s ` +
        `report=${defaults.reportIntervalSec}s quiet=${defaults.quietHours.start}-${defaults.quietHours.end}`,
    )
    const dry = await sendTell({ key: 'obs-selftest-dryrun', text: 'Agent 观察台 lite 测试（DRY_RUN=1，不真发）' })
    record('notify:dry-run', dry.dryRun === true && dry.sent === false, 'DRY_RUN=1 不打网络')
    let badKeyCode = ''
    try {
      await sendTell({ key: 'BAD KEY', text: 'x' })
    } catch (error) {
      badKeyCode = error && error.code
    }
    record('notify:bad-key', badKeyCode === 'BAD_KEY', `code=${badKeyCode || '(没抛)'}`)
    const key = notifyKey('codex', 'error', 490123)
    record('notify:key', /^obs-codex-error-\d+$/.test(key), key)
    // 配置覆盖：周期汇报开关/间隔/免打扰（支持 "23:00-08:00" 字符串）
    const configDir = mkdtempSync(path.join(tmpdir(), 'agent-observer-config-'))
    const configPath = path.join(configDir, 'notify.json')
    writeFileSync(configPath, JSON.stringify({ reportEnabled: false, reportIntervalSec: 600, quietHours: '23:00-08:00' }))
    const customConfig = readNotifyConfig(configPath)
    record(
      'report:config',
      customConfig.reportEnabled === false &&
        customConfig.reportIntervalSec === 600 &&
        customConfig.quietHours.start === 23 &&
        customConfig.quietHours.end === 8,
      `reportEnabled=${customConfig.reportEnabled} interval=${customConfig.reportIntervalSec}s quiet=${customConfig.quietHours.start}-${customConfig.quietHours.end}`,
    )
  } catch (error) {
    record('notify:config', false, String((error && error.message) || error))
  }

  // ---- 5) watchTick：异常判定 / 冷却 / 状态文件（假 summary + /tmp，DRY_RUN）----
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-observer-selftest-'))
    const stateFile = path.join(dir, 'notify-state.json')
    const configFile = path.join(dir, 'notify.json')
    const fakeAgent = (id, name, status, detail = '') => ({
      id,
      name,
      kind: 'code',
      running: status === 'working',
      status,
      lastActivityAt: null,
      ageSec: null,
      session: null,
      step: '',
      detail,
    })
    const fakeSummary = (agents) => ({ generatedAt: new Date().toISOString(), agents })
    const baseline = () => [
      fakeAgent('claude', 'Claude', 'working'),
      fakeAgent('codex', 'Codex', 'idle'),
      fakeAgent('dsh', 'DSH', 'working'),
    ]
    const t0 = Date.now()
    const tick1 = await watchTick({ summary: fakeSummary(baseline()), stateFile, configFile, now: t0 })
    const stateAfter1 = JSON.parse(readFileSync(stateFile, 'utf8'))
    record(
      'notify:tick-baseline',
      tick1.baseline.length === 3 && tick1.pushed.length === 0 && stateAfter1.agents.dsh.status === 'working',
      `首次只写基线，不推（state=${path.basename(stateFile)}）`,
    )
    // lite 已移除 GUI 掉线判定：code agent 从 idle 掉到 offline 只是「很久没活动」，不该推提醒。
    const offlineFixture = baseline()
    offlineFixture[1] = fakeAgent('codex', 'Codex', 'offline')
    const tick2 = await watchTick({ summary: fakeSummary(offlineFixture), stateFile, configFile, now: t0 + 120_000 })
    record('notify:offline-silent', tick2.pushed.length === 0, `idle→offline 不推（pushed=${tick2.pushed.length}）`)
    const errorFixture = baseline()
    errorFixture[2] = fakeAgent('dsh', 'DSH', 'error', '模拟采集失败：permission denied')
    const tick3 = await watchTick({ summary: fakeSummary(errorFixture), stateFile, configFile, now: t0 + 240_000 })
    const tick4 = await watchTick({ summary: fakeSummary(errorFixture), stateFile, configFile, now: t0 + 300_000 })
    record(
      'notify:error+cooldown',
      tick3.pushed.some((push) => push.kind === 'error' && /^obs-dsh-error-\d+$/.test(push.key)) &&
        tick4.pushed.length === 0 &&
        tick4.suppressed.some((item) => item.kind === 'error'),
      `t3=${tick3.pushed.map((push) => push.kind).join('/') || '—'}，t4 冷却 ${tick4.suppressed.length} 条`,
    )
    const tick5 = await watchTick({ summary: fakeSummary(baseline()), stateFile, configFile, now: t0 + 360_000 })
    const recoveryPushes = tick5.pushed.filter((push) => push.kind === 'recovery')
    record(
      'notify:recovery',
      recoveryPushes.length === 1 && recoveryPushes[0].agent === 'dsh',
      tick5.pushed.map((push) => `${push.agent}:${push.kind}`).join('/') || '(没推)',
    )
    const persisted = readNotifyState(stateFile)
    record(
      'notify:state-persist',
      persisted.agents.dsh &&
        persisted.agents.dsh.status === 'working' &&
        Boolean(persisted.agents.dsh.lastKinds.error) &&
        persisted.pushes.length >= 2,
      `落盘 ${persisted.pushes.length} 条推送记录，重启不重复`,
    )
    writeFileSync(configFile, JSON.stringify({ enabled: false }))
    const disabled = await watchTick({ summary: fakeSummary(errorFixture), stateFile, configFile, now: t0 + 540_000 })
    record('notify:disabled', disabled.skipped === 'disabled' && disabled.pushed.length === 0, 'enabled=false 直接跳过')
    const view = notifyStateView({ stateFile, configFile })
    record(
      'notify:state-view',
      typeof view.enabled === 'boolean' &&
        Number.isFinite(view.intervalSec) &&
        Number.isFinite(view.cooldownSec) &&
        Object.prototype.hasOwnProperty.call(view, 'lastState') &&
        Array.isArray(view.lastPushes),
      `interval=${view.intervalSec}s cooldown=${view.cooldownSec}s pushes=${view.lastPushes.length}`,
    )
  } catch (error) {
    record('notify:tick', false, String((error && error.message) || error))
  }

  // ---- 6) HTTP 路由回归：notify 路由 + summary/steps + snapshot 路由必须不存在 ----
  let routeServer = null
  try {
    // 路由测试用 /tmp 的配置/状态文件，绝不碰真实 ~/.cache；DRY_RUN=1 保证不真发。
    const routeDir = mkdtempSync(path.join(tmpdir(), 'agent-observer-routes-'))
    process.env.AGENT_OBSERVER_NOTIFY_CONFIG = path.join(routeDir, 'notify.json')
    process.env.AGENT_OBSERVER_NOTIFY_STATE = path.join(routeDir, 'notify-state.json')
    const routes = new Map()
    const effects = []
    const fakeCtx = {
      tools: { register: () => () => {} },
      inject: (_deps, factory) => {
        factory({
          webServer: {
            register: (route) => {
              routes.set(route.path, route)
              return () => {}
            },
          },
        })
      },
      effect: (factory) => {
        const dispose = factory()
        if (typeof dispose === 'function') effects.push(dispose)
      },
    }
    apply(fakeCtx)
    // 提醒循环只为真实 Host 服务：自测注册后立刻停掉，绝不让后台 tick 落真实状态。
    for (const dispose of effects) dispose()

    routeServer = createServer((request, response) => {
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
      const exact = routes.get(pathname)
      const prefix = routes.get('/agents')
      const route = exact && exact.kind === 'exact' ? exact : prefix && prefix.kind === 'prefix' ? prefix : null
      if (!route) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        return response.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '没有这个路由' } }))
      }
      Promise.resolve(route.handler(request, response)).catch((error) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: { message: String((error && error.message) || error) } }))
      })
    })
    await new Promise((resolve) => routeServer.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${routeServer.address().port}`
    const requestJson = async (pathname, options) => {
      const response = await fetch(`${origin}${pathname}`, options)
      return { status: response.status, body: await response.json() }
    }
    const notifyStateRoute = await requestJson('/agents/notify/state')
    record(
      'route:notify-state',
      notifyStateRoute.status === 200 &&
        notifyStateRoute.body.ok === true &&
        typeof notifyStateRoute.body.data.intervalSec === 'number' &&
        Object.prototype.hasOwnProperty.call(notifyStateRoute.body.data, 'lastState'),
      `interval=${notifyStateRoute.body.data.intervalSec}s`,
    )
    const notifyTestRoute = await requestJson('/agents/notify/test', { method: 'POST' })
    record(
      'route:notify-test',
      notifyTestRoute.status === 200 && notifyTestRoute.body.ok === true && notifyTestRoute.body.data.dryRun === true,
      'DRY_RUN=1 只走 dry-run',
    )
    const reportRoute = await requestJson('/agents/notify/report', { method: 'POST' })
    record(
      'route:notify-report',
      reportRoute.status === 200 &&
        reportRoute.body.ok === true &&
        reportRoute.body.data.dryRun === true &&
        /^obs-report-\d{8}-\d{2}$/.test(reportRoute.body.data.key || '') &&
        String(reportRoute.body.data.text || '').includes('【Agent 运行汇报】'),
      `key=${reportRoute.body.data.key}`,
    )
    const stateAfterReport = await requestJson('/agents/notify/state')
    record(
      'route:notify-state-report',
      stateAfterReport.status === 200 &&
        stateAfterReport.body.data.report &&
        stateAfterReport.body.data.report.enabled === true &&
        stateAfterReport.body.data.report.intervalSec === 1800 &&
        Boolean(stateAfterReport.body.data.report.lastReportAt) &&
        typeof stateAfterReport.body.data.report.nextDueAt === 'string',
      `interval=${stateAfterReport.body.data.report.intervalSec}s quietHours=${JSON.stringify(stateAfterReport.body.data.report.quietHours)}`,
    )
    const summaryRoute = await requestJson('/agents/summary')
    record(
      'route:summary',
      summaryRoute.status === 200 && summaryRoute.body.ok === true && summaryRoute.body.data.agents.length === 3,
      `${summaryRoute.body.data.agents.length} agents`,
    )
    const stepsRoute = await requestJson('/agents/dsh/steps?limit=1')
    record('route:steps', stepsRoute.status === 200 && stepsRoute.body.ok === true, `${stepsRoute.body.data.steps.length} steps`)
    const unknownRoute = await requestJson('/agents/notify')
    record(
      'route:notify-404',
      unknownRoute.status === 404 && unknownRoute.body.error && unknownRoute.body.error.code === 'NOT_FOUND',
      `HTTP ${unknownRoute.status}`,
    )
    const wrongMethod = await requestJson('/agents/notify/state', { method: 'POST' })
    record(
      'route:notify-405',
      wrongMethod.status === 405 && wrongMethod.body.error && wrongMethod.body.error.code === 'METHOD',
      `HTTP ${wrongMethod.status}`,
    )
    const reportGet = await requestJson('/agents/notify/report')
    record(
      'route:notify-report-405',
      reportGet.status === 405 && reportGet.body.error && reportGet.body.error.code === 'METHOD',
      `HTTP ${reportGet.status}`,
    )
    // lite 版必须没有截图/OCR 路由
    const snapshotPost = await requestJson('/agents/claude/snapshot', { method: 'POST' })
    const snapshotGet = await requestJson('/agents/claude/snapshot.png')
    record(
      'route:snapshot-gone',
      snapshotPost.status === 404 &&
        snapshotGet.status === 404 &&
        snapshotPost.body.error.code === 'NOT_FOUND' &&
        snapshotGet.body.error.code === 'NOT_FOUND',
      `POST snapshot HTTP ${snapshotPost.status} · GET snapshot.png HTTP ${snapshotGet.status}`,
    )
  } catch (error) {
    record('route:notify', false, String((error && error.message) || error))
  } finally {
    if (routeServer) await new Promise((resolve) => routeServer.close(resolve))
  }

  // ---- 7) 周期汇报 / 全量概览 / 免打扰（DRY_RUN=1，假 summary + /tmp）----
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-observer-report-'))
    const fakeAgent = (id, name, status, extra = {}) => ({
      id,
      name,
      kind: 'code',
      running: status === 'working',
      status,
      lastActivityAt: null,
      ageSec: extra.ageSec ?? null,
      session: extra.session || null,
      step: extra.step || '',
      detail: extra.detail || '',
    })
    const reportAgents = () => [
      fakeAgent('claude', 'Claude', 'idle', {
        ageSec: 1260,
        session: { title: '手表 copy' },
        step: '整理美国/迪拜发布节点',
      }),
      fakeAgent('codex', 'Codex', 'idle', {
        ageSec: 3120,
        session: { title: 'gif 表情包开发' },
        step: '检查 4 张旧版 GIF',
      }),
      fakeAgent('dsh', 'DSH', 'working', {
        session: { title: 'Agent-autoloop 逻辑与 DPH 插件方案' },
        step: '调用工具 bash',
      }),
    ]
    const reportNow = new Date(2026, 10, 6, 15, 30, 0).getTime()
    const reportConfig = { ...DEFAULT_CONFIG, quietHours: { start: 23, end: 8 } }
    const summaryOf = (agents) => ({ generatedAt: new Date(reportNow).toISOString(), agents })
    const kinds = (list) => collectProblems(list).map((item) => [item.id, item.kind])

    const agents = reportAgents()
    const reportText = buildReportText({ agents, problems: collectProblems(agents), now: reportNow, config: reportConfig })
    record(
      'report:text',
      reportText.startsWith('【Agent 运行汇报】') &&
        agents.every((agent) => reportText.includes(agent.name)) &&
        reportText.includes('✅ 全部 3 个正常。') &&
        reportText.length <= 2000 &&
        !reportText.includes('|') &&
        !/Grok|Muse/.test(reportText),
      `${reportText.length} 字，3 行现状 + 问题小节`,
    )

    // 问题判定 fixture：采集 error / 最近步骤疑似报错 / 全正常
    const errorFixture = reportAgents()
    errorFixture[1] = fakeAgent('codex', 'Codex', 'error', { detail: '采集失败：timeout' })
    const suspectedFixture = reportAgents()
    suspectedFixture[0] = fakeAgent('claude', 'Claude', 'idle', {
      ageSec: 60,
      session: { title: 'x' },
      step: '运行测试失败：TypeError: cannot read property foo。接下来重试',
    })
    record(
      'report:problems',
      JSON.stringify(kinds(reportAgents())) === '[]' &&
        kinds(errorFixture).some((item) => item[0] === 'codex' && item[1] === 'error') &&
        kinds(suspectedFixture).some((item) => item[0] === 'claude' && item[1] === 'suspected'),
      `error=${JSON.stringify(kinds(errorFixture))} suspected=${JSON.stringify(kinds(suspectedFixture))}`,
    )

    const errorText = buildReportText({
      agents: errorFixture,
      problems: collectProblems(errorFixture),
      now: reportNow,
      config: reportConfig,
    })
    record(
      'report:error-line',
      errorText.includes('⚠️ 问题：Codex 读不到') && errorText.includes('其余 2 个正常。'),
      '问题小节点名读不到 + 其余正常数',
    )

    const alertText = buildAlertText({
      kind: 'error',
      reason: '读不到（采集失败：timeout）',
      agent: errorFixture[1],
      agents: errorFixture,
      problems: collectProblems(errorFixture),
      now: reportNow,
      config: reportConfig,
    })
    const recoveryText = buildAlertText({
      kind: 'recovery',
      reason: '正在干活',
      agent: agents[2],
      agents,
      problems: collectProblems(agents),
      now: reportNow,
      config: reportConfig,
    })
    record(
      'report:alert-format',
      alertText.startsWith('⚠️ Agent 异常：Codex 读不到') &&
        alertText.includes('【Agent 现状】') &&
        alertText.includes('⚠️ 问题：') &&
        recoveryText.startsWith('✅ Agent 恢复：DSH 已恢复'),
      '即时提醒点名异常 + 同样带全量现状',
    )

    const sampleKey = reportKey(reportNow)
    record('report:key', /^obs-report-\d{8}-\d{2}$/.test(sampleKey), sampleKey)

    // 到期/基线/状态更新（非免打扰）：首次只写基线，30 分钟后发，之后 30 分钟内不再发
    const stateFile = path.join(dir, 'notify-state.json')
    const t0 = new Date(2026, 10, 6, 10, 0, 0).getTime()
    const tickBaseline = await watchTick({ summary: summaryOf(reportAgents()), stateFile, config: reportConfig, now: t0 })
    const baselineState = readNotifyState(stateFile)
    const tickNotDue = await watchTick({ summary: summaryOf(reportAgents()), stateFile, config: reportConfig, now: t0 + 120_000 })
    const tickDue = await watchTick({ summary: summaryOf(reportAgents()), stateFile, config: reportConfig, now: t0 + 1800_000 })
    const dueState = readNotifyState(stateFile)
    const tickNotDueAgain = await watchTick({
      summary: summaryOf(reportAgents()),
      stateFile,
      config: reportConfig,
      now: t0 + 1800_000 + 120_000,
    })
    record(
      'report:lifecycle',
      tickBaseline.report &&
        tickBaseline.report.skipped === 'baseline' &&
        !baselineState.lastReportAt &&
        tickNotDue.report === null &&
        tickDue.report &&
        tickDue.report.dryRun === true &&
        /^obs-report-\d{8}-\d{2}$/.test(tickDue.report.key || '') &&
        Boolean(dueState.lastReportAt) &&
        tickNotDueAgain.report === null,
      `baseline→30min 后 ${tickDue.report ? tickDue.report.key : '(没发)'}，状态已更新`,
    )

    // 免打扰跳过：10:00 基线 → 到期 10:30，但 23:30 实测在免打扰 → quiet；次日 08:05 才补发
    const quietStateFile = path.join(dir, 'notify-state-quiet.json')
    const quietDay = new Date(2026, 10, 6, 10, 0, 0).getTime()
    await watchTick({ summary: summaryOf(reportAgents()), stateFile: quietStateFile, config: reportConfig, now: quietDay })
    const quietTick = await watchTick({
      summary: summaryOf(reportAgents()),
      stateFile: quietStateFile,
      config: reportConfig,
      now: new Date(2026, 10, 6, 23, 30, 0).getTime(),
    })
    const quietState = readNotifyState(quietStateFile)
    const afterQuiet = await watchTick({
      summary: summaryOf(reportAgents()),
      stateFile: quietStateFile,
      config: reportConfig,
      now: new Date(2026, 10, 7, 8, 5, 0).getTime(),
    })
    record(
      'report:quiet-hours',
      quietTick.report &&
        quietTick.report.skipped === 'quiet' &&
        !quietState.lastReportAt &&
        afterQuiet.report &&
        afterQuiet.report.dryRun === true &&
        isQuietHour(new Date(2026, 10, 6, 23, 0, 0).getTime(), reportConfig.quietHours) &&
        !isQuietHour(new Date(2026, 10, 7, 8, 0, 0).getTime(), reportConfig.quietHours),
      '23:30 跳过；次日 08:05 补发',
    )

    // 手动触发：忽略免打扰；DRY_RUN 下也按「已处理」更新状态（便于自测）
    const manualStateFile = path.join(dir, 'notify-state-manual.json')
    const manual = await sendManualReport({
      summary: summaryOf(reportAgents()),
      stateFile: manualStateFile,
      config: reportConfig,
      now: new Date(2026, 10, 6, 23, 40, 0).getTime(),
    })
    const manualState = readNotifyState(manualStateFile)
    record(
      'report:manual',
      manual.dryRun === true &&
        /^obs-report-\d{8}-\d{2}$/.test(manual.key) &&
        manual.text.includes('【Agent 运行汇报】') &&
        manual.text.includes('DSH') &&
        manual.text.length <= 2000 &&
        Boolean(manualState.lastReportAt),
      `key=${manual.key}，状态已更新`,
    )

    const view = notifyStateView({ stateFile: quietStateFile, config: reportConfig, now: quietDay })
    record(
      'report:state-view',
      view.report &&
        view.report.enabled === true &&
        view.report.intervalSec === 1800 &&
        typeof view.report.lastReportAt === 'string' &&
        typeof view.report.quietHours.start === 'number' &&
        typeof view.report.nextDueAt === 'string',
      `nextDueAt=${clip(view.report.nextDueAt, 30)}`,
    )
  } catch (error) {
    record('report', false, String((error && error.message) || error))
  }

  // 提醒相关只留「测试名 + 结果 + 截断 detail」，不贴推送正文以外的私有内容。
  report.notify = {
    dryRun: process.env.DRY_RUN === '1',
    tests: results
      .filter(
        (item) =>
          item.name.startsWith('notify:') || item.name.startsWith('report:') || item.name.startsWith('route:notify'),
      )
      .map((item) => ({ name: item.name, ok: item.ok, detail: clip(item.detail, 90) })),
  }

  // 契约要求的「截断后的 JSON」：每段 text ≤100 字，可直接贴进 README/issue
  console.log('\n== 截断后的 JSON ==')
  console.log(JSON.stringify(report, null, 1))

  const failed = results.filter((item) => !item.ok)
  console.log(`\n== 结果：${results.length - failed.length}/${results.length} 通过 ==`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
