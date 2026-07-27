// Executable wrapper ONLY — PM2's script path and `npm run once` target.
// All logic (and all exports for tests) lives in app.js. This file is never
// imported by anything, so main() runs unconditionally: immune to both the
// PM2 fork-wrapper argv quirk (which broke the old argv guard: 22k silent
// restarts) and any test-runner environment coupling.
import { main } from './app.js';

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
