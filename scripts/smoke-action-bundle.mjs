// smoke-action-bundle.mjs — deterministic release smoke harness for a committed
// runtime bundle (`dist/**/index.js`).
//
// WHY THIS EXISTS: a bare `node <bundle>` invocation is NOT a deterministic
// health signal. A real adapter legitimately exits non-zero (a controlled 1) when
// required inputs are absent, so "tolerate exit codes 1..123" would also pass a
// genuinely broken bundle that throws an ordinary runtime exception (also exit 1).
//
// This harness instead runs the bundle in an ISOLATED, DETERMINISTIC self-test
// mode and requires it to exit EXACTLY 0. It sets `CHAOS_STUDIO_SMOKE_CHECK=1`,
// which the adapter honors to run a no-side-effect self-test (validate its own
// wiring, touch no network, mutate nothing) and exit 0. The child runs with a
// SCRUBBED environment (no inherited `INPUT_*`/token/CI variables) so the outcome
// depends only on the bundle, not on ambient state.
//
// It fails CLOSED on every unexpected outcome:
//   * any non-zero exit (including ordinary runtime exceptions, 1..123),
//   * a timeout (the WHOLE process tree is killed and treated as a failure),
//   * a crash via signal (SIGSEGV/etc.),
//   * the placeholder sentinel appearing in output.
//
// On timeout the child is spawned in its own process group (POSIX `detached`) so
// the entire tree — including any grandchildren the bundle spawned — is terminated.
// On Windows the bundle runs inside a named Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (see scripts/win-job.ps1): killing the job
// terminates the whole tree atomically and is VERIFIED (the job object is polled
// until it no longer exists), which — unlike `taskkill /t` — is robust even after
// the root child has exited while a re-parented grandchild lingers. A bounded
// post-kill deadline guarantees the harness itself cannot hang waiting for a wedged
// child to exit.
//
// Usage: node scripts/smoke-action-bundle.mjs <path-to-bundle>
//
// NOTE: the placeholder bundle (E1) does not implement the self-test path and
// exits 1; the release workflow rejects placeholders via a sentinel grep BEFORE
// invoking this harness, so this harness only ever runs against a real bundle
// (wired in E3/E4). Both `index.js` bundles honor `CHAOS_STUDIO_SMOKE_CHECK`.

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TIMEOUT_MS = 60_000;
// Cap the retained child output so a runaway or looping bundle cannot exhaust the
// harness's memory before the timeout fires. A healthy self-test emits only a few
// lines; crossing this bound is itself a failure (the tree is killed and the run fails).
const MAX_OUTPUT_BYTES = 1 << 20; // 1 MiB
// Assembled from fragments so this harness source is not itself mistaken for a
// built bundle carrying the sentinel.
const SENTINEL = ['__CHAOS_STUDIO', 'PLACEHOLDER', 'BUNDLE__'].join('_');

// Windows Job Object launcher/killer helper (see scripts/win-job.ps1). On Windows the
// bundle is launched INSIDE a named Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
// so the entire process tree can be terminated atomically and VERIFIABLY — unlike
// `taskkill /t`, which cannot reach a re-parented grandchild once the root has exited.
const WIN_JOB_PS1 = join(import.meta.dirname, 'win-job.ps1');
const IS_WINDOWS = process.platform === 'win32';
// A per-invocation job name (pid + high-res time) so concurrent harness runs never
// collide on the same named Job Object.
const JOB_NAME = `ChaosSmokeJob_${process.pid}_${Date.now()}`;
// Readiness marker: the launcher writes this file the instant the bundle becomes a job
// member. Its PRESENCE means the job exists with the child inside it (safe to reap via
// the job); its ABSENCE at timeout means the launcher has NOT yet established the job,
// so the harness must terminate the LAUNCHER rather than trust a "missing job" as a
// terminated tree (which would let the launcher start the bundle unmanaged afterward).
const READY_FILE = join(tmpdir(), `${JOB_NAME}.ready`);
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_JOB_PS1];

/** Removes the readiness marker file (best-effort) so it never leaks across runs. */
function cleanupReadyFile() {
  if (!IS_WINDOWS) return;
  try { rmSync(READY_FILE, { force: true }); } catch { /* best-effort */ }
}

function fail(message, detail) {
  // Explicitly reap the launcher and any helper before exiting, so a fail() reached via
  // a competing deadline (e.g. the post-kill grace timer firing while the kill helper is
  // still running) can never leave the launcher or the kill-mode helper alive.
  reapHelpers();
  cleanupReadyFile();
  console.error(`::error::${message}`);
  if (detail) process.stderr.write(detail.endsWith('\n') ? detail : `${detail}\n`);
  process.exit(1);
}

