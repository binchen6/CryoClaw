#!/usr/bin/env node
/* Copy only deployable website files; promo source frames stay in this repository. */
const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve(__dirname, '../website');
const blog = path.resolve(process.argv[2] || '../blog');
if (!fs.existsSync(path.join(blog, 'app/api/cryoclaw-dl/route.ts'))) throw new Error('Pass the blog repository path as the first argument.');
const target = path.join(blog, 'public/CryoClaw');
fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
const files = ['index.html', 'styles.css', 'design-tokens.css', 'app.js', 'release.json'];
for (const name of files) fs.copyFileSync(path.join(source, name), path.join(target, name));
fs.cpSync(path.join(source, 'assets'), path.join(target, 'assets'), { recursive: true, force: true });
console.log(`Synced ${files.length} page files and website assets to ${target}`);
