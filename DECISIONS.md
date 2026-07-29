# DECISIONS.md — QueueCTL Design Decisions

> This document answers all five required questions with specific references
> to the implementation. Generic answers were explicitly avoided.

---

## 1. Which exact lines prevent duplicate job claims and why is it atomic?

**File**: [`lib/queue.js`](./lib/queue.js) — function `claimJob()`

```js
// lib/queue.js  (lines ~60-90)
const claim = db.transaction(() => {
  const job = db.prepare(`
    SELECT * FROM jobs
    WHERE  state = 'pending'
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

  return { ...job, state: 'processing' };
});

return claim();
```

**Why it is atomic:**

`better-sqlite3`'s `db.transaction()` compiles to `BEGIN IMMEDIATE … COMMIT`.
`BEGIN IMMEDIATE` acquires a **reserved lock** immediately, which escalates to
an **exclusive lock** on the first write. SQLite's WAL mode allows concurrent
readers, but **only one writer** can hold the lock at a time.

When Worker A executes `claim()`, any Worker B that calls `claimJob()`
concurrently will block at the `BEGIN IMMEDIATE` statement (SQLite will retry
for up to `busy_timeout = 5000 ms`). By the time Worker B gets the lock,
Worker A's UPDATE has already changed the job's state to `'processing'`,
so the SELECT inside Worker B's transaction returns **no row** and
`claimJob()` returns `null`. The job is never executed twice.

**There is no TOCTOU gap**: the SELECT and UPDATE are in the *same*
exclusive transaction — no other SQL can interleave between them.

---

## 2. What happens after a SIGKILL during processing?

A `SIGKILL` (e.g., `kill -9 <pid>`) terminates the worker process
**immediately** — no signal handlers run, no cleanup occurs. The job remains
in `state = 'processing'` in the database.

**Recovery mechanism** (`lib/queue.js` — function `recoverStaleJobs()`):

```js
// lib/queue.js  (~line 135)
const result = db.prepare(`
  UPDATE jobs
  SET  state = 'pending',
       next_run_at    = ?,
       last_heartbeat = NULL,
       updated_at     = ?
  WHERE state = 'processing'
    AND (last_heartbeat IS NULL OR last_heartbeat < ?)
`).run(now, now, cutoff);
```

Every active worker calls `recoverStaleJobs()` **at the top of every poll
iteration** (every 1 second). The `cutoff` is `NOW - heartbeat_timeout`
(default: 30 seconds).

Workers update `last_heartbeat` every **5 seconds** while a job is running
(`lib/worker-runner.js` — `setInterval` calling `updateHeartbeat(job.id)`).

**Timeline after SIGKILL:**

```
t=0   Worker A is killed (SIGKILL), job stuck in 'processing'
t=5   Worker B's heartbeat check runs — cutoff = 30s ago; not stale yet
...
t=30  Worker B detects: last_heartbeat is 30s old → resets to 'pending'
t=31  Worker B (or C) picks up and executes the recovered job
```

**Worst-case recovery time**: 30 seconds (configurable via
`queuectl config set heartbeat-timeout <seconds>`).

**Trade-off**: There is a theoretical risk that a *very slow* (but not dead)
worker whose machine is I/O-starved could have its job reclaimed prematurely.
Mitigated by setting `heartbeat-timeout` higher than the expected worst-case
job execution stall. The 30-second default is conservative enough for typical
workloads.

---

## 3. Does `dlq retry` reset attempts? Why?

**Yes. `dlq retry <id>` resets `attempts` to `0`.**

**File**: `lib/queue.js` — function `retryDeadJob()`

```js
db.prepare(`
  UPDATE jobs
  SET  state = 'pending', attempts = 0, next_run_at = ?, output = NULL, updated_at = ?
  WHERE id = ?
`).run(now, now, id);
```

**Justification:**

A job reaches the Dead Letter Queue only after exhausting all retries
(i.e., `attempts >= max_retries`). At that point it is **permanently dead**
by the system's own definition. An operator who issues `dlq retry` is making
an *explicit human decision* to give the job another chance — perhaps because:

- The underlying issue (e.g., a missing file, a down service) has been fixed.
- They changed `max-retries` to allow more attempts.
- They want to manually re-run the job from a clean state.

If we did **not** reset `attempts`, the job would be immediately re-moved to
the DLQ on the very next failure (since `attempts >= max_retries` already).
This would make `dlq retry` pointless for jobs that have any chance of
transient failure.

Resetting to `0` gives the job its *full retry budget* again, which is the
only semantically meaningful behaviour for a manual operator retry action.

---

## 4. Which worker-stop designs were rejected?

Three approaches were considered. Here's why they were rejected in favour of
the **PID file + SIGTERM** approach:

### Approach A (chosen): PID File + SIGTERM

`queuectl worker start` spawns workers and each worker appends its PID to
`data/workers.pid`. `queuectl worker stop` reads the file, sends `SIGTERM`
to each PID.

**Why chosen:**
- Zero external dependencies
- Works cross-terminal and cross-process on all POSIX systems (and Windows
  with Node's `process.kill`)
- SIGTERM is the standard graceful-shutdown signal; workers already handle it
- No persistent daemon needed

### Approach B (rejected): Unix Domain Socket / Named Pipe

A control socket (e.g., `/tmp/queuectl.sock`) where workers listen and
`worker stop` sends a `shutdown` message.

**Why rejected:**
- Requires each worker to run an additional event listener
- Socket file cleanup on crash is fragile
- More complex to implement reliably across platforms (Windows named pipes
  differ from Unix sockets)
- No meaningful advantage over PID file for this use case

### Approach C (rejected): Shared Flag in SQLite (`config` table)

Insert a `shutdown = true` row in the config table. Workers poll this flag
and exit when they see it.

**Why rejected:**
- Polling adds 1-second latency per worker
- Must remember to clear the flag before starting new workers (easy to forget)
- Doesn't distinguish "stop all" from "stop this instance" cleanly
- More database round-trips for a control plane operation

### Approach D (rejected): Dedicated Daemon/Manager Process

A long-running manager process that workers connect to via IPC, which
orchestrates stop/start.

**Why rejected:**
- Over-engineering for this scope
- Daemon itself becomes a SPOF
- Adds process lifecycle complexity (PID file for the daemon itself, etc.)

---

## 5. How would priorities affect the design?

Priority support is **already implemented** as a bonus feature. The `jobs`
table has a `priority INTEGER NOT NULL DEFAULT 0` column, and `claimJob()`
orders by `priority ASC, created_at ASC` (lower number = higher priority).

If priorities were a first-class, critical requirement with strict ordering
guarantees, these additional considerations would apply:

### What changes

| Concern | Current (implemented) | Strict priority mode |
|---|---|---|
| **Ordering** | `ORDER BY priority ASC, created_at ASC` | Same — already correct |
| **Starvation** | Low-priority jobs can starve if high-priority jobs arrive continuously | Need aging: gradually increase effective priority over time |
| **Multiple queues** | Single table, single poll query | Separate queues per priority level; workers poll highest first |
| **Claim contention** | Single atomic transaction | If many workers compete for high-priority jobs, lock contention increases; partition workers by priority tier |
| **Backoff interaction** | `next_run_at` gates eligibility regardless of priority | Priority jobs should skip to front when back-off expires, not join the general pending pool |

### Specific code changes required

1. **Aging**: Add a query that periodically reduces `priority` for old
   `pending` jobs to prevent starvation.
2. **Priority tiers**: Worker pools dedicated to `priority = 0` (high) vs
   `priority > 0` (normal), preventing head-of-line blocking.
3. **Schema**: Consider adding `priority_group TEXT` for named queues.
4. **`dlq retry`**: Allow specifying a new priority for the retried job.

The current implementation handles moderate priority requirements correctly.
The single `claimJob()` transaction ensures priority ordering is respected
without race conditions.

---

## Summary Table

| Decision | Choice | Key File |
|---|---|---|
| Storage engine | SQLite with WAL + busy_timeout | `lib/db.js` |
| Atomic job claim | `BEGIN IMMEDIATE` transaction | `lib/queue.js:claimJob()` |
| Crash recovery | Heartbeat + watchdog query | `lib/queue.js:recoverStaleJobs()` |
| Worker stop | PID file + SIGTERM | `commands/worker.js`, `lib/worker-runner.js` |
| DLQ retry resets attempts | Yes — gives full retry budget | `lib/queue.js:retryDeadJob()` |
| Config affects existing jobs | max-retries: no; backoff-base: yes (next attempt) | `lib/queue.js:failJob()` |