const bundle = process.argv[2];
if (!bundle) fail('smoke harness requires a bundle path argument.');
if (!existsSync(bundle)) fail(`smoke harness: bundle '${bundle}' does not exist.`);

// Scrubbed, deterministic child environment: keep only what Node needs to run,
// then add the explicit self-test signal. No INPUT_*, tokens, or CI vars leak in.
// (On Windows the SAME scrubbing is applied to the node child inside win-job.ps1.)
const childEnv = {
  PATH: process.env.PATH ?? '',
  CHAOS_STUDIO_SMOKE_CHECK: '1',
};
if (IS_WINDOWS && process.env.SystemRoot) {
  childEnv.SystemRoot = process.env.SystemRoot; // Windows Node needs this to spawn.
}

// Spawn the bundle so a timeout can terminate the ENTIRE tree, not just the direct
// child. POSIX: `detached` puts the child in its own process group (negative-PID
// signal targets the whole group). Windows: launch through win-job.ps1, which places
// the bundle in a kill-on-close Job Object that all descendants inherit.
//
// POSIX CONTAINMENT NOTE (setsid escape): the negative-PID group kill reaches every
// descendant that stays in the child's process group, but a descendant that calls
// `setsid()` becomes its OWN session/group leader and LEAVES this group, so it can
// neither be signalled by `-pgid` nor keep this group alive. Covering such
// session-changing descendants requires OS-level containment — a Linux PID namespace
// (`unshare --pid --fork`) or a cgroup with `cgroup.kill` — which needs privileges the
// CI runner may not grant. This harness runs a TRUSTED self-test bundle
// (`CHAOS_STUDIO_SMOKE_CHECK=1`, scrubbed env) that does NOT fork session leaders, so
// the process group is sufficient here; when session-changing descendants must be
// covered, run this harness inside a cgroup/container that bounds all descendants
// (Windows already covers them via the KILL_ON_JOB_CLOSE Job Object).
const child = IS_WINDOWS
  ? spawn('powershell', [...PS_ARGS, '-Mode', 'launch', '-JobName', JOB_NAME, '-NodeExe', process.execPath, '-Bundle', bundle, '-ReadyFile', READY_FILE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn(process.execPath, [bundle], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

// Bounded accumulator over RAW BYTES into ONE fixed-size buffer. We COPY accepted bytes
// into a single pre-allocated MAX_OUTPUT_BYTES buffer rather than retaining the incoming
// chunks: an array of chunk Buffers (or a `subarray` VIEW into a large chunk) would keep
// each chunk's FULL backing store alive, so a single 50 MiB write truncated with
// `subarray` would still retain 50 MiB. Copying only the accepted prefix into our own
// fixed buffer bounds retained memory at exactly MAX_OUTPUT_BYTES regardless of chunk
// sizes or encoding, and drops every reference to the source chunks.
const outputBuf = Buffer.alloc(MAX_OUTPUT_BYTES);
let outputBytes = 0;
let overflowed = false;
function recordOutput(chunk) {
  if (overflowed) return;
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_OUTPUT_BYTES - outputBytes;
  if (buf.length > remaining) {
    // Copy only the bytes that fit, then stop retaining and fail-closed kill the tree.
    buf.copy(outputBuf, outputBytes, 0, remaining);
    outputBytes = MAX_OUTPUT_BYTES;
    overflowed = true;
    onOutputOverflow();
    return;
  }
  buf.copy(outputBuf, outputBytes, 0, buf.length);
  outputBytes += buf.length;
}
child.stdout.on('data', recordOutput);
child.stderr.on('data', recordOutput);

// Decode the retained bytes to a string once, on a terminal path only (sentinel check +
// error detail). The slice is a view into OUR fixed MAX-sized buffer, so it retains no
// more than MAX_OUTPUT_BYTES.
function getOutput() {
  return outputBuf.toString('utf8', 0, outputBytes);
}

// Grace period after a timeout kill: if the tree does not die and `close` never
// fires within this bound, the harness force-exits so IT can never hang either.
const POST_KILL_GRACE_MS = 5_000;

/** Best-effort direct-child kill fallback (used when tree termination fails). */
function killChildFallback() {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

// The most-recently-spawned Windows kill-mode helper process, tracked so it can be
// explicitly reaped (see reapHelpers) if a competing deadline fires while it is running.
let winKiller = null;

/**
 * True iff the child's POSIX process group has NO surviving members. `process.kill(
 * -pgid, 0)` is a permission/existence PROBE that sends no signal: it throws `ESRCH`
 * only when the group is empty; `EPERM` (exists but not signalable) or success both mean
 * members remain, so only `ESRCH` is treated as gone. No-op meaning on Windows.
 */
function posixGroupGone() {
  try {
    process.kill(-child.pid, 0);
    return false; // signalled successfully => a member exists
  } catch (e) {
    return e && e.code === 'ESRCH';
  }
}

/** Best-effort SIGKILL of the whole POSIX process group (idempotent; no-op if empty). */
function killPosixGroup() {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already empty */ }
}

/**
 * Probe the POSIX process group and terminate it if any descendant survives. Used on the
 * fail() path (the process is exiting, so this is a best-effort synchronous SIGKILL —
 * the SUCCESS path uses waitPosixGroupGone to VERIFY termination). No-op on Windows.
 */
function reapPosixGroup() {
  if (IS_WINDOWS) return;
  if (posixGroupGone()) return;
  killPosixGroup();
}

/**
 * Bounded async wait until the POSIX process group is CONFIRMED gone. Sends one SIGKILL
 * to the group, then polls `posixGroupGone()` until it is empty or `deadlineMs` elapses,
 * invoking `cb(gone)` with the result. On the happy path (root exited, no descendants)
 * the group is already empty, so `cb(true)` fires immediately with no added latency.
 *
 * The poll timer is deliberately KEPT REFERENCED (no `unref()`): it must hold the event
 * loop open until confirmation (success) OR the deadline (timeout) — an `unref()`ed timer
 * would let the harness process EXIT before the group is confirmed gone, reporting a
 * false pass while a descendant is still alive. The callback ends the wait either way
 * (success prints + returns so the loop drains; timeout calls `fail()` which exits).
 */
function waitPosixGroupGone(deadlineMs, cb) {
  killPosixGroup();
  const start = Date.now();
  const poll = () => {
    if (posixGroupGone()) { cb(true); return; }
    if (Date.now() - start >= deadlineMs) { cb(false); return; }
    // No unref(): this timer must keep the process alive until the group is confirmed
    // gone or the deadline elapses.
    setTimeout(poll, 50);
  };
  poll();
}

/**
 * Explicitly reap the launcher/direct child, any surviving POSIX process-group
 * descendants, and the Windows kill-mode helper. Idempotent and best-effort — used on
 * fail() so a bypassed fallback (competing deadlines) can never leak these processes.
 */
function reapHelpers() {
  killChildFallback();
  reapPosixGroup();
  if (winKiller) { try { winKiller.kill('SIGKILL'); } catch { /* already gone */ } }
}

/**
 * Terminate the child AND its descendants (the whole process tree).
 *  - POSIX: signal the whole process group created by `detached` (negative PID).
 *  - Windows: run win-job.ps1 in `kill` mode, which TerminateJobObject's the named
 *    job and AWAITS verified termination (the job object no longer exists). This is
 *    robust even after the root exited, because re-parented descendants remain job
 *    members. Its outcome is HANDLED: a spawn error, a non-zero exit (verification
 *    failed), or a signal all trigger the direct-child fallback so nothing leaks
 *    silently. `child.on('close')` plus the bounded post-kill deadline confirm exit.
 */
function killTree(signal) {
  if (!IS_WINDOWS) {
    // POSIX: negative PID targets the whole process group created by `detached`.
    try {
      process.kill(-child.pid, signal);
    } catch {
      killChildFallback();
    }
    return;
  }
  // READINESS GATE: if the launcher has NOT yet published the readiness marker, the
  // named Job Object may not exist yet — so a `kill` mode "job not found" must NOT be
  // treated as a terminated tree (the launcher would otherwise proceed to create the
  // job and start the bundle unmanaged). Terminate the LAUNCHER first: killing it
  // closes its job handle (KILL_ON_JOB_CLOSE reaps any already-assigned member) AND
  // stops it before it can create the job / start the bundle.
  const ready = existsSync(READY_FILE);
  if (!ready) {
    process.stderr.write('win-job readiness not established at kill time; terminating the launcher.\n');
    killChildFallback();
  }
  let killer;
  try {
    killer = spawn('powershell', [...PS_ARGS, '-Mode', 'kill', '-JobName', JOB_NAME], { stdio: 'ignore' });
    winKiller = killer; // track so a competing deadline can explicitly reap it
  } catch (err) {
    process.stderr.write(`win-job kill could not be spawned (${err.message}); using fallback.\n`);
    killChildFallback();
    return;
  }
  killer.on('error', (err) => {
    process.stderr.write(`win-job kill failed (${err.message}); using fallback.\n`);
    killChildFallback();
  });
  killer.on('exit', (code, sig) => {
    if (killer === winKiller) winKiller = null; // helper finished; no longer needs reaping
    // Exit 0 = the job object was verified gone (whole tree terminated). Any signal
    // or non-zero exit (e.g. 3 = could not confirm) means the tree may still be
    // alive; fall back to killing the launcher, whose exit closes the job handle and
    // triggers JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE for any remaining descendant.
    if (sig) {
      process.stderr.write(`win-job kill terminated by signal ${sig}; using fallback.\n`);
      killChildFallback();
    } else if (code !== 0) {
      process.stderr.write(`win-job kill exited ${code} (tree not verified gone); using fallback.\n`);
      killChildFallback();
    }
  });
}

let timedOut = false;
let postKillTimer = null;
const timer = setTimeout(() => {
  timedOut = true;
  killTree('SIGKILL');
  // Bounded post-kill deadline: do not wait forever for `close`. This watchdog is
  // deliberately KEPT REFERENCED (no `unref()`): it must hold the event loop open so
  // `fail()` actually runs if `close` never fires — an `unref()`ed watchdog could let
  // the harness EXIT (reporting a false pass / no failure) before the deadline elapses.
  // The normal `close` path clears it, so it only ever holds the loop until close or the
  // grace deadline.
  postKillTimer = setTimeout(() => {
    fail(`Action bundle smoke test timed out after ${TIMEOUT_MS} ms and did not exit within ${POST_KILL_GRACE_MS} ms of kill.`, getOutput());
  }, POST_KILL_GRACE_MS);
}, TIMEOUT_MS);

child.on('error', (err) => {
  clearTimeout(timer);
  if (postKillTimer) clearTimeout(postKillTimer);
  fail(`smoke harness could not spawn the bundle: ${err.message}`);
});

// Fired when the child's retained output crosses MAX_OUTPUT_BYTES. Mirrors the timeout
// path: kill the whole tree, then bound the wait for `close` so the harness itself can
// never hang. If `close` does not fire in time, force-fail with the captured prefix.
function onOutputOverflow() {
  if (timedOut) return; // a timeout kill is already in progress
  clearTimeout(timer);
  killTree('SIGKILL');
  // KEPT REFERENCED (no `unref()`) for the same reason as the timeout watchdog above:
  // it must keep the process alive so `fail()` runs if `close` never fires.
  postKillTimer = setTimeout(() => {
    fail(`Action bundle smoke test exceeded the ${MAX_OUTPUT_BYTES}-byte output cap and did not exit within ${POST_KILL_GRACE_MS} ms of kill.`, getOutput());
  }, POST_KILL_GRACE_MS);
}

child.on('close', (code, signal) => {
  clearTimeout(timer);
  if (postKillTimer) clearTimeout(postKillTimer);
  // Any FAILURE reason first — fail() reaps the launcher, helper, and POSIX group.
  if (overflowed) {
    fail(`Action bundle smoke test exceeded the ${MAX_OUTPUT_BYTES}-byte output cap.`, getOutput());
  }
  if (timedOut) {
    fail(`Action bundle smoke test timed out after ${TIMEOUT_MS} ms.`, getOutput());
  }
  if (signal) {
    fail(`Action bundle smoke test crashed with signal ${signal}.`, getOutput());
  }
  const decoded = getOutput();
  if (decoded.includes(SENTINEL)) {
    fail('Action bundle smoke test detected the placeholder sentinel.', decoded);
  }
  if (code !== 0) {
    // No tolerance for 1..123: a healthy bundle self-test MUST exit 0.
    fail(`Action bundle self-test exited ${code}; expected 0.`, decoded);
  }
  // SUCCESS CANDIDATE. On Windows the Job Object already reaped every descendant. On
  // POSIX a clean root exit is NOT proof the tree is gone — a detached grandchild can
  // outlive the root — so kill any surviving group members and WAIT (bounded) for the
  // group to be CONFIRMED empty before declaring success. If it does not disappear
  // (a stuck descendant), fail closed rather than report a false pass.
  if (IS_WINDOWS) {
    cleanupReadyFile();
    process.stdout.write('Action bundle passed the deterministic smoke self-test (exit 0).\n');
    return;
  }
  waitPosixGroupGone(POST_KILL_GRACE_MS, (gone) => {
    if (!gone) {
      fail(`Action bundle smoke test: the child process group did not terminate within ${POST_KILL_GRACE_MS} ms of cleanup (a descendant survived).`, decoded);
    }
    cleanupReadyFile();
    process.stdout.write('Action bundle passed the deterministic smoke self-test (exit 0).\n');
  });
});
