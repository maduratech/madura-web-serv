/**
 * PM2 production config for madura-web-serv.
 *
 * Deploy:
 *   npm ci --omit=dev
 *   npm run build
 *   pm2 start ecosystem.config.cjs   # first time
 *   pm2 reload ecosystem.config.cjs --update-env   # subsequent deploys
 *   pm2 save
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'madura-web-serv',
      cwd: __dirname,
      script: 'dist/server.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      node_args: '--max-old-space-size=384',
      env: {
        NODE_ENV: 'production',
      },
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
    },
  ],
};
