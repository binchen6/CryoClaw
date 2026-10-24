'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

// Keep OpenClaw and ClawHub fixed; patch their transport/tooling dependencies.
// The direct Undici 8 dependency also satisfies proxyline's peer. The 6.x alias
// supplies a verified replacement for npm's bundled copy without downgrading root.
const dependencies = Object.freeze({
  undici: '8.12.2',
  'undici-6': 'npm:undici@6.29.1',
  'ip-address': '10.7.4',
  zod: '4.6.6',
});
const overrides = Object.freeze({
  npm: '12.2.1',
  'undici@7': '7.30.1',
  'undici@6': '6.29.1',
  'ip-address': '$ip-address',
});
const stamp = JSON.stringify({ dependencies, overrides });

function repairBundledDependency(gatewayDir, name, expectedVersion, sourcePackage, owner = 'npm') {
  const root = path.resolve(gatewayDir, 'node_modules');
  const bundled = path.join(root, owner, 'node_modules', name);
  const source = path.join(root, sourcePackage);
  const replacement = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const current = fs.existsSync(bundled) ? JSON.parse(fs.readFileSync(path.join(bundled, 'package.json'), 'utf8')) : { name, version: null };
  if (replacement.name !== name || replacement.version !== expectedVersion) throw new Error('Missing safe bundled dependency replacement: ' + name);
  if (current.name !== name || current.version === expectedVersion) return false;
  if (current.version !== null && (semver.major(current.version) !== semver.major(expectedVersion) || semver.gt(current.version, expectedVersion))) throw new Error('Refusing bundled dependency downgrade: ' + name);

  // npm overrides do not necessarily replace files marked inBundle. Replace only
  // when every consumer accepts the pinned version, and keep lock evidence aligned.
  const scan = dir => {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Linked npm dependency directory: ' + dir);
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const p = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const range = p.dependencies?.[name] ?? p.optionalDependencies?.[name];
      if (range && !semver.satisfies(expectedVersion, range)) throw new Error('Incompatible bundled dependency consumer: ' + p.name);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) scan(path.join(dir, entry.name));
    }
  };
  scan(path.join(root, owner, 'node_modules'));
  if (path.relative(root, bundled) !== path.join(owner, 'node_modules', name)) throw new Error('Unexpected bundled dependency path');
  fs.rmSync(bundled, { recursive: true, force: true });
  fs.cpSync(source, bundled, { recursive: true });
  const lockPath = path.join(gatewayDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const entry = lock.packages?.[`node_modules/${sourcePackage}`];
    if (entry) {
      lock.packages[`node_modules/${owner}/node_modules/${name}`] = { ...entry, inBundle: true };
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    }
  }
  return true;
}

function repairBundledIpAddress(gatewayDir) {
  return repairBundledDependency(gatewayDir, 'ip-address', '10.7.4', 'ip-address');
}

function repairBundledDependencies(gatewayDir) {
  return {
    ipAddress: repairBundledIpAddress(gatewayDir),
    undici: repairBundledDependency(gatewayDir, 'undici', '6.29.1', 'undici-6'),
    openclawUndici: repairBundledDependency(gatewayDir, 'undici', '8.12.2', 'undici', 'openclaw'),
    openclawZod: repairBundledDependency(gatewayDir, 'zod', '4.6.6', 'zod', 'openclaw'),
  };
}

function assertGatewayDependencyPolicy(gatewayDir) {
  const expected = new Map([
    ['undici', '8.12.2'],
    ['undici-6', '6.29.1'],
    ['ip-address', '10.7.4'],
    ['zod', '4.6.6'],
    ['clawhub/node_modules/undici', '7.30.1'],
    ['npm/node_modules/undici', '6.29.1'],
    ['openclaw/node_modules/undici', '8.12.2'],
    ['openclaw/node_modules/zod', '4.6.6'],
  ]);
  for (const [relative, version] of expected) {
    const manifest = path.join(gatewayDir, 'node_modules', relative, 'package.json');
    const actual = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    if (actual !== version) throw new Error(`Gateway dependency policy mismatch at ${relative}: ${actual} != ${version}`);
  }
}

module.exports = {
  dependencies,
  overrides,
  stamp,
  repairBundledIpAddress,
  repairBundledDependencies,
  assertGatewayDependencyPolicy,
};
