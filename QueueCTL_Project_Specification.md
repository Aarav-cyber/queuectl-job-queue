# QueueCTL --- Backend Developer Internship Assignment

> This document is a project specification extracted and organized from
> the provided assignment PDF. It preserves the original requirements
> and constraints while presenting them as a developer-friendly
> implementation guide.

------------------------------------------------------------------------

# Objective

Build a **CLI-based background job queue system** called **QueueCTL**.

The system must:

-   Manage background jobs
-   Execute jobs using worker processes
-   Retry failed jobs using exponential backoff
-   Move permanently failed jobs into a Dead Letter Queue (DLQ)
-   Persist data across crashes and restarts
-   Operate entirely through a CLI

> Evaluation consists of both the implementation and a live review. You
> may use AI tools, but you must be able to explain, defend, modify, and
> debug every part of your implementation.

------------------------------------------------------------------------

# Allowed Tech Stack

Choose any one:

-   Python
-   Go
-   Node.js
-   Java

Submission:

-   Public GitHub repository
-   README.md
-   DECISIONS.md
-   Demo recording
-   Live review session

------------------------------------------------------------------------

# Core Features

The system must support:

-   Enqueuing jobs
-   Background workers
-   Multiple workers running in parallel
-   Automatic retry
-   Exponential backoff
-   Dead Letter Queue (DLQ)
-   Persistent storage
-   CLI interface
-   Crash recovery

------------------------------------------------------------------------

# Job Schema

Every job must contain at least:

``` json
{
  "id": "unique-job-id",
  "command": "echo 'Hello World'",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2025-11-04T10:30:00Z",
  "updated_at": "2025-11-04T10:30:00Z"
}
```

------------------------------------------------------------------------

# Job States

  State        Description
  ------------ -------------------------------------
  pending      Waiting to be picked up by a worker
  processing   Currently executing
  completed    Successfully executed
  failed       Failed but retryable after backoff
  dead         Permanently failed (DLQ)

------------------------------------------------------------------------

# Crash Recovery Requirement

A job must **never remain permanently in `processing`**.

If a worker is killed (including SIGKILL):

-   The system must detect the abandoned job.
-   Recover it automatically.
-   Make it executable again.
-   Worst-case recovery time must be **under 60 seconds**.

Explain the recovery mechanism and trade-offs in **DECISIONS.md**.

------------------------------------------------------------------------

# CLI Commands

## Enqueue

``` bash
queuectl enqueue '{"id":"job1","command":"sleep 2"}'
```

Adds a job.

------------------------------------------------------------------------

## Start Workers

``` bash
queuectl worker start --count 3
```

Runs workers in the foreground.

------------------------------------------------------------------------

## Stop Workers

``` bash
queuectl worker stop
```

Must gracefully stop workers from another terminal.

------------------------------------------------------------------------

## Status

``` bash
queuectl status
```

Displays summary of jobs and active workers.

------------------------------------------------------------------------

## List Jobs

``` bash
queuectl list --state pending
queuectl list --state pending --json
```

The `--json` output must print **only a JSON array** to stdout.

------------------------------------------------------------------------

## Dead Letter Queue

``` bash
queuectl dlq list

queuectl dlq retry job1
```

------------------------------------------------------------------------

## Config

``` bash
queuectl config set max-retries 3
```

Manage runtime configuration.

------------------------------------------------------------------------

# Interface Contract (Mandatory)

Your implementation **must exactly follow** these behaviors:

1.  `worker start`
    -   Runs in foreground.
    -   Ctrl+C (SIGINT/SIGTERM):
        -   Finish current job.
        -   Exit gracefully.
    -   SIGKILL simulates crash.
2.  `queuectl list --state <state> --json`
    -   Outputs **only** a JSON array.
3.  `worker stop`
    -   Must work from another terminal.
    -   Cross-process communication mechanism is your design decision.
    -   Explain chosen and rejected approaches in `DECISIONS.md`.

