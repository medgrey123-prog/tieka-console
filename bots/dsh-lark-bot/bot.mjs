#!/usr/bin/env node
/**
 * dsh-lark-bot —— 用 Lark 消息遥控 DeepSeek Harness
 *
 *   Lark 用户消息
 *      └─(WebSocket 长连接, lark-cli event consume)→ 本进程
 *            ├─ 白名单 / 去重 / 斜杠命令
 *            ├─ 每个会话(chat) ←→ 一个 DSH session（上下文连续）
 *            └─ dsh --profile headless --json "<消息>" → 进度实时回写 + 最终结果回传
 *
 * 用法:
 *   node bot.mjs                 常驻（后台/launchd）
 *   node bot.mjs --simulate "文本" 自测：走完整执行+回传链路，不需要真的发 Lark 消息
 *   node bot.mjs --status        打印运行状态
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const ROOT = path.join(HOME, '.dsh-lark-bot');
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(ROOT, 'state.json');
const PID_FILE = path.join(ROOT, 'bot.pid');

for (const d of [ROOT, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

// ─────────────────────────── 平台与二进制解析 ───────────────────────────
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

/** 粗略探测 npm 全局 node_modules 根目录（覆盖 Windows / macOS / Homebrew / npm prefix） */
function npmGlobalRoots() {
  const roots = [];
  if (IS_WIN) {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'));
  }
  roots.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
  if (!IS_WIN) {
    roots.push(path.join(HOME, '.npm-global', 'lib', 'node_modules'));
    roots.push('/usr/local/lib/node_modules');
    roots.push('/opt/homebrew/lib/node_modules');
  }
  return [...new Set(roots.map((p) => path.resolve(p)))];
}

function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return '';
}

function detectDshEntry() {
  const rel = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return firstExisting(npmGlobalRoots().map((r) => path.join(r, rel)));
}

function detectLarkBin() {
  const rel = path.join('@larksuite', 'cli', 'bin', 'lark-cli') + EXE;
  return firstExisting(npmGlobalRoots().map((r) => path.join(r, rel)));
}

// ─────────────────────────── 配置 ───────────────────────────
const DEFAULT_CONFIG = {
  dshProfile: 'headless', // 用哪个 DSH profile 执行
  dshEntry: '', // DSH 的 lib/bin.js 绝对路径（推荐，跨平台最稳）
  dshBin: '', // 兼容：dsh 可执行文件路径（.js 结尾也可）
  larkBin: '', // lark-cli 原生二进制绝对路径
  workdir: IS_WIN ? path.join(HOME, 'Documents') : path.join(HOME, 'Documents/DeepSeek-Harness'),
  allowedUsers: [], // open_id 白名单；留空 = 只允许 ownerOpenId
  ownerOpenId: '', // 主人 open_id
  allowGroups: false, // 是否允许群聊消息
  maxConcurrency: 1, // 同时执行的任务数
  taskTimeoutMs: 30 * 60 * 1000, // 单任务超时
  progressIntervalMs: 8000, // 进度回写间隔
  maxProgressEdits: 40, // 单条 ack 最多编辑次数（防接口限流）
  finalInlineMaxChars: 2500, // 最终答案 <= 此长度时直接编辑进 ack 气泡
  chunkChars: 3500, // 长答案分段长度
  maxMessageAgeMs: 15 * 60 * 1000, // 超过这个年龄的消息不执行（防重启后处理旧指令）
  testChatId: '', // --simulate 用
  logRetentionDays: 7,
};

// ─── tieka-console 套件补丁：配置路径 ────────────────────────────────
// 优先级：$DSH_LARK_BOT_CONFIG > ~/.dsh-lark-bot/config.json > 本文件同目录 config.json。
// 套件把配置放在 ~/.dsh-lark-bot/（与运行状态、日志同目录），源码目录只放 config.example.json；
// 上游布局（配置在源码目录）仍然兼容。--init / --doctor / 启动都按同一路径。
const CONFIG_HOME = path.join(ROOT, 'config.json');
const CONFIG_LEGACY = path.join(__dirname, 'config.json');
const CONFIG_CANDIDATES = [process.env.DSH_LARK_BOT_CONFIG, CONFIG_HOME, CONFIG_LEGACY].filter(Boolean);

const CONFIG_PATH =
  CONFIG_CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) || CONFIG_HOME;


function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cfg = { ...cfg, ...JSON.parse(raw) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`config.json 解析失败，用默认值: ${e.message}`);
  }
  // 二进制解析：显式配置优先，否则自动探测
  if (!cfg.dshEntry) {
    if (/\.js$/i.test(cfg.dshBin || '')) cfg.dshEntry = cfg.dshBin;
    else cfg.dshEntry = detectDshEntry();
  }
  if (cfg.dshEntry) cfg.dshBin = '';
  if (!cfg.larkBin) cfg.larkBin = detectLarkBin() || 'lark-cli';
  if (!cfg.allowedUsers?.length) cfg.allowedUsers = [cfg.ownerOpenId].filter(Boolean);
  return cfg;
}

