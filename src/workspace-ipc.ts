// 工作空间文件系统操作 — 目录浏览、文件读取、系统打开
// 所有路径操作均验证在允许的根目录内（workspace 根 + 内核 worktrees 目录），防止路径穿越
import { ipcMain, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as log from "./logger";
import { resolveUserStateDir } from "./constants";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { isSafeOpenExt } from "./safe-open";
import {readUserConfig} from "./provider-config";
import {readCryoclawConfig,writeCryoclawConfig} from "./cryoclaw-config";
import {readWorkspaceText,saveWorkspaceText,findWorkspaceFiles,readWorkspaceDraft,writeWorkspaceDraft} from "./workspace-files";
import * as os from "node:os";

// workspace 根路径由渲染进程首次调用 workspace:set-root 设定
let workspaceRoot: string | null = null;

// 安全面：agent 可写目录（workspace）里的可执行文件风险更高，仅允许"安全打开"扩展名。
// 白名单与 main.ts app:open-path 共用（见 safe-open.ts）；渲染层 chat 路径链接走
// app:open-path，不受此白名单影响。

// 平台大小写敏感性：Windows/macOS 文件系统大小写不敏感，同一真实目录可能以两种大小写
// 形态出现（OPENCLAW_STATE_DIR 环境变量写法与实际目录不符、realpath 返回磁盘真实大小写
// 而白名单 root 来自另一来源），大小写敏感比较会把合法路径误判为越界（用户看到
// "Access denied"）。口径与 openclaw-state-archive-paths.ts 的 normalizeForContainment 一致。
const CASE_INSENSITIVE_PLATFORM = process.platform === "win32" || process.platform === "darwin";

// 路径穿越校验：确保 target 在 root 内。caseInsensitive 默认跟随平台（可注入供单测）。
// 折叠不放宽拒绝方向：大小写不敏感平台上仅大小写不同的两个路径指向同一实体，
// "仅大小写不同"的兄弟目录在该平台上不可能存在，故归一化后仍拒绝真正的越界路径。
function isInsideRoot(target: string, root: string, caseInsensitive = CASE_INSENSITIVE_PLATFORM): boolean {
  const resolved = normalizeForContainment(target, caseInsensitive);
  const resolvedRoot = normalizeForContainment(root, caseInsensitive);
  const prefix=resolvedRoot.endsWith(path.sep)?resolvedRoot:resolvedRoot+path.sep;
  return resolved===resolvedRoot || resolved.startsWith(prefix);
}

function normalizeForContainment(input: string, caseInsensitive: boolean): string {
  const resolved = path.resolve(input);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

// 多根版 containment 校验（导出供单测）：target 落在任一 root 内即通过
export function isInsideAnyRoot(
  target: string,
  roots: readonly string[],
  caseInsensitive = CASE_INSENSITIVE_PLATFORM,
): boolean {
  return roots.some((root) => isInsideRoot(target, root, caseInsensitive));
}

// 允许访问的根集合：workspace 根（渲染层 set-root 设定，可能未设置）+
// 内核 worktrees 目录 ~/.openclaw/worktrees/（worktree 管理视图「打开目录」走这里）
function allowedRoots(): string[] {
  const roots: string[] = [];
  if (workspaceRoot) {
    roots.push(workspaceRoot);
  }
  roots.push(path.join(resolveUserStateDir(), "worktrees"));
  roots.push(path.join(resolveUserStateDir(),"workspace"));
  const config=readUserConfig();
  const configured=[config?.agents?.defaults?.workspace,...(Array.isArray(config?.agents?.list)?config.agents.list.map((agent:any)=>agent.workspace):[])];
  const approved=readCryoclawConfig()?.approvedWorkspaceRoots;
  for(const value of [...configured,...(Array.isArray(approved)?approved.slice(0,40):[])])if(typeof value==="string" && value){const expanded=value.replace(/^~(?=[\\/]|$)/,os.homedir()).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(match,key)=>process.env[key]??match);if(path.isAbsolute(expanded))roots.push(path.resolve(expanded));}
  return [...new Set(roots.flatMap(root=>{try{return [root,fs.realpathSync(root)];}catch{return [root];}}))];
}
export function authorizeWorkspaceRoot(root:string):void {
  const canonical=fs.realpathSync(root);if(!fs.statSync(canonical).isDirectory())return;
  const config=readCryoclawConfig()??{};config.approvedWorkspaceRoots=[...new Set([...(Array.isArray(config.approvedWorkspaceRoots)?config.approvedWorkspaceRoots:[]),canonical])].slice(-40);writeCryoclawConfig(config);
}
export function resetWorkspaceAccessForImport():void {workspaceRoot=null;const config=readCryoclawConfig();if(config?.approvedWorkspaceRoots){delete config.approvedWorkspaceRoots;writeCryoclawConfig(config);}}

// 公共守卫：检查路径合法性（workspace 根或 worktrees 根之内）
function guardPath(filePath: string): { ok: true } | { ok: false; error: { success: false; message: string } } {
  if (typeof filePath!=="string" || !filePath || !isInsideAnyRoot(filePath, allowedRoots())) {
    log.error(`workspace: path traversal blocked: ${filePath}`);
    return { ok: false, error: { success: false, message: "Access denied" } };
  }
  return { ok: true };
}

// symlink 逃逸守卫：workspace 是 agent 可写目录，攻击面在于 agent 可在其中创建
// 指向任意位置的符号链接（如 credentials/kimi-api-key），而 path.resolve 不解引用
// symlink、fs.stat/readFile/shell.openPath 都会跟随。解析真实路径后复核 containment；
// realpath 失败（文件不存在等）交由后续操作自然报错。返回 null 表示拒绝。
async function resolveRealInsideRoot(
  filePath: string,
): Promise<string | null | undefined> {
  try {
    const real = await fs.promises.realpath(filePath);
    return isInsideAnyRoot(real, allowedRoots()) ? real : null;
  } catch {
    // 解析失败（不存在/权限）：返回 undefined，让后续 stat/open 用原路径报具体错误
    return undefined;
  }
}

// guardPath + symlink 复核的组合守卫：通过时返回实际要操作的 target 路径
// （realpath 优先，解析失败回退原路径由后续操作报具体错误）。
async function guardRealPath(
  filePath: string,
): Promise<{ ok: true; target: string } | { ok: false; error: { success: false; message: string } }> {
  const check = guardPath(filePath);
  if (!check.ok) return check;
  const realPath = await resolveRealInsideRoot(filePath);
  if (realPath === null) {
    log.error(`workspace: symlink escape blocked: ${filePath}`);
    return { ok: false, error: { success: false, message: "Access denied" } };
  }
  return { ok: true, target: realPath ?? filePath };
}

// 目录版守卫（git IPC 的 cwd 入参用）：目录必须在白名单根内（path 校验 + realpath
// 复核防 symlink）。通过时返回 realpath（realpath 失败回退原路径，后续 git 自然报错）；
// 不通过返回 null。与 guardRealPath 同规则，只是错误交由调用方组织。
export async function resolveAllowedDir(dirPath: string): Promise<string | null> {
  if (typeof dirPath !== "string" || !dirPath) return null;
  if (!isInsideAnyRoot(dirPath, allowedRoots())) return null;
  try {
    const real = await fs.promises.realpath(dirPath);
    return isInsideAnyRoot(real, allowedRoots()) ? real : null;
  } catch {
    // 目录不存在/权限问题：回退原路径，让 git 自己报具体错误
    return dirPath;
  }
}

export function registerWorkspaceIpc(): void {
  // 设置 workspace 根路径（渲染进程从 gateway 获取后传入）
  // Only configured workspaces, worktrees and folders granted by the native picker.
  ipcMain.handle("workspace:set-root", (event, root: string) => {
    if (!assertTrustedIpcSender(event, "workspace:set-root")) throw new Error("IPC sender not trusted");
    if(typeof root!=="string" || !root || !path.isAbsolute(root))return {success:false,message:"Invalid workspace path"};
    const resolved = path.resolve(root);
    if (!isInsideAnyRoot(resolved,allowedRoots())) {
      return { success: false, message: "请通过文件夹选择器授权此工作区 / Select this folder to grant workspace access" };
    }
    workspaceRoot = resolved;
    log.info(`workspace root set: ${resolved}`);
    return { success: true };
  });  // 在 Finder/Explorer 中显示文件所在目录
  ipcMain.handle("workspace:open-folder", async (event, filePath: string) => {
    if (!assertTrustedIpcSender(event, "workspace:open-folder")) throw new Error("IPC sender not trusted");
    const check = await guardRealPath(filePath);
    if (!check.ok) return check.error;
    const target = check.target;
    try {
      shell.showItemInFolder(target);
      return { success: true };
    } catch (err: any) {
      log.error(`workspace:open-folder failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // 列出目录内容（支持子目录浏览）
  ipcMain.handle("workspace:list-dir", async (event, dirPath: string,options?:{showHidden?:boolean}) => {
    if (!assertTrustedIpcSender(event, "workspace:list-dir")) throw new Error("IPC sender not trusted");
    const check = await guardRealPath(dirPath);
    if (!check.ok) return check.error;
    const target = check.target;
    try {
      const entries:fs.Dirent[]=[];let truncated=false,visited=0;const started=Date.now();
      for await(const entry of await fs.promises.opendir(target)){
        if(++visited>20000 || entries.length>=5000 || visited%64===0 && Date.now()-started>1500){truncated=true;break;}
        if(options?.showHidden || !entry.name.startsWith(".") && !["node_modules","dist","build","vendor"].includes(entry.name))entries.push(entry);
      }
      const items = entries
        // 隐藏点目录与依赖目录：预览面板面向用户产物，node_modules 展开即数千项噪音
        .map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: path.join(target, e.name),
        }))
        .sort((a, b) => {
          // 文件夹在前，文件在后；同类型按名称排序
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { success: true, data: { items, root: target,truncated } };
    } catch (err: any) {
      log.error(`workspace:list-dir failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // 读取文件内容（纯文本，限制 1MB）
  ipcMain.handle("workspace:read-file", async (event, filePath: string) => {
    if (!assertTrustedIpcSender(event, "workspace:read-file")) throw new Error("IPC sender not trusted");
    const check = await guardRealPath(filePath);
    if (!check.ok) return check.error;
    const target = check.target;
    try {
      const data=await readWorkspaceText(target);
      const draft=await readWorkspaceDraft(target,resolveUserStateDir());
      return { success: true, data: {...data,name:path.basename(target),path:filePath,...(draft?{draft:draft.draft,draftBaseHash:draft.baseHash}:{})} };
    } catch (err: any) {
      log.error(`workspace:read-file failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });
  ipcMain.handle("workspace:write-file",async(event,params)=>{
    if(!assertTrustedIpcSender(event,"workspace:write-file"))throw new Error("IPC sender not trusted");
    try {const check=await guardRealPath(params?.path);if(!check.ok)return check.error;
      const result=await saveWorkspaceText(check.target,params?.content,params?.baseHash,async()=>{const current=await guardRealPath(params.path);return current.ok && current.target===check.target;});
      if(result.success)await writeWorkspaceDraft(check.target,resolveUserStateDir(),null,"").catch(()=>{});return result;
    } catch(error){return {success:false,message:error instanceof Error?error.message:String(error)};}
  });
  ipcMain.handle("workspace:save-draft",async(event,params)=>{
    if(!assertTrustedIpcSender(event,"workspace:save-draft"))throw new Error("IPC sender not trusted");
    try{const check=await guardRealPath(params?.path);if(!check.ok)return check.error;await writeWorkspaceDraft(check.target,resolveUserStateDir(),params?.draft,params?.baseHash);return {success:true};}
    catch(error){return {success:false,message:error instanceof Error?error.message:String(error)};}
  });
  const searches=new WeakMap<Electron.WebContents,number>();
  ipcMain.handle("workspace:find-files",async(event,params)=>{
    if(!assertTrustedIpcSender(event,"workspace:find-files"))throw new Error("IPC sender not trusted");
    try {const check=await guardRealPath(params?.root);if(!check.ok)return check.error;
      if(typeof params?.query!=="string" || params.query.length>200)return {success:false,message:"无效的搜索条件"};
      const generation=(searches.get(event.sender)??0)+1;searches.set(event.sender,generation);
      const data=await findWorkspaceFiles(check.target,params.query,params.showHidden===true,()=>searches.get(event.sender)!==generation);
      return {success:true,data};
    }catch(error){return {success:false,message:error instanceof Error?error.message:String(error)};}
  });
}

