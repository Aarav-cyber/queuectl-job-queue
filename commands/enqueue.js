'use strict';
/**
 * commands/enqueue.js
 *
 * queuectl enqueue '<json>'
 *
 * Adds a job to the queue.  The JSON argument must include at minimum
 * a "command" field.  An "id" is auto-generated if not provided.
 */

const { enqueueJob } = require('../lib/queue');

function register(program) {
  program
    .command('enqueue <json>')
    .description('Add a job to the queue')
    .action((jsonStr) => {
      let opts;
      try {
        opts = JSON.parse(jsonStr);
      } catch (err) {
        console.error('Error: Invalid JSON —', err.message);
        process.exit(1);
      }

      if (!opts.command) {
        console.error('Error: Job must include a "command" field');
        process.exit(1);
      }

      try {
        const job = enqueueJob(opts);
        console.log(`Enqueued job ${job.id}`);
        console.log(`  command:     ${job.command}`);
        console.log(`  max_retries: ${job.max_retries}`);
        console.log(`  priority:    ${job.priority}`);
      } catch (err) {
        console.error('Error enqueueing job:', err.message);
        process.exit(1);
      }
    });
}

module.exports = { register };