const CFG = loadConfig();

/** 把「命令 + 参数」解析成可直接 spawn 的 {file, args}，兼容 .js / .cmd / 原生可执行 */
function resolveCmd(cmd, args) {
  if (!cmd) throw new Error('空命令');
  if (/\.js$/i.test(cmd)) return { file: process.execPath, args: [cmd, ...args] };
  if (IS_WIN && /\.(cmd|bat)$/i.test(cmd)) {
    const quoted = [cmd, ...args].map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', quoted], verbatim: true };
  }
  return { file: cmd, args };
}

const ENV = {
  ...process.env,
  HOME,
  USERPROFILE: process.env.USERPROFILE || HOME,
  PATH: [
    CFG.dshEntry ? path.dirname(CFG.dshEntry) : '',
    CFG.larkBin ? path.dirname(CFG.larkBin) : '',
    path.dirname(process.execPath),
    ...(IS_WIN
      ? [path.join(process.env.APPDATA || '', 'npm'), 'C:\\Windows\\System32', 'C:\\Windows']
      : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
  ]
    .filter(Boolean)
    .join(path.delimiter),
};

// ─────────────────────────── 日志 ───────────────────────────
let logStream = null;
let logDay = '';
function logAt(level, msg) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (day !== logDay) {
    try {
      logStream?.end();
    } catch {}
    logStream = fs.createWriteStream(path.join(LOG_DIR, `bot-${day}.log`), { flags: 'a' });
    logDay = day;
    pruneLogs();
  }
  const line = `${now.toISOString()} [${level}] ${msg}`;
  try {
    logStream?.write(line + '\n');
  } catch {}
  if (process.stdout.isTTY) process.stdout.write(line + '\n');
}
const log = (level, msg) => logAt(level, msg);
const logInfo = (m) => log('INFO', m);
const logErr = (m) => log('ERROR', m);

function pruneLogs() {
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.startsWith('bot-') && f.endsWith('.log'))
      .sort();
    const keep = CFG.logRetentionDays || 7;
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch {}
}

// ─────────────────────────── 状态 ───────────────────────────
const state = { chats: {}, seen: [] };
const seen = new Set();

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(state, raw);
    for (const id of state.seen || []) seen.add(id);
  } catch {}
}
let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    state.seen = [...seen].slice(-800);
    const tmp = STATE_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      logErr(`保存状态失败: ${e.message}`);
    }
  }, 400);
}
function markSeen(messageId) {
  seen.add(messageId);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
  saveState();
}

function chatState(chatId) {
  if (!state.chats[chatId]) state.chats[chatId] = {};
  return state.chats[chatId];
}

