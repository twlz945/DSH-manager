#!/usr/bin/env node
/**
 * dsh-tui — 零依赖的 DSH 服务管理 TUI。
 *
 * 能力：
 *   - 查看可配置 DSH 服务（默认 web:3080）的运行状态（端口探测 + PID 存活）
 *   - 启动 / 重启 / 停止；服务以 detached 方式常驻，TUI 退出后继续运行
 *   - 识别并接管外部启动的实例（按端口 owner PID 终止）
 *
 * 用法：
 *   node dsh-tui.mjs                    进入全屏 TUI
 *   node dsh-tui.mjs status             输出状态 JSON
 *   node dsh-tui.mjs start|stop|restart [id]
 *   node dsh-tui.mjs --config <path> …  指定配置文件
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const VERSION = '1.0.0';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const DEFAULT_CONFIG_PATH = path.join(SCRIPT_DIR, 'dsh-tui.config.json');
const DEFAULT_RUNTIME_DIR = path.join(SCRIPT_DIR, '.dsh-tui');

export const defaultConfig = {
  services: [
    {
      id: 'web',
      name: 'DSH Web',
      command: 'dsh',
      args: ['web', '--port', '3080'],
      port: 3080,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:3080',
      cwd: '.',
      startTimeoutMs: 20000,
    },
  ],
};

// ------------------------------------------------------------------ config

function cloneDefaultConfig() {
  return structuredClone(defaultConfig);
}

function normalizeService(raw, index, baseDir) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`services[${index}] 不是对象`);
  }
  const id = String(raw.id ?? `svc${index + 1}`).trim();
  if (!id) throw new Error(`services[${index}].id 不能为空`);
  const command = String(raw.command ?? '').trim();
  if (!command) throw new Error(`services[${index}].command 不能为空`);
  const port = Number(raw.port ?? 3080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`services[${index}].port 无效: ${raw.port}`);
  }
  const host = String(raw.host ?? '127.0.0.1');
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const cwd = raw.cwd ? path.resolve(baseDir, String(raw.cwd)) : baseDir;
  return {
    id,
    name: String(raw.name ?? id),
    command,
    args,
    port,
    host,
    url: String(raw.url ?? `http://${host}:${port}`),
    cwd,
    startTimeoutMs: Math.max(500, Number(raw.startTimeoutMs ?? 20000) || 20000),
    env: raw.env && typeof raw.env === 'object' ? Object.fromEntries(
      Object.entries(raw.env).map(([k, v]) => [String(k), String(v)]),
    ) : {},
  };
}

/**
 * 读取配置；缺省文件返回内置默认配置，损坏时回退默认并返回 warning。
 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const raw = JSON.parse(text);
    if (!Array.isArray(raw.services) || raw.services.length === 0) {
      throw new Error('services 必须是非空数组');
    }
    const baseDir = path.dirname(path.resolve(configPath));
    const services = raw.services.map((s, i) => normalizeService(s, i, baseDir));
    const seen = new Set();
    for (const svc of services) {
      if (seen.has(svc.id)) throw new Error(`服务 id 重复: ${svc.id}`);
      seen.add(svc.id);
    }
    return { config: { services }, warning: null, path: path.resolve(configPath) };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const cfg = cloneDefaultConfig();
      cfg.services = cfg.services.map((s) => normalizeService(s, 0, SCRIPT_DIR));
      return { config: cfg, warning: null, path: path.resolve(configPath) };
    }
    return {
      config: cloneDefaultConfig(),
      warning: `配置文件解析失败，已回退内置默认配置：${err.message}`,
      path: path.resolve(configPath),
    };
  }
}

export function findService(config, id) {
  if (id) return config.services.find((s) => s.id === id) ?? null;
  return config.services.length === 1 ? config.services[0] : null;
}

// ------------------------------------------------------------------ probing

/**
 * TCP 端口是否有人监听。
 * 支持 portOpen(port) / portOpen(host, port) / portOpen(host, port, timeoutMs)。
 */
