/* CryoClaw Landing — 2026.9 R2 品牌焕新（浅色一等 · CryoBlue 混色）交互与动效
   兼容基线：现代浏览器（Chrome/Edge 111+、Safari 15.4+、Firefox 115+），无依赖零构建。
   所有动效经 prefersReduced 门控；IntersectionObserver 缺失时降级为直接显示。 */
(function () {
  "use strict";

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // ?snap=1：截图/打印模式——全部 reveal 直接可见、关闭平滑滚动与倾斜/磁吸
  var snapMode = /[?&]snap=1/.test(location.search);
  if (snapMode) {
    document.documentElement.style.scrollBehavior = "auto";
    prefersReduced = true;
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
    }, { threshold: 0.12, rootMargin: "0px 0px -60px 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ── 导航滚动态 + 进度条 + 背景视差（同 rAF 节流 scroll） ── */
  var nav = document.getElementById("nav");
  var progress = document.getElementById("nav-progress");
  var bgOrbs = document.querySelectorAll(".bg__orb");
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
      if (!prefersReduced && bgOrbs.length) {
        // 光斑反向视差，营造纵深
        var dy = y * 0.06;
        bgOrbs.forEach(function (orb, i) {
          var dir = i % 2 === 0 ? 1 : -1;
          orb.style.transform = "translateY(" + (dy * dir) + "px)";
        });
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
    var duration = 1500;
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
        if (entry.isIntersecting) { animateCount(entry.target); statIO.unobserve(entry.target); }
      });
    }, { threshold: 0.4 });
    statNums.forEach(function (el) { statIO.observe(el); });
  } else {
    statNums.forEach(animateCount);
  }

  /* ── 提供商跑马灯：复制一份实现无缝循环 ── */
  var track = document.getElementById("provider-track");
  if (track) track.innerHTML += track.innerHTML;

  /* ── mock 窗口流式对话 ── */
  var streamEl = document.getElementById("stream-text");
  var DEMO_LINES = [
    "本周重点：\n\n1. 品牌焕新 —— CryoBlue 蓝青混色 + CryoIcons 自绘图标。\n2. 对话页布局重构：消息流居中列、compose 一体化输入框。\n3. 内核 asar 再裁 10MB。",
  ];
  if (streamEl && !prefersReduced) {
    var text = DEMO_LINES[0], idx = 0;
    function typeNext() {
      if (idx <= text.length) {
        streamEl.textContent = text.slice(0, idx);
        idx++;
        var ch = text.charAt(idx - 1);
        var delay = ch === "\n" ? 150 : 22 + Math.random() * 38;
        setTimeout(typeNext, delay);
      } else {
        setTimeout(function () { idx = 0; streamEl.textContent = ""; typeNext(); }, 6500);
      }
    }
    if ("IntersectionObserver" in window) {
      var started = false;
      var mockIO = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && !started) {
          started = true; setTimeout(typeNext, 600); mockIO.disconnect();
        }
      }, { threshold: 0.3 });
      mockIO.observe(streamEl.closest(".hero__mock") || streamEl);
    } else { typeNext(); }
  } else if (streamEl) {
    streamEl.textContent = DEMO_LINES[0];
  }

  /* ── spotlight 边框：bento 卡光斑跟随指针（rAF 合帧） ── */
  if (!prefersReduced && window.matchMedia("(hover: hover)").matches) {
    document.querySelectorAll("[data-spot]").forEach(function (card) {
      var rafId = 0, lastE = null;
      card.addEventListener("pointermove", function (e) {
        lastE = e;
        if (rafId) return;
        rafId = requestAnimationFrame(function () {
          rafId = 0;
          if (!lastE) return;
          var rect = card.getBoundingClientRect();
          card.style.setProperty("--mx", (lastE.clientX - rect.left) + "px");
          card.style.setProperty("--my", (lastE.clientY - rect.top) + "px");
        });
      });
    });
  }

  /* ── 3D 倾斜：应用窗口 mock ── */
  var tiltWrap = document.getElementById("tilt");
  if (tiltWrap && !prefersReduced && window.matchMedia("(hover: hover)").matches) {
    var mockEl = tiltWrap.querySelector(".mock");
    var raf = 0;
    tiltWrap.addEventListener("pointermove", function (e) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var rect = tiltWrap.getBoundingClientRect();
        var px = (e.clientX - rect.left) / rect.width - 0.5;
        var py = (e.clientY - rect.top) / rect.height - 0.5;
        // 覆盖 CSS 默认微倾，动态追加
        mockEl.style.transform = "rotateY(" + (px * 7) + "deg) rotateX(" + (-py * 6) + "deg)";
      });
    });
    tiltWrap.addEventListener("pointerleave", function () {
      mockEl.style.transform = "";
      mockEl.style.transition = "transform .6s cubic-bezier(.16,1,.3,1)";
      setTimeout(function () { mockEl.style.transition = ""; }, 600);
    });
  }

  /* ── 磁吸按钮：朝指针轻微位移 ── */
  if (!prefersReduced && window.matchMedia("(hover: hover)").matches) {
    document.querySelectorAll("[data-magnetic]").forEach(function (btn) {
      btn.addEventListener("pointermove", function (e) {
        var rect = btn.getBoundingClientRect();
        var x = (e.clientX - rect.left - rect.width / 2) * 0.16;
        var y = (e.clientY - rect.top - rect.height / 2) * 0.16;
        btn.style.transform = "translate(" + x + "px," + y + "px)";
      });
      btn.addEventListener("pointerleave", function () {
        btn.style.transform = "";
        btn.style.transition = "transform .4s cubic-bezier(.34,1.56,.64,1)";
        setTimeout(function () { btn.style.transition = ""; }, 400);
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
      var asset = (data.assets || []).find(function (a) { return /Setup.*x64\.exe$/i.test(a.name); });
      if (asset) {
        ["download-hero", "download-cta"].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.href = asset.browser_download_url;
        });
      }
    })
    .catch(function () { /* 离线/限流时用静态兜底 */ });
})();