// ─────────────────────────── 进程锁 ───────────────────────────
function acquireLock() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (pid && pid !== process.pid && isAlive(pid)) {
      logErr(`已有实例在跑 (pid ${pid})，退出`);
      process.exit(0);
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
}
function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────── 子进程工具 ───────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const { file, args: argv, verbatim } = resolveCmd(cmd, args);
      child = spawn(file, argv, {
        cwd: opts.cwd || HOME,
        env: ENV,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: !!verbatim,
      });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e) });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, opts.timeout || 60000);
    if (opts.input !== undefined) {
      try {
        child.stdin.write(opts.input);
        child.stdin.end();
      } catch {}
    } else {
      try {
        child.stdin.end();
      } catch {}
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** 从 stdout / stderr 里都尝试解析 lark-cli 的 JSON 信封 */
function parseLarkJson(raw) {
  const txt = (raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {}
  // 逐行找 JSON 对象
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{')) continue;
    try {
      return JSON.parse(l);
    } catch {}
  }
  // 多行 pretty JSON：从第一个 { 截取
  const start = txt.indexOf('{');
  if (start >= 0) {
    try {
      return JSON.parse(txt.slice(start));
    } catch {}
  }
  return null;
}

/** Windows 下优雅终止整棵进程树 */
function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

async function larkOnce(args, opts = {}) {
  const fullArgs = [...args];
  const res = await run(CFG.larkBin, fullArgs, { timeout: opts.timeout || 60000, input: opts.input });
  // lark-cli 失败时可能把 JSON 信封打到 stderr，两处都试
  const json = parseLarkJson(res.out) || parseLarkJson(res.err);
  const ok = json?.ok !== false && res.code === 0;
  if (!ok) {
    const detail = json?.error ? JSON.stringify(json.error).slice(0, 300) : (res.err || res.out).slice(0, 300);
    logErr(`lark-cli ${args[0]} ${args[1] || ''} 失败 exit=${res.code}: ${detail}`);
  }
  return { ok, json, raw: res.out, err: res.err, code: res.code };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带重试的 lark-cli 调用（429 / 可重试错误退避重试） */
async function lark(args, opts = {}) {
  const attempts = opts.retries ?? 3;
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await larkOnce(args, opts);
    if (last.ok) return last;
    const code = last.json?.error?.code;
    const retryable = last.json?.error?.retryable === true || code === 429 || code === 99991400;
    if (!retryable || i === attempts - 1) return last;
    const wait = 1000 * 2 ** i + Math.floor(Math.random() * 400);
    logInfo(`lark-cli 可重试错误(${code})，${wait}ms 后重试 (${i + 1}/${attempts - 1})`);
    await sleep(wait);
  }
  return last;
}

/** 发消息，返回 message_id */
async function sendMessage(chatId, markdown) {
  const res = await lark(
    ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--markdown', '-'],
    { input: markdown },
  );
  const id = res.json?.data?.message_id;
  if (!res.ok || !id) logErr(`发消息失败 chat=${chatId}: ${(res.err || res.raw).slice(0, 300)}`);
  return id || null;
}

/** 编辑消息（bot 身份） */
async function editMessage(messageId, markdown) {
  const res = await lark(
    ['im', '+messages-edit', '--as', 'bot', '--message-id', messageId, '--markdown', '-'],
    { input: markdown },
  );
  return res.ok;
}

// ─────────────────────────── 文本工具 ───────────────────────────
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${r ? r + 's' : ''}`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function oneLine(text, max = 150) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function splitChunks(text, size) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };
  for (const rawLine of String(text).split('\n')) {
    let line = rawLine;
    while (line.length > size) {
      flush();
      out.push(line.slice(0, size));
      line = line.slice(size);
    }
    if (buf.length + line.length + 1 > size) flush();
    buf = buf ? buf + '\n' + line : line;
  }
  flush();
  return out.length ? out : [''];
}

const HELP_TEXT = `🤖 **DSH 机器人** · 用 Lark 遥控 DeepSeek Harness

**直接发消息** = 给 DSH 派活（我会真的执行：跑命令、改文件、查资料…）
同一对话内**保持上下文**，可以连续追问。

**斜杠命令**
\`/new\` 开新会话（清空上下文）
\`/stop\` 停止正在执行的任务
\`/status\` 查看会话与队列状态
\`/cwd <目录>\` 切换工作目录
\`/whoami\` 查看我的 open_id
\`/help\` 显示本帮助

💡 长任务会实时更新进度，完成后结果直接回在这个对话里。`;

// ─────────────────────────── 任务调度 ───────────────────────────
const queues = new Map(); // chatId -> { items: [], running: false, current: null }
let activeCount = 0;

function getQueue(chatId) {
  if (!queues.has(chatId)) queues.set(chatId, { items: [], running: false, current: null });
  return queues.get(chatId);
}

function enqueue(task) {
  const q = getQueue(task.chatId);
  const busy = q.running || activeCount >= CFG.maxConcurrency;
  q.items.push(task);
  if (busy) {
    sendMessage(
      task.chatId,
      `⏳ 已排队（第 ${q.items.length} 位${q.running ? '，当前任务执行中' : ''}）`,
    ).catch(() => {});
  }
  pump();
}

function pump() {
  if (activeCount >= CFG.maxConcurrency) return;
  for (const [chatId, q] of queues) {
    if (q.running || q.items.length === 0) continue;
    const task = q.items.shift();
    q.running = true;
    q.current = task;
    task.startedAt = Date.now();
    activeCount++;
    runTask(task)
      .catch((e) => logErr(`任务异常: ${e.stack || e}`))
      .finally(() => {
        q.running = false;
        q.current = null;
        activeCount--;
        pump();
      });
    if (activeCount >= CFG.maxConcurrency) return;
  }
}

// ─────────────────────────── 执行任务 ───────────────────────────
async function runTask(task) {
  const { chatId, text, senderId } = task;
  const cs = chatState(chatId);
  const startedAt = Date.now();

  const ackId = await sendMessage(chatId, `🤔 收到，开始执行…\n> ${oneLine(text, 100)}`);
  const progress = {
    steps: 0,
    lastTool: '',
    lastToolInput: '',
    textBuf: '',
    thinkingChars: 0,
    timer: null,
    editing: false,
    edits: 0,
    lastRender: '',
    stopped: false,
  };

  // ── 启动 dsh ──
  const spawnDsh = (sessionId) => {
    const args = ['--profile', CFG.dshProfile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push(text);
    const { file, args: argv, verbatim } = resolveCmd(CFG.dshEntry || CFG.dshBin || 'dsh', args);
    return spawn(file, argv, {
      cwd: cs.cwd || CFG.workdir,
      env: ENV,
      // POSIX 下独立进程组便于整组 kill；Windows 用 taskkill /T
      detached: !IS_WIN,
      windowsVerbatimArguments: !!verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };

  let child = spawnDsh(cs.sessionId);
  let sawSession = false;
  let finalText = null;
  let stderrBuf = '';
  let timedOut = false;
  let interrupted = false;

  const killChild = () => {
    killTree(child, 'SIGTERM');
    setTimeout(() => killTree(child, 'SIGKILL'), 5000);
  };

  // 供 /stop 精准中断
  task.interrupt = () => {
    interrupted = true;
    logInfo(`收到 /stop，中断任务 chat=${chatId}`);
    killChild();
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    logErr(`任务超时 chat=${chatId}`);
    killChild();
  }, CFG.taskTimeoutMs);

  const attach = (proc) => {
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        return;
      }
      switch (ev.type) {
        case 'session':
          sawSession = true;
          if (ev.sessionId && ev.sessionId !== cs.sessionId) {
            cs.sessionId = ev.sessionId;
            saveState();
            logInfo(`会话映射 chat=${chatId} → ${ev.sessionId}`);
          }
          if (ev.cwd) cs.cwd = ev.cwd;
          break;
        case 'status':
          if (ev.step) progress.steps = Math.max(progress.steps, ev.step);
          break;
        case 'tool_call': {
          progress.lastTool = ev.tool || '';
          try {
            progress.lastToolInput = oneLine(
              JSON.stringify(ev.input ?? '').replace(/^"|"$/g, ''),
              110,
            );
          } catch {
            progress.lastToolInput = '';
          }
          break;
        }
        case 'text':
          if (ev.text) progress.textBuf += ev.text;
          break;
        case 'thinking':
          progress.thinkingChars += (ev.text || '').length;
          break;
        case 'final':
          if (typeof ev.text === 'string') finalText = ev.text;
          break;
      }
    });
    proc.stderr.on('data', (d) => {
      stderrBuf += d;
      if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-12000);
    });
  };

  attach(child);

  // ── 进度回写 ──
  const renderProgress = () => {
    const elapsed = fmtDuration(Date.now() - startedAt);
    const parts = [`🏃 **执行中** · ${elapsed}`];
    const bits = [];
    if (progress.steps) bits.push(`第 ${progress.steps} 步`);
    if (progress.lastTool) bits.push(`\`${progress.lastTool}\``);
    if (bits.length) parts.push(bits.join(' · '));
    if (progress.lastToolInput) parts.push(`↳ ${progress.lastToolInput}`);
    const tail = oneLine(progress.textBuf.slice(-600), 220);
    if (tail) parts.push(`💬 ${tail}`);
    return parts.join('\n\n');
  };

  const startProgressLoop = () => {
    progress.timer = setInterval(async () => {
      if (progress.stopped || !ackId || progress.editing) return;
      if (progress.edits >= CFG.maxProgressEdits) return;
      const content = renderProgress();
      if (content === progress.lastRender) return;
      progress.lastRender = content;
      progress.editing = true;
      progress.edits++;
      try {
        await editMessage(ackId, content);
      } finally {
        progress.editing = false;
      }
    }, CFG.progressIntervalMs);
  };
  startProgressLoop();

  // ── 等待退出 ──
  const exitInfo = await new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', (e) => resolve({ code: -1, signal: null, error: String(e) }));
  });

  // 会话失效（--session-id 指向不存在的 session）→ 直接重跑一次
  if (!sawSession && exitInfo.code !== 0 && cs.sessionId && !timedOut && !interrupted) {
    const hint = stderrBuf.toLowerCase();
    if (hint.includes('session') || hint.includes('unknown') || hint.includes('not found')) {
      logInfo(`会话 ${cs.sessionId} 不可用，重开新会话 chat=${chatId}`);
      delete cs.sessionId;
      saveState();
      try {
        child = spawnDsh(undefined);
        attach(child);
        const r = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
        exitInfo.code = r.code;
        exitInfo.signal = r.signal;
      } catch (e) {
        logErr(`重开会话失败: ${e.message}`);
      }
    }
  }

  clearTimeout(timeoutTimer);
  progress.stopped = true;
  if (progress.timer) clearInterval(progress.timer);
  const dur = fmtDuration(Date.now() - startedAt);
  const ok = exitInfo.code === 0 && !timedOut && !interrupted;
  const answer = (finalText ?? progress.textBuf).trim();

  logInfo(
    `任务结束 chat=${chatId} ok=${ok} code=${exitInfo.code} dur=${dur} steps=${progress.steps} ` +
      `answerChars=${answer.length} tool=${progress.lastTool}`,
  );

  // ── 回传结果 ──
  const editOrSend = async (md) => {
    if (ackId && progress.edits < CFG.maxProgressEdits + 5) {
      const done = await editMessage(ackId, md);
      if (done) return;
    }
    await sendMessage(chatId, md);
  };

  if (ok) {
    if (!answer) {
      await editOrSend(`✅ **完成** · ${dur}\n\n（任务已执行完成，没有文本输出）`);
      return;
    }
    if (answer.length <= CFG.finalInlineMaxChars) {
      await editOrSend(`✅ **完成** · ${dur}\n\n${answer}`);
    } else {
      const chunks = splitChunks(answer, CFG.chunkChars);
      await editOrSend(`✅ **完成** · ${dur} · 结果较长，分 ${chunks.length} 条发送 ↓`);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `**(${i + 1}/${chunks.length})**\n` : '';
        const id = await sendMessage(chatId, prefix + chunks[i]);
        if (!id) logErr(`分片 ${i + 1} 发送失败 chat=${chatId}`);
      }
    }
    return;
  }

  // 失败
  const reason = timedOut
    ? `超时（>${fmtDuration(CFG.taskTimeoutMs)}）`
    : interrupted
      ? '已被 /stop 中断'
      : `退出码 ${exitInfo.code}${exitInfo.signal ? ` / signal ${exitInfo.signal}` : ''}`;
  const detail = [];
  if (progress.lastTool) detail.push(`**最后动作** \`${progress.lastTool}\` ${progress.lastToolInput}`);
  const snip = oneLine(progress.textBuf.slice(-500), 300);
  if (snip) detail.push(`**过程输出**\n${snip}`);
  const errTail = oneLine(stderrBuf.slice(-800), 500);
  if (errTail) detail.push(`**错误输出**\n\`\`\`\n${errTail}\n\`\`\``);
  await editOrSend(`❌ **执行未完成** · ${dur}\n\n${reason}\n\n${detail.join('\n\n')}`);
}

