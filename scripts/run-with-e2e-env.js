// scripts/run-with-e2e-env.js
//
// Loads .env.e2e into process.env, then spawns the given command with that
// env — used by package.json's e2e:* scripts so they work identically on
// Windows/macOS/Linux without needing a cross-env-style dependency (`set
// VAR=x&&cmd` vs `VAR=x cmd` aren't portable; spawning a child process with
// an explicit `env` object is).
//
// Usage: node scripts/run-with-e2e-env.js <command> [...args]
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const parsed = dotenv.parse(
  require('fs').readFileSync(path.join(__dirname, '..', '.env.e2e'))
);

const [command, ...args] = process.argv.slice(2);
const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: true,
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, ...parsed },
});

process.exit(result.status ?? 1);
