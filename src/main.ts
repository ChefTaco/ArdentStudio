#!/usr/bin/env node
import { ConfigError, ENV_CATALOG, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createService, listen, shutdown } from './service.js';
import { VERSION } from './version.js';

const command = process.argv[2] ?? 'serve';

if (command === 'version' || command === '--version') {
  process.stdout.write(`${VERSION}\n`);
} else if (command === 'env') {
  // Names and descriptions only; values are never printed.
  process.stdout.write(ENV_CATALOG.map(entry => `${entry.name}\t${entry.required ? 'required' : 'optional'}${entry.secret ? '\tsecret' : ''}\t${entry.description}\n`).join(''));
} else if (command === 'serve') {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : 'Configuration could not be read'}\n`);
    process.exit(78);
  }
  const logger = createLogger(config.logLevel);
  const service = createService(config, { logger });
  service.start();
  const server = listen(service, config, logger);
  let stopping = false;
  const onSignal = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });
    shutdown(service, server, logger).then(() => process.exit(0), error => {
      logger.error('Shutdown failed', { error: error instanceof Error ? error.message : 'unknown' });
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
} else {
  process.stderr.write('usage: ardent-studio [serve | env | version]\n');
  process.exit(64);
}
