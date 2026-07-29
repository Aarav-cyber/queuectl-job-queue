# QueueCTL

A **CLI-based background job queue system** built with Node.js and SQLite.

Features:
- Persistent job queue with SQLite (WAL mode)
- Multiple parallel worker processes
- Exponential backoff retry
- Dead Letter Queue (DLQ)
- Crash recovery via heartbeat watchdog
- Cross-terminal graceful worker shutdown

---

## Requirements

- Node.js ≥ 18
- npm

---

## Installation

```bash
cd /path/to/queuectl
npm install
npm link        # makes `queuectl` available globally
```

> **Windows users**: If `npm link` requires admin rights, run PowerShell as Administrator, or use `node queuectl.js` directly.

---

## Quick Start

### 1. Enqueue a job

```bash
queuectl enqueue '{"command":"echo Hello World"}'

# With a custom ID
queuectl enqueue '{"id":"job1","command":"sleep 2"}'

# With custom retries and priority
queuectl enqueue '{"command":"false","max_retries":5,"priority":1}'
```

### 2. Start workers

```bash
# Single worker
queuectl worker start

# 3 parallel workers
queuectl worker start --count 3
```

Workers run in the **foreground**. Press `Ctrl+C` to trigger graceful shutdown (they finish the current job first).

### 3. Stop workers (from another terminal)

```bash
queuectl worker stop
```

### 4. Check status

```bash
queuectl status
```

### 5. List jobs

```bash
queuectl list
queuectl list --state pending
queuectl list --state completed --json    # prints only a JSON array
```

### 6. Dead Letter Queue

```bash
queuectl dlq list                 # list permanently failed jobs
queuectl dlq retry <job-id>       # re-enqueue a dead job
```

### 7. Configuration

```bash
queuectl config set max-retries 5
queuectl config set backoff-base 3
queuectl config set heartbeat-timeout 30
queuectl config get max-retries
queuectl config list
```

---

## Job Schema

```json
{
  "id": "unique-job-id",
  "command": "echo 'Hello World'",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "priority": 0,
  "timeout": null,
  "created_at": "2025-11-04T10:30:00Z",
  "updated_at": "2025-11-04T10:30:00Z"
}
```

### Job States

| State        | Description                              |
|-------------|------------------------------------------|
| `pending`    | Waiting to be picked up by a worker      |
| `processing` | Currently executing                      |
| `completed`  | Successfully executed (exit code 0)      |
| `failed`     | Failed, retryable after backoff delay    |
| `dead`       | Permanently failed — moved to DLQ        |

---

## Retry & Backoff

Retry delay formula:

```
delay = backoff_base ^ attempts   (seconds)
```

With default `backoff_base = 2`:

| Retry | Delay    |
|-------|----------|
| 1st   | 2 seconds  |
| 2nd   | 4 seconds  |
| 3rd   | 8 seconds  |

After `max_retries` failures, the job moves to the **Dead Letter Queue** (`state = dead`).

---

## Crash Recovery

Workers update a `last_heartbeat` timestamp in the DB every **5 seconds** while executing a job.

Every poll cycle, each worker runs a watchdog query:

```sql
UPDATE jobs
SET state = 'pending'
WHERE state = 'processing'
  AND last_heartbeat < (NOW - heartbeat_timeout)
```

After a `SIGKILL`, the abandoned job is recovered within **≤30 seconds** by any surviving worker.

---

## Architecture

```
queuectl (CLI)
├── commands/
│   ├── enqueue.js       – add job to DB
│   ├── worker.js        – start N workers / stop via PID file
│   ├── status.js        – show job counts + active workers
│   ├── list.js          – list jobs by state
│   ├── dlq.js           – DLQ list/retry
│   └── config.js        – get/set runtime config
├── lib/
│   ├── db.js            – SQLite connection + schema init
│   ├── queue.js         – atomic claim, CRUD, crash recovery
│   ├── worker-runner.js – worker loop (spawned per worker)
│   └── config-store.js  – persistent config read/write
└── data/
    ├── queue.db         – SQLite database
    └── workers.pid      – active worker PIDs
```

---

## Persistence

All data is stored in `data/queue.db` (SQLite). The database survives:
- Process restarts
- Worker crashes
- System reboots (if the data directory is preserved)

---

## Bonus Features

- **Priority queue**: Set `priority` field (lower = runs first, default 0)
- **Job timeouts**: Set `timeout` field (seconds); worker kills the job if exceeded
- **Job output logging**: stdout/stderr captured and stored in `jobs.output` column

---

## Automated Test Scenarios

### 1. Basic job completes
```bash
queuectl enqueue '{"id":"t1","command":"echo hello"}'
queuectl worker start &
sleep 3 && queuectl list --state completed --json
```

### 2. Failed job retries and moves to DLQ
```bash
queuectl enqueue '{"id":"t2","command":"false","max_retries":3}'
queuectl worker start
# After 2+4+8 = 14s, job should be in DLQ
queuectl dlq list
```

### 3. Many jobs, multiple workers, exactly-once execution
```bash
for i in $(seq 1 10); do queuectl enqueue "{\"command\":\"echo job-$i\"}"; done
queuectl worker start --count 3
# Wait for completion
queuectl list --state completed --json | jq length   # should be 10
```

### 4. Worker SIGKILL recovery
```bash
queuectl enqueue '{"id":"long","command":"sleep 60"}'
queuectl worker start &
WORKER_PID=$!
sleep 2
kill -9 $WORKER_PID
# Start a second worker and watch it recover the job
queuectl worker start
```

### 5. Jobs survive restart
```bash
queuectl enqueue '{"id":"persist","command":"echo survived"}'
# Kill everything, restart
queuectl worker start
queuectl list --state completed
```

---

## License

MIT
