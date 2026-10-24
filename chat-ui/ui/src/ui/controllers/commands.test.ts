import test from "node:test";
import assert from "node:assert/strict";
import { filterCommands, resolveCommandDescription,loadCommands, resetCommands, getCachedCommands } from "./commands.ts";
import type {GatewayBrowserClient} from "../gateway.ts";
import { setLocale } from "../i18n.ts";
import type { CommandEntry } from "../types.ts";

function cmd(name: string, overrides: Partial<CommandEntry> = {}): CommandEntry {
  return { name, description: `English desc for ${name}`, acceptsArgs: true, ...overrides };
}

test('reconnect invalidates commands without querying the catalog and rejects previous replies',async()=>{
  let finish!:(value:unknown)=>void;
  const client={request:()=>new Promise(resolve=>finish=resolve)} as unknown as GatewayBrowserClient;
  const pending=loadCommands(client);resetCommands(client);finish({commands:[cmd('old')]});
  assert.equal(await pending,null);assert.equal(getCachedCommands(),null);
});

test('command catalog is scoped to its connection and late responses cannot replace the new catalog',async()=>{
  let finish!:(value:unknown)=>void;
  const old={request:()=>new Promise(resolve=>finish=resolve)} as unknown as GatewayBrowserClient;
  const current={request:async(_method:string,params:any)=>{assert.equal(params.scope,'text');return {commands:[cmd('current')]};}} as unknown as GatewayBrowserClient;
  const pending=loadCommands(old,{force:true});assert.equal((await loadCommands(current))?.[0].name,'current');
  finish({commands:[cmd('old')]});assert.equal(await pending,null);assert.equal((await loadCommands(current))?.[0].name,'current');
});

test('command search matches slash aliases and descriptive intent',()=>{
  setLocale('en');try{const commands=[cmd('custom',{textAliases:['/find'],description:'Search project files'})];assert.equal(filterCommands(commands,'/find').length,1);assert.equal(filterCommands(commands,'project').length,1);}finally{setLocale('zh');}
});

test("filterCommands：空查询返回前 limit 条", () => {
  const commands = [cmd("goal"), cmd("think"), cmd("fast")];
  assert.deepEqual(
    filterCommands(commands, "", 2).map((c) => c.name),
    ["goal", "think"],
  );
});

test("filterCommands：前缀匹配优先于包含匹配", () => {
  const commands = [cmd("new"), cmd("goal"), cmd("go"), cmd("think"), cmd("newnote")];
  const result = filterCommands(commands, "go");
  assert.deepEqual(
    result.map((c) => c.name),
    ["goal", "go"],
  );
});

test("filterCommands：textAliases 参与匹配，大小写不敏感，limit 截断", () => {
  const commands = [cmd("Goal", { textAliases: ["target"] }), cmd("think"), cmd("go")];
  assert.deepEqual(
    filterCommands(commands, "TARGET").map((c) => c.name),
    ["Goal"],
  );
  const many = Array.from({ length: 20 }, (_, i) => cmd(`cmd${i}`));
  assert.equal(filterCommands(many, "cmd", 8).length, 8);
});

test("resolveCommandDescription：中文界面下收录的命令返回中文描述", () => {
  setLocale("zh");
  assert.equal(resolveCommandDescription(cmd("goal")), "设置/管理会话目标（开始、暂停、恢复、清除）");
  assert.equal(resolveCommandDescription(cmd("think")), "调整思考强度（think hard / think harder 等）");
  assert.equal(resolveCommandDescription(cmd("plan")), "进入计划模式（先规划后执行）");
});

test("resolveCommandDescription：中文界面下未收录命令回退内核英文描述", () => {
  setLocale("zh");
  const c = cmd("customcmd");
  assert.equal(resolveCommandDescription(c), "English desc for customcmd");
});

test("resolveCommandDescription：英文界面下优先内核英文描述", () => {
  setLocale("en");
  try {
    // 收录命令也应显示英文
    assert.equal(resolveCommandDescription(cmd("goal")), "English desc for goal");
    // 内核无英文描述时回退词典英文值（不再是中文映射）
    const noDesc = { name: "goal", acceptsArgs: true } as unknown as CommandEntry;
    assert.equal(resolveCommandDescription(noDesc), "Set or manage the session goal (start, pause, resume, clear)");
    // 未收录命令且内核无描述 → 空串
    const unknown = { name: "customcmd", acceptsArgs: true } as unknown as CommandEntry;
    assert.equal(resolveCommandDescription(unknown), "");
  } finally {
    setLocale("zh");
  }
});