export function portOpen(hostOrPort, portOrTimeout, timeoutMs = 500) {
  let host = '127.0.0.1';
  let port;
  let timeout = timeoutMs;
  if (typeof hostOrPort === 'number') {
    port = hostOrPort;
  } else if (typeof hostOrPort === 'string' && /^\d+$/.test(hostOrPort.trim())) {
    port = Number(hostOrPort);
  } else {
    host = String(hostOrPort ?? '127.0.0.1');
    port = Number(portOrTimeout);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), Math.max(100, timeoutMs));
    socket.once('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 运行命令并把 stdout/stderr 捕获到临时文件（避免管道依赖，沙箱下也稳定）。 */
function captureSync(command, args, timeout = 5000) {
  const file = path.join(
    os.tmpdir(),
    `dsh-tui-cap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  );
  let fd;
  try {
    fd = fs.openSync(file, 'w+');
    const res = spawnSync(command, args, {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout,
    });
    fs.closeSync(fd);
    fd = undefined;
    if (res.error) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(file); } catch {}
  }
}

/** 查询监听某端口的进程 PID（Windows: netstat / POSIX: lsof|ss）。 */
export function findPortPid(port) {
  try {
    if (IS_WIN) {
      const out = captureSync('netstat', ['-ano', '-p', 'tcp']);
      if (!out) return null;
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)$/i);
        if (m && Number(m[1].slice(m[1].lastIndexOf(':') + 1)) === port) {
          return Number(m[3]) || null;
        }
      }
      return null;
    }
    const lsof = captureSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    if (lsof && lsof.trim()) {
      const pid = Number(lsof.trim().split(/\s+/)[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    const ss = captureSync('ss', ['-ltnp', `sport = :${port}`]);
    const m = ss && ss.match(/pid=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ state

export function statePath(runtimeDir) {
  return path.join(runtimeDir, 'state.json');
}

export function readState(runtimeDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(runtimeDir), 'utf8'));
    if (raw && typeof raw.services === 'object' && raw.services !== null) {
      return { services: raw.services };
    }
  } catch {}
  return { services: {} };
}

function writeState(runtimeDir, state) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const file = statePath(runtimeDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function safeId(id) {
  return String(id).replace(/[^\w.-]+/g, '_');
}

export function logPathFor(runtimeDir, id) {
  return path.join(runtimeDir, 'logs', `${safeId(id)}.log`);
}

// ------------------------------------------------------------------ status

export async function getStatus(service, { runtimeDir = DEFAULT_RUNTIME_DIR, state } = {}) {
  const st = state ?? readState(runtimeDir);
  const rec = st.services[service.id];
  const managedPid = rec && pidAlive(rec.pid) ? rec.pid : null;
  const open = await portOpen(service.host, service.port);
  let status = 'stopped';
  let pid = null;
  let portPid = null;
  if (open && managedPid) {
    status = 'running';
    pid = managedPid;
  } else if (open) {
    status = 'external';
    portPid = findPortPid(service.port);
    pid = portPid;
  } else if (managedPid) {
    status = 'starting';
    pid = managedPid;
  }
  const startedAt = managedPid && rec.startedAt ? rec.startedAt : null;
  return {
    id: service.id,
    name: service.name,
    status,
    port: service.port,
    host: service.host,
    url: service.url,
    pid,
    portPid,
    managedPid,
    startedAt,
    uptimeMs: startedAt ? Math.max(0, Date.now() - startedAt) : null,
    logPath: rec?.logPath ?? logPathFor(runtimeDir, service.id),
  };
}

// ------------------------------------------------------------------ process control

function needsShell(command) {
  if (!IS_WIN) return false;
  return !/\.exe$/i.test(command);
}

function runQuiet(command, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve(false);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function killTree(pid, force = false) {
  if (!pid || !Number.isInteger(pid)) return false;
  if (pid <= 4 || pid === process.pid || pid === process.ppid) return false;
  if (IS_WIN) {
    const ok = await runQuiet('taskkill', ['/PID', String(pid), '/T', '/F']);
    if (ok) return true;
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
  try {
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(-pid, signal); // detached 子进程 = 新进程组组长
    } catch {
      process.kill(pid, signal);
    }
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口在 settleMs 内持续无人监听才算稳定关闭（吸收 kill 后的瞬时窗口）。 */
async function waitPortClosedStable(host, port, timeoutMs, settleMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let closedSince = null;
  while (Date.now() < deadline) {
    const open = await portOpen(host, port, 400);
    if (open) {
      closedSince = null;
    } else {
      if (closedSince === null) closedSince = Date.now();
      if (Date.now() - closedSince >= settleMs) return true;
    }
    await sleep(120);
  }
  return false;
}

export async function startService(service, { runtimeDir = DEFAULT_RUNTIME_DIR } = {}) {
  const st = readState(runtimeDir);
  const rec = st.services[service.id];
  if (rec && pidAlive(rec.pid)) {
    const s = await getStatus(service, { runtimeDir, state: st });
    if (s.status === 'running') {
      return { ok: true, message: `${service.name} 已在运行（pid ${s.pid}）`, status: s };
    }
    return { ok: false, message: `${service.name} 正在启动中（pid ${rec.pid}），请稍候`, status: s };
  }
  if (await portOpen(service.host, service.port)) {
    const portPid = findPortPid(service.port);
    const s = await getStatus(service, { runtimeDir, state: st });
    return {
      ok: false,
      message: `端口 ${service.port} 已被外部进程占用${portPid ? `（pid ${portPid}）` : ''}，请先停止该实例`,
      status: s,
    };
  }

  const logPath = logPathFor(runtimeDir, service.id);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let logFd;
  try {
    logFd = fs.openSync(logPath, 'w');
    fs.writeSync(
      logFd,
      `[${new Date().toISOString()}] ${service.command} ${service.args.join(' ')}\n`,
    );
  } catch (err) {
    return { ok: false, message: `无法创建日志文件 ${logPath}：${err.message}` };
  }

  let child;
  try {
    child = spawn(service.command, service.args, {
      cwd: service.cwd,
      env: { ...process.env, ...(service.env ?? {}) },
      detached: true,
      windowsHide: true,
      shell: needsShell(service.command),
      stdio: ['ignore', logFd, logFd],
    });
  } catch (err) {
    fs.closeSync(logFd);
    return { ok: false, message: `启动失败：${err.message}（日志：${logPath}）` };
  }

  const spawned = await new Promise((resolve) => {
    child.once('spawn', () => resolve({ ok: true }));
    child.once('error', (error) => resolve({ ok: false, error }));
  });
  try {
    fs.closeSync(logFd);
  } catch {}
  child.unref();

  if (!spawned.ok) {
    return {
      ok: false,
      message: `启动失败：${spawned.error?.message ?? '无法创建进程'}（日志：${logPath}）`,
    };
  }

  const startedAt = Date.now();
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = startedAt + service.startTimeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(service.host, service.port, 400)) {
      const fresh = readState(runtimeDir);
      fresh.services[service.id] = {
        pid: child.pid,
        startedAt,
        command: service.command,
        args: service.args,
        logPath,
      };
      writeState(runtimeDir, fresh);
      const s = await getStatus(service, { runtimeDir });
      return { ok: true, message: `${service.name} 已启动（pid ${child.pid}，端口 ${service.port}）`, status: s };
    }
    if (exited || child.exitCode !== null) break;
    await sleep(200);
  }

  killTree(child.pid, true).catch(() => {});
  await sleep(100);
  const fresh = readState(runtimeDir);
  if (fresh.services[service.id]) {
    delete fresh.services[service.id];
    writeState(runtimeDir, fresh);
  }
  const message = exited || child.exitCode !== null
    ? `启动失败：进程已退出（code ${child.exitCode}），请查看日志 ${logPath}`
    : `启动超时（${Math.round(service.startTimeoutMs / 1000)} 秒内端口未监听），已终止进程，请查看日志 ${logPath}`;
  return { ok: false, message };
}

export async function stopService(service, { runtimeDir = DEFAULT_RUNTIME_DIR } = {}) {
  const st = readState(runtimeDir);
  const rec = st.services[service.id];
  const managedAlive = rec ? pidAlive(rec.pid) : false;
  const open = await portOpen(service.host, service.port);
  if (!managedAlive && !open) {
    if (rec) {
      delete st.services[service.id];
      writeState(runtimeDir, st);
    }
    return {
      ok: true,
      message: `${service.name} 未在运行`,
      status: await getStatus(service, { runtimeDir }),
    };
  }

  const pids = new Set();
  if (managedAlive) pids.add(rec.pid);
  if (open) {
    const portPid = findPortPid(service.port);
    if (portPid) pids.add(portPid);
  }
  await Promise.all([...pids].map((pid) => killTree(pid, true).catch(() => false)));

  // 关闭后可能有残留 owner 或瞬时重绑：多次复查，必要时按端口重新定位并终止。
  let closed = await waitPortClosedStable(service.host, service.port, 6000);
  for (let attempt = 0; attempt < 2 && !closed; attempt++) {
    const portPid = findPortPid(service.port);
    const targets = portPid ? [portPid] : [...pids];
    await Promise.all(targets.map((pid) => killTree(pid, true).catch(() => false)));
    closed = await waitPortClosedStable(service.host, service.port, 3000);
  }
  if (!closed) {
    return {
      ok: false,
      message: `停止失败：端口 ${service.port} 仍在监听${rec ? `（pid ${rec.pid}）` : ''}，可重试或手动结束进程`,
      status: await getStatus(service, { runtimeDir }),
    };
  }

  const fresh = readState(runtimeDir);
  if (fresh.services[service.id]) {
    delete fresh.services[service.id];
    writeState(runtimeDir, fresh);
  }
  return {
    ok: true,
    message: `已停止 ${service.name}`,
    status: await getStatus(service, { runtimeDir }),
  };
}

export async function restartService(service, { runtimeDir = DEFAULT_RUNTIME_DIR } = {}) {
  const stopped = await stopService(service, { runtimeDir });
  if (!stopped.ok) return stopped;
  return startService(service, { runtimeDir });
}

// ------------------------------------------------------------------ formatting / rendering

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  let total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  total %= 3600;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (h > 0) return `${h}时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function codePointWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) w += codePointWidth(ch.codePointAt(0));
  return w;
}

function pad(text, width) {
  const s = String(text);
  const w = displayWidth(s);
  if (w >= width) return truncate(s, width);
  return s + ' '.repeat(width - w);
}

function truncate(text, width) {
  const s = String(text);
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/\x1b\[[0-9;?]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = codePointWidth(cp);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out;
}

const STATUS_STYLE = {
  running: { label: 'running', color: '\x1b[32m' },
  external: { label: 'external', color: '\x1b[33m' },
  starting: { label: 'starting', color: '\x1b[36m' },
  stopped: { label: 'stopped', color: '\x1b[90m' },
  error: { label: 'error', color: '\x1b[31m' },
};

/**
 * 生成界面行（纯文本，color 时附加 ANSI）。
 * model: { url, now, selectedIndex, offset, message:{kind,text}, busy, services:[status] }
 */
export function renderScreen(model, opts = {}) {
  const cols = Math.max(50, Math.min(opts.cols || 100, 200));
  const rows = Math.max(8, opts.rows || 30);
  const color = opts.color !== false;
  const lines = [];
  const width = cols - 1;
  const cyan = (s) => (color ? `\x1b[36m${s}\x1b[0m` : s);
  const dim = (s) => (color ? `\x1b[90m${s}\x1b[0m` : s);

  const clock = new Date(model.now ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  const titleLeft = ' DSH 服务管理器';
  const titleRight = model.busy ? `${model.busy}` : clock;
  const gap = Math.max(1, width - displayWidth(titleLeft) - displayWidth(titleRight));
  lines.push(cyan(titleLeft) + ' '.repeat(gap - (color ? 0 : 0)) + titleRight);

  const sep = '─'.repeat(width);
  lines.push(color ? `\x1b[90m${sep}\x1b[0m` : sep);

  const nameW = Math.max(12, Math.min(26, width - 47));
  const header =
    '  ' + pad('服务', nameW) + '  ' + pad('状态', 10) + '  ' + pad('端口', 7) +
    '  ' + pad('PID', 8) + '  ' + pad('运行时长', 12);
  lines.push(dim(header));

  const services = model.services ?? [];
  const listCapacity = Math.max(1, rows - 8);
  const offset = Math.max(0, Math.min(model.offset ?? 0, Math.max(0, services.length - listCapacity)));
  const visible = services.slice(offset, offset + listCapacity);

  visible.forEach((svc, i) => {
    const absolute = offset + i;
    const selected = absolute === model.selectedIndex;
    const style = STATUS_STYLE[svc.status] ?? STATUS_STYLE.stopped;
    const statusText = `● ${style.label}`;
    const pid = svc.pid ?? (svc.portPid ?? '-');
    const uptime = svc.uptimeMs === null || svc.uptimeMs === undefined ? '-' : formatDuration(svc.uptimeMs);
    let row = (selected ? '> ' : '  ') +
      pad(svc.name, nameW) + '  ' +
      pad(statusText, 10) + '  ' +
      pad(`:${svc.port}`, 7) + '  ' +
      pad(String(pid ?? '-'), 8) + '  ' +
      pad(uptime, 12);
    row = pad(row, width);
    if (color && selected) row = `\x1b[7m${row}\x1b[0m`;
    else if (color) row = row.replace(`● ${style.label}`, `${style.color}● ${style.label}\x1b[0m`);
    lines.push(row);
  });

  for (let i = visible.length; i < listCapacity; i++) lines.push('');

  lines.push(color ? `\x1b[90m${sep}\x1b[0m` : sep);

  const msg = model.message?.text ?? '就绪';
  const kind = model.message?.kind ?? 'info';
  const prefix = kind === 'err' ? '错误: ' : kind === 'ok' ? '完成: ' : '消息: ';
  let msgLine = pad(prefix + msg, width);
  if (color) {
    const c = kind === 'err' ? '\x1b[31m' : kind === 'ok' ? '\x1b[32m' : '\x1b[97m';
    msgLine = c + msgLine + '\x1b[0m';
  }
  lines.push(msgLine);

  const hint = '[s] 启动   [r] 重启   [x] 停止   [↑/↓] 选择   [q] 退出';
  lines.push(dim(truncate(hint, width)));
  if (model.url) lines.push(dim(truncate(`URL: ${model.url}`, width)));

  return lines.slice(0, rows).map((l) => truncate(l, width));
}

// ------------------------------------------------------------------ TUI

/**
 * 增量按键解码器：处理方向键等 ESC 序列被拆分到多个数据块的情况。
 * 孤立 ESC 延迟 escDelayMs 后作为 'esc' 发出，避免方向键误触发退出。
 */
export function createKeyDecoder(onKey, { escDelayMs = 40 } = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let escTimer = null;

  function emit(key) {
    onKey(key);
  }

  function clearEscTimer() {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  }

  function scheduleLoneEsc() {
    if (escTimer) return;
    escTimer = setTimeout(() => {
      escTimer = null;
      if (buffer === '\x1b') {
        buffer = '';
        emit('esc');
      }
    }, escDelayMs);
    escTimer.unref?.();
  }

  function feed(chunk) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    clearEscTimer();
    while (buffer.length > 0) {
      if (buffer[0] === '\x1b') {
        if (buffer.length === 1) {
          scheduleLoneEsc();
          break;
        }
        const csi = buffer.match(/^\x1b\[([0-9;?]*)([A-Za-z~])/);
        if (csi) {
          const final = csi[2];
          if (final === 'A') emit('up');
          else if (final === 'B') emit('down');
          else if (final === 'Z') emit('shift-tab');
          buffer = buffer.slice(csi[0].length);
          continue;
        }
        const ss3 = buffer.match(/^\x1bO([A-Za-z])/);
        if (ss3) {
          if (ss3[1] === 'A') emit('up');
          else if (ss3[1] === 'B') emit('down');
          buffer = buffer.slice(ss3[0].length);
          continue;
        }
        if (buffer.length >= 3) {
          // 未知转义序列：丢弃 ESC + 下一字节后继续
          buffer = buffer.slice(2);
          continue;
        }
        break;
      }
      const ch = buffer[0];
      buffer = buffer.slice(1);
      emit(ch);
    }
  }

  return {
    feed,
    dispose() {
      clearEscTimer();
      buffer = '';
    },
  };
}

async function runTui(config, runtimeDir, warning) {
  const forceTty = process.env.DSH_TUI_FORCE_TTY === '1';
  if ((!process.stdin.isTTY || !process.stdout.isTTY) && !forceTty) {
    console.error('dsh-tui: 当前不是交互式终端，无法进入 TUI。可用 "node dsh-tui.mjs status" 查看状态。');
    process.exit(1);
  }

  const services = config.services;
  let selected = 0;
  let offset = 0;
  let statuses = new Map();
  let message = warning
    ? { kind: 'err', text: warning }
    : { kind: 'info', text: '就绪：s 启动 / r 重启 / x 停止' };
  let busy = null;
  let confirm = null;
  let refreshing = false;
  let stopped = false;
  let spinnerFrame = 0;
  let timer = null;
  let spinner = null;

  const out = process.stdout;
  const write = (s) => out.write(s);

  function terminalSize() {
    return { cols: Math.max(50, out.columns || 100), rows: Math.max(10, out.rows || 30) };
  }

  function paint() {
    if (stopped) return;
    const { cols, rows } = terminalSize();
    const svcList = services.map((svc, i) => {
      const st = statuses.get(svc.id);
      return st ?? { id: svc.id, name: svc.name, status: 'starting', port: svc.port, pid: null, uptimeMs: null };
    });
    // 保证选中项在视口内
    const capacity = Math.max(1, rows - 8);
    if (selected < offset) offset = selected;
    if (selected >= offset + capacity) offset = selected - capacity + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, svcList.length - capacity)));

    const lines = renderScreen(
      {
        url: services[selected]?.url,
        now: Date.now(),
        selectedIndex: selected,
        offset,
        message,
        busy: busy ? `${busy}${'.'.repeat(spinnerFrame % 4)}` : null,
        services: svcList,
      },
      { cols, rows, color: true },
    );
    write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[0J');
  }

  async function refreshAll() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const results = await Promise.all(
        services.map(async (svc) => {
          try {
            return await getStatus(svc, { runtimeDir });
          } catch (err) {
            return {
              id: svc.id,
              name: svc.name,
              status: 'error',
              port: svc.port,
              pid: null,
              uptimeMs: null,
              error: err.message,
            };
          }
        }),
      );
      if (!stopped) {
        statuses = new Map(results.map((r) => [r.id, r]));
        paint();
      }
    } finally {
      refreshing = false;
    }
  }

  async function perform(action) {
    if (busy) return;
    const svc = services[selected];
    const current = statuses.get(svc.id);
    const isExternal = current?.status === 'external';
    if (isExternal && action !== 'start') {
      const now = Date.now();
      if (!confirm || confirm.action !== action || confirm.id !== svc.id || confirm.until < now) {
        confirm = { action, id: svc.id, until: now + 3000, pid: current.portPid };
        message = {
          kind: 'info',
          text: `外部进程${current.portPid ? ` pid ${current.portPid}` : ''}占用端口；3 秒内再按 ${action === 'stop' ? 'x' : 'r'} 确认终止`,
        };
        paint();
        return;
      }
      confirm = null;
    }
    busy = action === 'start' ? '启动中' : action === 'stop' ? '停止中' : '重启中';
    paint();
    let res;
    try {
      if (action === 'start') res = await startService(svc, { runtimeDir });
      else if (action === 'stop') res = await stopService(svc, { runtimeDir });
      else res = await restartService(svc, { runtimeDir });
    } catch (err) {
      res = { ok: false, message: `操作异常：${err.message}` };
    }
    busy = null;
    confirm = null;
    message = { kind: res.ok ? 'ok' : 'err', text: res.message };
    await refreshAll();
  }

  function cleanup() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (spinner) clearInterval(spinner);
    timer = null;
    spinner = null;
    try {
      process.stdin.setRawMode(false);
    } catch {}
    try {
      process.stdin.pause();
    } catch {}
    write('\x1b[?25h\x1b[?1049l');
  }

  function quit(code = 0) {
    cleanup();
    process.exit(code);
  }

  try {
    process.stdin.setRawMode(true);
  } catch {}

  const decoder = createKeyDecoder((key) => {
    if (busy || stopped) return;
    if (key === 'q' || key === 'esc' || key === '\x03') quit(0);
    else if (key === 'up' || key === 'k') {
      selected = (selected - 1 + services.length) % services.length;
      confirm = null;
      paint();
    } else if (key === 'down' || key === 'j') {
      selected = (selected + 1) % services.length;
      confirm = null;
      paint();
    } else if (key === 's' || key === '\r') perform('start');
    else if (key === 'r') perform('restart');
    else if (key === 'x' || key === '\x7f') perform('stop');
  });
  process.stdin.on('data', (chunk) => decoder.feed(chunk));

  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  process.on('exit', cleanup);
  out.on('resize', paint);

  write('\x1b[?1049h\x1b[?25l');
  await refreshAll();
  paint();
  timer = setInterval(refreshAll, 1000);
  spinner = setInterval(() => {
    spinnerFrame += 1;
    if (busy) paint();
  }, 400);
  // 首帧渲染完成后再开始读键，避免启动瞬间的输入在绘制前触发退出。
  process.stdin.resume();
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const opts = { configPath: null, command: 'tui', id: null, help: false, version: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' || arg === '-c') {
      opts.configPath = argv[++i];
      if (!opts.configPath) throw new Error('--config 需要一个路径');
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version' || arg === '-V') opts.version = true;
    else rest.push(arg);
  }
  opts.command = rest[0] ?? 'tui';
  opts.id = rest[1] ?? null;
  if (!['tui', 'status', 'start', 'stop', 'restart', 'list'].includes(opts.command)) {
    throw new Error(`未知命令: ${opts.command}`);
  }
  return opts;
}