// ─────────────────────────── 斜杠命令 ───────────────────────────
async function handleCommand(evt, raw) {
  const chatId = evt.chat_id;
  const [cmdRaw, ...rest] = raw.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ').trim();
  const cs = chatState(chatId);

  switch (cmd) {
    case '/help':
    case '/?':
    case '/h':
      await sendMessage(chatId, HELP_TEXT);
      return;
    case '/new':
    case '/clear':
    case '/reset':
      delete cs.sessionId;
      saveState();
      await sendMessage(chatId, '🆕 已开启新会话，之前的上下文不再带入。');
      return;
    case '/stop':
    case '/cancel': {
      const q = getQueue(chatId);
      let stopped = false;
      if (q.current?.interrupt) {
        q.current.interrupt();
        stopped = true;
      }
      const dropped = q.items.length;
      q.items.length = 0;
      await sendMessage(
        chatId,
        stopped || dropped
          ? `🛑 已停止当前任务${dropped ? `，并清空 ${dropped} 个排队任务` : ''}。`
          : '当前没有在执行的任务。',
      );
      return;
    }
    case '/status': {
      const q = getQueue(chatId);
      const lines = [
        '📊 **状态**',
        `- 会话：${cs.sessionId ? `\`${cs.sessionId}\`` : '新会话（未开始）'}`,
        `- 工作目录：\`${cs.cwd || CFG.workdir}\``,
        `- 当前任务：${q.current ? `执行中 ${fmtDuration(Date.now() - (q.current.startedAt || Date.now()))}` : '空闲'}`,
        `- 排队：${q.items.length}`,
        `- 全局并发：${activeCount}/${CFG.maxConcurrency}`,
      ];
      await sendMessage(chatId, lines.join('\n'));
      return;
    }
    case '/cwd':
    case '/cd': {
      if (!arg) {
        await sendMessage(chatId, `当前工作目录：\`${cs.cwd || CFG.workdir}\`\n用法：\`/cwd /绝对路径\``);
        return;
      }
      const p = path.resolve(arg.replace(/^~(?=$|[\\/])/, HOME));
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
        await sendMessage(chatId, `❌ 目录不存在：\`${p}\``);
        return;
      }
      cs.cwd = p;
      saveState();
      await sendMessage(chatId, `📁 工作目录已切换为：\`${p}\`\n（新会话生效；当前上下文保留）`);
      return;
    }
    case '/whoami':
      await sendMessage(
        chatId,
        `🪪 **身份信息**\n- open_id: \`${evt.sender_id}\`\n- chat_id: \`${chatId}\`\n- chat_type: ${evt.chat_type}`,
      );
      return;
    case '/ping':
      await sendMessage(chatId, '🏓 pong');
      return;
    default:
      await sendMessage(chatId, `未知命令 \`${cmdRaw}\`，输入 /help 查看可用命令。`);
  }
}

