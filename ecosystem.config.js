// PM2 - rulare permanenta pe VPS/hosting cu Node
// pm2 start ecosystem.config.js && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'instagram-bot',
      script: 'instagram-bot.js',
      args: '--headless --auto',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      time: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
