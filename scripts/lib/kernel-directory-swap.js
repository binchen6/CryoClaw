"use strict";
const fs = require("node:fs");
const path = require("node:path");
function rename(from, to, io) {
  for (let attempt=0;;attempt++) {
    try { io.renameSync(from,to); return; }
    catch(error) {
      if (attempt>=10 || !["EPERM","EACCES","EBUSY"].includes(error.code)) throw error;
      // Defender/indexers can briefly hold a freshly copied directory. Retry
      // this one rename only; never replay npm, model calls or the transaction.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(100,20*(attempt+1)));
    }
  }
}

function versionOf(directory, io = fs) {
  const root = path.join(directory, "node_modules", "openclaw");
  const version = JSON.parse(io.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !io.statSync(path.join(root, "openclaw.mjs")).isFile()) throw new Error("Incomplete physical gateway directory");
  return version;
}

// One directory rename publishes the whole tree. The journal names only siblings
// derived from a numeric timestamp; never follow paths supplied by a journal.
function recoverDirectorySwap(current, io = fs) {
  const journalPath = current + ".swap.json";
  if (!io.existsSync(journalPath)) return "clean";
  const journal = JSON.parse(io.readFileSync(journalPath, "utf8"));
  if (!Number.isSafeInteger(journal.ts) || journal.ts <= 0 || ![journal.from, journal.to].every(v => typeof v === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v))) throw new Error("Invalid physical gateway swap journal; evidence retained");
  const old = `${current}.old-${journal.ts}`, next = `${current}.new-${journal.ts}`;
  let result;
  if (!io.existsSync(current)) {
    if (!io.existsSync(old) || versionOf(old, io) !== journal.from) throw new Error("Physical gateway recovery has no complete previous tree; evidence retained");
    rename(old, current, io); result = "rollback";
  } else {
    const version = versionOf(current, io);
    if (version === journal.to) result = "committed";
    else if (version === journal.from && !io.existsSync(old)) result = "unchanged";
    else throw new Error("Physical gateway recovery identity mismatch; evidence retained");
  }
  io.rmSync(next, { recursive: true, force: true });
  io.rmSync(old, { recursive: true, force: true });
  io.rmSync(journalPath, { force: true });
  return result;
}

function swapDirectory(candidate, current, target, io = fs, {moveCandidate=false} = {}) {
  recoverDirectorySwap(current, io);
  if (versionOf(candidate, io) !== target) throw new Error("Physical gateway target version mismatch");
  const from = versionOf(current, io), ts = Date.now();
  const next = `${current}.new-${ts}`, old = `${current}.old-${ts}`, journalPath = current + ".swap.json", temp = journalPath + ".tmp";
  if (io.existsSync(next) || io.existsSync(old)) throw new Error("Physical gateway staging collision");
  let moved=false;
  if(moveCandidate){
    try{rename(candidate,next,io);moved=true;}
    catch(error){if(error.code!=='EXDEV')throw error;}
  }
  if(!moved)io.cpSync(candidate, next, { recursive: true, verbatimSymlinks: true });
  if (versionOf(next, io) !== target) throw new Error("Copied physical gateway is incomplete");
  io.writeFileSync(temp, JSON.stringify({ from, to: target, ts }) + "\n", {flush:true});
  rename(temp, journalPath, io);
  try {
    rename(current, old, io);
    rename(next, current, io);
  } catch (error) {
    try { recoverDirectorySwap(current, io); } catch { /* Keep journal and all evidence. */ }
    throw error;
  }
  recoverDirectorySwap(current, io);
}

module.exports = { versionOf, swapDirectory, recoverDirectorySwap };
