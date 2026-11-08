import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  defaultConfig,
  portOpen,
  findPortPid,
  getStatus,
  startService,
  stopService,
  restartService,
  readState,
  renderScreen,
  formatDuration,
  createKeyDecoder,
} from '../dsh-tui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TUI = path.resolve(HERE, '..', 'dsh-tui.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'fake-server.mjs');

const tmps = [];
afterEach(() => {
  while (tmps.length) {
    const dir = tmps.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tui-test-'));
  tmps.push(dir);
  return dir;
}

function writeConfig(dir, services) {
  const cfgPath = path.join(dir, 'dsh-tui.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ services }, null, 2));
  return cfgPath;
}

let portCursor = 30000 + ((process.pid * 37) % 10000);
async function freePort() {
  // 不通过本进程 listen 再关闭来取端口：沙箱对“本进程刚关闭的监听端口”会出现幽灵连接。
  // 改为扫描未占用的高位端口，并用连接探测确认空闲。
  for (let i = 0; i < 500; i++) {
    const port = 20000 + ((portCursor++ * 7919) % 40000);
    if (!(await portOpen(port))) return port;
  }
  throw new Error('无法找到空闲端口');
}

async function waitFor(fn, timeoutMs = 8000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

function fakeService(port, extra = {}) {
  return {
    id: 'fake',
    name: 'Fake Service',
    command: process.execPath,
    args: [FIXTURE, String(port), '127.0.0.1'],
    port,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${port}`,
    startTimeoutMs: 8000,
    ...extra,
  };
}

function startExternal(port) {
  const child = spawn(process.execPath, [FIXTURE, String(port)], {
    stdio: 'ignore',
    windowsHide: true,
    // 沙箱下非 detached 子进程可能无法初始化（0xC0000142），detached 可靠；
    // 生产实现同样是 detached。
    detached: true,
  });
  return child;
}

function pidGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

function runCli(args, { timeoutMs = 20000 } = {}) {
  const outFile = path.join(
    os.tmpdir(),
    `dsh-tui-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  );
  const fd = fs.openSync(outFile, 'w');
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(process.execPath, [TUI, ...args], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      detached: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      try { fs.closeSync(fd); } catch {}
      reject(new Error(`CLI 超时: ${args.join(' ')}`));
    }, timeoutMs);
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      reject(err);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      let stdout = '';
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      resolve({ code, stdout });
    });
  });
}

// ---------------------------------------------------------------- config

test('默认配置包含 web:3080', () => {
  const { config, warning } = loadConfig(path.join(tmpDir(), 'missing.json'));
  assert.equal(warning, null);
  const web = config.services.find((s) => s.id === 'web');
  assert.ok(web, '默认配置必须包含 web 服务');
  assert.equal(web.port, 3080);
  assert.equal(web.command, 'dsh');
  assert.deepEqual(web.args, ['web', '--port', '3080']);
  assert.equal(defaultConfig.services[0].id, 'web');
});

test('配置损坏时回退默认配置并给出警告', () => {
  const dir = tmpDir();
  const cfgPath = path.join(dir, 'dsh-tui.config.json');
  fs.writeFileSync(cfgPath, '{ not valid json');
  const { config, warning } = loadConfig(cfgPath);
  assert.match(warning, /回退|默认/);
  assert.equal(config.services[0].id, 'web');
});

test('配置合并：缺失字段使用安全默认值', () => {
  const dir = tmpDir();
  const cfgPath = writeConfig(dir, [
    { id: 'svc1', command: 'node', port: 4321 },
  ]);
  const { config, warning } = loadConfig(cfgPath);
  assert.equal(warning, null);
  const svc = config.services[0];
  assert.equal(svc.name, 'svc1');
  assert.equal(svc.host, '127.0.0.1');
  assert.equal(svc.startTimeoutMs, 20000);
  assert.equal(svc.args[0], undefined);
});

// ---------------------------------------------------------------- probing

test('端口探测：关闭端口 false，监听端口 true', async () => {
  const port = await freePort();
  assert.equal(await portOpen(port), false);
  const child = startExternal(port);
  try {
    assert.equal(await waitFor(() => portOpen(port)), true);
    assert.equal(await portOpen(port), true);
  } finally {
    child.kill('SIGKILL');
  }
});

