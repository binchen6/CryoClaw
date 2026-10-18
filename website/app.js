/* Release metadata is optional: downloads and content also work without JS. */
(() => {
  'use strict';
  const official = 'https://github.com/binchen6/CryoClaw/releases/latest';
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  fetch('/api/cryoclaw-release', { signal: controller.signal }).then(r => {
    if (!r.ok) throw new Error('Release unavailable');
    return r.json();
  }).then(data => {
    if (!/^v?\d+(\.\d+){2}$/.test(data.tag_name)) return;
    const version = data.tag_name.replace(/^v/, '');
    set('hero-version', 'v' + version);
    set('download-version', '最新版本 v' + version);
    ['download-hero', 'download-cta'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.href = '/api/cryoclaw-dl?v=' + encodeURIComponent(version);
    });
    const asset = (data.assets || []).find(a => /^CryoClaw-Setup-.*-x64\.exe$/i.test(a.name));
    if (asset && asset.browser_download_url.startsWith('https://github.com/binchen6/CryoClaw/releases/download/')) {
      const el = document.getElementById('download-official');
      if (el) el.href = asset.browser_download_url;
      set('download-size', 'Windows x64 · ' + Math.round(asset.size / 1048576) + ' MB');
    }
    if (data.published_at && !isNaN(Date.parse(data.published_at))) set('download-date', new Date(data.published_at).toLocaleDateString('zh-CN') + ' 发布');
    const box = document.getElementById('whatsnew');
    if (box) { const a = document.createElement('a'); a.href = official; a.textContent = '查看 v' + version + ' 完整更新 →'; box.replaceChildren(a); box.classList.add('is-on'); }
  }).catch(() => {}).finally(() => clearTimeout(timer));
})();

/* One frame per input: no idle animation loop or particle dependencies. */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const title = document.querySelector('.hero__title');
  let enabled = !reduced.matches;
  if (title) {
    title.setAttribute('data-mask-text', Array.from(title.querySelectorAll('.hero__line')).map(line => line.textContent.trim()).join('\n'));
    title.addEventListener('pointermove', event => {
      if (!enabled || !fine.matches) return;
      const r = title.getBoundingClientRect();
      title.style.setProperty('--light-x', event.clientX - r.left + 'px');
      title.style.setProperty('--light-y', event.clientY - r.top + 'px');
      title.classList.add('is-tracking');
    }, { passive: true });
    title.addEventListener('pointerleave', () => {
      title.classList.remove('is-tracking');
    });
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'ambient-particles'; canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }
  let frame = 0;
  function draw() {
    frame = 0;
    const width = innerWidth, height = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    if (!enabled) return;
    const style = getComputedStyle(document.documentElement);
    const colors = [style.getPropertyValue('--accent').trim(), style.getPropertyValue('--accent-2').trim()];
    const count = Math.min(42, Math.floor(width / 24));
    for (let i = 0; i < count; i++) {
      const speed = .035 + (i % 5) * .012;
      const x = ((i * 137.508 + Math.sin(scrollY * .001 + i) * 16) % width + width) % width;
      const y = ((i * 193.71 - scrollY * speed) % height + height) % height;
      ctx.globalAlpha = .12 + (i % 3) * .045;
      ctx.fillStyle = colors[i % 2]; ctx.beginPath(); ctx.arc(x, y, 1 + (i % 3) * .5, 0, Math.PI * 2); ctx.fill();
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
  addEventListener('scroll', schedule, { passive: true }); addEventListener('resize', schedule, { passive: true });
  reduced.addEventListener('change', () => { enabled = !reduced.matches; if (!enabled && title) { title.classList.remove('is-tracking'); title.style.setProperty('--title-x', '0px'); title.style.setProperty('--title-y', '0px'); } schedule(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  schedule();
})();
