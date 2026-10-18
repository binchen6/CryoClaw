import type { ChildProcess } from "node:child_process";

/** Confirm process creation before quitting; spawn failures are normally asynchronous. */
export function launchInstaller(
  spawn: () => ChildProcess,
  started: () => void,
  failed: (error: unknown) => void,
): void {
  try {
    const child = spawn();
    child.once("error", failed);
    child.once("spawn", () => {
      try { child.unref(); started(); }
      catch (error) { failed(error); }
    });
  } catch (error) { failed(error); }
}
