/**
 * pm2 configuration.
 *
 * `vesopa_hosting` is a separate process from `vesopa_web` and
 * `vesopa_backoffice`, on its own port behind its own nginx server block. The
 * live box runs a number of unrelated applications under the same account, so
 * every pm2 command must name this app explicitly — never `pm2 restart all`.
 */
module.exports = {
  apps: [
    {
      name: 'vesopa_hosting',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      // fork, not cluster: the rate limiter and the pricing cache are per
      // process, and two workers would each keep their own copy.
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
