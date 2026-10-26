/* Website contract + browser checks. Installer links are inspected, never followed. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'website');
const output = path.join(root, '.cache/website-20261025');
const release = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'));
const film = JSON.parse(fs.readFileSync(path.join(directory, 'promo/latest/film.json'), 'utf8'));
const installer = release.assets.find(asset => asset.name.endsWith('-x64.exe'));
const version = release.tag_name.slice(1);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.vtt': 'text/vtt' };

function checkStatic() {
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(directory, 'styles.css'), 'utf8');
  const tokens = fs.readFileSync(path.join(directory, 'design-tokens.css'), 'utf8');
  const app = fs.readFileSync(path.join(directory, 'app.js'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate HTML IDs');
  const idSet = new Set(ids);
  let localReferences = 0;
  for (const match of html.matchAll(/\b(?:href|src|poster)="([^"]+)"/g)) {
    const reference = match[1];
    if (/^(https?:|data:|\/api\/)/.test(reference)) continue;
    if (reference.startsWith('#')) { assert.ok(idSet.has(reference.slice(1)), 'Missing anchor: ' + reference); continue; }
    const relative = reference.replace(/^\/CryoClaw\/?/, '').split(/[?#]/)[0];
    const resolved = path.resolve(directory, relative || 'index.html');
    assert.ok(resolved.startsWith(directory + path.sep), 'Asset leaves website: ' + reference);
    assert.ok(fs.existsSync(resolved), 'Missing local asset: ' + reference);
    localReferences++;
  }
  for (const id of ['start', 'workspace', 'workflow', 'extensions', 'dashboard', 'demo', 'download']) assert.ok(idSet.has(id), 'Missing product story: ' + id);
  assert.ok(tokens.startsWith(fs.readFileSync(path.join(root, 'shared/design-tokens.css'), 'utf8').trimEnd()), 'Desktop token copy is out of sync');
  const declared = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  for (const match of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(declared.has(match[1]), 'Undefined CSS token: ' + match[1]);
  assert.ok(!/#[a-f0-9]{3,8}\b|(?:rgb|hsl)a?\(/i.test(css), 'View colors must use tokens');
  assert.ok(!/transition\s*:\s*all\b|text-transform\s*:\s*uppercase/i.test(css), 'Style contract');
  assert.ok(!/<[^>]+(?:\son\w+\s*=|\sstyle\s*=)/i.test(html), 'CSP requires external styles and scripts');
  assert.ok(/<video\b[^>]*preload="none"/.test(html) && !/<video\b[^>]*\bautoplay\b/.test(html), 'Video must load on demand');
  assert.ok(html.includes('看 ' + film.duration + ' 秒演示') && html.includes('CryoClaw in motion · ' + film.duration + 's'), 'Video copy differs from latest film duration');
  const captions = fs.readFileSync(path.join(directory, 'assets/cryoclaw-demo.zh-CN.vtt'), 'utf8');
  assert.equal((captions.match(/ --> /g) || []).length, film.captions.length, 'Caption cue count differs from latest film');
  for (const [, , text] of film.captions) assert.ok(captions.includes(text), 'Missing caption: ' + text);
  assert.ok(!/<section\b[^>]*data-panel[^>]*\shidden\b/.test(html), 'No-JS readers need every preview and platform');
  assert.ok(html.includes('第三方 gh-proxy.com'), 'Mirror must identify the third party');
  for (const id of ['hero-version', 'download-version']) assert.ok(html.includes('id="' + id + '">' + release.tag_name), 'Pinned version mismatch: ' + id);
  for (const id of ['download-hero', 'download-cta']) assert.ok(new RegExp('id="' + id + '" href="/api/cryoclaw-dl\\?v=' + version.replaceAll('.', '\\.') + '"').test(html), 'Pinned download mismatch: ' + id);
  assert.ok(html.includes('id="download-official" href="' + installer.browser_download_url + '"'), 'Official asset mismatch');
  assert.ok(html.includes('id="download-mirror" href="https://gh-proxy.com/' + installer.browser_download_url + '"'), 'Mirror asset mismatch');
  assert.ok(html.includes('id="checksum-value">' + installer.digest.slice(7)), 'Pinned checksum mismatch');
  assert.ok(html.includes('id="download-size">' + (installer.size / 1048576).toFixed(1) + ' MB'), 'Pinned size mismatch');
  new vm.Script(app, { filename: 'website/app.js' });
  for (const name of ['CryoMiSans.woff2', 'CryoInter.woff2', 'CryoMono.woff2', 'MiSans-LICENSE.pdf', 'Inter-OFL.txt', 'JetBrainsMono-OFL.txt']) assert.ok(fs.statSync(path.join(directory, 'assets/fonts', name)).size > 1000, 'Font or license is missing: ' + name);
  const report = { checks: ['local assets and anchors', 'five product stories', 'desktop tokens and CSS references', 'CSP and on-demand video', 'latest video duration and captions', 'no-JS panels', 'verified release/URL/size/SHA-256 snapshot', 'JavaScript syntax', 'self-hosted fonts and licenses'], localReferences, release: release.tag_name, videoDuration: film.duration };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'static-verification.json'), JSON.stringify(report, null, 2));
  return report;
}

async function checkBrowser() {
  const runtime = process.env.CRYOCLAW_PLAYWRIGHT_PATH ? createRequire(path.join(process.env.CRYOCLAW_PLAYWRIGHT_PATH, 'package.json')) : require;
  const { chromium } = runtime('playwright');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = url.pathname === '/api/cryoclaw-release' ? path.join(directory, 'release.json') : path.resolve(directory, url.pathname.replace(/^\/CryoClaw\/?/, '') || 'index.html');
    if (!file.startsWith(directory + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (error, data) => { if (error) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browserArg = process.argv.indexOf('--browser');
  let browser;
  const errors = [], warnings = [], checks = [];
  const monitor = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
      if (message.type() === 'warning') warnings.push(message.text());
    });
  };
  const settle = page => page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
  });
  const base = process.env.CRYOCLAW_SITE_URL || `http://127.0.0.1:${server.address().port}/CryoClaw`;
  try {
    browser = await chromium.launch({ headless: true, ...(browserArg >= 0 ? { executablePath: process.argv[browserArg + 1] } : {}) });
    for (const [width, scheme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [320, 'light'], [768, 'light'], [900, 'light'], [1024, 'light']]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: scheme, reducedMotion: 'reduce' });
      monitor(page);
      const mediaRequests = [];
      page.on('request', request => { if (/\.mp4(?:\?|$)/.test(request.url())) mediaRequests.push(request.url()); });
      await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.__copiedChecksum = value; } }, configurable: true }); });
      await page.goto(base, { waitUntil: 'networkidle' });
      assert.equal(await page.title(), 'CryoClaw — 把对话，接到工作里。');
      assert.ok(await page.locator('#hero-title').isVisible(), 'First meaningful screen');
      assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0, 'Framework error overlay');
      await page.evaluate(() => document.fonts.ready);
      const loadedFonts = await page.evaluate(() => [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family));
      for (const family of ['CryoMiSans', 'CryoInter', 'CryoMono']) assert.ok(loadedFonts.includes(family), 'Missing font: ' + family);
      const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, broken: [...document.images].filter(img => img.getBoundingClientRect().height && img.complete && !img.naturalWidth).map(img => img.src) }));
      assert.ok(layout.scroll <= layout.width + 1, width + ': horizontal overflow ' + JSON.stringify(layout));
      assert.deepEqual(layout.broken, []);
      assert.deepEqual(mediaRequests, [], 'Video downloaded before playback');
      assert.ok((await page.locator('#download-cta').getAttribute('href')).startsWith('/api/cryoclaw-dl?v='));
      const explorer = page.locator('.product-explorer');
      for (const name of ['本地工作空间', '模型管理', '主题定制', '对话与交付']) {
        const tab = explorer.getByRole('tab', { name, exact: true });
        await tab.click();
        assert.equal(await tab.getAttribute('aria-selected'), 'true');
        assert.equal(await explorer.getByRole('tabpanel').count(), 1);
      }
      await explorer.getByRole('tab', { name: '对话与交付', exact: true }).focus();
      await page.keyboard.press('End');
      assert.equal(await explorer.getByRole('tab', { name: '主题定制', exact: true }).getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Home');
      const platform = page.locator('.download-card');
      await platform.getByRole('tab', { name: '其他平台', exact: true }).click();
      assert.ok(await page.locator('#download-other').isVisible());
      assert.equal(await platform.getByRole('tabpanel').count(), 1);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await platform.getByRole('tab', { name: 'Windows x64', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await explorer.getByRole('tab', { name: '对话与交付', exact: true }).getAttribute('aria-selected'), 'true', 'Tab groups interfered');
      if (width <= 900) {
        const menu = page.locator('.menu-toggle');
        await menu.click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await menu.getAttribute('aria-expanded'), 'false');
        await menu.click();
        await page.locator('#mobile-nav').getByRole('link', { name: '下载 CryoClaw' }).click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'false');
      }
      const theme = page.locator('.theme-toggle');
      await theme.click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), scheme === 'dark' ? 'light' : 'dark');
      await theme.click();
      await page.locator('.checksum summary').click();
      assert.match(await page.locator('#checksum-value').textContent(), /^[a-f0-9]{64}$/i);
      await page.locator('.copy-button').click();
      assert.equal(await page.evaluate(() => window.__copiedChecksum), await page.locator('#checksum-value').textContent());
      await page.locator('.checksum summary').click();
      await page.locator('.faq-list summary').first().click();
      assert.notEqual(await page.locator('.faq-list details').first().getAttribute('open'), null);
      await page.locator('.faq-list summary').first().click();
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('motion-ready')), false, 'Reduced motion must show content without entrances');
      for (const image of await page.locator('.dashboard-live img').all()) {
        const ratio = await image.evaluate(async img => {
          img.loading = 'eager';
          await img.decode();
          const rect = img.getBoundingClientRect();
          return { shown: rect.width / rect.height, original: img.naturalWidth / img.naturalHeight };
        });
        assert.ok(Math.abs(ratio.shown - ratio.original) < .03, width + ': dashboard image loses its aspect ratio: ' + JSON.stringify(ratio));
      }
      await page.mouse.move(0, 0);
      await page.evaluate(async () => {
        window.scrollTo({ top: 0, behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));
      });
      assert.equal(await page.locator('.desktop-nav [aria-current]').count(), 0, 'Navigation retained a later section at the hero');
      await page.screenshot({ path: path.join(output, `website-${width}-${scheme}.png`), fullPage: true });
      await page.screenshot({ path: path.join(output, `hero-${width}-${scheme}.png`) });
      checks.push(width + 'px ' + scheme + ': layout, fonts, assets, separate tabs, keyboard, menu, theme, checksum copy, FAQ, media deferral and reduced motion');
      await page.close();
    }
    const motion = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'no-preference' });
    monitor(motion);
    await motion.goto(base, { waitUntil: 'networkidle' });
    await settle(motion);
    assert.equal(await motion.locator('.hero-copy').evaluate(element => getComputedStyle(element).opacity), '1', 'Normal-motion hero entrance');
    for (const id of ['tab-models', 'tab-workspace', 'tab-theme', 'tab-chat']) await motion.locator('#' + id).click();
    await settle(motion);
    assert.equal(await motion.locator('.product-explorer [data-panel]:not([hidden])').count(), 1, 'Interrupted tab motion left an outgoing panel visible');
    const menu = motion.locator('.menu-toggle');
    await menu.click();
    await settle(motion);
    assert.ok(await motion.locator('#mobile-nav').isVisible());
    await menu.click();
    await settle(motion);
    assert.equal(await motion.locator('#mobile-nav').isVisible(), false, 'Menu did not complete its exit');
    await menu.click();
    await settle(motion);
    await motion.locator('#mobile-nav').getByRole('link', { name: '看板', exact: true }).click();
    await settle(motion);
    assert.equal(await motion.evaluate(() => document.activeElement.id), 'dashboard', 'Mobile anchor must move focus out of the closing menu');
    const theme = motion.locator('.theme-toggle');
    await theme.click();
    await motion.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await settle(motion);
    await theme.click();
    await motion.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await settle(motion);
    for (const element of await motion.locator('.reveal').all()) {
      await element.scrollIntoViewIfNeeded();
      await motion.waitForFunction(element => element.classList.contains('is-in'), await element.elementHandle());
      await settle(motion);
      assert.equal(await element.evaluate(element => getComputedStyle(element).opacity), '1', 'Scroll reveal did not complete');
    }
    await motion.mouse.move(0, 0);
    await motion.evaluate(() => document.activeElement?.blur());
    await motion.locator('#dashboard').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await settle(motion);
    await motion.screenshot({ path: path.join(output, 'dashboard-390-normal-motion.png') });
    await motion.locator('.download-card').evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await settle(motion);
    await motion.screenshot({ path: path.join(output, 'download-390-normal-motion.png') });
    await motion.evaluate(async () => {
      window.scrollTo({ top: 0, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    await settle(motion);
    assert.equal(await motion.locator('.desktop-nav [aria-current]').count(), 0, 'Normal-motion navigation must clear at the hero');
    await motion.screenshot({ path: path.join(output, 'hero-390-normal-motion.png') });
    await motion.screenshot({ path: path.join(output, 'website-390-normal-motion.png'), fullPage: true });
    await motion.close();
    checks.push('390px normal motion: entrances, interrupted tab swaps, menu exit, anchor focus, theme cross-fades and scroll reveals');
    if (!process.env.CRYOCLAW_SITE_URL) {
      const noJS = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
      await noJS.goto(base);
      assert.ok(await noJS.locator('#download-cta').isVisible());
      assert.equal(await noJS.locator('#download-official').getAttribute('href'), installer.browser_download_url);
      assert.equal(await noJS.locator('#checksum-value').textContent(), installer.digest.slice(7));
      for (const id of ['panel-chat', 'panel-models', 'panel-workspace', 'panel-theme', 'download-windows', 'download-other']) assert.ok(await noJS.locator('#' + id).isVisible(), 'No-JS panel: ' + id);
      assert.ok(await noJS.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'No-JS overflow');
      await noJS.close();
      for (const [name, response] of [
        ['metadata unavailable', { status: 503, body: '{}' }],
        ['unverified metadata', { status: 200, contentType: 'application/json', body: JSON.stringify({ ...release, assets: release.assets.map(asset => ({ ...asset, digest: null })) }) }],
        ['unexpected asset URL', { status: 200, contentType: 'application/json', body: JSON.stringify({ ...release, assets: release.assets.map(asset => ({ ...asset, browser_download_url: 'https://example.invalid/installer.exe' })) }) }]
      ]) {
        const failed = await browser.newPage();
        await failed.route('**/api/cryoclaw-release', route => route.fulfill(response));
        await failed.goto(base + '/');
        await failed.getByText('版本信息暂未刷新，仍可下载当前稳定版').waitFor();
        assert.equal(await failed.locator('#download-cta').getAttribute('href'), '/api/cryoclaw-dl?v=' + version, name);
        assert.equal(await failed.locator('#checksum-value').textContent(), installer.digest.slice(7), name);
        await failed.close();
      }
      checks.push('No-JS previews/platforms/downloads and unavailable or unverified metadata fallback');
    }
    const videoPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    monitor(videoPage);
    await videoPage.goto(base);
    const playback = await videoPage.locator('#demo video').evaluate(async video => {
      video.muted = true;
      await video.play();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Website video playback timed out')), 15000);
        const progress = () => {
          if (video.currentTime > .15) { clearTimeout(timeout); video.removeEventListener('timeupdate', progress); resolve(); }
        };
        video.addEventListener('timeupdate', progress);
      });
      video.pause();
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, error: video.error?.message || null };
    });
    assert.ok(Math.abs(playback.duration - film.duration) < .12, 'Website video duration differs from latest film');
    assert.equal(playback.width, film.width);
    assert.equal(playback.height, film.height);
    assert.equal(playback.error, null);
    await videoPage.close();
    checks.push('Latest MP4 starts playing after request and matches film duration/resolution');
    assert.deepEqual(errors, [], 'Renderer/CSP errors');
    assert.deepEqual(warnings, [], 'Renderer warnings');
    const report = { base, checks, playback, errors, warnings };
    fs.writeFileSync(path.join(output, process.env.CRYOCLAW_SITE_URL ? 'live-verification.json' : 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser?.close(); server.close(); }
}

try {
  const report = checkStatic();
  if (process.argv.includes('--static')) console.log(JSON.stringify(report, null, 2));
  else checkBrowser().catch(error => { console.error(error); process.exitCode = 1; });
} catch (error) { console.error(error); process.exitCode = 1; }
