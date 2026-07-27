// Documents the exact PM2 configuration this bot's entrypoint behavior was
// verified under. Adopt with:
//   pm2 delete tender-alerts && pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'tender-alerts',
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,      // breathing room: a crash-loop can't spin at ~1s
      max_memory_restart: '750M',
      kill_timeout: 30000,
      time: true,
      env: { NODE_ENV: 'production', TZ: 'Asia/Kolkata' },
    },
  ],
};