test('findPortPid 能找到监听端口的进程', async () => {
  const port = await freePort();
  const child = startExternal(port);
  try {
    assert.equal(await waitFor(() => portOpen(port)), true);
    assert.equal(findPortPid(port), child.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------- lifecycle

test('start/stop：启动后记录 state、端口就绪、日志落盘；停止后进程与端口消失', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const svc = fakeService(port);
  const runtimeDir = path.join(dir, '.dsh-tui');

  const started = await startService(svc, { runtimeDir });
  assert.equal(started.ok, true, started.message);
  assert.equal(await portOpen(port), true);

  const state = readState(runtimeDir);
  assert.equal(typeof state.services.fake.pid, 'number');
  assert.ok(state.services.fake.startedAt > 0);
  assert.ok(fs.existsSync(state.services.fake.logPath), '日志文件应存在');
  const managedPid = state.services.fake.pid;

  const status = await getStatus(svc, { runtimeDir });
  assert.equal(status.status, 'running');
  assert.equal(status.pid, state.services.fake.pid);
  assert.ok(status.uptimeMs >= 0);

  const stopped = await stopService(svc, { runtimeDir });
  assert.equal(stopped.ok, true, stopped.message);
  // 沙箱会对刚释放的 loopback 端口出现“幽灵连接”（netstat 无 owner），
  // 因此以“进程死亡 + netstat 无监听者”作为端口释放证据。
  assert.equal(
    await waitFor(() => pidGone(managedPid) && findPortPid(port) === null, 5000),
    true,
    `停止后进程 ${managedPid} 未退出或端口 ${port} 仍有 owner=${findPortPid(port)}`,
  );
  assert.equal(readState(runtimeDir).services.fake, undefined);
});

test('start 在端口被外部进程占用时拒绝启动', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const external = startExternal(port);
  const runtimeDir = path.join(dir, '.dsh-tui');
  try {
    assert.equal(await waitFor(() => portOpen(port)), true);
    const res = await startService(fakeService(port), { runtimeDir });
    assert.equal(res.ok, false);
    assert.match(res.message, /占用/);
  } finally {
    external.kill('SIGKILL');
  }
});

test('restart：停止后重新拉起，进程与启动时间更新', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const svc = fakeService(port);
  const runtimeDir = path.join(dir, '.dsh-tui');

  const first = await startService(svc, { runtimeDir });
  assert.equal(first.ok, true, first.message);
  const firstPid = readState(runtimeDir).services.fake.pid;
  const firstStartedAt = readState(runtimeDir).services.fake.startedAt;

  const res = await restartService(svc, { runtimeDir });
  assert.equal(res.ok, true, res.message);
  assert.equal(await portOpen(port), true);
  const second = readState(runtimeDir).services.fake;
  assert.notEqual(second.startedAt, firstStartedAt);
  assert.ok(second.pid > 0);

  await stopService(svc, { runtimeDir });
});

test('外部实例：识别为 external，可接管并停止', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const external = startExternal(port);
  const runtimeDir = path.join(dir, '.dsh-tui');
  try {
    assert.equal(await waitFor(() => portOpen(port)), true);
    const status = await getStatus(fakeService(port), { runtimeDir });
    assert.equal(status.status, 'external');
    assert.equal(status.portPid, external.pid);

    const res = await stopService(fakeService(port), { runtimeDir });
    assert.equal(res.ok, true, res.message);
    assert.equal(
      await waitFor(() => pidGone(external.pid) && findPortPid(port) === null, 5000),
      true,
      `外部实例 ${external.pid} 未被终止，或端口 ${port} 仍有 owner=${findPortPid(port)}`,
    );
  } finally {
    try { external.kill('SIGKILL'); } catch {}
  }
});

test('state 中 PID 已死但端口仍监听 → 视为 external', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const external = startExternal(port);
  const runtimeDir = path.join(dir, '.dsh-tui');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'state.json'),
    JSON.stringify({ services: { fake: { pid: 999999, startedAt: Date.now() - 1000, logPath: path.join(runtimeDir, 'logs', 'fake.log') } } }),
  );
  try {
    assert.equal(await waitFor(() => portOpen(port)), true);
    const status = await getStatus(fakeService(port), { runtimeDir });
    assert.equal(status.status, 'external');
    await stopService(fakeService(port), { runtimeDir });
    assert.equal(await waitFor(() => pidGone(external.pid) && findPortPid(port) === null, 5000), true);
  } finally {
    try { external.kill('SIGKILL'); } catch {}
  }
});

test('启动失败：命令不存在时给出可读错误且不留管理态', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const svc = fakeService(port, {
    command: 'definitely-not-a-real-dsh-command-xyz',
    args: [],
    startTimeoutMs: 3000,
  });
  const runtimeDir = path.join(dir, '.dsh-tui');

  const res = await startService(svc, { runtimeDir });
  assert.equal(res.ok, false);
  assert.match(res.message, /失败|错误|不存在|日志/);
  assert.equal(readState(runtimeDir).services.fake, undefined);
  assert.equal(await portOpen(port), false);
});

// ---------------------------------------------------------------- CLI / detached