------------------------------------------------------------------------

# System Requirements

## 1. Job Execution

-   Execute jobs using the shell.
-   Exit code 0 = success.
-   Non-zero = failure.
-   Command-not-found counts as failure.

------------------------------------------------------------------------

## 2. Retry & Backoff

Retry delay:

    delay = base ^ attempts

Example (base = 2):

-   Retry 1 → 2 seconds
-   Retry 2 → 4 seconds
-   Retry 3 → 8 seconds

Requirements:

-   Default base = 2
-   Configurable using:

``` bash
queuectl config set backoff-base
```

After max retries:

    dead

`dlq retry <id>` must re-enqueue a dead job.

Document whether retry resets attempts and justify it.

------------------------------------------------------------------------

## 3. Persistence

All data must survive:

-   Restart
-   Crash
-   Process termination

Any persistent storage is acceptable provided locking guarantees remain
valid.

------------------------------------------------------------------------

## 4. Worker Management & Concurrency

Requirements:

-   Multiple workers
-   Separate OS processes
-   Separate terminal sessions

Guarantees:

-   One job can never execute twice simultaneously.
-   Claiming a job must be atomic across processes.

In `DECISIONS.md`, point to the exact lines implementing atomic
claiming.

Graceful shutdown:

-   Finish in-flight job.
-   Exit.

------------------------------------------------------------------------

## 5. Configuration

Configuration must persist.

Configurable values:

-   Retry count
-   Backoff base

Document whether changing configuration affects existing queued jobs.

------------------------------------------------------------------------

# Automated Test Scenarios

The interviewer will run automated tests covering:

1.  Basic job completes.
2.  Failed job retries and moves to DLQ.
3.  Many jobs across multiple workers; every job executes exactly once.
4.  Worker receives SIGKILL mid-job; jobs recover automatically.
5.  Jobs survive complete restart.

Scenarios 1--3 are mandatory. Failure ends the interview.

------------------------------------------------------------------------

# Required Deliverables

-   Working QueueCTL CLI
-   Persistent storage
-   Retry & backoff
-   DLQ
-   Crash recovery
-   README.md
-   DECISIONS.md
-   Incremental Git history
-   Demo recording

------------------------------------------------------------------------

# DECISIONS.md Must Answer

1.  Which exact lines prevent duplicate job claims and why is it atomic?
2.  What happens after a SIGKILL during processing?
3.  Does `dlq retry` reset attempts? Why?
4.  Which worker-stop designs were rejected?
5.  How would priorities affect the design?

Generic answers receive zero credit.

------------------------------------------------------------------------

# Live Review

Approximately 30 minutes.

## Automated Test (\~10 min)

Your CLI is executed.

## Design Defense (\~10 min)

Explain architecture and edge cases.

## Live Coding (\~10 min)

Modify your implementation.

A follow-up requirement may also be sent after submission.

------------------------------------------------------------------------

# Evaluation

  Category             Weight
  -------------------- --------
  Automated Test       Gate
  Functionality        20%
  Robustness           20%
  Live Review          30%
  Code Quality         15%
  README + DECISIONS   15%

------------------------------------------------------------------------

# Bonus Features

Optional:

-   Job timeouts
-   Priority queue
-   Scheduled jobs (`run_at`)
-   Job output logging
-   Metrics
-   Minimal dashboard

------------------------------------------------------------------------

# Disqualification Conditions

-   Fails automated scenarios 1--3
-   Duplicate job execution
-   Jobs lost after restart
-   Jobs stuck forever in processing
-   Cannot explain implementation
-   Missing README.md
-   Missing DECISIONS.md
-   Generic DECISIONS.md answers

------------------------------------------------------------------------

# Submission Checklist

-   Public GitHub repository
-   Incremental commit history
-   README.md
-   DECISIONS.md
-   Demo recording link
-   Repository submitted for review

------------------------------------------------------------------------
