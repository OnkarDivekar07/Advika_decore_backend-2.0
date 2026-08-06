// pm2 process-manager config for production.
//
// Replaces `nodemon` (a dev-only file-watcher/reloader, not a process
// supervisor) as the production start command. pm2 restarts the app if it
// crashes, and forwards SIGTERM/SIGINT to the process so the graceful
// shutdown handling in server.js gets a chance to run before pm2 kills it.
//
// Usage:
//   npm start                 -> pm2-runtime start ecosystem.config.js --env production
//   npx pm2 start ecosystem.config.js   (if running pm2 as a daemon instead of pm2-runtime)
//
// If you're deploying on a platform that already supplies its own process
// supervisor (Render, Railway, Fly.io, ECS, Kubernetes, etc.), you can skip
// pm2 entirely and point the platform's start command at `node server.js`
// directly — the graceful shutdown handling works either way.
module.exports = {
  apps: [
    {
      name: 'backend-2-0',
      script: './server.js',
      instances: process.env.PM2_INSTANCES || 1,
      exec_mode: process.env.PM2_INSTANCES > 1 ? 'cluster' : 'fork',

      // pm2-runtime already runs in the foreground (Docker-friendly); these
      // matter mainly for `pm2 start` (daemon) usage.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',

      // Give in-flight requests / BullMQ jobs a chance to finish inside the
      // SIGTERM handler in server.js before pm2 force-kills the process.
      kill_timeout: 10000,

      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
