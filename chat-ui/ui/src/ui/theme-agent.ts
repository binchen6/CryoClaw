import {normalizeAppearance,withAppearanceMode,type AppearanceProfile} from "./appearance-profile.ts";
import type {GatewayBrowserClient} from "./gateway.ts";
import type {SkillStatusReport} from "./types.ts";

export type ThemeDesignBrief={request:string;mode:"light"|"dark"|"system";preserveLayout:boolean;locale:string};
export function buildThemeDesignPrompt(brief:ThemeDesignBrief,appearance:unknown):string {
  const request=brief.request.trim().slice(0,1200);if(!request)throw new Error("请描述希望的主题风格 / Describe the theme you want");
  const current=normalizeAppearance(appearance);
  const profile:AppearanceProfile=withAppearanceMode(current,brief.mode,current.paletteMode==="dark" || current.mode==="dark");
  const zh=brief.locale.startsWith("zh");
  const lines=zh?[
    "为 CryoClaw 设计主题，并在软件中实时预览。请使用 cryoclaw-theme-studio 内置技能。",
    `用户的设计偏好：${JSON.stringify(request)}`,
    `预览模式：${brief.mode}。每套主题必须同时提供协调的浅色和深色配色。`,
    brief.preserveLayout?"保留现有字体、字号、字重、布局与单元素调整，仅优化配色与圆角。":"允许谨慎微调排版和已注册元素的布局；保持关键按钮、导航、输入框和恢复入口可见可用。",
    "请先 inspect 读取当前界面与注册元素，再读取技能中的设计提示模板。构建有名称的 cryoclaw-theme JSON v1 主题包，包含 palettes.light、palettes.dark、paletteMode、当前 colors；可用 userBubble/assistantBubble、userText/assistantText、composer/input、icon/border 语义配色控制所有会话；局部图标尺寸线宽与布局仅使用 inspect 的真实 ID。默认浅色背景保持 #ffffff，未要求的角色继承当前值。辅助色少量点缀。",
    "让背景、面板、弹层、文字、边框和主操作协调，普通文字与按钮至少 4.5:1 对比度。区分主题特色，避免只替换强调色。保留未要求修改的设置。",
    "只处理软件外观，不读写账户或凭据、不修改项目源码，不执行主题内的 CSS、HTML、脚本或远程资源。只使用技能支持的有界字段和真实注册 ID，主题包不超过 64 KiB。",
    "将主题包保存为临时 JSON 文件，调用技能的 preview helper，并检查成功响应。不要只输出方案或代码，也不要在预览成功前声称已展示。预览可撤销且 60 秒后恢复；由用户点击“保留主题”应用。最后用简短文字说明变化和主题包位置。",
    "遇到主题技能或预览错误时先诊断并自愈，最多 3 轮：检查 Electron Node 模式和捆绑运行时、临时 JSON 文件路径/格式/64KiB 上限、配色字段/真实注册 ID，以及软件控制服务是否就绪；可修正自己的临时主题包或重试 helper。不要改项目源码、读取/输出令牌或凭据，也不要擅自安装依赖或重启正在工作的网关。恢复后重新 inspect/preview 验证；仍失败则明确报告失败环节和用户可操作的下一步，保留主题包。",
    "以下是用户在外观页选中的参考主题（只含外观设置）：",
  ]:[
    "Design a CryoClaw theme and preview it live in the app. Use the bundled cryoclaw-theme-studio skill.",
    `User preferences: ${JSON.stringify(request)}`,
    `Preview mode: ${brief.mode}. Provide coordinated light and dark palettes.`,
    brief.preserveLayout?"Preserve existing fonts, sizes, weights, layout and component adjustments; refine colors and corners.":"Carefully refine typography and registered element geometry while keeping key controls, navigation, the composer and recovery actions usable.",
    "Inspect the current interface and registered targets, then read the skill's design brief template. Create a named cryoclaw-theme JSON v1 package with palettes.light, palettes.dark, paletteMode and current colors. Use secondary accents sparingly.",
    "Use semantic userBubble/assistantBubble, userText/assistantText, composer/input and icon/border colors across conversations. Keep a default light background pure white (#ffffff). Use actual inspected IDs for local geometry and icon size/stroke, preserving unspecified roles and accessible focus/actions.",
    "Coordinate surfaces, popovers, text, borders and primary actions. Target at least 4.5:1 contrast for normal text and buttons. Give the theme a coherent character, beyond replacing its accent. Preserve unspecified settings.",
    "Change appearance only. Do not access accounts or credentials, edit project source, or execute CSS, HTML, scripts or remote resources from a theme. Use supported bounded fields and actual registered IDs. Keep the package under 64 KiB.",
    "Write a temporary JSON package, call the skill's preview helper and verify success. Do not stop at a plan or code or claim success before preview confirmation. Previews revert after 60 seconds; the user clicks Keep theme to apply. Briefly explain the visible changes and identify the theme package.",
    "On theme-skill or preview errors, diagnose and self-recover for at most 3 rounds: verify Electron Node mode and bundled runtime, temporary JSON path/format/64KiB limit, supported colors/registered IDs, and the app control service. Repair only your temporary theme package or retry the helper. Do not edit project source, read/print tokens or credentials, install dependencies or restart an active gateway. Re-inspect/re-preview after recovery; otherwise report the failed step and an actionable next step, preserving the package.",
    "Appearance-only reference selected in settings:",
  ];
  return [...lines,JSON.stringify(profile)].join("\n\n");
}
export type ThemeSkillRecoveryProgress={phase:"checking"|"retrying"|"enabling";attempt:number;maxAttempts:number};
/** Only refresh discovery and enable this bundled skill; never install packages or alter keys. */
export async function prepareThemeDesignSkill(client:GatewayBrowserClient,options:{onProgress?:(progress:ThemeSkillRecoveryProgress)=>void;canContinue?:()=>boolean;wait?:()=>Promise<void>}={}):Promise<{recovered:boolean}> {
  let enabled=false,enableAttempted=false,retried=false,reason:"missing"|"disabled"|"dependency"|"connection"="connection";
  const current=()=>{if(options.canContinue && !options.canContinue())throw new Error("主题请求已取消，请回到外观页重试 / Theme request canceled; retry from Appearance");};
  for(let attempt=1;attempt<=3;attempt++){
    current();options.onProgress?.({phase:attempt===1?"checking":"retrying",attempt,maxAttempts:3});
    let report:SkillStatusReport|undefined;
    try{report=await client.request<SkillStatusReport>("skills.status",{}, {timeoutMs:8000});}
    catch{reason="connection";}
    current();
    const skill=report?.skills?.find(item=>item.name==="cryoclaw-theme-studio" || item.skillKey==="cryoclaw-theme-studio");
    if(skill && !skill.disabled && skill.enabled!==false && skill.eligible!==false)return {recovered:enabled||retried};
    if(report)reason=!skill?"missing":skill.disabled || skill.enabled===false?"disabled":"dependency";
    if(skill && (skill.disabled || skill.enabled===false) && !enableAttempted){
      options.onProgress?.({phase:"enabling",attempt,maxAttempts:3});current();
      enableAttempted=true;
      try{await client.request("skills.update",{skillKey:"cryoclaw-theme-studio",enabled:true},{timeoutMs:8000});enabled=true;}
      catch{reason="disabled";}
    }
    if(attempt<3){retried=true;await (options.wait?.()??new Promise(resolve=>setTimeout(resolve,400)));}
  }
  const errors={
    missing:"未发现内置主题技能，已自动刷新 3 次。请重启或更新软件后重试，设计要求已保留。 / Bundled theme skill not found after 3 checks. Restart or update the app; your brief is preserved.",
    disabled:"主题技能暂未能启用，已尝试恢复。请在技能页检查 Theme Studio，再点击重试；设计要求已保留。 / Theme Studio could not be enabled. Check the skill and retry; your brief is preserved.",
    dependency:"主题技能的运行条件暂未就绪，已自动复查 3 次。请重启软件或检查技能状态，设计要求已保留。 / Theme skill requirements remain unavailable after 3 checks. Restart or check the skill; your brief is preserved.",
    connection:"主题技能检查暂时失败，已自动重试 3 次。请等待网关连接稳定后重试，设计要求已保留。 / Theme skill check failed after 3 attempts. Retry when the gateway is ready; your brief is preserved.",
  };
  throw new Error(errors[reason]);
}