function printHelp() {
  console.log(`dsh-tui ${VERSION} — DSH 服务管理 TUI

用法:
  node dsh-tui.mjs [--config 文件]                 进入全屏 TUI
  node dsh-tui.mjs [--config 文件] status          输出状态 JSON
  node dsh-tui.mjs [--config 文件] start <id>      启动服务
  node dsh-tui.mjs [--config 文件] stop <id>       停止服务
  node dsh-tui.mjs [--config 文件] restart <id>    重启服务
  node dsh-tui.mjs [--config 文件] list            列出服务

选项:
  -c, --config <路径>   配置文件（默认 ${DEFAULT_CONFIG_PATH}）
  -h, --help            显示帮助
  -V, --version         显示版本

TUI 按键:
  ↑/↓ 或 k/j  选择服务    s/Enter  启动    r  重启    x  停止    q  退出
  停止/重启外部实例需在 3 秒内再按一次 x/r 确认。

服务以 detached 方式常驻，退出 TUI 不会停止服务。`);
}

function statusReport(config, configPath, runtimeDir, warning) {
  return Promise.all(
    config.services.map(async (svc) => {
      try {
        return await getStatus(svc, { runtimeDir });
      } catch (err) {
        return {
          id: svc.id,
          name: svc.name,
          status: 'error',
          port: svc.port,
          host: svc.host,
          url: svc.url,
          pid: null,
          portPid: null,
          startedAt: null,
          uptimeMs: null,
          error: err.message,
        };
      }
    }),
  ).then((services) => ({
    version: VERSION,
    config: configPath,
    runtimeDir,
    warning,
    services,
  }));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`dsh-tui: ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.version) {
    console.log(VERSION);
    return;
  }

  const configPath = opts.configPath ?? process.env.DSH_TUI_CONFIG ?? DEFAULT_CONFIG_PATH;
  const { config, warning, path: resolvedPath } = loadConfig(configPath);
  const runtimeDir = path.join(path.dirname(resolvedPath), '.dsh-tui');

  if (opts.command === 'tui') {
    await runTui(config, runtimeDir, warning);
    return;
  }
  if (opts.command === 'list') {
    console.log(JSON.stringify(config.services.map((s) => ({ id: s.id, name: s.name, port: s.port, command: s.command, args: s.args })), null, 2));
    return;
  }
  if (opts.command === 'status') {
    if (warning) console.error(warning);
    const report = await statusReport(config, resolvedPath, runtimeDir, warning);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const svc = findService(config, opts.id);
  if (!svc) {
    const ids = config.services.map((s) => s.id).join(', ');
    const hint = opts.id ? `找不到服务 "${opts.id}"` : '配置中有多个服务，请指定服务 id';
    console.error(`dsh-tui: ${hint}，可用服务: ${ids}`);
    process.exit(2);
  }
  const runner = opts.command === 'start' ? startService : opts.command === 'stop' ? stopService : restartService;
  const res = await runner(svc, { runtimeDir });
  console.log(res.message);
  process.exit(res.ok ? 0 : 1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`dsh-tui: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
