'use strict';
/**
 * commands/worker.js
 *
 * queuectl worker start [--count N]
 *   Spawns N worker-runner processes in the foreground.
 *   Blocks until all workers exit (e.g., after Ctrl+C).
 *
 * queuectl worker stop
 *   Reads the PID file and sends SIGTERM to all registered worker PIDs.
 *   This works cross-terminal / cross-process.
 *
 * DESIGN: Worker-stop uses a PID file instead of a daemon/socket because:
 *   - It requires no persistent daemon process
 *   - PIDs are available across all terminals
 *   - SIGTERM is the POSIX-standard graceful shutdown signal
 *   See DECISIONS.md §4 for rejected alternatives.
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const { DATA_DIR } = require('../lib/db');

const PID_FILE       = path.join(DATA_DIR, 'workers.pid');
const WORKER_SCRIPT  = path.join(__dirname, '..', 'lib', 'worker-runner.js');

// ─── helpers ──────────────────────────────────────────────────────────────────

function readPids() {
  if (!fs.existsSync(PID_FILE)) return [];
  const content = fs.readFileSync(PID_FILE, 'utf8').trim();
  return content
    ? content.split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];
}

// ─── register ─────────────────────────────────────────────────────────────────

function register(program) {
  const workerCmd = program
    .command('worker')
    .description('Manage workers');

  // ── worker start ────────────────────────────────────────────────────────────
  workerCmd
    .command('start')
    .description('Start worker processes in the foreground')
    .option('--count <n>', 'Number of parallel workers', '1')
    .action((opts) => {
      const count = Math.max(1, parseInt(opts.count, 10) || 1);
      console.log(`Starting ${count} worker(s)...`);

      const children = [];

      for (let i = 0; i < count; i++) {
        const worker = spawn(process.execPath, [WORKER_SCRIPT], {
          stdio: 'inherit',
          env:   { ...process.env, WORKER_ID: `worker-${i + 1}` },
        });
        children.push(worker);
      }

      // Track how many are still alive
      let alive = children.length;

      for (const child of children) {
        child.on('exit', (code, signal) => {
          alive--;
          if (alive === 0) {
            process.exit(0);
          }
        });
        child.on('error', (err) => {
          console.error('Worker spawn error:', err.message);
        });
      }

      // Propagate Ctrl+C / SIGTERM to all children (graceful shutdown)
      const propagate = (signal) => {
        console.log(`\nReceived ${signal}, forwarding to ${children.length} worker(s)...`);
        for (const child of children) {
          try { child.kill(signal); } catch (_) {}
        }
      };

      process.on('SIGINT',  () => propagate('SIGTERM'));
      process.on('SIGTERM', () => propagate('SIGTERM'));
    });

  // ── worker stop ─────────────────────────────────────────────────────────────
  workerCmd
    .command('stop')
    .description('Gracefully stop all running workers (from any terminal)')
    .action(() => {
      const pids = readPids();

      if (pids.length === 0) {
        console.log('No running workers found (PID file is empty or missing).');
        return;
      }

      let stopped = 0;
      let notFound = 0;

      for (const pid of pids) {
        try {
          // process.kill with SIGTERM on the PID — works cross-process/terminal
          process.kill(pid, 'SIGTERM');
          console.log(`Sent SIGTERM to worker PID ${pid}`);
          stopped++;
        } catch (err) {
          if (err.code === 'ESRCH') {
            // Process already dead
            console.log(`Worker PID ${pid} is no longer running`);
            notFound++;
          } else {
            console.error(`Failed to signal PID ${pid}: ${err.message}`);
          }
        }
      }

      console.log(`\nSignalled ${stopped} worker(s). ${notFound} PID(s) were already gone.`);
      console.log('Workers will finish their current jobs and exit gracefully.');
    });
}

module.exports = { register };
