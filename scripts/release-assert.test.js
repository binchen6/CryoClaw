"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {requestHeaders,assetDownloadUrl}=require('./release-assert');
test('release assertions restrict authorization to the HTTPS GitHub API',()=>{
  assert.equal(requestHeaders('https://api.github.com/repos/owner/repo/releases','application/json','private-test-token').Authorization,'Bearer private-test-token');
  for(const url of ['https://release-assets.githubusercontent.com/a','https://github.com/owner/repo/releases/download/a','https://api.github.com.example.test/a','http://api.github.com/a'])assert.equal(requestHeaders(url,'application/octet-stream','private-test-token').Authorization,undefined);
});
test('draft assets use the authenticated API while public assets use download URLs',()=>{
  const asset={url:'https://api.github.com/repos/o/r/releases/assets/1',browser_download_url:'https://github.com/o/r/releases/download/v1/latest.yml'};
  assert.equal(assetDownloadUrl({draft:true},asset),asset.url);
  assert.equal(assetDownloadUrl({draft:false},asset),asset.browser_download_url);
});
