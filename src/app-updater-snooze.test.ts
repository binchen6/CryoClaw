import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => ({
  check: vi.fn(async () => null),
  snooze: null as null | {until: "forever"; setAt: number},
}));
vi.mock("electron", () => ({app: {isPackaged:true,getVersion:()=>"2026.1018.2",getPath:()=>"unused"}}));
vi.mock("electron-updater", () => ({autoUpdater: {on:vi.fn(),checkForUpdates:mock.check}}));
vi.mock("./logger", () => ({info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()}));
vi.mock("./app-flags", () => ({BUNDLED_DEFAULT_FLAGS:{differentialDownload:true},loadAppFlags:async()=>({source:"default",flags:{differentialDownload:true}})}));
vi.mock("./update-snooze", async importOriginal => ({
  ...await importOriginal<typeof import("./update-snooze")>(),
  readSnooze:()=>mock.snooze,
  writeSnooze:vi.fn(), // Persistence can fail without throwing; memory must still win.
  clearSnooze:vi.fn(),
}));
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();mock.check.mockClear();mock.snooze=null;});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

test("failed snooze persistence still suppresses startup and periodic checks", async()=>{
  const updater=await import("./app-updater");
  updater.initAppUpdater({push:()=>{}});
  updater.snoozeAppUpdate("forever");
  await vi.advanceTimersByTimeAsync(12*60*60*1000);
  expect(mock.check).not.toHaveBeenCalled();
});

test("clearing snooze resumes checks even if the old disk record remains", async()=>{
  mock.snooze={until:"forever",setAt:1};
  const updater=await import("./app-updater");
  updater.initAppUpdater({push:()=>{}});
  updater.clearAppUpdateSnooze();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mock.check).toHaveBeenCalledOnce();
});
