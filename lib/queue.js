'use strict';
/**
 * lib/queue.js
 *
 * All job-queue operations: enqueue, atomic claim, complete, fail,
 * recover stale jobs, list, DLQ operations.
 *
 * CRITICAL: claimJob() uses a single SQLite transaction with an
 * exclusive write lock. Because better-sqlite3 is synchronous and
 * SQLite serialises writers at the file level, only one OS process
 * can execute this transaction at a time — guaranteeing no job is
 * ever claimed twice.
 */

const { getDb }              = require('./db');
const { getConfig }          = require('./config-store');
const { v4: uuidv4 }         = require('uuid');

// ─── helpers ─────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function addSeconds(isoStr, seconds) {
  const d = new Date(isoStr);
  d.setSeconds(d.getSeconds() + seconds);
  return d.toISOString();
}

// ─── enqueue ─────────────────────────────────────────────────────────────────

/**
 * Adds a new job to the queue.
 * @param {object} opts
 * @param {string} [opts.id]          – custom id; auto-generated if omitted
 * @param {string} opts.command       – shell command to run
 * @param {number} [opts.max_retries] – defaults to config value
 * @param {number} [opts.priority]    – lower = higher priority; default 0
 * @param {number} [opts.timeout]     – seconds; null = no timeout
 */
function enqueueJob(opts) {
  const db  = getDb();
  const now = nowIso();

  const defaultRetries = parseInt(getConfig('max-retries') || '3', 10);

  const job = {
    id:          opts.id        || uuidv4(),
    command:     opts.command,
    state:       'pending',
    attempts:    0,
    max_retries: opts.max_retries != null ? opts.max_retries : defaultRetries,
    priority:    opts.priority   != null ? opts.priority    : 0,
    timeout:     opts.timeout    || null,
    next_run_at: now,
    created_at:  now,
    updated_at:  now,
  };

  db.prepare(`
    INSERT INTO jobs
      (id, command, state, attempts, max_retries, priority, timeout, next_run_at, created_at, updated_at)
    VALUES
      (@id, @command, @state, @attempts, @max_retries, @priority, @timeout, @next_run_at, @created_at, @updated_at)
  `).run(job);

  return job;
}

// ─── atomic claim ─────────────────────────────────────────────────────────────

/**
 * Atomically claims the next eligible pending job for this worker.
 *
 * HOW ATOMICITY IS ACHIEVED (see DECISIONS.md §1):
 *   better-sqlite3 transactions are synchronous.  SQLite uses a write-ahead
 *   log (WAL) but still grants only ONE exclusive write lock at a time.
 *   The transaction below does a SELECT then UPDATE inside a single
 *   BEGIN EXCLUSIVE block.  Any other process attempting claimJob() at the
 *   same instant will block on the busy_timeout (5 s) and then retry —
 *   by which time the first process has already updated the state to
 *   'processing', so the second process finds no eligible row and returns null.
 *
 * @returns {object|null}  The claimed job row, or null if queue is empty.
 */
function claimJob() {
  const db  = getDb();
  const now = nowIso();

  // db.transaction() compiles a BEGIN IMMEDIATE … COMMIT block.
  // SQLite elevates to EXCLUSIVE on the first write inside the block.
  const claim = db.transaction(() => {
    const job = db.prepare(`
      SELECT * FROM jobs
      WHERE  state IN ('pending', 'failed')
        AND  next_run_at <= ?
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `).get(now);

    if (!job) return null;

    db.prepare(`
      UPDATE jobs
      SET    state = 'processing',
             last_heartbeat = ?,
             updated_at     = ?
      WHERE  id = ?
    `).run(now, now, job.id);

    return { ...job, state: 'processing', last_heartbeat: now };
  });

  return claim();
}

// ─── heartbeat ────────────────────────────────────────────────────────────────

/**
 * Worker calls this every ~5 s while executing a job.
 * Keeps the job "alive" so the crash-recovery watchdog doesn't reclaim it.
 */
