'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { arg, connect, waitForPageTarget, killTree } = require('./lib/cdp-harness');

async function assertPortAvailable(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  await new Promise(resolve => server.close(resolve));
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? null;
}

async function main(argv = process.argv) {
  const out = path.resolve(arg(argv, '--out', 'out/chat-stream-performance/current'));
  const port = Number(arg(argv, '--port', '9360'));
  await assertPortAvailable(port);
  fs.mkdirSync(out, { recursive: true });
  const marker = randomUUID();
  const binary = require('electron');
  const staged = process.platform === 'win32'
    ? await require('./lib/stage-electron-runtime').stageElectronRuntime(binary)
    : { exe: binary, cleanup: async () => {} };
  const env = { ...process.env, CRYOCLAW_REFERENCE_MARKER: marker };
  delete env.ELECTRON_RUN_AS_NODE;
  const fd = fs.openSync(path.join(out, 'electron.log'), 'w');
  const child = spawn(staged.exe, [`--remote-debugging-port=${port}`, path.join(__dirname, 'lib/reference-ui-fixture.cjs'), '--out', out], {
    cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  const report = { ok: false, scope: 'Offline built renderer; fake file IPC and gateway events; no provider, real profile or network', sends: [], streams: [] };
  let ws, cdp;
  try {
    const page = await waitForPageTarget(port, 30000);
    assert.ok(page, 'Isolated renderer target');
    assert.equal(new URL(page.url).searchParams.get('qaMarker'), marker);
    ({ ws, cdp } = await connect(page));
    await cdp.send('Page.bringToFront');
    await cdp.evaluate(`(async () => {
      const app = document.querySelector('openclaw-app');
      await app.updateComplete;
      const client = app.client;
      client.stop();
      window.__qaGatewayEvent = client.opts.onEvent;
      window.__qaCalls = [];
      window.__qaReadActive = 0;
      window.__qaReadMaxActive = 0;
      window.__qaLongTasks = [];
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) window.__qaLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }).observe({ type: 'longtask' });
      } catch {}
      window.cryoclaw = {
        readFileBase64: filePath => new Promise(resolve => {
          window.__qaReadActive++;
          window.__qaReadMaxActive = Math.max(window.__qaReadMaxActive, window.__qaReadActive);
          setTimeout(() => {
            window.__qaReadActive--;
            resolve({ base64: 'b2ZmbGluZQ==', size: filePath.length, mimeType: 'text/plain' });
          }, 80);
        }),
      };
      client.request = (method, params) => {
        window.__qaCalls.push({ method, params });
        if (method === 'chat.send') return Promise.resolve({ runId: 'offline-send-run' });
        if (method === 'chat.history') return Promise.resolve({ messages: app.chatMessages });
        if (method === 'sessions.patch') return Promise.resolve({});
        return new Promise(() => {});
      };
      app.tab = 'chat';
      app.connected = true;
      app.chatLoading = false;
      app.chatSending = false;
      app.chatRunId = null;
      app.chatStream = null;
      app.chatQueue = [];
      app.chatMessages = Array.from({ length: 200 }, (_, index) => ({
        id: 'history-' + index,
        role: index % 2 ? 'assistant' : 'user',
        timestamp: 1792800000000 + index * 1000,
        content: [{ type: 'text', text: index % 2 ? '历史回复 ' + index : '历史问题 ' + index }],
      }));
      app.chatVisibleMessageCount = 200;
      app.chatToolMessages = [];
      app.requestUpdate();
      await app.updateComplete;
      return true;
    })()`);

    for (const count of [1, 4, 8]) {
      const row = await cdp.evaluate(`(async () => {
        const app = document.querySelector('openclaw-app');
        app.chatRunId = null;
        app.chatSending = false;
        app.chatStream = null;
        app.chatPendingStreamText = null;
        app.chatQueue = [];
        app.chatMessage = 'offline ${count} attachments';
        app.chatAttachments = Array.from({ length: ${count} }, (_, index) => ({
          id: 'file-${count}-' + index, filePath: '/tmp/offline-${count}-' + index + '.txt', name: 'file-' + index + '.txt',
        }));
        window.__qaCalls = [];
        window.__qaReadMaxActive = 0;
        const started = performance.now();
        await app.handleSendChat();
        await app.updateComplete;
        const send = window.__qaCalls.find(call => call.method === 'chat.send');
        return {
          count: ${count}, accepted: Boolean(send), elapsedMs: performance.now() - started,
          maxActiveReads: window.__qaReadMaxActive,
          attachmentOrder: send?.params?.attachments?.map(item => item.fileName) ?? [],
          echoVisible: app.chatMessages.at(-1)?.content?.[0]?.text === 'offline ${count} attachments',
          lastError: app.lastError, lastMessage: app.chatMessages.at(-1),
          calls: window.__qaCalls.map(call => call.method),
        };
      })()`, { timeoutMs: 30000 });
      report.sends.push(row);
      assert.ok(row.accepted && row.echoVisible, `Send failed for ${count} attachments`);
      assert.equal(row.attachmentOrder.length, count);
      assert.ok(row.maxActiveReads <= 4, 'File reads must remain bounded');
    }

    for (const scenario of [
      { length: 20000, atBottom: true },
      { length: 100000, atBottom: true },
      { length: 100000, atBottom: false },
    ]) {
      const row = await cdp.evaluate(`(async () => {
        const app = document.querySelector('openclaw-app');
        const runId = 'stream-${scenario.length}-${scenario.atBottom}';
        const text = 'x'.repeat(${scenario.length});
        app.chatRunId = runId;
        app.chatStream = '';
        app.chatPendingStreamText = null;
        app.chatStreamFrozenPrefix = '';
        app.chatStreamStartedAt = Date.now();
        app.chatLastActivityAt = Date.now();
        app.chatToolMessages = [];
        app.chatHasAutoScrolled = true;
        app.chatUserNearBottom = ${scenario.atBottom};
        const thread = document.querySelector('.chat-thread');
        if (thread) thread.scrollTop = ${scenario.atBottom} ? thread.scrollHeight : 0;
        const longTaskStart = window.__qaLongTasks.length;
        const frames = [];
        const started = performance.now();
        for (let offset = 0; offset < text.length; offset += 120) {
          const deltaText = text.slice(offset, offset + 120);
          const frameStarted = performance.now();
          window.__qaGatewayEvent({ type: 'event', event: 'chat', payload: {
            sessionKey: app.sessionKey, runId, state: 'delta', deltaText,
          } });
          await new Promise(requestAnimationFrame);
          frames.push(performance.now() - frameStarted);
        }
        await app.updateComplete;
        await document.querySelector('oc-chat-stream')?.updateComplete;
        const longTasks = window.__qaLongTasks.slice(longTaskStart);
        return {
          length: ${scenario.length}, atBottom: ${scenario.atBottom},
          elapsedMs: performance.now() - started, frames,
          streamMatches: (app.chatPendingStreamText ?? app.chatStream) === text,
          longTaskCount: longTasks.length,
          longTaskTotalMs: longTasks.reduce((sum, item) => sum + item.duration, 0),
          longTaskMaxMs: Math.max(0, ...longTasks.map(item => item.duration)),
        };
      })()`, { timeoutMs: 120000 });
      assert.ok(row.streamMatches, 'Streaming text was lost or truncated');
      row.frameP50Ms = percentile(row.frames, 0.5);
      row.frameP95Ms = percentile(row.frames, 0.95);
      row.frameMaxMs = Math.max(...row.frames);
      delete row.frames;
      report.streams.push(row);
    }
    report.rendererExceptions = cdp.exceptions;
    assert.deepEqual(cdp.exceptions, []);
    report.ok = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
    report.rendererExceptions = cdp?.exceptions;
  } finally {
    ws?.close();
    killTree(child);
    fs.closeSync(fd);
    await staged.cleanup();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
