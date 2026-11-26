#!/usr/bin/env node
import { BackupError, backupDataDir } from './backup.js';
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
} else if (command === 'backup') {
  // Only the data directory is needed: a backup runs beside the service, without its other settings.
  const target = process.argv[3];
  const dataDir = process.env.ARDENT_STUDIO_DATA ?? '';
  if (!target) {
    process.stderr.write('usage: ardent-studio backup <empty or new directory>  (reads ARDENT_STUDIO_DATA)\n');
    process.exit(64);
  }
  backupDataDir(dataDir, target).then(result => {
    process.stdout.write(`Backed up ${result.database} and ${result.blobs} blobs (${result.bytes} bytes)\n`);
  }, (error: unknown) => {
    process.stderr.write(`Backup failed: ${error instanceof BackupError ? error.message : error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exit(1);
  });
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
  process.stderr.write('usage: ardent-studio [serve | env | version | backup <dir>]\n');
  process.exit(64);
}
