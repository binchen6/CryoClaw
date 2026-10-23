const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
test("bundled skill entries stay compact and every progressive reference exists",()=>{
  const root=path.join(__dirname,"../builtin-skills");let bytes=0,descriptions=0;
  for(const name of fs.readdirSync(root)){
    const file=path.join(root,name,"SKILL.md");if(!fs.existsSync(file))continue;
    const text=fs.readFileSync(file,"utf8"),description=text.match(/^description:\s*(.*)$/m)?.[1];
    assert.ok(description,`description: ${name}`);bytes+=Buffer.byteLength(text);descriptions+=description.length;
    for(const match of text.matchAll(/\]\((?!https?:|#)([^)]+)\)/g))assert.ok(fs.existsSync(path.resolve(path.dirname(file),match[1])),`${name}: ${match[1]}`);
    if(name.startsWith("officecli-")){assert.match(text,/--input batch.json/);assert.match(text,/validate/);assert.ok(fs.existsSync(path.join(root,name,"reference/operations.md")));}
  }
  assert.ok(bytes<=12000,`entrypoint bytes: ${bytes}`);assert.ok(descriptions<=900,`catalogue description chars: ${descriptions}`);
});
