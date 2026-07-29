'use strict';
/**
 * commands/config.js
 *
 * queuectl config set <key> <value>   — persists a config value
 * queuectl config get <key>           — prints a config value
 * queuectl config list                — prints all config key/values
 *
 * Supported keys (all configurable at runtime):
 *   max-retries       — default number of retries for new jobs
 *   backoff-base      — base for exponential backoff (delay = base ^ attempts)
 *   heartbeat-timeout — seconds before a processing job is considered stale
 */

const { getConfig, setConfig, getAllConfig } = require('../lib/config-store');

const KNOWN_KEYS = {
  'max-retries':       'Default max retries for new jobs (integer)',
  'backoff-base':      'Backoff base (delay = base ^ attempts, in seconds)',
  'heartbeat-timeout': 'Seconds before a stale processing job is recovered (default 30)',
};

function register(program) {
  const configCmd = program
    .command('config')
    .description('Manage runtime configuration');

  // ── config set ──────────────────────────────────────────────────────────────
  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action((key, value) => {
      if (!KNOWN_KEYS[key]) {
        console.warn(`Warning: "${key}" is not a known config key.`);
        console.warn(`Known keys: ${Object.keys(KNOWN_KEYS).join(', ')}`);
      }

      // Basic validation
      const numVal = parseFloat(value);
      if (isNaN(numVal) || numVal <= 0) {
        console.error(`Error: Value must be a positive number (got "${value}")`);
        process.exit(1);
      }

      setConfig(key, value);
      console.log(`Config updated: ${key} = ${value}`);

      if (key === 'max-retries') {
        console.log('  Note: this only applies to newly enqueued jobs, not existing ones.');
      }
      if (key === 'backoff-base') {
        console.log('  Note: affects the next retry attempt of existing failed jobs.');
      }
    });

  // ── config get ──────────────────────────────────────────────────────────────
  configCmd
    .command('get <key>')
    .description('Get a configuration value')
    .action((key) => {
      const value = getConfig(key);
      if (value === null) {
        console.error(`Config key "${key}" not found.`);
        process.exit(1);
      }
      console.log(`${key} = ${value}`);
    });

  // ── config list ─────────────────────────────────────────────────────────────
  configCmd
    .command('list')
    .description('List all configuration values')
    .action(() => {
      const rows = getAllConfig();
      console.log('\nConfiguration:');
      console.log('─'.repeat(40));
      for (const row of rows) {
        const desc = KNOWN_KEYS[row.key] ? `  (${KNOWN_KEYS[row.key]})` : '';
        console.log(`  ${row.key.padEnd(22)} = ${row.value}${desc}`);
      }
      console.log('─'.repeat(40) + '\n');
    });
}

module.exports = { register };
