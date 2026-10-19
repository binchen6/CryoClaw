/* Content and pinned downloads work before JavaScript or release metadata loads. */
(() => {
  'use strict';
  const root = document.documentElement;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const themeButton = document.querySelector('.theme-toggle');
  const setThemeLabel = () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : systemTheme.matches;
    themeButton.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
    themeButton.setAttribute('aria-pressed', String(dark));
  };
  try { const saved = localStorage.getItem('cryoclaw-site-theme'); if (['light', 'dark'].includes(saved)) root.dataset.theme = saved; } catch { /* Private browsing can deny storage. */ }
  themeButton.hidden = false;
  setThemeLabel();
  systemTheme.addEventListener('change', setThemeLabel);
  themeButton.addEventListener('click', () => {
    root.dataset.theme = (root.dataset.theme ? root.dataset.theme === 'dark' : systemTheme.matches) ? 'light' : 'dark';
    try { localStorage.setItem('cryoclaw-site-theme', root.dataset.theme); } catch { /* Theme still works without persistence. */ }
    setThemeLabel();
  });

  const menuButton = document.querySelector('.menu-toggle');
  const mobileMenu = document.getElementById('mobile-nav');
  const closeMenu = () => { mobileMenu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-label', '展开导航'); };
  menuButton.hidden = false;
  menuButton.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? '收起导航' : '展开导航');
    mobileMenu.hidden = !open;
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !mobileMenu.hidden) { closeMenu(); menuButton.focus(); } });
  matchMedia('(min-width: 801px)').addEventListener('change', event => { if (event.matches) closeMenu(); });
  document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', event => {
    const hash = link.getAttribute('href');
    const target = document.getElementById(hash.slice(1));
    if (!target) return;
    event.preventDefault(); closeMenu();
    history.pushState(null, '', hash);
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    if (link.classList.contains('skip-link')) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }));

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const selectTab = tab => {
    tabs.forEach(item => {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault(); selectTab(tabs[next]); tabs[next].focus();
    });
  });
  if ('IntersectionObserver' in window) {
    const links = [...document.querySelectorAll('.desktop-nav a')];
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      links.forEach(link => { if (link.hash === '#' + entry.target.id) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
    }), { rootMargin: '-20% 0px -55% 0px' });
    links.forEach(link => observer.observe(document.getElementById(link.hash.slice(1))));
  }

  const copy = document.querySelector('.copy-button');
  if (navigator.clipboard) {
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(document.getElementById('checksum-value').textContent); copy.textContent = '已复制'; }
      catch { copy.textContent = '请手动复制'; }
      setTimeout(() => { copy.textContent = '复制'; }, 2200);
    });
  }

  const set = (id, value) => { document.getElementById(id).textContent = value; };
  const applyRelease = data => {
    if (!/^v\d+(\.\d+){2}$/.test(data.tag_name)) throw new Error('Invalid release');
    const version = data.tag_name.slice(1);
    const name = 'CryoClaw-Setup-' + version + '-x64.exe';
    const official = 'https://github.com/binchen6/CryoClaw/releases/download/' + data.tag_name + '/' + name;
    const asset = (data.assets || []).find(a => a.name === name && a.browser_download_url === official && Number.isSafeInteger(a.size) && a.size > 0);
    if (!asset) throw new Error('Installer not published');
    set('hero-version', data.tag_name); set('download-version', data.tag_name);
    set('download-size', (asset.size / 1048576).toFixed(1) + ' MB');
    if (data.published_at && !isNaN(Date.parse(data.published_at))) set('download-date', new Date(data.published_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' 发布');
    ['download-hero', 'download-cta'].forEach(id => { document.getElementById(id).href = '/api/cryoclaw-dl?v=' + encodeURIComponent(version); });
    document.getElementById('download-official').href = official;
    document.getElementById('download-mirror').href = 'https://gh-proxy.com/' + official;
    document.getElementById('release-notes').href = 'https://github.com/binchen6/CryoClaw/releases/tag/' + data.tag_name;
    const checksum = document.querySelector('.checksum');
    const digest = /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7) : '';
    checksum.hidden = !digest;
    if (digest) { set('checksum-value', digest); set('checksum-command', 'Get-FileHash .\\' + name + ' -Algorithm SHA256'); }
    set('release-status', data.stale ? '当前显示已验证的稳定版本' : '已同步 GitHub 发布信息');
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  fetch('/api/cryoclaw-release', { signal: controller.signal }).then(response => {
    if (!response.ok) throw new Error('Metadata unavailable'); return response.json();
  }).then(applyRelease).catch(() => { set('release-status', '版本信息暂未刷新，仍可下载当前稳定版'); }).finally(() => clearTimeout(timeout));
})();
