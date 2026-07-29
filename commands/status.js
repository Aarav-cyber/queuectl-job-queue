'use strict';
/**
 * commands/status.js
 *
 * queuectl status
 *
 * Displays a summary of:
 *   - Job counts grouped by state
 *   - Active worker PIDs (from the PID file)
 */

const path      = require('path');
const fs        = require('fs');
const { countByState } = require('../lib/queue');
const { DATA_DIR }     = require('../lib/db');

const PID_FILE = path.join(DATA_DIR, 'workers.pid');

function readPids() {
  if (!fs.existsSync(PID_FILE)) return [];
  const content = fs.readFileSync(PID_FILE, 'utf8').trim();
  return content
    ? content.split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = just check existence
    return true;
  } catch (_) {
    return false;
  }
}

function register(program) {
  program
    .command('status')
    .description('Show system status: job counts and active workers')
    .action(() => {
      // ── Job counts ──────────────────────────────────────────────────────────
      const counts = countByState();
      const total  = Object.values(counts).reduce((a, b) => a + b, 0);

      console.log('\n╔══════════════════════════════╗');
      console.log('║        QueueCTL Status       ║');
      console.log('╠══════════════════════════════╣');
      console.log(`║  pending    : ${String(counts.pending).padStart(5)}           ║`);
      console.log(`║  processing : ${String(counts.processing).padStart(5)}           ║`);
      console.log(`║  completed  : ${String(counts.completed).padStart(5)}           ║`);
      console.log(`║  failed     : ${String(counts.failed).padStart(5)}           ║`);
      console.log(`║  dead (DLQ) : ${String(counts.dead).padStart(5)}           ║`);
      console.log('╠══════════════════════════════╣');
      console.log(`║  total      : ${String(total).padStart(5)}           ║`);
      console.log('╠══════════════════════════════╣');

      // ── Workers ─────────────────────────────────────────────────────────────
      const pids   = readPids();
      const active = pids.filter(isAlive);
      const stale  = pids.filter(p => !isAlive(p));

      console.log(`║  workers (active): ${String(active.length).padStart(3)}         ║`);
      if (active.length > 0) {
        console.log(`║    PIDs: ${active.join(', ').substring(0, 20).padEnd(20)} ║`);
      }
      if (stale.length > 0) {
        console.log(`║  stale PIDs: ${stale.length} (not running)   ║`);
      }
      console.log('╚══════════════════════════════╝\n');
    });
}

module.exports = { register };
