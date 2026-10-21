import {normalizeAppearance,withAppearanceMode,type AppearanceProfile} from "./appearance-profile.ts";
import type {GatewayBrowserClient} from "./gateway.ts";
import type {SkillStatusReport} from "./types.ts";

/** Fill-in fields shown under Appearance → Let your agent design a theme. */
export type ThemeDesignFields={
  style:string;
  primary:string;
  secondary:string;
  appearance:string;
  corners:string;
  typography:string;
  keep:string;
  avoid:string;
  extra:string;
};
export type ThemeDesignBrief=ThemeDesignFields&{mode:"light"|"dark"|"system";preserveLayout:boolean;locale:string;referenceImages?:number};
export const EMPTY_THEME_FIELDS:ThemeDesignFields={style:"",primary:"",secondary:"",appearance:"",corners:"",typography:"",keep:"",avoid:"",extra:""};
export const THEME_FIELD_LIMITS:Record<keyof ThemeDesignFields,number>={style:300,primary:120,secondary:120,appearance:120,corners:120,typography:200,keep:200,avoid:200,extra:400};
const FIELD_KEYS=Object.keys(THEME_FIELD_LIMITS) as Array<keyof ThemeDesignFields>;
export function cleanThemeField(value:string,key:keyof ThemeDesignFields):string {
  return Array.from(String(value??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim()).slice(0,THEME_FIELD_LIMITS[key]).join("");
}
export function cleanThemeFields(fields:Partial<ThemeDesignFields>):ThemeDesignFields {
  const result={...EMPTY_THEME_FIELDS};
  for(const key of FIELD_KEYS)result[key]=cleanThemeField(fields[key]??"",key);
  return result;
}
/** Returns a bilingual validation message when the fill-in brief cannot be sent. */
export function themeFieldsError(fields:Partial<ThemeDesignFields>,locale:string):string|null {
  const zh=String(locale??"").startsWith("zh"),value=cleanThemeFields(fields);
  if(Array.from(value.style).length<2)return zh?"请先填写风格意象（至少 2 个字）。":"Describe the visual direction first (at least 2 characters).";
  for(const key of ["primary","secondary"] as const){
    if(/^#/.test(value[key]) && !/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(value[key]))return zh?`${key==="primary"?"主色":"辅色"}以 # 开头时须为 3 位或 6 位十六进制，例如 #1a6fd0。`:`A color starting with # must use 3 or 6 hex digits, for example #1a6fd0.`;
  }
  return null;
}
export function buildThemeDesignPrompt(brief:ThemeDesignBrief,appearance:unknown):string {
  const locale=String(brief.locale??""),zh=locale.startsWith("zh"),fields=cleanThemeFields(brief);
  const invalid=themeFieldsError(fields,locale);if(invalid)throw new Error(invalid);
  const current=normalizeAppearance(appearance);
  const profile:AppearanceProfile=withAppearanceMode(current,brief.mode,current.paletteMode==="dark" || current.mode==="dark");
  const referenceImages=Math.max(0,Math.min(8,Math.floor(Number(brief.referenceImages)||0)));
  const show=(value:string)=>value||(zh?"（未填写，保持现状）":"(not provided; keep the current setting)");
  const briefLines=zh?[
    `- 风格意象：${show(fields.style)}`,
    `- 主色：${show(fields.primary)}`,
    `- 辅色：${show(fields.secondary)}`,
    `- 明暗偏好：${show(fields.appearance)}`,
    `- 圆角倾向：${show(fields.corners)}`,
    `- 排版偏好：${show(fields.typography)}`,
    `- 必须保留：${show(fields.keep)}`,
    `- 希望避免：${show(fields.avoid)}`,
    `- 补充要求：${show(fields.extra)}`,
  ]:[
    `- Visual direction: ${show(fields.style)}`,
    `- Primary color: ${show(fields.primary)}`,
    `- Secondary color: ${show(fields.secondary)}`,
    `- Light/dark preference: ${show(fields.appearance)}`,
    `- Corner tendency: ${show(fields.corners)}`,
    `- Typography preference: ${show(fields.typography)}`,
    `- Must keep: ${show(fields.keep)}`,
    `- Avoid: ${show(fields.avoid)}`,
    `- Extra requirements: ${show(fields.extra)}`,
  ];
  const referenceLine=referenceImages
    ? (zh?`参考图：用户随本条消息附上 ${referenceImages} 张参考图（见消息附件）。参考图仅用于提取配色、明暗层次与质感；不要复制其中的文字、logo、品牌标识、人物或具体布局，也不要把参考图转存为外部资源或写进主题包。`:`Reference images: the user attached ${referenceImages} image(s) to this message. Use them only for palette, light/dark depth and texture. Do not copy their text, logos, brand marks, people or specific layout, and never embed or re-host the images in the theme package.`)
    : (zh?"参考图：本条消息未附参考图，请仅依据文字 brief 设计。":"Reference images: none attached; design from the written brief only.");
  const lines=zh?[
    "为 CryoClaw 设计主题，并在软件中实时预览。请使用 cryoclaw-theme-studio 内置技能。",
    `用户已填写结构化设计 brief（未填写的项表示保持当前外观）：\n${briefLines.join("\n")}`,
    referenceLine,
    `预览模式：${brief.mode}。每套主题必须同时提供协调的浅色与深色 palettes，并让 paletteMode 与当前 colors 指向同一版。`,
    brief.preserveLayout?"保留现有字体、字号、字重、布局与单元素调整，仅优化配色、圆角、间距密度、阴影与边框粗细。":"允许谨慎微调排版和已注册元素的布局；保持关键按钮、导航、输入框和恢复入口可见可用。",
    "请先 inspect 读取当前界面、当前主题与可用元素标识，再读取技能中的设计参考模板 references/design-prompt.md。",
    "构建有名称且带 description（≤120 字符，一句话概括主题气质）的 cryoclaw-theme JSON v1 主题包：必须包含 palettes.light、palettes.dark、paletteMode 与当前 colors。可选有界字段：density 0.9–1.1（间距呼吸感，1 为现状）、shadow none|soft|default|strong（阴影强度，default 为现状）、borderWidth 0–2（细线边框粗细，1 为现状）。仅在 brief 明确指向时使用这些字段，缺省即保持现状，禁止自定义 CSS。",
    "用 userBubble/assistantBubble、userText/assistantText、composer/input、icon/border 语义配色覆盖所有会话；局部图标尺寸线宽与布局仅使用 inspect 的真实 ID。默认浅色背景保持 #ffffff，未要求的角色继承当前值；辅助色少量点缀。",
    "让背景、面板、弹层、文字、边框和主操作协调，普通文字与按钮至少 4.5:1 对比度，浅色与深色两版都要核对。区分主题特色，避免只替换强调色。保留未要求修改的设置。",
    "只处理软件外观，不读写账户或凭据、不修改项目源码，不执行主题内的 CSS、HTML、脚本或远程资源。只使用技能支持的有界字段和真实注册 ID，主题包不超过 64 KiB。",
    "将主题包保存为临时 JSON 文件，调用技能的 preview helper，并检查成功响应。不要只输出方案或代码，也不要在预览成功前声称已展示。预览可撤销且 60 秒后恢复；由用户点击“保留主题”应用。最后用简短文字说明变化和主题包位置。",
    "失败时按技能的恢复流程最多重试 3 轮，仅修复临时主题包或 helper 调用；保留主题包并报告具体失败步骤。成功后用不超过三句话说明主题名、主要变化及保留/撤销入口。",
    "以下是用户在外观页当前的主题设置（只含外观设置）：",
  ]:[
    "Design a CryoClaw theme and preview it live in the app. Use the bundled cryoclaw-theme-studio skill.",
    `The user filled in this structured brief (blank items mean keep the current appearance):\n${briefLines.join("\n")}`,
    referenceLine,
    `Preview mode: ${brief.mode}. Provide coordinated light and dark palettes and keep paletteMode aligned with the current colors.`,
    brief.preserveLayout?"Preserve existing fonts, sizes, weights, layout and component adjustments; refine colors, corners, spacing density, shadows and border thickness only.":"Carefully refine typography and registered element geometry while keeping key controls, navigation, the composer and recovery actions usable.",
    "Inspect the current interface, theme and registered targets first, then read the skill's design brief template at references/design-prompt.md.",
    "Create a named cryoclaw-theme JSON v1 package with a description (≤120 characters, one line on the theme's character), palettes.light, palettes.dark, paletteMode and current colors. Optional bounded fields: density 0.9–1.1 (spacing breathability, 1 is current), shadow none|soft|default|strong (shadow strength, default is current) and borderWidth 0–2 (hairline thickness, 1 is current). Use them only when the brief calls for them; omitted means keep the current look, and custom CSS is never allowed.",
    "Use semantic userBubble/assistantBubble, userText/assistantText, composer/input and icon/border colors across conversations. Keep a default light background pure white (#ffffff). Use actual inspected IDs for local geometry and icon size/stroke, preserving unspecified roles and accessible focus/actions. Use secondary accents sparingly.",
    "Coordinate surfaces, popovers, text, borders and primary actions. Target at least 4.5:1 contrast for normal text and buttons in both variants. Give the theme a coherent character, beyond replacing its accent. Preserve unspecified settings.",
    "Change appearance only. Do not access accounts or credentials, edit project source, or execute CSS, HTML, scripts or remote resources from a theme. Use supported bounded fields and actual registered IDs. Keep the package under 64 KiB.",
    "Write a temporary JSON package, call the skill's preview helper and verify success. Do not stop at a plan or code or claim success before preview confirmation. Previews revert after 60 seconds; the user clicks Keep theme to apply. Briefly explain the visible changes and identify the theme package.",
    "On failure follow the skill recovery procedure for at most 3 rounds, repairing only the temporary package or helper invocation. Preserve the package and report the failed step if unresolved. On success use at most three sentences: theme name, main changes, and Keep/Revert actions.",
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