function updateHeartbeat(jobId) {
  const db  = getDb();
  const now = nowIso();
  db.prepare(`UPDATE jobs SET last_heartbeat = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, jobId);
}

// ─── complete ─────────────────────────────────────────────────────────────────

function completeJob(jobId, output) {
  const db  = getDb();
  const now = nowIso();
  db.prepare(`
    UPDATE jobs
    SET  state = 'completed', output = ?, updated_at = ?
    WHERE id = ?
  `).run(output || null, now, jobId);
}

// ─── fail ─────────────────────────────────────────────────────────────────────

/**
 * Marks a job as failed.  Increments attempts, applies exponential backoff,
 * and either re-queues it (state='failed') or moves it to DLQ (state='dead').
 */
function failJob(jobId, output) {
  const db   = getDb();
  const now  = nowIso();
  const job  = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return;

  const newAttempts = job.attempts + 1;
  const backoffBase = parseFloat(getConfig('backoff-base') || '2');
  const maxRetries  = job.max_retries;

  if (newAttempts >= maxRetries) {
    // Move to Dead Letter Queue
    db.prepare(`
      UPDATE jobs
      SET  state = 'dead', attempts = ?, output = ?, updated_at = ?
      WHERE id = ?
    `).run(newAttempts, output || null, now, jobId);
  } else {
    // Exponential backoff: delay = base ^ attempts  (attempts is 0-indexed before increment)
    const delaySeconds = Math.pow(backoffBase, newAttempts);
    const nextRunAt    = addSeconds(now, delaySeconds);

    db.prepare(`
      UPDATE jobs
      SET  state = 'failed', attempts = ?, output = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(newAttempts, output || null, nextRunAt, now, jobId);
  }
}

// ─── crash recovery watchdog ──────────────────────────────────────────────────

/**
 * Reclaims any job stuck in 'processing' whose heartbeat is older than
 * the configured heartbeat-timeout (default 30 s).
 *
 * Called at the top of every worker poll loop.  After a SIGKILL the
 * abandoned job will be recovered within one poll interval (1 s) by a
 * surviving worker — well under the 60-second requirement.
 */
function recoverStaleJobs() {
  const db              = getDb();
  const now             = nowIso();
  const timeoutSeconds  = parseInt(getConfig('heartbeat-timeout') || '30', 10);

  // Compute the cutoff: anything with heartbeat older than this is stale
  const cutoff = addSeconds(now, -timeoutSeconds);

  const result = db.prepare(`
    UPDATE jobs
    SET  state = 'pending',
         next_run_at    = ?,
         last_heartbeat = NULL,
         updated_at     = ?
    WHERE state = 'processing'
      AND (last_heartbeat IS NULL OR last_heartbeat < ?)
  `).run(now, now, cutoff);

  return result.changes; // number of jobs recovered
}

// ─── list ─────────────────────────────────────────────────────────────────────

function listJobs(state) {
  const db = getDb();
  if (state) {
    return db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY priority ASC, created_at ASC').all(state);
  }
  return db.prepare('SELECT * FROM jobs ORDER BY priority ASC, created_at ASC').all();
}

function getJob(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function countByState() {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT state, COUNT(*) as count FROM jobs GROUP BY state
  `).all();
  const counts = { pending: 0, processing: 0, completed: 0, failed: 0, dead: 0 };
  for (const r of rows) counts[r.state] = r.count;
  return counts;
}

// ─── DLQ ─────────────────────────────────────────────────────────────────────

function getDLQJobs() {
  const db = getDb();
  return db.prepare(`SELECT * FROM jobs WHERE state = 'dead' ORDER BY updated_at DESC`).all();
}

/**
 * Re-enqueues a dead job.
 * Resets attempts to 0 so it gets a full retry budget again.
 * Rationale: the job was declared permanently failed; giving it a fresh
 * start is the only way an operator can meaningfully retry it.
 * See DECISIONS.md §3 for full justification.
 */
function retryDeadJob(id) {
  const db  = getDb();
  const now = nowIso();
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ? AND state = 'dead'`).get(id);
  if (!job) return null;

  db.prepare(`
    UPDATE jobs
    SET  state = 'pending', attempts = 0, next_run_at = ?, output = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, now, id);

  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

module.exports = {
  enqueueJob,
  claimJob,
  updateHeartbeat,
  completeJob,
  failJob,
  recoverStaleJobs,
  listJobs,
  getJob,
  countByState,
  getDLQJobs,
  retryDeadJob,
};
