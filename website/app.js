/* CryoClaw Landing — 交互与动效
   兼容基线：ES5 语法（var/function），无依赖零构建；
   所有动效经 prefersReduced 门控，IntersectionObserver 缺失时降级为直接显示。 */
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

  /* ── 导航滚动态 + 滚动进度条 + hero 视差（同一 rAF 节流 scroll 处理器） ── */
  var nav = document.getElementById("nav");
  var progress = document.getElementById("nav-progress");
  var aurora = document.getElementById("aurora");
  var mockWrap = document.querySelector(".hero__mock");
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var y = window.scrollY || window.pageYOffset || 0;
      nav.classList.toggle("is-scrolled", y > 24);
      if (progress) {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.width = (max > 0 ? (y / max) * 100 : 0) + "%";
      }
      if (!prefersReduced) {
        // 视差：aurora 下移快、mock 上移慢，营造纵深（仅首屏范围内有意义）
        if (aurora && y < window.innerHeight * 1.5) {
          aurora.style.transform = "translateY(" + y * 0.18 + "px)";
        }
        if (mockWrap && y < window.innerHeight * 1.5) {
          mockWrap.style.transform = "translateY(" + y * -0.06 + "px)";
        }
      }
    });
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
    "本周重点：\n\n1. 发布 v2026.828.1 —— 设计 token 现代化，浅色/暗色双主题独立调参。\n2. 对话页布局重构：消息流居中列、compose 一体化输入框。\n3. 内核 asar 再裁 10MB",
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

  /* ── spotlight 边框：特性卡光斑跟随指针 ── */
  if (!prefersReduced && window.matchMedia("(hover: hover)").matches) {
    document.querySelectorAll(".feature-card").forEach(function (card) {
      var rafId = 0;
      var lastE = null;
      card.addEventListener("pointermove", function (e) {
        lastE = e;
        if (rafId) return; // rAF 合帧节流：一帧内多次 pointermove 只落一次样式写
        rafId = requestAnimationFrame(function () {
          rafId = 0;
          if (!lastE) return;
          var rect = card.getBoundingClientRect();
          card.style.setProperty("--mx", (lastE.clientX - rect.left) + "px");
          card.style.setProperty("--my", (lastE.clientY - rect.top) + "px");
        });
      });
    });

    /* ── 磁性按钮：指针靠近时轻微吸附（最大 4px） ── */
    document.querySelectorAll("[data-magnetic]").forEach(function (btn) {
      var STRENGTH = 0.12;
      var MAX = 4;
      var rafId = 0;
      var lastE = null;
      var pressed = false;
      var apply = function () {
        if (!lastE) { btn.style.transform = ""; return; }
        var rect = btn.getBoundingClientRect();
        var dx = (lastE.clientX - (rect.left + rect.width / 2)) * STRENGTH;
        var dy = (lastE.clientY - (rect.top + rect.height / 2)) * STRENGTH;
        dx = Math.max(-MAX, Math.min(MAX, dx));
        dy = Math.max(-MAX, Math.min(MAX, dy));
        // 按下时保留 :active 缩放反馈（内联 transform 会盖掉 CSS 的 .btn:active scale）
        btn.style.transform = "translate(" + dx + "px," + dy + "px)" + (pressed ? " scale(0.97)" : "");
      };
      btn.addEventListener("pointermove", function (e) {
        lastE = e;
        if (rafId) return; // rAF 合帧节流
        rafId = requestAnimationFrame(function () {
          rafId = 0;
          apply();
        });
      });
      btn.addEventListener("pointerdown", function () {
        pressed = true;
        apply();
      });
      btn.addEventListener("pointerup", function () {
        pressed = false;
        apply();
      });
      btn.addEventListener("pointerleave", function () {
        pressed = false;
        lastE = null;
        btn.style.transform = "";
      });
    });
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
