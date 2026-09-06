import { ConfigError, loadConfig } from './config';
import { createPoller } from './poller';
import { startServer } from './server';

function load() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // One line, no stack: this is a setup mistake, not a bug.
      console.error(`[pkvw-trkr] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const cfg = load();

createPoller(cfg).start();

const server = startServer(cfg);
console.log(
  `[pkvw-trkr] listening on http://${server.hostname}:${server.port} ` +
    `(window ${cfg.window.startHour}:00-${cfg.window.endHour}:00 ${cfg.timezone}, ` +
    `refresh ${cfg.refreshMs / 1000}s)`,
);
