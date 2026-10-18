export type ModelRole = "utilityModel" | "decisionModel";
export type ModelRoleSelection = string | undefined;

/** Undefined inherits, an empty string explicitly disables the native role. */
export function configureModelRoles(config:Record<string,any>,roles:Record<ModelRole,ModelRoleSelection>):void {
  for(const value of Object.values(roles)) {
    if(value!==undefined && value!=="" && (value.length>512 || !/^[^\s/]+\/\S+$/.test(value)))throw new Error("请选择有效的 provider/model 模型。");
  }
  const defaults=(config.agents??={}).defaults??={};
  for(const role of ["utilityModel","decisionModel"] as const) {
    if(roles[role]===undefined)delete defaults[role];else defaults[role]=roles[role];
  }
}