// ─────────────────────────── 事件接入 ───────────────────────────
function allowed(senderId) {
  return CFG.allowedUsers.includes(senderId);
}

async function handleEvent(evt) {
  if (evt.type !== 'im.message.receive_v1') return;
  const messageId = evt.message_id || evt.id;
  if (!messageId) return;
  if (seen.has(messageId)) return;
  markSeen(messageId);

  if (evt.sender_type !== 'user') return; // 忽略机器人/应用自己发的
  if (!allowed(evt.sender_id)) {
    logInfo(`忽略未授权发送者 ${evt.sender_id} chat=${evt.chat_id}`);
    if (evt.chat_type === 'p2p') {
      await sendMessage(
        evt.chat_id,
        `⛔ 未授权。\n你的 open_id：\`${evt.sender_id}\`\n如需授权，请把这段发给管理员加入白名单。`,
      );
    }
    return;
  }
  if (evt.chat_type !== 'p2p' && !CFG.allowGroups) {
    logInfo(`忽略群消息 chat=${evt.chat_id}（未开启 allowGroups）`);
    return;
  }

  const msgType = evt.message_type || 'text';
  if (msgType !== 'text' && msgType !== 'post') {
    await sendMessage(evt.chat_id, `暂时只支持文本消息（收到的是 \`${msgType}\`）🙂`);
    return;
  }

  const text = String(evt.content || '').trim();
  if (!text) {
    await sendMessage(evt.chat_id, '暂时只支持文本消息 🙂');
    return;
  }

  const age = Date.now() - Number(evt.create_time || evt.timestamp || Date.now());
  if (CFG.maxMessageAgeMs > 0 && age > CFG.maxMessageAgeMs) {
    logInfo(`忽略过期消息 age=${Math.round(age / 1000)}s chat=${evt.chat_id}`);
    await sendMessage(evt.chat_id, '⌛ 这条消息太久了（可能是我重启前的），未执行。请重新发一次。');
    return;
  }

  logInfo(`收到消息 chat=${evt.chat_id} sender=${evt.sender_id} len=${text.length}: ${oneLine(text, 80)}`);

  if (text.startsWith('/')) {
    await handleCommand(evt, text);
    return;
  }

  enqueue({
    chatId: evt.chat_id,
    chatType: evt.chat_type,
    senderId: evt.sender_id,
    messageId,
    text,
    receivedAt: Date.now(),
  });
}

