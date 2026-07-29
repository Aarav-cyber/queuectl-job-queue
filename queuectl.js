#!/usr/bin/env node
'use strict';
/**
 * queuectl.js — CLI entry point
 *
 * Registers all sub-commands and delegates to commander.
 */

const { Command } = require('commander');
const program     = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue system')
  .version('1.0.0');

// Register sub-commands
require('./commands/enqueue').register(program);
require('./commands/worker').register(program);
require('./commands/status').register(program);
require('./commands/list').register(program);
require('./commands/dlq').register(program);
require('./commands/config').register(program);

// Parse and dispatch
program.parseAsync(process.argv).catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
