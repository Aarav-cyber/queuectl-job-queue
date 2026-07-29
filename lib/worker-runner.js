'use strict';
/**
 * lib/worker-runner.js
 *
 * This file is the worker process entry point.  It is spawned as a separate
 * OS process by `queuectl worker start`.  Each worker instance runs its own
 * infinite poll loop:
 *
 *   1. Call recoverStaleJobs() — rescue any job abandoned by a crashed worker.
 *   2. Call claimJob()         — atomically claim the next pending job.
 *   3. Execute the job command via a child shell process.
 *   4. Update heartbeat every HEARTBEAT_INTERVAL_MS while the job runs.
 *   5. Mark the job completed or failed.
 *   6. Sleep POLL_INTERVAL_MS and repeat.
 *
 * Graceful shutdown (SIGTERM / SIGINT):
 *   - Sets a flag so the loop doesn't pick up a new job after the current one.
 *   - Waits for the current job to finish, then exits cleanly.
 *
 * SIGKILL simulation (crash):
 *   - The process is killed instantly; no cleanup runs.
 *   - The next live worker will detect the abandoned job via the heartbeat
 *     watchdog (recoverStaleJobs) and reset it to 'pending' within 30 s.
 */

const { spawnSync, spawn } = require('child_process');
const path                 = require('path');
const fs                   = require('fs');

const { claimJob, completeJob, failJob, updateHeartbeat, recoverStaleJobs } = require('./queue');
const { getConfig } = require('./config-store');
const { DATA_DIR }  = require('./db');

const POLL_INTERVAL_MS      = 1_000;   // how often to poll for new jobs
const HEARTBEAT_INTERVAL_MS = 5_000;   // how often to update heartbeat during execution

const WORKER_ID  = process.env.WORKER_ID || `worker-${process.pid}`;
const PID_FILE   = path.join(DATA_DIR, 'workers.pid');

// ─── PID file management ──────────────────────────────────────────────────────

function registerPid() {
  let pids = readPids();
  if (!pids.includes(process.pid)) {
    pids.push(process.pid);
  }
  fs.writeFileSync(PID_FILE, pids.join('\n'), 'utf8');
}

function unregisterPid() {
  let pids = readPids().filter(p => p !== process.pid);
  fs.writeFileSync(PID_FILE, pids.join('\n'), 'utf8');
}

function readPids() {
  if (!fs.existsSync(PID_FILE)) return [];
  const content = fs.readFileSync(PID_FILE, 'utf8').trim();
  return content
    ? content.split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];
}

// ─── job execution ────────────────────────────────────────────────────────────

/**
 * Executes a job's shell command.
 * Starts a heartbeat timer that updates the DB every 5 s.
 * Respects per-job timeout if set.
 *
 * Returns { success: boolean, output: string }
 */
function executeJob(job) {
  const timeoutSeconds = job.timeout || parseInt(getConfig('job-timeout') || '0', 10);
  const timeoutMs      = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;

  // Start heartbeat ticker
  const heartbeatTimer = setInterval(() => {
    try { updateHeartbeat(job.id); } catch (_) {}
  }, HEARTBEAT_INTERVAL_MS);

  let output = '';
  let success = false;

  try {
    // Use spawnSync with shell:true so the command runs exactly like a shell script.
    // We set a timeout if configured; on timeout spawnSync sets status to null and
    // error.code to 'ETIMEDOUT'.
    const isWindows = process.platform === 'win32';
    const shell     = isWindows ? true : '/bin/sh';

    const result = spawnSync(job.command, {
      shell:   shell,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      encoding: 'utf8',
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    output = [stdout, stderr].filter(Boolean).join('\n');

    if (result.error) {
      // Includes ENOENT (command not found) and ETIMEDOUT
      output += `\nError: ${result.error.message}`;
      success = false;
    } else {
      // exit code 0 = success; non-zero = failure (spec requirement)
      success = result.status === 0;
    }
  } finally {
    clearInterval(heartbeatTimer);
  }

  return { success, output };
}

// ─── main loop ────────────────────────────────────────────────────────────────

let shuttingDown  = false;
let currentJobId  = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runLoop() {
  console.log(`[${WORKER_ID}] Worker started (PID ${process.pid})`);
  registerPid();

  while (true) {
    if (shuttingDown) break;

    // 1. Crash recovery watchdog — runs every iteration
    try {
      const recovered = recoverStaleJobs();
      if (recovered > 0) {
        console.log(`[${WORKER_ID}] Recovered ${recovered} stale job(s)`);
      }
    } catch (err) {
      console.error(`[${WORKER_ID}] Recovery error:`, err.message);
    }

    // 2. Claim a job
    let job = null;
    try {
      job = claimJob();
    } catch (err) {
      console.error(`[${WORKER_ID}] Claim error:`, err.message);
    }

    if (!job) {
      // Queue is empty — wait before polling again
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // 3. Execute
    currentJobId = job.id;
    console.log(`[${WORKER_ID}] Executing job ${job.id}: ${job.command}`);

    let execResult;
    try {
      execResult = executeJob(job);
    } catch (err) {
      execResult = { success: false, output: `Unhandled exception: ${err.message}` };
    }

    currentJobId = null;

    // 4. Update state
    if (execResult.success) {
      completeJob(job.id, execResult.output);
      console.log(`[${WORKER_ID}] Job ${job.id} completed`);
    } else {
      failJob(job.id, execResult.output);
      const updated = require('./queue').getJob(job.id); // re-read to log new state
      console.log(`[${WORKER_ID}] Job ${job.id} failed → state=${updated ? updated.state : '?'}`);
    }

    // 5. If graceful shutdown requested, exit after finishing the job
    if (shuttingDown) break;

    // Brief pause between jobs
    await sleep(POLL_INTERVAL_MS);
  }

  unregisterPid();
  console.log(`[${WORKER_ID}] Worker exiting gracefully`);
  process.exit(0);
}

// ─── signal handlers ──────────────────────────────────────────────────────────

function handleShutdown(signal) {
  if (shuttingDown) return; // ignore duplicate signals
  console.log(`\n[${WORKER_ID}] Received ${signal} — finishing current job then exiting...`);
  shuttingDown = true;
  // If no job is running right now, exit immediately
  if (!currentJobId) {
    unregisterPid();
    process.exit(0);
  }
  // Otherwise the loop will exit after the job completes
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT',  () => handleShutdown('SIGINT'));

// Ensure PID file is cleaned up on normal exit
process.on('exit', () => {
  try { unregisterPid(); } catch (_) {}
});

// ─── start ────────────────────────────────────────────────────────────────────

runLoop().catch(err => {
  console.error(`[${WORKER_ID}] Fatal error:`, err);
  unregisterPid();
  process.exit(1);
});