// ─────────────────────────── 长连接消费者 ───────────────────────────
let stopping = false;
let consumerChild = null;

function startConsumerLoop() {
  let backoff = 2000;

  const startOnce = () =>
    new Promise((resolve) => {
      const child = spawn(CFG.larkBin, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
        cwd: ROOT,
        env: ENV,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      consumerChild = child;
      let ready = false;
      let stderrTail = '';

      const readyTimer = setTimeout(() => {
        if (!ready) {
          logErr('消费者 30s 内未就绪，重启');
          try {
            child.kill('SIGTERM');
          } catch {}
        }
      }, 30000);

      child.stderr.on('data', (d) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-4000);
        for (const line of s.split('\n')) {
          if (!line.trim()) continue;
          if (line.includes('[event] ready event_key=')) {
            ready = true;
            clearTimeout(readyTimer);
            backoff = 2000;
            logInfo('✅ 事件监听已就绪 (im.message.receive_v1)');
          } else if (line.includes('feishu-websocket: connected')) {
            logInfo('🔌 WebSocket 已连接');
          } else if (line.includes('exited') || line.includes('error') || line.includes('reason:')) {
            logInfo(`consumer: ${line.trim()}`);
          }
        }
      });

      // 保持 stdin 打开（unbounded 模式下 stdin EOF 会优雅退出）
      createInterface({ input: child.stdout }).on('line', async (line) => {
        const t = line.trim();
        if (!t) return;
        let evt;
        try {
          evt = JSON.parse(t);
        } catch {
          logErr(`事件解析失败: ${t.slice(0, 200)}`);
          return;
        }
        try {
          await handleEvent(evt);
        } catch (e) {
          logErr(`处理事件异常: ${e.stack || e}`);
        }
      });

      child.on('close', (code) => {
        clearTimeout(readyTimer);
        consumerChild = null;
        if (!ready) logErr(`消费者启动失败 exit=${code} ${stderrTail.slice(-600)}`);
        resolve({ code, ready });
      });
      child.on('error', (e) => {
        logErr(`消费者启动出错: ${e.message}`);
        resolve({ code: -1, ready: false });
      });
    });

  const loop = async () => {
    while (!stopping) {
      const { ready } = await startOnce();
      if (stopping) break;
      logErr(`消费者断开，${Math.round(backoff / 1000)}s 后重启`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  };
  loop();
}

// ─────────────────────────── 自测 ───────────────────────────
async function simulate(text) {
  loadState(); // 复用真实会话映射，避免自测覆盖用户的上下文
  const chatId = CFG.testChatId;
  if (!chatId) {
    console.error(
      [
        'config.json 里没有 testChatId，无法自测。',
        '获取方式：在 Lark 里给机器人发任意一条消息（机器人会回复「未授权」并带上 open_id/chat_id），',
        '或看日志 ~/.dsh-lark-bot/logs/ 里第一行「收到消息 chat=oc_xxx」。',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(`[simulate] 走完整链路：${text}`);
  const evt = {
    type: 'im.message.receive_v1',
    message_id: 'om_simulate_' + Date.now(),
    chat_id: chatId,
    chat_type: 'p2p',
    message_type: 'text',
    sender_id: CFG.ownerOpenId,
    sender_type: 'user',
    content: text,
    create_time: String(Date.now()),
  };
  await handleEvent(evt);
  // 等队列跑空
  while (activeCount > 0 || [...queues.values()].some((q) => q.items.length)) {
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('[simulate] 完成');
  process.exit(0);
}

// ─────────────────────────── 启动 ───────────────────────────
function printStatus() {
  const st = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  } catch {}
  console.log(
    JSON.stringify(
      {
        running: pid ? isAlive(pid) : false,
        pid: pid && isAlive(pid) ? pid : null,
        root: ROOT,
        workdir: CFG.workdir,
        allowedUsers: CFG.allowedUsers,
        chats: Object.keys(st.chats || {}).length,
        sessions: Object.entries(st.chats || {}).map(([k, v]) => ({ chat: k, session: v.sessionId || null })),
        logDir: LOG_DIR,
      },
      null,
      2,
    ),
  );
}

// ─────────────────────────── 初始化 & 环境自检 ───────────────────────────
const ICON = { ok: '✅', fail: '❌', warn: '⚠️ ' };

async function doctor() {
  const rows = [];
  const add = (ok, label, detail, critical = true) => rows.push({ ok, label, detail, critical });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20, `Node.js v${process.versions.node}`, major >= 20 ? '' : `版本过低，需要 >= 20（当前 ${process.versions.node}）`);
  add(true, `平台 ${process.platform}/${process.arch}`, '', false);

  const hasCfg = fs.existsSync(CONFIG_PATH);
  add(hasCfg, 'config.json', hasCfg ? CONFIG_PATH : '缺失 → 先运行 node bot.mjs --init');

  const dsh = CFG.dshEntry || CFG.dshBin;
  if (dsh && (/\.js$/i.test(dsh) ? fs.existsSync(dsh) : true)) {
    const r = await run(dsh, ['--version'], { timeout: 90000 });
    if (r.code === 0) {
      add(true, `DSH (${dsh})`, (r.out.match(/\d+\.\d+\.\d+[-\w.]*/) || [''])[0] || 'OK');
    } else {
      add(false, `DSH (${dsh})`, `执行失败 exit=${r.code}: ${(r.err || r.out).slice(0, 200)}`);
    }
  } else {
    add(false, 'DSH 可执行入口', '找不到 @deepseek-ai/dsh，请先 npm i -g @deepseek-ai/dsh');
  }

  const lv = await run(CFG.larkBin, ['--version'], { timeout: 60000 });
  add(
    lv.code === 0,
    `lark-cli (${CFG.larkBin})`,
    lv.code === 0 ? (lv.out || '').trim().split('\n')[0].slice(0, 60) : `执行失败: ${(lv.err || lv.out).slice(0, 200)}`,
  );

  const st = await lark(['auth', 'status'], { retries: 1 });
  const d = st.json;
  if (d && d.ok !== false) {
    add(true, 'Lark 应用', `appId=${d.appId || '?'} brand=${d.brand || '?'}`);
    const botOk = !!d.identities?.bot?.available;
    add(botOk, 'bot 身份（发消息/收事件）', botOk ? '' : d.identities?.bot?.message || '不可用');
    const u = d.identities?.user;
    add(!!u?.available, 'user 身份（可选，仅部分工具需要）', u?.userName ? `已登录 ${u.userName}` : '未登录（本机器人不强制）', false);

    // 应用侧配置：机器人能力 / 长连接 / 事件订阅（纯读，失败只告警）
    if (d.appId && botOk) {
      const appRes = await lark(
        ['api', 'GET', `/open-apis/application/v6/applications/${d.appId}`, '--as', 'bot', '--params', '{"lang":"zh_cn"}'],
        { retries: 4 },
      );
      const app = appRes.json?.data?.app;
      if (app) {
        const botAb = app.mobile_default_ability === 'bot';
        add(
          botAb,
          '应用已开启「机器人」能力',
          botAb ? '' : '未开启 → 开发者后台 → 添加应用能力 → 机器人',
        );
        const cb = app.callback_info?.callback_type;
        add(
          cb === 'websocket',
          '事件订阅方式 = 长连接',
          cb === 'websocket' ? '' : `当前 ${cb || '未配置'} → 开发者后台 → 事件与回调 → 订阅方式选「长连接」`,
        );
      } else {
        add(false, '应用配置读取', `读不到应用信息（可能是权限/网络）：${(appRes.err || appRes.raw).slice(0, 120)}`, false);
      }
      const verRes = await lark(
        [
          'api',
          'GET',
          `/open-apis/application/v6/applications/${d.appId}/app_versions`,
          '--as',
          'bot',
          '--params',
          '{"lang":"zh_cn","page_size":5}',
        ],
        { retries: 4 },
      );
      const items = verRes.json?.data?.items || [];
      const hasRecv = items.some((it) => (it.event_infos || []).some((e) => e.event_type === 'im.message.receive_v1'));
      if (items.length) {
        add(
          hasRecv,
          '已订阅事件 im.message.receive_v1',
          hasRecv ? '' : '未订阅 → 事件与回调 → 添加事件 → 接收消息（im.message.receive_v1）',
        );
      } else {
        add(false, '已发布版本', '没有已发布版本 → 版本管理与发布 → 创建版本并发布', false);
      }
    }
  } else {
    add(false, 'Lark 登录态', 'lark-cli auth status 失败 → 先 lark-cli config init');
  }

  const wdOk = fs.existsSync(CFG.workdir);
  add(wdOk, `工作目录 ${CFG.workdir}`, wdOk ? '' : '目录不存在，请改 config.json 的 workdir');
  add(CFG.allowedUsers.length > 0, '白名单 allowedUsers', CFG.allowedUsers.join(', ') || '为空 → 谁都不能指挥机器人');
  add(!!CFG.testChatId, 'testChatId（--simulate 自测用）', CFG.testChatId || '为空：可先跑 --simulate 用，或发消息后用 /whoami 取 chat_id', false);

  let writable = true;
  try {
    const f = path.join(ROOT, '.doctor');
    fs.writeFileSync(f, 'ok');
    fs.unlinkSync(f);
  } catch {
    writable = false;
  }
  add(writable, `状态目录 ${ROOT}`, writable ? '' : '不可写');
  if (CFG.dshEntry && CFG.dshBin) add(false, '配置冲突', 'dshEntry 与 dshBin 同时存在，dshEntry 优先', false);

  console.log('\n🔍 DSH × Lark 机器人 环境自检\n');
  for (const r of rows) {
    console.log(`${r.ok ? ICON.ok : r.critical ? ICON.fail : ICON.warn} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = rows.filter((r) => !r.ok && r.critical);
  console.log(`\n${failed.length ? `❌ ${failed.length} 项必需检查未通过` : '✅ 全部必需项通过'}\n`);
  process.exitCode = failed.length ? 1 : 0;
}

function initConfig(force) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  if (Object.keys(existing).length && !force) {
    console.log(`config.json 已存在：${CONFIG_PATH}\n如需按当前环境重建，加 --force（已有字段会保留）`);
    return;
  }
  const cfg = {
    ...existing,
    dshProfile: existing.dshProfile || 'headless',
    dshEntry: detectDshEntry(),
    larkBin: detectLarkBin() || 'lark-cli',
    workdir:
      existing.workdir && fs.existsSync(existing.workdir) ? existing.workdir : DEFAULT_CONFIG.workdir,
    ownerOpenId: existing.ownerOpenId || '',
    allowedUsers: existing.allowedUsers || [],
    testChatId: existing.testChatId || '',
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`✅ 已写入 ${CONFIG_PATH}\n`);
  console.log(`  dshEntry : ${cfg.dshEntry || '(未找到！请先 npm i -g @deepseek-ai/dsh)'}`);
  console.log(`  larkBin  : ${cfg.larkBin}`);
  console.log(`  workdir  : ${cfg.workdir}`);
  console.log('\n下一步：');
  console.log('  1) 给机器人发一条消息，看它回复里的 open_id（或让它发 /whoami）');
  console.log('  2) 把 open_id 填进 config.json 的 ownerOpenId + allowedUsers');
  console.log('  3) 把收到消息的 chat_id 填进 testChatId（可选，用于 --simulate 自测）');
  console.log('  4) node bot.mjs --doctor 复检，然后 node bot.mjs --simulate "你好"\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--status') return printStatus();
  if (argv[0] === '--doctor') return doctor();
  if (argv[0] === '--init') return initConfig(argv.includes('--force'));
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(
      [
        'DSH × Lark 机器人',
        '',
        '  node bot.mjs                常驻（前台；生产环境用 botctl.sh / botctl.ps1 托管）',
        '  node bot.mjs --init         按当前环境生成 config.json',
        '  node bot.mjs --doctor       环境自检（Node / DSH / lark-cli / 登录态 / 配置）',
        '  node bot.mjs --simulate "x" 端到端自测（真发 Lark 消息、真执行）',
        '  node bot.mjs --status       运行状态',
      ].join('\n'),
    );
    return;
  }
  if (argv[0] === '--simulate') return simulate(argv.slice(1).join(' ') || '回复：机器人链路正常');

  loadState();
  acquireLock();
  logInfo(
    `启动 pid=${process.pid} platform=${process.platform} dsh=${CFG.dshEntry || CFG.dshBin} profile=${CFG.dshProfile} workdir=${CFG.workdir}`,
  );
  logInfo(`lark=${CFG.larkBin}`);
  logInfo(`白名单: ${CFG.allowedUsers.join(', ') || '(空)'}`);

  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    logInfo(`收到 ${sig}，退出中…`);
    try {
      consumerChild?.kill('SIGTERM');
    } catch {}
    releaseLock();
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => logErr(`未捕获异常: ${e.stack || e}`));
  process.on('unhandledRejection', (e) => logErr(`未处理 Promise: ${e?.stack || e}`));

  startConsumerLoop();
  setInterval(() => {}, 1 << 30); // 保活
}

main();