test('CLI：父进程退出后子服务仍存活（detached），可再次停止', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const svc = fakeService(port);
  const cfgPath = writeConfig(dir, [svc]);

  const started = await runCli(['--config', cfgPath, 'start', 'fake']);
  assert.equal(started.code, 0, started.stdout);
  assert.ok(started.stdout.length > 0);
  assert.equal(await portOpen(port), true, '父进程退出后子服务仍应存活');

  const statusRun = await runCli(['--config', cfgPath, 'status']);
  assert.equal(statusRun.code, 0, statusRun.stdout);
  const st = JSON.parse(statusRun.stdout);
  assert.equal(st.services[0].status, 'running');
  assert.equal(st.services[0].port, port);
  const managedPid = st.services[0].pid;

  const stopRun = await runCli(['--config', cfgPath, 'stop', 'fake']);
  assert.equal(stopRun.code, 0, stopRun.stdout);
  assert.equal(
    await waitFor(() => pidGone(managedPid) && findPortPid(port) === null, 5000),
    true,
    `CLI 停止后进程 ${managedPid} 未退出或端口 ${port} 仍有 owner=${findPortPid(port)}`,
  );
});

// ---------------------------------------------------------------- rendering

test('按键解码：分片到达的方向键序列不会被误判为退出', () => {
  const keys = [];
  const dec = createKeyDecoder((k) => keys.push(k));
  dec.feed('\x1b');
  dec.feed('[');
  dec.feed('A');
  assert.deepEqual(keys, ['up']);
});

test('按键解码：孤立 ESC 延迟后作为退出键', async () => {
  const keys = [];
  const dec = createKeyDecoder((k) => keys.push(k));
  dec.feed('\x1b');
  assert.deepEqual(keys, [], '孤立 ESC 不应立即触发退出');
  await new Promise((r) => setTimeout(r, 100));
  dec.dispose();
  assert.deepEqual(keys, ['esc']);
});

test('renderScreen：高亮行按可见宽度排版，ANSI 不占宽度', () => {
  const lines = renderScreen(
    {
      url: 'http://127.0.0.1:4321',
      now: Date.now(),
      selectedIndex: 0,
      offset: 0,
      message: { kind: 'info', text: '就绪' },
      services: [
        { id: 'fake', name: 'Fake Service', status: 'running', port: 4321, pid: 4242, uptimeMs: 65000 },
      ],
    },
    { cols: 100, rows: 20, color: true },
  );
  const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const width = (s) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) >= 0x2e80 ? 2 : 1), 0);
  const row = lines.find((l) => strip(l).includes('Fake Service'));
  assert.ok(row, '应有服务行');
  assert.equal(width(strip(row)), 99, '可见宽度应铺满界面宽度');
});

test('renderScreen：显示服务名、状态与端口', () => {
  const model = {
    url: 'http://127.0.0.1:3080',
    now: Date.now(),
    selectedIndex: 0,
    message: { kind: 'info', text: '就绪' },
    services: [
      { id: 'web', name: 'DSH Web', status: 'running', port: 3080, pid: 1234, uptimeMs: 65000 },
      { id: 'backup', name: 'Backup', status: 'stopped', port: 3090, pid: null, uptimeMs: null },
    ],
  };
  const lines = renderScreen(model, { cols: 100, rows: 24, color: false });
  const text = lines.join('\n');
  assert.match(text, /DSH Web/);
  assert.match(text, /running/);
  assert.match(text, /3080/);
  assert.match(text, /Backup/);
  assert.match(text, /stopped/);
  assert.match(text, /已停止|就绪/);
  assert.ok(lines.length >= 6);
});

test('formatDuration 可读化', () => {
  assert.equal(formatDuration(0), '0秒');
  assert.equal(formatDuration(59_000), '59秒');
  assert.equal(formatDuration(65_000), '1分5秒');
  assert.equal(formatDuration(3_725_000), '1时2分5秒');
  assert.equal(formatDuration(null), '-');
});

// ---------------------------------------------------------------- TUI smoke

test('TUI 冒烟：可启动、渲染服务列表、读取按键并干净退出', async () => {
  const dir = tmpDir();
  const cfgPath = writeConfig(dir, [
    {
      id: 'smoke',
      name: 'Smoke Web',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      port: 47881,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:47881',
      startTimeoutMs: 3000,
    },
  ]);
  const outFile = path.join(dir, 'tui.out');
  const inFd = fs.openSync(path.join(dir, 'keys.txt'), 'w+');
  fs.writeSync(inFd, 'q');
  fs.closeSync(inFd);
  const fdIn = fs.openSync(path.join(dir, 'keys.txt'), 'r');
  const fdOut = fs.openSync(outFile, 'w');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TUI, '--config', cfgPath], {
      stdio: [fdIn, fdOut, fdOut],
      windowsHide: true,
      env: { ...process.env, DSH_TUI_FORCE_TTY: '1' },
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('TUI 未在 15 秒内退出'));
    }, 15000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  try { fs.closeSync(fdIn); } catch {}
  try { fs.closeSync(fdOut); } catch {}
  const raw = fs.readFileSync(outFile, 'utf8');
  const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.equal(code, 0, text.slice(0, 400));
  assert.match(text, /DSH 服务管理器/);
  assert.match(text, /Smoke Web/);
  assert.match(text, /47881/);
  assert.match(text, /\[q\] 退出/);
});
