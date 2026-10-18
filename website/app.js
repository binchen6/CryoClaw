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
