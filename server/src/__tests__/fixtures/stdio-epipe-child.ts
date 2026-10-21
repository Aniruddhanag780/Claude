// Child process for lib/stdio-epipe-loop.test.ts. Boots the same three pieces
// index.ts installs before anything else logs (console redaction + its
// server_logs tap, the process safety net, the DB), then logs a warn on a
// timer the way the health checker does. The parent closes our stdout/stderr
// after "child ready", so every later console write hits a dead pipe.
import { installLogRedaction } from '../../lib/log-redaction.js';
import { installProcessSafetyNet } from '../../lib/process-safety-net.js';
import { initDb } from '../../db/index.js';

installLogRedaction();
installProcessSafetyNet();
// PG: connect via the DATABASE_URL the parent test process exported (its
// per-test clone) — there is no database file to pass on the command line.
await initDb();
console.log('child ready');
setInterval(() => console.warn('[fixture] periodic warn'), 500);
