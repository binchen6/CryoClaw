import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const entries = ["index", "compile/index", "error/index", "format/index", "guard/index", "schema/index", "system/index", "type/index", "value/index"];
async function inspect(root) {
  const modules = await Promise.all(entries.map(entry => import(pathToFileURL(path.resolve(root, "build", `${entry}.mjs`)).href)));
  const exports = modules.map(module => Object.keys(module).map(name => [name, typeof module[name]]));
  // Keep all alias relationships between public exports, including classes,
  // default namespaces and functions shared by root and /type.
  const bindings = modules.flatMap((module, i) => Object.keys(module).map(name => ({ key: `${i}:${name}`, value: module[name] })));
  const shared = [];
  for (let i = 0; i < bindings.length; i++) for (let j = i + 1; j < bindings.length; j++) {
    if (bindings[i].value === bindings[j].value) shared.push([bindings[i].key, bindings[j].key]);
  }
  const [Type, compile, , format, , , , , value] = modules;
  const schema = Type.Object({ name: Type.String(), count: Type.Integer({ minimum: 0 }), kind: Type.Union([Type.Literal("a"), Type.Literal("b")]), tags: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
  const data = [{ name: "hello", count: 3, kind: "a" }, { name: 1, count: 0, kind: "a" }, { name: "bad", count: -1, kind: "c" }, { name: "extra", count: 2, kind: "b", other: true }];
  const validator = compile.Compile(schema);
  const checks = data.map(item => [value.Check(schema, item), validator.Check(item), [...value.Errors(schema, item)]]);
  assert.deepEqual(checks.map(row => row.slice(0, 2)), [[true, true], [false, false], [false, false], [false, false]]);
  format.Set("cryoclaw-runtime-smoke", input => input === "valid");
  const formatted = Type.String({ format: "cryoclaw-runtime-smoke" });
  const formatValidator = compile.Compile(formatted);
  const registry = [value.Check(formatted, "valid"), value.Check(formatted, "invalid"), formatValidator.Check("valid"), formatValidator.Check("invalid")];
  assert.deepEqual(registry, [true, false, true, false], "format registration must reach both compiled and interpreted validators");
  format.Reset();
  return { exports, shared, schema, checks, registry, created: value.Create(schema) };
}

const original = await inspect(process.argv[2]);
const compact = await inspect(process.argv[3]);
assert.deepEqual(compact, original);
console.log(JSON.stringify({ ok: true, entryPoints: entries.length, exports: original.exports.reduce((sum, items) => sum + items.length, 0), sharedBindings: original.shared.length }));
