import assert from "node:assert/strict";
import test from "node:test";
import {
  hasVisibleSession,
  resolveVisibleSessionFallback,
  resolveVisibleSessionSelection,
} from "./session-visibility.ts";

function testFallbackPrefersFirstVisibleSessionWhenMainIsHidden() {
  const hello = {
    snapshot: {
      sessionDefaults: {
        mainSessionKey: "main",
      },
    },
  } as any;
  const sessions = {
    sessions: [{ key: "foo" }, { key: "bar" }],
  } as any;

  assert.equal(hasVisibleSession(sessions, "main"), false);
  assert.equal(resolveVisibleSessionFallback(hello, sessions), "foo");
  assert.equal(resolveVisibleSessionSelection("main", hello, sessions), "foo");
}

function testFallbackStillUsesMainWhenItIsVisible() {
  const hello = {
    snapshot: {
      sessionDefaults: {
        mainSessionKey: "main",
      },
    },
  } as any;
  const sessions = {
    sessions: [{ key: "main" }, { key: "foo" }],
  } as any;

  assert.equal(resolveVisibleSessionFallback(hello, sessions), "main");
}

function main() {
  testFallbackPrefersFirstVisibleSessionWhenMainIsHidden();
  testFallbackStillUsesMainWhenItIsVisible();
  console.log("session visibility tests passed");
}

main();

test("an empty session list preserves the gateway's canonical main conversation",()=>{
  const hello={snapshot:{sessionDefaults:{mainSessionKey:"agent:main:main",mainKey:"main"}}} as any;
  const sessions={sessions:[]} as any;
  assert.equal(resolveVisibleSessionFallback(hello,sessions),"agent:main:main");
  assert.equal(resolveVisibleSessionSelection("agent:main:main",hello,sessions),"agent:main:main");
  assert.equal(resolveVisibleSessionSelection("stale-session",hello,sessions),"agent:main:main");
});
test("without gateway defaults the empty-list fallback remains main",()=>{
  assert.equal(resolveVisibleSessionFallback(null,{sessions:[]} as any),"main");
});
