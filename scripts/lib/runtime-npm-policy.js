'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const { extractTarGzArchive } = require('./extract-archive');
const version = '11.21.1';
const integrity = 'sha512-YTzL6QBEJXyHcTu0JiUc7RKMp+mzlJtl7rGLmERaXUQeFHIMc9atdr6G9M9C8vDWbv40epoTQAzNL2/PtZVDhQ==';

function patchRuntimeNpmDependencies(source, replacements) {
  for (const item of replacements) {
    const manifest = JSON.parse(fs.readFileSync(path.join(item.source, 'package.json'), 'utf8'));
    if (manifest.name !== item.name || manifest.version !== item.version) throw new Error('Missing runtime npm dependency replacement: ' + item.name);
    if (fs.lstatSync(item.source).isSymbolicLink()) throw new Error('Linked runtime npm replacement');
  }
  for (const item of replacements) {
    const validate = dir => {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Linked runtime npm directory');
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        const p = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const range = p.dependencies?.[item.name] ?? p.optionalDependencies?.[item.name];
        if (range && !semver.satisfies(item.version, range)) throw new Error('Incompatible runtime npm dependency consumer: ' + p.name);
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) validate(path.join(dir, entry.name));
      }
    };
    validate(source);
  }
  for (const item of replacements) {
    const target = path.join(source, 'node_modules', item.name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(item.source, target, { recursive: true });
    for (const lockName of ['package-lock.json', 'npm-shrinkwrap.json']) {
      const lockPath = path.join(source, lockName);
      if (!item.lockEntry || !fs.existsSync(lockPath)) continue;
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (!lock.packages?.[`node_modules/${item.name}`]) continue;
      lock.packages[`node_modules/${item.name}`] = { ...item.lockEntry, inBundle: true };
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    }
  }
}

function refreshRuntimeNpm(runtimeDir, platform, gatewayDir, archive) {
  const root = path.resolve(runtimeDir);
  const target = path.join(root, platform === 'darwin' ? 'vendor/npm' : 'node_modules/npm');
  const gatewayLock = JSON.parse(fs.readFileSync(path.join(gatewayDir, 'package-lock.json'), 'utf8'));
  const replacements = [
    { name: 'ip-address', version: '10.7.4', source: path.resolve(gatewayDir, 'node_modules/ip-address'), lockEntry: gatewayLock.packages?.['node_modules/ip-address'] },
    { name: 'undici', version: '6.29.1', source: path.resolve(gatewayDir, 'node_modules/undici-6'), lockEntry: gatewayLock.packages?.['node_modules/undici-6'] },
  ];
  try {
    const p = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    const current = Object.fromEntries(replacements.map(item => [item.name, JSON.parse(fs.readFileSync(path.join(target, 'node_modules', item.name, 'package.json'), 'utf8')).version]));
    if (p.version === version && replacements.every(item => current[item.name] === item.version)) return false;
  } catch {}
  if ('sha512-' + crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64') !== integrity) throw new Error('Runtime npm archive integrity mismatch');
  const tmp = fs.mkdtempSync(path.join(root, '.npm-security-'));
  try {
    extractTarGzArchive(archive, tmp);
    const source = path.join(tmp, 'package');
    if (JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version !== version) throw new Error('Unexpected runtime npm version');
    patchRuntimeNpmDependencies(source, replacements);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel) || fs.lstatSync(target).isSymbolicLink()) throw new Error('Unsafe runtime npm target');
    fs.rmSync(target, { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    return true;
  } finally {
    const rel = path.relative(root, tmp);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Unsafe runtime npm temporary path');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
module.exports = { version, integrity, refreshRuntimeNpm, patchRuntimeNpmDependencies };
