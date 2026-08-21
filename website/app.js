/* CryoClaw Landing — 交互与动效 */
(function () {
  "use strict";

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // ?snap=1：截图/打印模式——全部 reveal 直接可见、关闭平滑滚动
  var snapMode = /[?&]snap=1/.test(location.search);
  if (snapMode) {
    document.documentElement.style.scrollBehavior = "auto";
    prefersReduced = true;
    var heroEl = document.querySelector(".hero");
    if (heroEl) heroEl.style.minHeight = "0";
  }

  /* ── 滚动 reveal ── */
  var revealEls = document.querySelectorAll(".reveal");
  if (prefersReduced || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ── 导航滚动态 ── */
  var nav = document.getElementById("nav");
  function onScroll() {
    nav.classList.toggle("is-scrolled", window.scrollY > 24);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ── 数字滚动 ── */
  function animateCount(el) {
    var target = parseFloat(el.dataset.count);
    var suffix = el.dataset.suffix || "";
    var isFloat = String(el.dataset.count).indexOf(".") !== -1;
    if (prefersReduced) {
      el.textContent = (isFloat ? target.toFixed(1) : target) + suffix;
      return;
    }
    var start = null;
    var duration = 1400;
    function tick(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var value = target * eased;
      el.textContent = (isFloat ? value.toFixed(1) : Math.round(value)) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  var statNums = document.querySelectorAll(".stat__num");
  if ("IntersectionObserver" in window) {
    var statIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animateCount(entry.target);
          statIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    statNums.forEach(function (el) { statIO.observe(el); });
  } else {
    statNums.forEach(animateCount);
  }

  /* ── 提供商跑马灯：复制一份实现无缝循环 ── */
  var track = document.getElementById("provider-track");
  if (track) {
    track.innerHTML += track.innerHTML;
  }

  /* ── mock 窗口流式对话 ── */
  var streamEl = document.getElementById("stream-text");
  var DEMO_LINES = [
    "本周重点：\n\n1. 发布 v2026.821.2 —— 应用更新迁移 GitHub Releases，差分下载只拉变更块。\n2. 日志统一收口，诊断包一键导出，排障时间减半。\n3. 内核 asar 再裁 10MB，测试基线 487 用例全绿。\n\n下周：macOS 公证与 ARM64 分架构构建。",
  ];
  if (streamEl && !prefersReduced) {
    var text = DEMO_LINES[0];
    var idx = 0;
    function typeNext() {
      if (idx <= text.length) {
        streamEl.textContent = text.slice(0, idx);
        idx++;
        var ch = text.charAt(idx - 1);
        var delay = ch === "\n" ? 160 : 24 + Math.random() * 40;
        setTimeout(typeNext, delay);
      } else {
        setTimeout(function () {
          idx = 0;
          streamEl.textContent = "";
          typeNext();
        }, 6000);
      }
    }
    // 等 mock 进入视口再开始打字
    if ("IntersectionObserver" in window) {
      var started = false;
      var mockIO = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && !started) {
          started = true;
          setTimeout(typeNext, 600);
          mockIO.disconnect();
        }
      }, { threshold: 0.3 });
      mockIO.observe(streamEl.closest(".hero__mock") || streamEl);
    } else {
      typeNext();
    }
  } else if (streamEl) {
    streamEl.textContent = DEMO_LINES[0];
  }

  /* ── GitHub API：取最新版本号与直链（渐进增强，失败静默保留静态文案） ── */
  fetch("https://api.github.com/repos/binchen6/CryoClaw/releases/latest")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.tag_name) return;
      var version = data.tag_name.replace(/^v/, "");
      var heroVer = document.getElementById("hero-version");
      if (heroVer) heroVer.textContent = "v" + version;
      var dlVer = document.getElementById("download-version");
      if (dlVer) dlVer.textContent = "最新版本 v" + version;
      var asset = (data.assets || []).find(function (a) {
        return /Setup.*x64\.exe$/i.test(a.name);
      });
      if (asset) {
        ["download-hero", "download-cta"].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.href = asset.browser_download_url;
        });
      }
    })
    .catch(function () { /* 离线/限流时用静态兜底 */ });
})();
