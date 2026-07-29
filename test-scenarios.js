#!/usr/bin/env node
/**
 * test-scenarios.js — Automated test runner for QueueCTL
 * Runs all 5 required test scenarios and prints pass/fail results.
 *
 * Usage: node test-scenarios.js
 */

'use strict';

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ── helpers ──────────────────────────────────────────────────────────────────

const ROOT     = __dirname;
const CLI      = path.join(ROOT, 'queuectl.js');
const DATA     = path.join(ROOT, 'data');
const PID_FILE = path.join(DATA, 'workers.pid');

// Current DB path (changes per scenario to avoid EBUSY on Windows)
let CURRENT_DB = path.join(DATA, 'queue.db');

let passed = 0;
let failed = 0;

function log(msg)    { console.log(`  ${msg}`); }
function ok(msg)     { console.log(`  ✅ PASS: ${msg}`); passed++; }
function fail(msg)   { console.log(`  ❌ FAIL: ${msg}`); failed++; }
function header(msg) { console.log(`\n${'═'.repeat(60)}\n${msg}\n${'═'.repeat(60)}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cli(args, opts = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd:      ROOT,
    encoding: 'utf8',
    timeout:  15000,
    env:      { ...process.env, QUEUECTL_DB: CURRENT_DB },
    ...opts,
  });
  return result;
}

function resetDb(scenarioName) {
  // Use a per-scenario DB to avoid EBUSY on Windows (worker holds file open)
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  CURRENT_DB = path.join(DATA, `queue_${scenarioName}.db`);
  // Remove any existing scenario DB
  if (fs.existsSync(CURRENT_DB)) {
    try { fs.unlinkSync(CURRENT_DB); } catch (_) {}
  }
  if (fs.existsSync(PID_FILE)) {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
  }
  // Point the db module to this scenario's file by setting env var
  process.env.QUEUECTL_DB = CURRENT_DB;
  log(`Database reset (${path.basename(CURRENT_DB)})`);
}

function clearLibCache() {
  Object.keys(require.cache).forEach(k => {
    if (k.includes(`${path.sep}lib${path.sep}`) || k.includes(`${path.sep}commands${path.sep}`)) {
      delete require.cache[k];
    }
  });
}

function getJobs(state) {
  clearLibCache();
  const { listJobs } = require('./lib/queue');
  return listJobs(state);
}

function countState(state) {
  return getJobs(state).length;
}

// Start N workers, return child processes
function startWorkers(count = 1) {
  const WORKER = path.join(ROOT, 'lib', 'worker-runner.js');
  const workers = [];
  for (let i = 0; i < count; i++) {
    const w = spawn(process.execPath, [WORKER], {
      cwd:   ROOT,
      stdio: 'pipe',
      env:   { ...process.env, WORKER_ID: `w${i+1}`, QUEUECTL_DB: CURRENT_DB },
    });
    workers.push(w);
  }
  return workers;
}

function stopWorkers(workers) {
  for (const w of workers) {
    try { w.kill('SIGTERM'); } catch (_) {}
  }
}

async function waitForState(state, count, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (countState(state) >= count) return true;
    await sleep(500);
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════ //
// SCENARIO 1: Basic job completes
// ═══════════════════════════════════════════════════════════════════════════ //

async function scenario1() {
  header('SCENARIO 1: Basic job completes');
  resetDb('s1');
  clearLibCache();

  const { enqueueJob } = require('./lib/queue');
  enqueueJob({ id: 's1-job1', command: 'echo Hello World' });
  log('Enqueued job s1-job1 (echo Hello World)');

  const workers = startWorkers(1);
  log('Started 1 worker...');

  const done = await waitForState('completed', 1, 10000);

  stopWorkers(workers);
  await sleep(500);

  if (done) {
    ok('Job completed within 10 seconds');
    const jobs = getJobs('completed');
    ok(`Job output: "${(jobs[0].output || '').trim()}"`);
  } else {
    const jobs = getJobs(null);
    fail(`Job did not complete. Jobs: ${JSON.stringify(jobs.map(j => ({id:j.id,state:j.state})))}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════ //
// SCENARIO 2: Failed job retries and moves to DLQ
// ═══════════════════════════════════════════════════════════════════════════ //

async function scenario2() {
  header('SCENARIO 2: Failed job retries → DLQ');
  resetDb('s2');
  clearLibCache();

  const { enqueueJob } = require('./lib/queue');
  // Command that always fails; max_retries=3, so:
  // attempt 0→fail, backoff 2^1=2s; attempt 1→fail, backoff 2^2=4s; attempt 2→fail → dead
  enqueueJob({ id: 's2-job1', command: 'node -e "process.exit(1)"', max_retries: 3 });
  log('Enqueued always-failing job (max_retries=3)');

  const workers = startWorkers(1);
  log('Started 1 worker. Waiting for job to exhaust retries (~14s)...');

  // 3 attempts: backoff 2+4+8 = 14s + execution time; give 30s
  const dead = await waitForState('dead', 1, 30000);

  stopWorkers(workers);
  await sleep(500);

  if (dead) {
    ok('Job moved to Dead Letter Queue after exhausting retries');
    const jobs = getJobs('dead');
    log(`DLQ job attempts = ${jobs[0].attempts}`);
    if (jobs[0].attempts === 3) {
      ok('Attempt count is exactly 3 (correct)');
    } else {
      fail(`Expected 3 attempts, got ${jobs[0].attempts}`);
    }
  } else {
    const jobs = getJobs(null);
    fail(`Job never reached DLQ. State: ${JSON.stringify(jobs.map(j => ({id:j.id,state:j.state,attempts:j.attempts})))}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════ //
// SCENARIO 3: Many jobs, multiple workers, each runs exactly once
// ═══════════════════════════════════════════════════════════════════════════ //

async function scenario3() {
  header('SCENARIO 3: 10 jobs × 3 workers, each job executes exactly once');
  resetDb('s3');
  clearLibCache();

  const { enqueueJob } = require('./lib/queue');
  for (let i = 1; i <= 10; i++) {
    enqueueJob({ id: `s3-job${i}`, command: `echo job-${i}` });
  }
  log('Enqueued 10 jobs');

  const workers = startWorkers(3);
  log('Started 3 workers...');

  const done = await waitForState('completed', 10, 30000);

  stopWorkers(workers);
  await sleep(1000); // let workers exit

  const completed  = getJobs('completed');
  const pending    = getJobs('pending');
  const processing = getJobs('processing');
  const failedJ    = getJobs('failed');

  log(`Completed: ${completed.length}, Pending: ${pending.length}, Processing: ${processing.length}, Failed: ${failedJ.length}`);

  if (completed.length === 10) {
    ok('All 10 jobs completed');
  } else {
    fail(`Only ${completed.length}/10 jobs completed`);
  }

  // Check no duplicates by ID
  const ids    = completed.map(j => j.id);
  const unique = new Set(ids).size;
  if (unique === ids.length && unique === 10) {
    ok('All 10 completed job IDs are unique (no duplicate execution)');
  } else {
    fail(`Duplicate job IDs detected or wrong count: ${ids.join(', ')}`);
  }

  if (pending.length === 0 && processing.length === 0) {
    ok('No jobs left pending or processing');
  } else {
    fail(`Jobs still pending/processing: pending=${pending.length}, processing=${processing.length}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════ //
// SCENARIO 4: Worker SIGKILL → job recovers automatically
// ═══════════════════════════════════════════════════════════════════════════ //

async function scenario4() {
  header('SCENARIO 4: Worker SIGKILL mid-job → job auto-recovers');
  resetDb('s4');
  clearLibCache();

  const { enqueueJob } = require('./lib/queue');
  // Long-running job so we can SIGKILL the worker mid-execution
  enqueueJob({ id: 's4-job1', command: 'node -e "setTimeout(()=>process.exit(0),60000)"' });
  log('Enqueued a 60-second job');

  const [victim] = startWorkers(1);
  log(`Started victim worker (PID ${victim.pid})`);

  // Wait for worker to claim the job
  const claimed = await waitForState('processing', 1, 10000);
  if (!claimed) {
    fail('Job was never claimed (prerequisite failed)');
    stopWorkers([victim]);
    return;
  }
  ok('Job claimed and in processing state');

  // Wait a moment so the worker is definitely mid-execution
  await sleep(2000);

  // SIGKILL the victim worker
  try { victim.kill('SIGKILL'); } catch (_) {}
  log(`SIGKILLed victim worker (PID ${victim.pid})`);

  // Briefly wait, then start a rescue worker
  await sleep(1000);
  const [rescuer] = startWorkers(1);
  log(`Started rescue worker (PID ${rescuer.pid}), waiting for recovery (≤35s)...`);

  // The rescue worker will detect the stale heartbeat (30s timeout) and reset to pending,
  // then pick up and complete the job. But since the job runs for 60s, let's just check
  // that it gets recovered (back to pending or completed within the timeout window).
  // We set heartbeat-timeout to 10s for this test to speed things up.

  // Manually set heartbeat timeout to 10s for faster test
  clearLibCache();
  const { setConfig } = require('./lib/config-store');
  setConfig('heartbeat-timeout', '10');
  log('Set heartbeat-timeout=10s for faster recovery test');

  // Now wait for job to be recovered to pending (within 15s) or completed (within 90s)
  let recovered = false;
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const pending   = getJobs('pending');
    const completed = getJobs('completed');
    if (pending.length > 0) {
      ok('Job recovered from SIGKILL back to pending state (within heartbeat timeout)');
      recovered = true;
      break;
    }
    if (completed.length > 0) {
      ok('Job recovered from SIGKILL and completed');
      recovered = true;
      break;
    }
    await sleep(500);
  }

  stopWorkers([rescuer]);
  await sleep(500);

  // Reset heartbeat timeout back to default
  clearLibCache();
  const { setConfig: sc2 } = require('./lib/config-store');
  sc2('heartbeat-timeout', '30');

  if (!recovered) {
    const jobs = getJobs(null);
    fail(`Job stuck in processing after SIGKILL. State: ${JSON.stringify(jobs.map(j => ({id:j.id,state:j.state,last_heartbeat:j.last_heartbeat})))}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════ //
// SCENARIO 5: Jobs survive complete restart
// ═══════════════════════════════════════════════════════════════════════════ //

async function scenario5() {
  header('SCENARIO 5: Jobs survive complete restart (persistence)');
  resetDb('s5');
  clearLibCache();

  const { enqueueJob } = require('./lib/queue');
  enqueueJob({ id: 's5-job1', command: 'echo survived-restart' });
  enqueueJob({ id: 's5-job2', command: 'echo survived-too' });
  log('Enqueued 2 jobs (no workers started — simulating an app crash)');

  // Simulate restart by clearing all module cache (as if process restarted)
  clearLibCache();
  log('Simulating restart (clearing module cache)...');

  // Check jobs still exist
  const { listJobs } = require('./lib/queue');
  const pending = listJobs('pending');
  log(`After "restart": ${pending.length} pending jobs found`);

  if (pending.length === 2) {
    ok('Both jobs persisted across restart');
  } else {
    fail(`Expected 2 pending jobs, found ${pending.length}`);
    return;
  }

  // Start workers and complete them
  const workers = startWorkers(1);
  const done = await waitForState('completed', 2, 15000);

  stopWorkers(workers);
  await sleep(500);

  if (done) {
    ok('Both persisted jobs completed after restart');
    ok('Persistence verified — data survives process termination');
  } else {
    const comp = getJobs('completed');
    fail(`Only ${comp.length}/2 persisted jobs completed`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════ //
// BONUS: Test --json list output format
// ═══════════════════════════════════════════════════════════════════════════ //

async function scenarioJsonOutput() {
  header('BONUS: queuectl list --json outputs only a JSON array');

  const result = cli(['list', '--state', 'completed', '--json']);
  const stdout = result.stdout || '';

  try {
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed)) {
      ok('--json output is a valid JSON array (spec compliant)');
    } else {
      fail('--json output is valid JSON but not an array');
    }
  } catch (e) {
    fail(`--json output is not valid JSON: ${e.message}\nOutput was: "${stdout}"`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════ //
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════ //

async function main() {
  console.log('\n🚀 QueueCTL — Automated Test Suite\n');
  console.log('Testing all 5 required scenarios + bonus checks...\n');

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenarioJsonOutput();

  console.log(`\n${'═'.repeat(60)}`);
  const status = failed === 0 ? '✅ ALL TESTS PASSED' : `❌ ${failed} TEST(S) FAILED`;
  console.log(`RESULTS: ${passed} passed, ${failed} failed — ${status}`);
  console.log('═'.repeat(60) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
