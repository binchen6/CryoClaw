/* Visual and interaction smoke checks; uses the same Playwright runtime as promo capture. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const runtime = process.env.CRYOCLAW_PLAYWRIGHT_PATH ? createRequire(path.join(process.env.CRYOCLAW_PLAYWRIGHT_PATH, 'package.json')) : require;
const { chromium } = runtime('playwright');
const directory = path.join(root, 'website');
const output = path.join(root, '.cache/website-rework');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.vtt': 'text/vtt' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = url.pathname === '/api/cryoclaw-release' ? path.join(directory, 'release.json') : path.resolve(directory, url.pathname.replace(/^\/CryoClaw\/?/, '') || 'index.html');
  if (!file.startsWith(directory + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => { if (error) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data); });
});

(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browserArg = process.argv.indexOf('--browser');
  const browser = await chromium.launch({ headless: true, ...(browserArg >= 0 ? { executablePath: process.argv[browserArg + 1] } : {}) });
  const errors = [], checks = [];
  const base = process.env.CRYOCLAW_SITE_URL || `http://127.0.0.1:${server.address().port}/CryoClaw`;
  try {
    for (const [width, scheme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [320, 'light'], [768, 'light'], [1024, 'light']]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: scheme, reducedMotion: 'reduce' });
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.locator('#hero-version').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const loadedFonts = await page.evaluate(() => [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family));
      for (const family of ['CryoMiSans', 'CryoInter', 'CryoMono']) assert.ok(loadedFonts.includes(family), `Missing font: ${family}`);
      const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, broken: [...document.images].filter(img => img.getBoundingClientRect().height && img.complete && !img.naturalWidth).map(img => img.src) }));
      assert.ok(layout.scroll <= layout.width + 1, `${width}: horizontal overflow ${JSON.stringify(layout)}`);
      assert.deepEqual(layout.broken, []);
      assert.ok((await page.locator('#download-cta').getAttribute('href')).startsWith('/api/cryoclaw-dl?v='));
      for (const name of ['本地工作空间', '模型管理', '主题定制', '对话与交付']) {
        const tab = page.getByRole('tab', { name, exact: true });
        await tab.click(); assert.equal(await tab.getAttribute('aria-selected'), 'true');
        assert.equal(await page.getByRole('tabpanel').count(), 1);
      }
      await page.getByRole('tab', { name: '对话与交付', exact: true }).focus();
      await page.keyboard.press('End'); assert.equal(await page.getByRole('tab', { name: '主题定制', exact: true }).getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Home');
      if (width <= 800) {
        const menu = page.locator('.menu-toggle'); await menu.click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape'); assert.equal(await menu.getAttribute('aria-expanded'), 'false');
        await menu.click(); await page.locator('#mobile-nav').getByRole('link', { name: '下载 CryoClaw' }).click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'false');
      }
      const theme = page.locator('.theme-toggle'); await theme.click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), scheme === 'dark' ? 'light' : 'dark');
      await theme.click();
      await page.locator('.checksum summary').click();
      assert.match(await page.locator('#checksum-value').textContent(), /^[a-f0-9]{64}$/i);
      await page.locator('.checksum summary').click();
      await page.locator('.faq-list summary').first().click(); assert.ok(await page.locator('.faq-list details').first().getAttribute('open') !== null);
      await page.locator('.faq-list summary').first().click();
      await page.evaluate(async () => { window.scrollTo(0, document.body.scrollHeight); await new Promise(r => requestAnimationFrame(r)); window.scrollTo(0, 0); });
      await page.screenshot({ path: path.join(output, `website-${width}-${scheme}.png`), fullPage: true });
      await page.screenshot({ path: path.join(output, `hero-${width}-${scheme}.png`) });
      checks.push(`${width}px ${scheme}: layout, images, tabs, keyboard, theme, FAQ and download links`);
      await page.close();
    }
    if (!process.env.CRYOCLAW_SITE_URL) {
      const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
      await page.goto(base); assert.ok(await page.locator('#download-cta').isVisible());
      assert.ok((await page.locator('#download-official').getAttribute('href')).endsWith('.exe')); await page.close();
      const failed = await browser.newPage();
      await failed.route('**/api/cryoclaw-release', route => route.fulfill({ status: 503, body: '{}' }));
      await failed.goto(base + '/'); await failed.getByText('版本信息暂未刷新，仍可下载当前稳定版').waitFor();
      assert.match(await failed.locator('#download-cta').getAttribute('href'), /2026\.1019\.0/);
      await failed.close(); checks.push('No-JS downloads and metadata failure fallback');
    }
    assert.deepEqual(errors, [], 'Renderer/CSP errors');
    fs.writeFileSync(path.join(output, process.env.CRYOCLAW_SITE_URL ? 'live-verification.json' : 'verification.json'), JSON.stringify({ base, checks, errors }, null, 2));
    console.log(JSON.stringify({ checks, errors }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
