const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refreshRuntimeNpm, patchRuntimeNpmDependencies } = require('./lib/runtime-npm-policy');

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test('runtime npm update rejects changed archives before touching the installed tool', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryoclaw-npm-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'runtime'), gateway = path.join(dir, 'gateway');
  write(runtime, 'node_modules/npm/package.json', { version: '11.19.1' });
  write(gateway, 'node_modules/ip-address/package.json', { version: '10.7.4' });
  write(gateway, 'package-lock.json', {});
  const archive = path.join(dir, 'bad.tgz');
  fs.writeFileSync(archive, 'altered archive');
  assert.throws(() => refreshRuntimeNpm(runtime, 'win32', gateway, archive), /integrity mismatch/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules/npm/package.json'), 'utf8')).version, '11.19.1');
});

test('runtime npm fast path requires both safe dependency copies', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryoclaw-npm-fast-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'runtime'), gateway = path.join(dir, 'gateway');
  write(runtime, 'node_modules/npm/package.json', { version: '11.21.1' });
  write(runtime, 'node_modules/npm/node_modules/ip-address/package.json', { version: '10.7.4' });
  write(runtime, 'node_modules/npm/node_modules/undici/package.json', { version: '6.29.1' });
  write(gateway, 'package-lock.json', {});
  assert.equal(refreshRuntimeNpm(runtime, 'win32', gateway, path.join(dir, 'unused.tgz')), false);
});

test('runtime npm bundled dependency replacement validates consumers and updates lock evidence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryoclaw-npm-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), ip = path.join(dir, 'ip'), undici = path.join(dir, 'undici-6');
  write(source, 'node_modules/consumer/package.json', { name: 'consumer', dependencies: { undici: '^6.25.0', 'ip-address': '^10.0.0' } });
  write(source, 'package-lock.json', { packages: { 'node_modules/undici': { version: '6.29.0' }, 'node_modules/ip-address': { version: '10.7.2' } } });
  write(ip, 'package.json', { name: 'ip-address', version: '10.7.4' });
  write(undici, 'package.json', { name: 'undici', version: '6.29.1' });
  fs.writeFileSync(path.join(undici, 'safe.txt'), 'safe');
  patchRuntimeNpmDependencies(source, [
    { name: 'ip-address', version: '10.7.4', source: ip, lockEntry: { version: '10.7.4' } },
    { name: 'undici', version: '6.29.1', source: undici, lockEntry: { version: '6.29.1' } },
  ]);
  assert.equal(fs.readFileSync(path.join(source, 'node_modules/undici/safe.txt'), 'utf8'), 'safe');
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/undici'].version, '6.29.1');
  assert.equal(lock.packages['node_modules/undici'].inBundle, true);
  assert.equal(lock.packages['node_modules/ip-address'].version, '10.7.4');
});
