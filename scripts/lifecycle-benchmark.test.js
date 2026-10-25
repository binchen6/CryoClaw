const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

function source(file) {
  return fs.readFileSync(require.resolve(file), "utf8");
}

test("startup benchmarks separate liveness/readiness and record graceful quit duration", () => {
  const benchmark = source("./gateway-startup-cdp-benchmark.js");
  assert.match(benchmark, /healthz/);
  assert.match(benchmark, /readyz/);
  assert.match(benchmark, /quitMs/);
  assert.match(benchmark, /quitStarted/);
  const profiler = source("./lib/gateway-cpu-profile.js");
  assert.match(profiler, /delayMs=2000/);
  assert.match(profiler, /durationMs=60000/);
});

test("startup helpers use the current log and only clean the owned process tree", () => {
  const js = source("./measure-startup.js");
  assert.match(js, /\.openclaw", "logs", "app\.log"/);
  assert.match(js, /healthzMs/);
  assert.match(js, /readyzMs/);
  const ps = source("./measure-startup.ps1");
  assert.match(ps, /\.openclaw\\logs\\app\.log/);
  assert.match(ps, /taskkill \/PID \$proc\.Id \/T \/F/);
  assert.doesNotMatch(ps, /Get-Process -Name "CryoClaw"/);
});
