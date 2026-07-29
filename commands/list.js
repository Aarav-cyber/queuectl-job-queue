'use strict';
/**
 * commands/list.js
 *
 * queuectl list [--state <state>] [--json]
 *
 * Lists jobs, optionally filtered by state.
 * With --json: outputs ONLY a JSON array to stdout (spec requirement).
 */

const { listJobs } = require('../lib/queue');

const VALID_STATES = ['pending', 'processing', 'completed', 'failed', 'dead'];

function register(program) {
  program
    .command('list')
    .description('List jobs, optionally filtered by state')
    .option('--state <state>', `Filter by state (${VALID_STATES.join('|')})`)
    .option('--json', 'Output as a JSON array (stdout only)')
    .action((opts) => {
      const { state, json: asJson } = opts;

      if (state && !VALID_STATES.includes(state)) {
        console.error(`Error: Invalid state "${state}". Valid: ${VALID_STATES.join(', ')}`);
        process.exit(1);
      }

      const jobs = listJobs(state || null);

      if (asJson) {
        // SPEC: must print ONLY a JSON array to stdout
        process.stdout.write(JSON.stringify(jobs, null, 2) + '\n');
        return;
      }

      // Human-readable table
      if (jobs.length === 0) {
        console.log(state ? `No jobs with state "${state}".` : 'No jobs found.');
        return;
      }

      const header = `${'ID'.padEnd(38)} ${'STATE'.padEnd(12)} ${'ATTEMPTS'.padEnd(9)} ${'COMMAND'.padEnd(35)} CREATED`;
      const sep    = '─'.repeat(header.length);

      console.log('\n' + sep);
      console.log(header);
      console.log(sep);

      for (const job of jobs) {
        const cmd     = job.command.length > 33 ? job.command.substring(0, 30) + '...' : job.command;
        const created = job.created_at ? job.created_at.replace('T', ' ').replace('Z', '') : '';
        console.log(
          `${job.id.padEnd(38)} ${job.state.padEnd(12)} ${String(job.attempts).padEnd(9)} ${cmd.padEnd(35)} ${created}`
        );
      }

      console.log(sep);
      console.log(`Total: ${jobs.length} job(s)${state ? ` in state "${state}"` : ''}\n`);
    });
}

module.exports = { register };
