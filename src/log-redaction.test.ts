import test from "node:test";
import assert from "node:assert/strict";
import {redactLogSecrets} from "./log-redaction.ts";

test("URL capabilities are removed while diagnostic paths and revisions survive",()=>{
  const input="http://127.0.0.1:18789/__cryoclaw__/dashboards/b/c?v=4&ticket=synthetic.value (line:3) https://service.invalid/?API_KEY=example-key&source=kept#access_token=example-token";
  assert.equal(redactLogSecrets(input),"http://127.0.0.1:18789/__cryoclaw__/dashboards/b/c?v=4&ticket=*** (line:3) https://service.invalid/?API_KEY=***&source=kept#access_token=***");
  assert.equal(redactLogSecrets("?%74icket=example&token=other"),"?%74icket=***&token=***");
});
test("userinfo, bearer and local proxy secrets do not escape in free text",()=>{
  assert.equal(redactLogSecrets("https://name:synthetic@service.invalid/ Authorization: Bearer example-token http://127.0.0.1:1234/abcdefgh123456/coding"),"https://***@service.invalid/ Authorization: Bearer *** http://127.0.0.1:1234/***/coding");
  assert.equal(redactLogSecrets("?version=2&keyboard=normal&%invalid=kept"),"?version=2&keyboard=normal&%invalid=kept");
});
