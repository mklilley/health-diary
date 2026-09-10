// Run PM2 as the same unprivileged account used by the systemd jobs.
// The app loads .env itself; secrets are deliberately absent from PM2's config.
module.exports = {
  apps: [{
    name: 'health-diary-bot',
    cwd: __dirname,
    script: 'src/bot/bot.js',
    interpreter: process.execPath,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    min_uptime: '10s',
    max_restarts: 20,
    exp_backoff_restart_delay: 1000,
    kill_timeout: 180000,
    max_memory_restart: '512M',
    time: true,
    env: { NODE_ENV: 'production', TZ: 'Europe/London' },
  }],
};
