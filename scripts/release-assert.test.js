"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {requestHeaders,assetDownloadUrl,validateManifest}=require('./release-assert');
test('release assertions restrict authorization to the HTTPS GitHub API',()=>{
  assert.equal(requestHeaders('https://api.github.com/repos/owner/repo/releases','application/json','private-test-token').Authorization,'Bearer private-test-token');
  for(const url of ['https://release-assets.githubusercontent.com/a','https://github.com/owner/repo/releases/download/a','https://api.github.com.example.test/a','http://api.github.com/a'])assert.equal(requestHeaders(url,'application/octet-stream','private-test-token').Authorization,undefined);
});

function fixture(){
  const version='2026.1018.3',name=`CryoClaw-Setup-${version}-x64.exe`,sha512=Buffer.alloc(64,1).toString('base64');
  return {version,name,yml:{version,files:[{url:name,size:123,sha512}],path:name,sha512},assets:[{name,size:123},{name:`${name}.blockmap`,size:10}]};
}
test('manifest verifies sizes, checksums and all referenced architectures',()=>{
  const f=fixture();assert.equal(validateManifest(f.yml,f.version,f.assets).url,f.name);
  for(const mutate of [
    x=>x.yml.files[0].size++,
    x=>x.yml.files[0].sha512='invalid',
    x=>x.yml.sha512=Buffer.alloc(64,2).toString('base64'),
    x=>x.assets.pop(),
    x=>x.yml.files.push({...x.yml.files[0],url:'missing-arm64.exe'}),
    x=>x.yml.files.push({...x.yml.files[0]}),
  ]){const x=fixture();mutate(x);assert.throws(()=>validateManifest(x.yml,x.version,x.assets));}
});
test('manifest permits arm64 first and validates its own top-level checksum',()=>{
  const f=fixture(),arm={url:f.name.replace('x64','arm64'),size:456,sha512:Buffer.alloc(64,2).toString('base64')};
  f.yml.files.unshift(arm);f.yml.path=arm.url;f.yml.sha512=arm.sha512;
  f.assets.push({name:arm.url,size:456},{name:`${arm.url}.blockmap`,size:10});
  assert.equal(validateManifest(f.yml,f.version,f.assets).url,f.name);
});
test('draft assets use the authenticated API while public assets use download URLs',()=>{
  const asset={url:'https://api.github.com/repos/o/r/releases/assets/1',browser_download_url:'https://github.com/o/r/releases/download/v1/latest.yml'};
  assert.equal(assetDownloadUrl({draft:true},asset),asset.url);
  assert.equal(assetDownloadUrl({draft:false},asset),asset.browser_download_url);
});
