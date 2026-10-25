/* The complete page and verified download snapshot remain usable without JS. */
(() => {
  'use strict';
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const tokens = getComputedStyle(root);
  const motionDuration = parseFloat(tokens.getPropertyValue('--duration-normal')) * 1000 || 200;
  const motionEase = tokens.getPropertyValue('--ease-standard').trim() || 'cubic-bezier(0.2, 0, 0, 1)';
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const themeButton = document.querySelector('.theme-toggle');
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : systemTheme.matches;
  const setThemeLabel = () => {
    themeButton.setAttribute('aria-label', isDark() ? '切换到浅色主题' : '切换到深色主题');
    themeButton.setAttribute('aria-pressed', String(isDark()));
  };
  try {
    const saved = localStorage.getItem('cryoclaw-site-theme');
    if (['light', 'dark'].includes(saved)) root.dataset.theme = saved;
  } catch { /* Storage is optional in private browsing. */ }
  themeButton.hidden = false;
  setThemeLabel();
  systemTheme.addEventListener('change', setThemeLabel);
  themeButton.addEventListener('click', () => {
    const theme = isDark() ? 'light' : 'dark';
    const change = () => { root.dataset.theme = theme; setThemeLabel(); };
    if (document.startViewTransition && !reducedMotion.matches) document.startViewTransition(change);
    else change();
    try { localStorage.setItem('cryoclaw-site-theme', theme); } catch { /* Theme still works. */ }
  });

  const menuButton = document.querySelector('.menu-toggle');
  const mobileMenu = document.getElementById('mobile-nav');
  let menuAnimation;
  let menuRevision = 0;
  const setMenu = open => {
    const revision = ++menuRevision;
    const previousHeight = mobileMenu.hidden ? 0 : mobileMenu.getBoundingClientRect().height;
    menuAnimation?.cancel();
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? '收起导航' : '展开导航');
    if (reducedMotion.matches || typeof mobileMenu.animate !== 'function') { mobileMenu.hidden = !open; return; }
    mobileMenu.hidden = false;
    const fullHeight = mobileMenu.getBoundingClientRect().height;
    menuAnimation = mobileMenu.animate([
      { height: previousHeight + 'px', opacity: open ? 0 : 1, transform: open ? 'translateY(-8px)' : 'none', overflow: 'hidden' },
      { height: (open ? fullHeight : 0) + 'px', opacity: open ? 1 : 0, transform: open ? 'none' : 'translateY(-8px)', overflow: 'hidden' }
    ], { duration: motionDuration, easing: motionEase });
    menuAnimation.finished.then(() => {
      if (revision === menuRevision) mobileMenu.hidden = !open;
    }).catch(() => { /* A newer toggle owns the final state. */ });
  };
  const closeMenu = () => { if (menuButton.getAttribute('aria-expanded') === 'true') setMenu(false); };
  menuButton.hidden = false;
  menuButton.addEventListener('click', () => setMenu(menuButton.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') { closeMenu(); menuButton.focus(); }
  });
  matchMedia('(min-width: 901px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  // Each tab group owns its selection, keyboard order and outgoing motion.
  document.querySelectorAll('[data-tabs]').forEach(group => {
    const tablist = group.querySelector('[data-tablist]');
    const tabs = [...tablist.querySelectorAll('[data-tab]')];
    const panels = tabs.map(tab => document.getElementById(tab.hash.slice(1)));
    const animations = new Map();
    let selected = Math.max(0, tabs.findIndex(tab => tab.hash === location.hash));
    tablist.setAttribute('role', 'tablist');
    group.classList.add('tabs-enhanced');
    const selectTab = (next, animate = true) => {
      selected = next;
      tabs.forEach((tab, index) => {
        const active = index === selected;
        const panel = panels[index];
        const wasHidden = panel.hidden;
        const opacity = wasHidden ? 0 : Number(getComputedStyle(panel).opacity);
        animations.get(panel)?.cancel();
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panel.setAttribute('aria-hidden', String(!active));
        panel.inert = !active;
        if (!animate || reducedMotion.matches || typeof panel.animate !== 'function') { panel.hidden = !active; return; }
        if (!active && wasHidden) return;
        panel.hidden = false;
        const motion = panel.animate(active ? [
          { opacity: wasHidden ? 0 : opacity, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ] : [
          { opacity, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(-8px)' }
        ], { duration: motionDuration, easing: motionEase });
        animations.set(panel, motion);
        motion.finished.then(() => {
          if (animations.get(panel) !== motion) return;
          panel.hidden = index !== selected;
          animations.delete(panel);
        }).catch(() => { /* Rapid tab changes cancel the old transition. */ });
      });
    };
    tabs.forEach((tab, index) => {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panels[index].id);
      panels[index].setAttribute('role', 'tabpanel');
      panels[index].tabIndex = 0;
      tab.addEventListener('click', event => { event.preventDefault(); if (selected !== index) selectTab(index); });
      tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        if (selected !== next) selectTab(next);
        tabs[next].focus();
      });
    });
    selectTab(selected, false);
  });

  document.querySelectorAll('a[href^="#"]:not([data-tab])').forEach(link => link.addEventListener('click', event => {
    const hash = link.getAttribute('href');
    const target = document.getElementById(hash.slice(1));
    if (!target) return;
    event.preventDefault();
    closeMenu();
    history.pushState(null, '', hash);
    target.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    if (link.classList.contains('skip-link') || mobileMenu.contains(link)) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }));

  if ('IntersectionObserver' in window) {
    const links = [...document.querySelectorAll('.desktop-nav a')];
    const visibleSections = new Map();
    const navigationObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => visibleSections.set(entry.target.id, entry.isIntersecting));
      const current = links.find(link => visibleSections.get(link.hash.slice(1)));
      links.forEach(link => {
        if (link === current) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-15% 0px -55% 0px' });
    links.forEach(link => navigationObserver.observe(document.getElementById(link.hash.slice(1))));
    if (!reducedMotion.matches) {
      const reveals = [...document.querySelectorAll('.reveal')];
      const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        revealObserver.unobserve(entry.target);
      }), { rootMargin: '0px 0px 48px 0px', threshold: 0.04 });
      reveals.forEach(element => revealObserver.observe(element));
      root.classList.add('motion-ready');
      reducedMotion.addEventListener('change', event => {
        if (event.matches) { root.classList.remove('motion-ready'); revealObserver.disconnect(); }
      });
    }
  }

  const copy = document.querySelector('.copy-button');
  if (navigator.clipboard?.writeText) {
    copy.hidden = false;
    copy.setAttribute('aria-label', '复制 SHA-256 校验值');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(document.getElementById('checksum-value').textContent); copy.textContent = '已复制'; }
      catch { copy.textContent = '请手动复制'; }
      setTimeout(() => { copy.textContent = '复制'; }, 2200);
    });
  }

  const set = (id, value) => { document.getElementById(id).textContent = value; };
  const pinnedVersion = document.getElementById('download-version').textContent.slice(1).split('.').map(Number);
  const applyRelease = data => {
    if (!/^v\d+(\.\d+){2}$/.test(data.tag_name)) throw new Error('Invalid release');
    const version = data.tag_name.slice(1);
    const parts = version.split('.').map(Number);
    if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Invalid release');
    const publishedAt = typeof data.published_at === 'string' ? Date.parse(data.published_at) : NaN;
    if (!Number.isFinite(publishedAt)) throw new Error('Invalid release date');
    const difference = parts.map((part, index) => part - pinnedVersion[index]).find(value => value !== 0) || 0;
    if (difference < 0) throw new Error('Older metadata');
    const name = 'CryoClaw-Setup-' + version + '-x64.exe';
    const official = 'https://github.com/binchen6/CryoClaw/releases/download/' + data.tag_name + '/' + name;
    const asset = (data.assets || []).find(item => item.name === name && item.browser_download_url === official && Number.isSafeInteger(item.size) && item.size > 0 && /^sha256:[a-f0-9]{64}$/i.test(item.digest || ''));
    if (!asset) throw new Error('Verified installer not published');
    set('hero-version', data.tag_name);
    set('download-version', data.tag_name);
    set('download-size', (asset.size / 1048576).toFixed(1) + ' MB');
    set('download-date', new Date(publishedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' 发布');
    ['download-hero', 'download-cta'].forEach(id => { document.getElementById(id).href = '/api/cryoclaw-dl?v=' + encodeURIComponent(version); });
    document.getElementById('download-official').href = official;
    document.getElementById('download-mirror').href = 'https://gh-proxy.com/' + official;
    document.getElementById('release-notes').href = 'https://github.com/binchen6/CryoClaw/releases/tag/' + data.tag_name;
    set('checksum-value', asset.digest.slice(7));
    set('checksum-command', 'Get-FileHash .\\' + name + ' -Algorithm SHA256');
    set('release-status', data.stale ? '当前显示已验证的稳定版本' : '已同步 GitHub 发布信息');
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  fetch('/api/cryoclaw-release', { signal: controller.signal }).then(response => {
    if (!response.ok) throw new Error('Metadata unavailable');
    return response.json();
  }).then(applyRelease).catch(() => { set('release-status', '版本信息暂未刷新，仍可下载当前稳定版'); }).finally(() => clearTimeout(timeout));
})();
