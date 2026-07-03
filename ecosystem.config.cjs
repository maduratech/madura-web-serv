/**
 * PM2 production config for madura-web-serv.
 *
 * Deploy on the VPS:
 *   npm run deploy
 *
 * Or manually:
 *   npm ci && npm run build && npm prune --omit=dev
 *   pm2 start ecosystem.config.cjs   # first time
 *   pm2 reload ecosystem.config.cjs --update-env
 *   pm2 save
 *
 * Do NOT run `npm ci --omit=dev` before `npm run build` — TypeScript is a devDependency.
 */
const path = require("path");

module.exports = {
  apps: [
    {
      name: "madura-web-serv",
      cwd: __dirname,
      script: "dist/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1200M",
      node_args: "--max-old-space-size=1024",
      env: {
        NODE_ENV: "production",
      },
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(__dirname, "logs", "pm2-error.log"),
      out_file: path.join(__dirname, "logs", "pm2-out.log"),
    },
  ],
};
