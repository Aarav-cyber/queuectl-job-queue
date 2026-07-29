'use strict';
/**
 * commands/dlq.js
 *
 * queuectl dlq list            — lists all dead jobs
 * queuectl dlq retry <id>      — re-enqueues a dead job (resets attempts to 0)
 */

const { getDLQJobs, retryDeadJob } = require('../lib/queue');

function register(program) {
  const dlqCmd = program
    .command('dlq')
    .description('Dead Letter Queue operations');

  // ── dlq list ────────────────────────────────────────────────────────────────
  dlqCmd
    .command('list')
    .description('List all permanently failed (dead) jobs')
    .option('--json', 'Output as a JSON array')
    .action((opts) => {
      const jobs = getDLQJobs();

      if (opts.json) {
        process.stdout.write(JSON.stringify(jobs, null, 2) + '\n');
        return;
      }

      if (jobs.length === 0) {
        console.log('Dead Letter Queue is empty.');
        return;
      }

      const header = `${'ID'.padEnd(38)} ${'ATTEMPTS'.padEnd(10)} ${'COMMAND'.padEnd(35)} LAST UPDATED`;
      const sep    = '─'.repeat(header.length);

      console.log('\n═══════ Dead Letter Queue ═══════');
      console.log(sep);
      console.log(header);
      console.log(sep);

      for (const job of jobs) {
        const cmd     = job.command.length > 33 ? job.command.substring(0, 30) + '...' : job.command;
        const updated = job.updated_at ? job.updated_at.replace('T', ' ').replace('Z', '') : '';
        console.log(
          `${job.id.padEnd(38)} ${String(job.attempts).padEnd(10)} ${cmd.padEnd(35)} ${updated}`
        );
      }

      console.log(sep);
      console.log(`Total: ${jobs.length} dead job(s)\n`);
      console.log('Tip: use `queuectl dlq retry <id>` to re-enqueue a job\n');
    });

  // ── dlq retry ───────────────────────────────────────────────────────────────
  dlqCmd
    .command('retry <id>')
    .description('Re-enqueue a dead job (resets attempts to 0)')
    .action((id) => {
      const job = retryDeadJob(id);

      if (!job) {
        console.error(`Error: Job "${id}" not found in the Dead Letter Queue.`);
        process.exit(1);
      }

      console.log(`Re-enqueued job ${job.id}`);
      console.log(`  state:   ${job.state}`);
      console.log(`  command: ${job.command}`);
      console.log(`  Note: attempts reset to 0; job will retry up to ${job.max_retries} times`);
    });
}

module.exports = { register };
