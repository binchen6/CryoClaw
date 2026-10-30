// 看板入门（onboarding）：新用户第一块看板。
// 结构与参考页一致：主视觉（四个可切换的示例）→ 模板库 → 提示词卡片 → 排版演示 → 手势与数据规则。
// 所有卡片自包含、无外部网络，示例数据在卡片内明确标注。
const base = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;min-height:100%}
body{font-family:MiSans,Inter,'Microsoft YaHei UI','PingFang SC','Segoe UI',system-ui,sans-serif;color:#0f1216;background:#fff;padding:0;overflow-y:auto}
h1,h2,h3,p{margin:0}h1{font-size:clamp(34px,5vw,58px);line-height:1.06;letter-spacing:-2.4px;font-weight:850}
h2{font-size:26px;line-height:1.2;letter-spacing:-.6px;font-weight:800}
h3{font-size:13px;font-weight:700;letter-spacing:.02em}
p{font-size:14px;line-height:1.7;color:#69727a}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font:600 11px/1.2 var(--font-meta,ui-monospace,monospace);letter-spacing:.18em;text-transform:uppercase;color:#168aff}
.eyebrow:before{content:'';width:18px;height:1px;background:currentColor;opacity:.6}
.muted{color:#8a949c}
.mono{font-family:var(--font-meta,ui-monospace,monospace);font-variant-numeric:tabular-nums}
button{font:inherit;cursor:pointer;border:0;background:transparent;color:inherit}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:20px;background:#eef4f8;color:#42697d;font:600 10.5px/1.2 var(--font-meta,ui-monospace,monospace);letter-spacing:.06em;white-space:nowrap}
.pill i{width:6px;height:6px;border-radius:50%;background:#168aff}
.cta{display:inline-flex;align-items:center;gap:8px;padding:11px 16px;border-radius:12px;background:#0f1216;color:#fff;font-size:13px;font-weight:650;transition:transform .16s ease,background .16s ease}
.cta:hover{background:#168aff;transform:translateY(-1px)}.cta:active{transform:none}
.ghost{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border:1px solid #e2e8ee;border-radius:10px;background:#fff;color:#42697d;font-size:12px;font-weight:600}
.ghost:hover{border-color:#168aff;color:#0b63b0}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
@media(max-width:520px){h1{font-size:32px;letter-spacing:-1.4px}h2{font-size:20px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>`;

/* 四个主视觉示例。数据是固定的演示值，面板上标注「示例」。 */
function marketPanel() {
  return `<div class="panel" data-panel="market">
  <div class="market">
    <div class="market__main">
      <div class="market__head"><div><b>上证指数</b><span class="mono">000001</span></div><div class="seg" role="group" aria-label="周期"><button aria-pressed="false">10日</button><button class="is-on" aria-pressed="true">30日</button><button aria-pressed="false">60日</button></div></div>
      <div class="market__price"><strong class="mono">3,936.52</strong><span>点</span><em class="mono down">-0.40%</em><small>示例</small></div>
      <div class="market__legend mono"><i class="ma5"></i>MA5 <i class="ma20"></i>MA20 <span class="dim">日线</span></div>
      <svg class="market__chart" viewBox="0 0 520 190" role="img" aria-label="示例 K 线与成交量"></svg>
      <div class="market__axis mono"><span>08/13</span><span>09/23</span></div>
    </div>
    <div class="market__side">
      <div class="side-card"><div class="side-head"><b>我的自选</b><span class="mono dim">3</span></div>
        <div class="watch"><div class="watch__row is-active"><span>大盘 上证指数</span><b class="mono">3,936.52</b></div>
          <div class="watch__row"><span>贵州茅台 <i class="mono dim">600519</i></span><b class="mono">¥1,251.24</b><em class="mono down">-0.20%</em></div>
          <div class="watch__row"><span>宁德时代 <i class="mono dim">300750</i></span><b class="mono">¥301.00</b><em class="mono down">-1.19%</em></div>
          <div class="watch__row"><span>比亚迪 <i class="mono dim">002594</i></span><b class="mono">¥85.85</b><em class="mono down">-0.84%</em></div>
        </div></div>
      <div class="side-card"><div class="side-head"><b>当日报价</b><span class="mono dim">点</span></div>
        <div class="quote"><div><span>今开</span><b class="mono">3,951.37</b></div><div><span>最高</span><b class="mono">3,951.52</b></div><div><span>最低</span><b class="mono">3,934.46</b></div><div><span>昨收</span><b class="mono">3,952.13</b></div></div>
      </div>
    </div>
  </div></div>`;
}
function storePanel() {
  return `<div class="panel" data-panel="store" hidden>
  <div class="store">
    <div class="store__card">
      <div class="store__head"><b>线上商店</b><div class="row"><div class="seg"><button aria-pressed="false">7天</button><button class="is-on" aria-pressed="true">14天</button></div><span class="mono dim">9月</span></div></div>
      <div class="metrics">
        <div><span>净收入</span><strong class="mono">¥573,665</strong><em class="mono up">+7.3% 较上期</em></div>
        <div><span>订单</span><strong class="mono">2,688</strong><em class="muted">85 笔退款</em></div>
        <div><span>客单价</span><strong class="mono">¥213</strong><em class="muted">扣除退款</em></div>
        <div><span>转化率</span><strong class="mono">4.44%</strong><em class="muted">60,550 次访问</em></div>
      </div>
      <div class="store__body">
        <div class="trend"><div class="trend__head"><span>收入趋势</span><span class="link">看明细 ↗</span></div><svg viewBox="0 0 360 120" role="img" aria-label="示例收入趋势"><defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#168aff" stop-opacity=".22"/><stop offset="1" stop-color="#168aff" stop-opacity="0"/></linearGradient></defs><path d="M8 96 L48 92 L88 64 L128 86 L168 80 L208 58 L248 74 L288 44 L328 52 L352 70 L352 116 L8 116 Z" fill="url(#trendFill)"/><path d="M8 96 L48 92 L88 64 L128 86 L168 80 L208 58 L248 74 L288 44 L328 52 L352 70" fill="none" stroke="#168aff" stroke-width="2.2" stroke-linejoin="round"/></svg><div class="trend__axis mono"><span>09-15</span><span>09-28</span></div></div>
        <div class="channels"><div class="trend__head"><span>渠道贡献</span><span class="link">全部</span></div>
          <div class="channel"><div><span>品牌官网</span><b class="mono">61%</b></div><i style="--w:61%"></i></div>
          <div class="channel"><div><span>社媒投放</span><b class="mono">16%</b></div><i style="--w:16%"></i></div>
          <div class="channel"><div><span>渠道合作</span><b class="mono">23%</b></div><i style="--w:23%"></i></div>
          <p class="channel__note">↗ 品牌官网贡献 61% 净收入 · 示例</p>
        </div>
      </div>
    </div>
  </div></div>`;
}
function projectPanel() {
  return `<div class="panel" data-panel="project" hidden>
  <div class="project">
    <div class="project__card">
      <div class="project__head"><b>官网上线</b><span class="dot-warn"><i></i>有风险</span></div>
      <div class="seg seg--wide"><button aria-pressed="true">设计 <span class="mono">4/4</span></button><button aria-pressed="false">开发 <span class="mono">3/5</span></button><button aria-pressed="false">验收 <span class="mono">1/3</span></button></div>
      <div class="tasks">
        <div class="task"><i class="ring"></i><div><b>支付回调联调</b><span>Alex · 09.21 · 延期</span></div><em class="chip">有阻塞</em></div>
        <div class="task"><i class="ring"></i><div><b>账号与订单权限</b><span>Jo · 09.24</span></div><em class="chip chip--run">进行中</em></div>
        <div class="task is-done"><i class="check">✓</i><div><b>首页与落地页</b><span>Alex · 09.20</span></div><em class="chip chip--done">已完成</em></div>
      </div>
    </div>
    <div class="project__side">
      <div class="side-card"><div class="side-head"><b>项目进度</b><span class="mono dim">示例</span></div><strong class="mono big">67<small>%</small></strong><p class="dim">8 / 12 完成</p><div class="bar"><i style="width:67%"></i></div><p class="dim small">9月27日上线</p></div>
      <div class="side-card"><div class="side-head"><b>里程碑</b></div>
        <div class="ms is-done"><i>✓</i><div><b>设计交付</b><span class="mono">09.20</span></div></div>
        <div class="ms is-now"><i></i><div><b>联调完成</b><span class="mono">09.25</span></div></div>
        <div class="ms"><i></i><div><b>官网上线</b><span class="mono">09.27</span></div></div>
      </div>
    </div>
  </div></div>`;
}
function briefPanel() {
  return `<div class="panel" data-panel="brief" hidden>
  <div class="brief">
    <div class="brief__card brief__news">
      <div class="brief__head"><b>今日资讯</b><div class="seg"><button class="is-on" aria-pressed="true">全部</button><button aria-pressed="false">已收藏</button></div></div>
      <p class="brief__date mono">9月23日</p>
      <article class="lead"><h3>AI Agent 加速落地办公场景，从对话走向执行任务</h3><p>行业综述：AI Agent 正从简单问答进化为能拆解任务、调用工具、持续执行的智能体，办公自动化成为最先规模落地的方向…</p></article>
      <div class="news"><div><span>多模态大模型成为主流，图文音视频统一理解</span><i>☆</i></div><div><span>开源模型生态持续繁荣，中小模型能力快速逼近旗舰</span><i>☆</i></div><div><span>推理成本快速下降，AI 应用进入普惠阶段</span><i>☆</i></div></div>
    </div>
    <div class="brief__side">
      <div class="side-card"><div class="side-head"><b>我的邮件</b><span class="pill">示例</span></div><div class="mail__meta"><span>未读 <b class="mono">2</b></span><span class="down">紧急 <b class="mono">1</b></span></div>
        <div class="mail"><i></i><div><b>产品团队</b><em class="down">紧急</em><span>上线评审，请确认时间</span></div><span class="mono dim">09:10</span></div>
        <div class="mail"><i></i><div><b>设计团队</b><em>待回</em><span>首页设计稿已更新</span></div><span class="mono dim">08:45</span></div>
      </div>
      <div class="side-card"><div class="side-head"><b>开源发现</b><span class="mono dim">趋势</span></div>
        <div class="repo"><div><b>面向生产环境的 AI Agent 编排</b><span class="mono">agentflow/agent-flow</span></div><span class="mono dim">☆ 8,600</span></div>
        <div class="repo"><div><b>Prompt 全生命周期管理工具</b><span class="mono">promptops/prompt-o…</span></div><span class="mono dim">☆ 6,200</span></div>
      </div>
    </div>
  </div></div>`;
}

const hero = `<!doctype html><html><head>${base}<style>
body{background:radial-gradient(ellipse at 92% 4%,#dcefff,transparent 58%),linear-gradient(155deg,#f7fbff,#eaf6ff)}
.hero{position:relative;display:grid;align-content:center;grid-template-columns:minmax(230px,.72fr) minmax(0,1.5fr);gap:26px;padding:46px 32px 30px;min-height:100%;background-image:radial-gradient(#8ec4e64d 1px,transparent 1px);background-size:18px 18px}
.hero__lead{align-self:center;display:flex;flex-direction:column;gap:12px;min-width:0}
.hero__lead h1 em{font-style:normal;color:#168aff}
.hero__lead p{font-size:14px;letter-spacing:.08em}
.tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px;max-width:360px}
.tabs button{padding:10px 12px;border-radius:10px;background:#fff;color:#42697d;font-size:13px;font-weight:600;box-shadow:0 1px 2px #0f121610;position:relative;transition:color .16s,background .16s}
.tabs button[aria-selected=true]{color:#0b63b0;background:#fff}
.tabs button[aria-selected=true]:after{content:'';position:absolute;left:12px;right:12px;bottom:5px;height:2px;border-radius:2px;background:#168aff}
.hero__stage{position:relative;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:10px}
.bubble{position:static;align-self:flex-end;z-index:3;max-width:88%;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:14px 14px 4px 14px;background:#fff;color:#2b4a5c;font-size:13px;line-height:1.4;box-shadow:0 10px 30px #0f121614;text-align:left}
.bubble:hover{color:#0b63b0}.bubble span{display:block}.bubble i{font-style:normal;color:#168aff}
.panel{width:100%;min-width:0}
.market{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(150px,.85fr);gap:10px}
.market__main,.side-card{background:#111a20;color:#e7eef3;border-radius:14px;padding:14px 16px;min-width:0}
.market__head,.side-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.market__head b{font-size:14px;font-weight:650}.market__head .mono{font-size:11px;color:#7f97a5;margin-left:6px}
.seg{display:inline-flex;gap:2px;padding:2px;border-radius:7px;background:#ffffff14}
.seg button{padding:4px 8px;border-radius:5px;font-size:11px;color:#9db4c1}
.seg button.is-on{background:#ffffff1f;color:#fff}
.market__price{display:flex;align-items:baseline;gap:6px;margin:8px 0 2px}
.market__price strong{font-size:clamp(22px,3.4vw,34px);letter-spacing:-1px}
.market__price span{font-size:12px;color:#8fa6b4}.market__price em{font-style:normal;font-size:12px}.market__price small{margin-left:auto;font-size:10px;color:#68808d;letter-spacing:.12em}
.down{color:#ef5350}.up{color:#26a69a}
.market__legend{display:flex;align-items:center;gap:6px;font-size:10px;color:#8fa6b4}.market__legend i{width:12px;height:2px;border-radius:2px;display:inline-block}
.market__legend .ma5{background:#f5c542}.market__legend .ma20{background:#5aa9e6;margin-left:6px}.market__legend .dim{margin-left:auto}
.market__chart{width:100%;height:165px;display:block;margin-top:6px}
.market__axis{display:flex;justify-content:space-between;font-size:9.5px;color:#68808d}
.market__side{display:flex;flex-direction:column;gap:10px;min-width:0}
.watch{display:flex;flex-direction:column;gap:1px;margin-top:8px}
.watch__row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:6px 7px;border-radius:7px;font-size:11.5px;align-items:baseline}
.watch__row span{color:#b9c9d3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.watch__row b{font-size:11.5px;text-align:right}.watch__row em{grid-column:2;font-style:normal;font-size:10px;text-align:right}
.watch__row .dim{color:#6d8592;font-style:normal;font-size:10px;margin-left:4px}
.watch__row.is-active{background:#ffffff12}.watch__row.is-active span{color:#fff}
.quote{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
.quote div{display:flex;flex-direction:column;gap:2px}.quote span{font-size:10px;color:#7f97a5}.quote b{font-size:11.5px}
.store__card{background:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 12px 34px #0f12160f}
.store__head{display:flex;align-items:center;justify-content:space-between;gap:12px}.store__head b{font-size:14px}
.store__head .seg{background:#eef3f7}.store__head .seg button{color:#8a949c}.store__head .seg button.is-on{background:#fff;color:#0f1216;box-shadow:0 1px 2px #0f121612}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0 12px}
.metrics div{display:flex;flex-direction:column;gap:3px;min-width:0}.metrics span{font-size:11px;color:#8a949c}.metrics strong{font-size:clamp(16px,2.2vw,22px);letter-spacing:-.5px}.metrics em{font-style:normal;font-size:10.5px;color:#8a949c}.metrics em.up{color:#12b981}
.store__body{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(150px,.85fr);gap:14px;border-top:1px solid #eef3f7;padding-top:12px}
.trend__head,.channels .trend__head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:#42697d}
.trend__head b,.channels b{font-weight:650}.link{color:#168aff;font-size:10.5px}
.trend svg{width:100%;height:96px;display:block;margin-top:4px}
.trend__axis{display:flex;justify-content:space-between;font-size:9.5px;color:#a8b3bb}
.channel{display:flex;flex-direction:column;gap:5px;margin-top:10px}.channel div{display:flex;justify-content:space-between;font-size:11px;color:#42697d}.channel b{font-weight:600}
.channel i{display:block;height:6px;border-radius:6px;background:linear-gradient(90deg,#168aff var(--w),#e8f3ff var(--w))}
.channel:nth-of-type(2) i{background:linear-gradient(90deg,#38bdf8 var(--w),#eaf7ff var(--w))}
.channel:nth-of-type(3) i{background:linear-gradient(90deg,#8b5cf6 var(--w),#f1ecff var(--w))}
.channel__note{margin-top:10px;font-size:10.5px;color:#8a949c}
.project{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(150px,.8fr);gap:10px}
.project__card{background:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 12px 34px #0f12160f;min-width:0}
.project__head{display:flex;align-items:center;justify-content:space-between;gap:8px}.project__head b{font-size:14px}
.dot-warn{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:#d97706}.dot-warn i{width:6px;height:6px;border-radius:50%;background:#f59e0b}
.seg--wide{display:flex;margin:10px 0 4px;background:#f2f6f9}.seg--wide button{flex:1;color:#69727a;font-size:11.5px;padding:7px 8px}.seg--wide button[aria-pressed=true]{background:#fff;color:#0f1216;box-shadow:0 1px 2px #0f121610}.seg--wide .mono{color:#a8b3bb;font-size:10px;margin-left:4px}
.task{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #f0f4f7}.task:first-child{border-top:0}
.task>div{min-width:0;flex:1}.task b{display:block;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.task span{display:block;font-size:10.5px;color:#8a949c}
.task .ring{width:14px;height:14px;border-radius:50%;border:1.5px solid #cfe0ea;flex:none}.task .check{width:16px;height:16px;border-radius:50%;background:#0f1216;color:#fff;font-size:9px;display:grid;place-items:center;flex:none}
.task.is-done b{color:#8a949c;text-decoration:line-through}
.chip{font-style:normal;font-size:9.5px;padding:3px 7px;border-radius:20px;background:#fff1e6;color:#b45309;white-space:nowrap}.chip--run{background:#e8f3ff;color:#0b63b0}.chip--done{background:#eef7f2;color:#0f7a55}
.project__side{display:flex;flex-direction:column;gap:10px;min-width:0}
.big{display:block;font-size:36px;letter-spacing:-1.5px;margin-top:6px}.big small{font-size:14px;color:#8a949c}
.bar{height:6px;border-radius:6px;background:#eef3f7;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;border-radius:inherit;background:#168aff}
.dim{color:#8a949c}.small{font-size:10.5px}
.ms{display:flex;gap:8px;align-items:flex-start;padding:5px 0}.ms i{width:12px;height:12px;border-radius:50%;border:1.5px solid #cfe0ea;margin-top:2px;display:grid;place-items:center;font-size:8px;color:#fff;flex:none}
.ms b{display:block;font-size:11.5px;font-weight:600}.ms span{display:block;font-size:10px;color:#8a949c}.ms.is-done i{background:#0f1216;border-color:#0f1216}.ms.is-now i{border-color:#168aff;box-shadow:0 0 0 3px #168aff22}.ms.is-now b{color:#0b63b0}
.brief{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(160px,.85fr);gap:10px}
.brief__card{background:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 12px 34px #0f12160f;min-width:0}
.brief__head{display:flex;align-items:center;justify-content:space-between;gap:8px}.brief__head b{font-size:14px}
.brief__head .seg{background:#f2f6f9}.brief__head .seg button{color:#8a949c}.brief__head .seg button.is-on{background:#fff;color:#0f1216}
.brief__date{font-size:10px;color:#a8b3bb;margin:4px 0 8px}
.brief__news .lead{border-bottom:1px solid #f0f4f7;padding-bottom:9px;margin-bottom:6px}
.brief__news h3{font-size:15px;line-height:1.45;letter-spacing:-.2px}
.brief__news .lead p{font-size:11px;line-height:1.6;margin-top:3px;color:#8a949c;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.news div{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid #f6f9fb;font-size:11.5px;color:#2b4a5c}.news div:last-child{border-bottom:0}.news i{font-style:normal;color:#c8d3da}
.brief__side{display:flex;flex-direction:column;gap:10px;min-width:0}
.brief__side .side-card{background:#fff;color:#0f1216;box-shadow:0 12px 34px #0f12160f;padding:12px 14px}
.brief__side .side-head b{font-size:13px}
.mail__meta{display:flex;gap:12px;margin:6px 0 2px;font-size:10.5px;color:#8a949c}.mail__meta b{color:#0f1216}
.mail{display:flex;align-items:flex-start;gap:7px;padding:6px 0;border-top:1px solid #f4f7f9}.mail i{width:5px;height:5px;border-radius:50%;background:#168aff;margin-top:5px;flex:none}
.mail div{flex:1;min-width:0}.mail b{display:block;font-size:11px;font-weight:600}.mail em{font-style:normal;font-size:9.5px;color:#8a949c;margin-left:4px}.mail em.down{color:#dc2626}.mail span{display:block;font-size:10.5px;color:#8a949c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mail>.mono{font-size:9.5px;color:#a8b3bb;white-space:nowrap}
.repo{padding:7px 0;border-top:1px solid #f4f7f9}.repo div{min-width:0}.repo b{display:block;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.repo span{display:block;font-size:9.5px;color:#a8b3bb;margin-top:1px}.repo>.mono{color:#8a949c;font-size:10px;margin-top:2px}
@media(max-width:900px){.hero{grid-template-columns:1fr;padding:24px}.hero__stage{margin-top:6px}.bubble{top:-6px}}
@media(max-width:620px){.market,.store__body,.project,.brief{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.tabs{max-width:none}.market__chart{height:130px}.bubble{position:static;margin:0 0 8px;max-width:none;border-radius:12px}}
@media(max-height:420px){.hero{padding:20px 24px}.market__chart{height:120px}}
</style></head><body>
<div class="hero">
  <div class="hero__lead">
    <span class="eyebrow">看板 · 入门</span>
    <h1>关心的事<br><em>实时呈现</em></h1>
    <p>行情 项目 资讯 一眼看清</p>
    <div class="tabs" role="tablist" aria-label="示例看板">
      <button role="tab" data-tab="market" aria-selected="true">A 股盯盘</button>
      <button role="tab" data-tab="store" aria-selected="false">业务数据分析</button>
      <button role="tab" data-tab="project" aria-selected="false">项目管理</button>
      <button role="tab" data-tab="brief" aria-selected="false">每日简报</button>
    </div>
  </div>
  <div class="hero__stage">
    <button class="bubble" id="bubble" type="button"><span>帮我盯住 A 股大盘和自选股，每小时更新行情</span><i aria-hidden="true">↗</i></button>
    ${marketPanel()}${storePanel()}${projectPanel()}${briefPanel()}
  </div>
</div>
<script>
var prompts={market:'帮我盯住 A 股大盘和自选股，每小时更新行情',store:'把店铺的收入、订单和渠道表现做成一张看板',project:'跟踪官网上线进度，列出待办、风险和里程碑',brief:'把每日资讯、开源项目和邮件放在一起'};
var tabs=[].slice.call(document.querySelectorAll('[data-tab]')),panels=[].slice.call(document.querySelectorAll('[data-panel]')),bubble=document.getElementById('bubble');
function select(id,notify){
 tabs.forEach(function(button){button.setAttribute('aria-selected',String(button.dataset.tab===id));});
 panels.forEach(function(panel){panel.hidden=panel.dataset.panel!==id;});
 bubble.querySelector('span').textContent=prompts[id];
 if(notify){var ok=cryoclawDashboard.compose(prompts[id]);bubble.querySelector('i').textContent=ok?'✓':'↗';setTimeout(function(){bubble.querySelector('i').textContent='↗';},1600);}
}
tabs.forEach(function(button){button.onclick=function(){select(button.dataset.tab,false);};});
bubble.onclick=function(){select(document.querySelector('[data-tab][aria-selected=true]').dataset.tab,true);};
marketChart();
function marketChart(){
 var svg=document.querySelector('.market__chart');if(!svg)return;
 var seed=42,rand=function(){seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
 var count=26,width=520,height=190,pad=6,step=(width-pad*2)/count,price=3960,data=[];
 for(var index=0;index<count;index++){var open=price,close=open+(rand()-.48)*34,high=Math.max(open,close)+rand()*12,low=Math.min(open,close)-rand()*12;price=close;data.push({open:open,close:close,high:high,low:low,volume:6+rand()*16});}
 var min=Math.min.apply(null,data.map(function(d){return d.low;})),max=Math.max.apply(null,data.map(function(d){return d.high;})),scale=function(value){return height-20-(value-min)/(max-min)*(height-60);};
 var ns='http://www.w3.org/2000/svg',parts=[];
 for(var i=0;i<count;i++){var d=data[i],x=pad+i*step+step/2,up=d.close>=d.open,color=up?'#ef5350':'#26a69a';
  parts.push('<line x1="'+x.toFixed(1)+'" y1="'+scale(d.high).toFixed(1)+'" x2="'+x.toFixed(1)+'" y2="'+scale(d.low).toFixed(1)+'" stroke="'+color+'" stroke-width="1"/>');
  var top=Math.min(scale(d.open),scale(d.close)),box=Math.max(2,Math.abs(scale(d.open)-scale(d.close)));
  parts.push('<rect x="'+(x-step*.3).toFixed(1)+'" y="'+top.toFixed(1)+'" width="'+(step*.6).toFixed(1)+'" height="'+box.toFixed(1)+'" fill="'+color+'" opacity=".92"/>');
  parts.push('<rect x="'+(x-step*.3).toFixed(1)+'" y="'+(height-14-d.volume).toFixed(1)+'" width="'+(step*.6).toFixed(1)+'" height="'+d.volume.toFixed(1)+'" fill="'+color+'" opacity=".22"/>');
 }
 function average(period){var points=[];for(var index=period-1;index<count;index++){var sum=0;for(var j=0;j<period;j++)sum+=data[index-j].close;points.push((pad+(index-period/2)*step+step/2).toFixed(1)+','+scale(sum/period).toFixed(1));}return points.join(' ');}
 parts.push('<polyline points="'+average(5)+'" fill="none" stroke="#f5c542" stroke-width="1.4" opacity=".9"/>');
 parts.push('<polyline points="'+average(20)+'" fill="none" stroke="#5aa9e6" stroke-width="1.4" opacity=".75"/>');
 svg.innerHTML=parts.join('');
}
</script>
</body></html>`;

const templates = `<!doctype html><html><head>${base}<style>
body{background:#fff;padding:46px 28px 26px;display:flex;flex-direction:column;gap:16px}
.head{display:flex;flex-direction:column;gap:4px}
.head p{font-size:13px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;flex:1;min-height:0}
.tpl{display:flex;flex-direction:column;border:1px solid #e6edf2;border-radius:16px;background:#fbfdfe;overflow:hidden;min-width:0;transition:border-color .18s,box-shadow .18s,transform .18s}
.tpl:hover{border-color:#bcd9ea;box-shadow:0 16px 34px #0f121610;transform:translateY(-2px)}
.tpl__title{display:flex;align-items:center;gap:7px;padding:11px 13px 8px;font-size:13.5px;font-weight:700}
.tpl__title i{width:7px;height:7px;border-radius:50%}
.tpl[data-tpl=finance] .tpl__title i{background:#ef4444}.tpl[data-tpl=productivity] .tpl__title i{background:#168aff}.tpl[data-tpl=creative] .tpl__title i{background:#8b5cf6}
.tpl__preview{position:relative;margin:0 10px;border-radius:10px;overflow:hidden;flex:1;min-height:120px}
.tpl__caption{padding:9px 13px 11px;font-size:11px;line-height:1.55;color:#8a949c}
.tpl__action{margin:0 13px 13px;display:none}
.tpl:hover .tpl__action,.tpl:focus-within .tpl__action{display:inline-flex}
.fin{background:#0c1418;color:#dfe9ef;padding:10px;display:flex;flex-direction:column;gap:6px;height:100%;box-sizing:border-box}
.fin__chips{display:flex;gap:4px;flex-wrap:wrap}.fin__chips span{font-size:8px;padding:2px 6px;border-radius:20px;background:#ffffff14;color:#b9c9d3}
.fin svg{width:100%;flex:1;min-height:60px}
.fin__row{display:flex;align-items:baseline;justify-content:space-between;font-size:9px;color:#9db4c1}
.fin__row b{font-size:12px;color:#fff}
.prod{background:linear-gradient(150deg,#eaf6ff,#d6ecfb);padding:9px;display:grid;grid-template-columns:1.1fr .9fr;gap:6px;height:100%;box-sizing:border-box}
.prod__todo,.prod__timer{background:#fff;border-radius:9px;padding:8px;min-width:0;box-shadow:0 4px 12px #0f121608}
.prod__todo b,.prod__timer b{display:block;font-size:10px;margin-bottom:5px}
.prod__todo div{display:flex;align-items:center;gap:4px;font-size:9px;color:#69727a;padding:2px 0}
.prod__todo i{width:6px;height:6px;border-radius:50%;border:1px solid #cfe0ea;flex:none}
.prod__habit{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-top:8px}.prod__habit i{height:6px;border-radius:2px;background:#e3eef6}.prod__habit i:nth-child(3n){background:#bfe3fb}
.prod__timer{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:#bfe3fb}
.prod__timer strong{font-size:18px;letter-spacing:-.5px}.prod__timer span{font-size:8.5px;color:#42697d}
.cre{background:#08090b;height:100%;display:grid;place-items:center;position:relative;color:#fff}
.vinyl{width:84px;height:84px;border-radius:50%;background:repeating-radial-gradient(circle,#15181c 0 2px,#0b0d10 2px 4px);display:grid;place-items:center;box-shadow:0 10px 24px #000a}
.vinyl:after{content:'';width:24px;height:24px;border-radius:50%;background:#7dd3fc}
.cre__label{position:absolute;left:9px;right:9px;bottom:8px;display:flex;align-items:baseline;justify-content:space-between;font-size:8px;color:#9aa7b2}
.cre__label b{font-size:9px;color:#fff;font-weight:600}
@media(max-width:820px){.grid{grid-template-columns:1fr;overflow-y:auto}.tpl__preview{min-height:140px}}
</style></head><body>
<div class="head"><h2>搭建你的第一个看板</h2><p>挑一个喜欢的模板，点卡片预览，喜欢就添加到我的看板。</p></div>
<div class="grid">
  <article class="tpl" data-tpl="finance"><div class="tpl__title"><i></i>每日财经</div>
    <div class="tpl__preview fin"><div class="fin__chips"><span>腾讯控股</span><span>阿里巴巴</span><span>NVDA</span></div>
      <svg viewBox="0 0 220 90" aria-hidden="true"><g stroke="#ef5350" fill="#ef5350"><rect x="10" y="20" width="6" height="18"/><rect x="26" y="30" width="6" height="14"/><rect x="58" y="24" width="6" height="20"/><rect x="90" y="14" width="6" height="16"/><rect x="106" y="26" width="6" height="12"/></g><g stroke="#26a69a" fill="#26a69a"><rect x="42" y="40" width="6" height="16"/><rect x="74" y="34" width="6" height="18"/><rect x="122" y="38" width="6" height="14"/><rect x="138" y="46" width="6" height="12"/><rect x="154" y="36" width="6" height="18"/><rect x="170" y="42" width="6" height="10"/><rect x="186" y="30" width="6" height="14"/></g><g fill="#ffffff22"><rect x="10" y="76" width="6" height="8"/><rect x="26" y="76" width="6" height="11"/><rect x="42" y="76" width="6" height="6"/><rect x="58" y="76" width="6" height="12"/><rect x="74" y="76" width="6" height="9"/><rect x="90" y="76" width="6" height="7"/><rect x="106" y="76" width="6" height="13"/><rect x="122" y="76" width="6" height="8"/><rect x="138" y="76" width="6" height="10"/><rect x="154" y="76" width="6" height="6"/><rect x="170" y="76" width="6" height="11"/><rect x="186" y="76" width="6" height="9"/></g></svg>
      <div class="fin__row"><b class="mono">3,936.52</b><span class="mono">-0.40%</span></div></div>
    <div class="tpl__caption">市场温度 · 个股 K 线 · 板块热力图 · 交易日自动更新</div><button class="ghost tpl__action" data-create="每日财经">用这个模板 ↗</button></article>
  <article class="tpl" data-tpl="productivity"><div class="tpl__title"><i></i>个人效率</div>
    <div class="tpl__preview prod"><div class="prod__todo"><b>待办打卡</b><div><i></i>把这张卡拖到喜欢的位置</div><div><i></i>给「喝水」打个卡</div><div><i></i>散步 20 分钟</div><div class="prod__habit" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div><div class="prod__timer"><b>番茄钟</b><strong class="mono">25:00</strong><span>开始 / 重置</span></div></div>
    <div class="tpl__caption">待办打卡 · 番茄钟 · 电脑体检 · 一天的高效工作台</div><button class="ghost tpl__action" data-create="个人效率">用这个模板 ↗</button></article>
  <article class="tpl" data-tpl="creative"><div class="tpl__title"><i></i>来点酷的</div>
    <div class="tpl__preview cre"><div class="vinyl"></div><div class="cre__label"><b>Valze in D Flat Major</b><span>Chopin · 25:00</span></div></div>
    <div class="tpl__caption">黑胶播放器 · 历史上的今天 · 节拍器 · 弄点酷的桌面</div><button class="ghost tpl__action" data-create="来点酷的">用这个模板 ↗</button></article>
</div>
<script>
var map={'每日财经':'briefing','个人效率':'productivity','来点酷的':'creative'};
[].slice.call(document.querySelectorAll('[data-create]')).forEach(function(button){
 button.onclick=function(){
  var name=button.dataset.create;
  var ok=cryoclawDashboard.compose('用「'+name+'」模板新建一块看板，保留模板里的模块和说明。');
  button.textContent=ok?'已填入输入框，检查后发送 ↗':'请在主窗口使用';
  if(ok)setTimeout(function(){button.textContent='用这个模板 ↗';},2400);
 };
});
</script>
</body></html>`;

const prompts = `<!doctype html><html><head>${base}<style>
body{background:radial-gradient(ellipse at 88% 0,#e8f3ff,transparent 55%),#fff;padding:46px 28px 26px;display:flex;flex-direction:column;gap:12px;position:relative;overflow:hidden}
body:before{content:'';position:absolute;right:-30px;top:-10px;width:280px;height:180px;opacity:.5;background-image:radial-gradient(#9ccbe8 1.2px,transparent 1.2px);background-size:14px 14px;pointer-events:none;mask-image:linear-gradient(120deg,transparent,#000)}
.head{display:flex;flex-direction:column;gap:4px;position:relative}.head p{font-size:13px}
.cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:4px;position:relative}
.foot{margin-top:2px;font-size:11px;color:#8a949c;position:relative}
.prompt{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:12px;background:#eaf6ff;border:1px solid #d5e9f7;text-align:left;font-size:11.5px;line-height:1.6;color:#42697d;transition:transform .16s,box-shadow .16s,border-color .16s;min-width:0}
.prompt b{font-size:12.5px;color:#0f1216}
.prompt:hover{transform:translateY(-2px);background:#d9efff;border-color:#a9d3ea;box-shadow:0 12px 26px #0f12160f}
.prompt[aria-pressed=true]{background:#bfe3fb;border-color:#8fc9ec;color:#1e4a63}
.prompt[aria-pressed=true] b{color:#0b3a52}
.prompt span{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.prompt em{font-style:normal;font-size:10px;color:#0b63b0;margin-top:auto}
@media(max-width:900px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){.cards{grid-template-columns:1fr}.prompt span{-webkit-line-clamp:3}}
</style></head><body>
<div class="head"><h2>让 CryoClaw 搭建你的专属看板</h2><p>点击卡片查看咒语，一键创建同款看板。</p></div>
<div class="cards" id="cards"></div>
<p class="foot">点击只会把提示词填进输入框，不会自动发送。</p>
<script>
var items=[
 {title:'盯盘',text:'帮我做一个自选股盯盘 widget 放到画布上：关注茅台、五粮液和苹果，每个交易日收盘后自动抓收盘价和涨跌幅刷新。'},
 {title:'番茄钟',text:'做一个番茄钟组件：25 分钟专注 + 5 分钟休息，能开始 / 暂停 / 重置，今天完成几轮记在组件里。'},
 {title:'待办打卡',text:'来一张待办 + 习惯打卡 widget：待办可增删勾选，习惯显示最近 7 天格子，数据存我本地不去。'},
 {title:'每日简报',text:'建一个每日 AI 新闻简报 widget，配一个每天早上 8 点的定时任务：先给 3 条核心摘要和为什么重要，再列来源链接。'},
 {title:'播放器',text:'做一个本地音乐播放器 widget：扫描我曲库里的歌生成列表，支持播放 / 暂停 / 切歌和进度条。'}
];
var host=document.getElementById('cards');
items.forEach(function(item,index){
 var button=document.createElement('button');button.className='prompt';button.type='button';button.setAttribute('aria-pressed','false');
 var title=document.createElement('b');title.textContent=item.title;
 var text=document.createElement('span');text.textContent=item.text;
 var hint=document.createElement('em');hint.textContent='填入输入框 ↗';
 button.appendChild(title);button.appendChild(text);button.appendChild(hint);
 button.onclick=function(){
  var ok=cryoclawDashboard.compose('新建一个看板，并'+item.text.replace(/^做|^来|^建/,function(prefix){return prefix==='建'?'创建':'做';}));
  if(!ok){hint.textContent='请在主窗口使用';return;}
  [].slice.call(host.children).forEach(function(other){other.setAttribute('aria-pressed','false');other.querySelector('em').textContent='填入输入框 ↗';});
  button.setAttribute('aria-pressed','true');hint.textContent='已填入输入框 ✓';
 };
 host.appendChild(button);
});
</script>
</body></html>`;

const layout = `<!doctype html><html><head>${base}<style>
body{background:linear-gradient(150deg,#f7fbff,#e8f3ff);padding:46px 28px 26px;display:flex;flex-direction:column;gap:12px}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}
.head>div{display:flex;flex-direction:column;gap:4px}.head p{font-size:13px}
.board{flex:1;min-height:220px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));grid-template-areas:"a a b b" "a a c d";gap:10px}
.tile{border-radius:14px;padding:14px;min-width:0;min-height:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden;will-change:transform}
.tile small{font:600 10px/1.2 var(--font-meta,monospace);letter-spacing:.14em;color:#5b8aa6}
.tile b{display:block;font-size:22px;letter-spacing:-.6px;line-height:1.2;margin-top:4px}
.tile span{display:block;font-size:11.5px;color:#42697d;margin-top:4px}
.a{grid-area:a;background:#fff;justify-content:flex-end;box-shadow:0 12px 30px #0f12160a}
.b{grid-area:b;background:#bfe3fb;justify-content:center;align-items:center;text-align:center}
.c{grid-area:c;background:#168aff;color:#fff;justify-content:flex-start}
.c small,.c span{color:#dceeff}
.d{grid-area:d;background:#0d1117;color:#fff;justify-content:space-between}
.board.alt{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-areas:"a b b" "a c d"}
.timer{font-size:34px;letter-spacing:-1.5px;margin:2px 0}
.ticks{display:flex;gap:3px;margin-top:6px}.ticks i{width:5px;height:5px;border-radius:50%;background:#ffffff66}
.list{display:flex;flex-direction:column;gap:5px;margin-top:8px}.list div{display:flex;align-items:center;gap:6px;font-size:11px}.list i{width:6px;height:6px;border-radius:50%;background:#fff}.list div:not(.done) i{background:#ffffff55}
.chart{display:flex;align-items:flex-end;justify-content:space-between;gap:6px;margin-top:6px}
.chart svg{width:100%;height:56px}
.delta{display:flex;align-items:baseline;justify-content:space-between}.delta strong{font-size:22px;letter-spacing:-.8px}.delta span{font-size:10px;color:#9aa7b2}
@media(max-width:720px){.board{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"a b" "c d"}.board.alt{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"b a" "d c"}}
</style></head><body>
<div class="head"><div><h2>随心摆放 组合看板</h2><p>换个布局试试。</p></div><button class="ghost" id="shuffle" type="button">换个布局</button></div>
<div class="board" id="board">
  <div class="tile a"><small>灵感</small><b>留点空白，<br>让想法发生。</b><span>拖动标题栏，把常用的放在手边。</span></div>
  <div class="tile b"><small>专注</small><div class="timer mono">25:00</div><span>番茄钟 · 开始 / 重置</span><div class="ticks"><i></i><i></i><i></i><i></i></div></div>
  <div class="tile c"><small>今日</small><div class="list"><div class="done"><i></i>整理灵感</div><div><i></i>回复邮件</div><div><i></i>收尾归档</div></div></div>
  <div class="tile d"><div class="delta"><strong class="mono">+18.6%</strong><span>本周</span></div><div class="chart"><svg viewBox="0 0 120 50" aria-hidden="true"><path d="M2 44 L18 40 L30 30 L44 34 L58 22 L72 26 L86 14 L100 18 L118 6" fill="none" stroke="#7dd3fc" stroke-width="2"/></svg></div><small>周一 — 周五</small></div>
</div>
<script>
var board=document.getElementById('board'),button=document.getElementById('shuffle');
button.onclick=function(){
 var tiles=[].slice.call(board.children),before=new Map();
 tiles.forEach(function(tile){before.set(tile,tile.getBoundingClientRect());});
 board.classList.toggle('alt');
 tiles.forEach(function(tile){
  var from=before.get(tile),to=tile.getBoundingClientRect(),dx=from.left-to.left,dy=from.top-to.top,sx=from.width/to.width,sy=from.height/to.height;
  if(Math.abs(dx)<1&&Math.abs(dy)<1&&Math.abs(sx-1)<.01&&Math.abs(sy-1)<.01)return;
  cryoclawDashboard.motion.animate(tile,[{transform:'translate('+dx+'px,'+dy+'px) scale('+sx+','+sy+')',transformOrigin:'0 0'},{transform:'none',transformOrigin:'0 0'}],{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'});
 });
};
</script>
</body></html>`;

const basics = `<!doctype html><html><head>${base}<style>
body{padding:46px 26px 22px;display:flex;flex-direction:column;gap:12px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
.item{display:flex;flex-direction:column;gap:3px;padding:10px 11px;border:1px solid #e6edf2;border-radius:11px;background:#fff}
.item b{font-size:12.5px}.item span{font-size:11.5px;line-height:1.5;color:#8a949c}
.note{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:11px;background:#f2f8fd;color:#2b4a5c;font-size:11.5px;line-height:1.6}
.note b{color:#0b63b0}
kbd{font:600 10px/1 var(--font-meta,monospace);padding:2px 4px;border:1px solid #dfe7ee;border-bottom-width:2px;border-radius:4px;background:#fff;color:#42697d}
@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body>
<div class="row" style="justify-content:flex-end"><span class="pill"><i></i>四个动作 · 随时可撤销</span></div>
<div class="grid">
  <div class="item"><b>拖动</b><span>按住卡片顶部横条移动，松手自动保存顺序。</span></div>
  <div class="item"><b>缩放</b><span>拖右下角连续改宽高，不会跳格。</span></div>
  <div class="item"><b>全屏</b><span>右上角 ⤢，同一份文档展开，状态不丢。</span></div>
  <div class="item"><b>返回</b><span><kbd>Esc</kbd> 逐层退出全屏、选择与编辑。</span></div>
</div>
<div class="note"><span><b>滚动：</b>卡片内容比卡片高时先在卡片内滚动，滚到边缘后看板接着滚动。<b>数据：</b>每个数字都要有公开来源和时间，失败时保留上一版并标注已过期。</span></div>
</body></html>`;

export const onboardingCards = [
 {cardId:'onboarding-hero',title:'看板入门',kind:'html',accent:'paper',layout:{w:12,h:560,order:0},html:hero},
 {cardId:'onboarding-templates',title:'搭建你的第一个看板',kind:'html',accent:'paper',layout:{w:12,h:480,order:1},html:templates},
 {cardId:'onboarding-prompts',title:'让 CryoClaw 搭建你的专属看板',kind:'html',accent:'ice',layout:{w:12,h:360,order:2},html:prompts},
 {cardId:'onboarding-layout',title:'随心摆放 组合看板',kind:'html',accent:'ice',layout:{w:12,h:440,order:3},html:layout},
 {cardId:'onboarding-basics',title:'手势与数据',kind:'html',accent:'paper',layout:{w:12,h:230,order:4},html:basics},
];
