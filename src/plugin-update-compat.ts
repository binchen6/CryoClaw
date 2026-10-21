const semver: {valid:(version:string)=>string|null;validRange:(range:string)=>string|null;satisfies:(version:string,range:string)=>boolean;prerelease:(version:string)=>unknown[]|null;rsort:(versions:string[])=>string[]} = require("semver");

export function isPluginHostCompatible(raw:unknown,hostVersion:string):boolean {
  const pkg=raw as any;
  if(!pkg || !semver.valid(hostVersion))return false;
  const ranges=[pkg.peerDependencies?.openclaw,pkg.openclaw?.compat?.pluginApi,pkg.openclaw?.install?.minHostVersion];
  return ranges.every(range=>range===undefined || typeof range==="string" && !!semver.validRange(range) && semver.satisfies(hostVersion,range));
}
export function selectCompatiblePluginVersion(raw:unknown,hostVersion:string):string|null {
  const versions=(raw as any)?.versions;
  if(!versions || typeof versions!=="object")return null;
  const candidates=Object.keys(versions).filter(version=>semver.valid(version) && !semver.prerelease(version) && isPluginHostCompatible(versions[version],hostVersion));
  return semver.rsort(candidates)[0]??null;
}
