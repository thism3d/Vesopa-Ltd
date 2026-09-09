/**
 * pm2 configuration for vesopa_auth (auth.vesopa.com).
 *
 * THIS BOX RUNS SEVERAL UNRELATED APPLICATIONS UNDER THE SAME HESTIA ACCOUNT.
 * cloud.vesopa.com is live on the same user. Every pm2 command must name this
 * app explicitly:
 *
 *     pm2 restart auth.vesopa.com     <- always
 *     pm2 restart all                 <- never, on this box
 *
 * And pm2 here is PER HESTIA USER. Running it as root starts a second daemon
 * beside the running one and the two fight over the port:
 *
 *     su - vesopasoftware -c 'PM2_HOME=/home/vesopasoftware/.pm2 pm2 …'
 *
 * `.cjs` and not `.js` because package.json sets no module type and pm2 loads
 * this with require(); a plain `.js` is read as ESM by newer Node and fails
 * with "module is not defined".
 */
module.exports = {
  apps: [
    {
      name: 'auth.vesopa.com',
      script: 'src/server.js',
      cwd: __dirname,

      instances: 1,
      /*
       * fork, not cluster, and for this application the reason is unusually
       * sharp. Under cluster mode every worker keeps its own copy of anything
       * held in memory, and here that would mean:
       *
       *   - N times the sign-in attempts before an account is locked, because
       *     each worker counts separately
       *   - a signing key cached in one worker and not another, so a token
       *     minted by one is briefly unverifiable by the next
       *
       * Neither of those produces an error anybody would see. The rate limiter
       * is in the database partly for this reason; the process model is the
       * other half of it.
       */
      exec_mode: 'fork',

      autorestart: true,
      max_memory_restart: '512M',

      /*
       * Crash-loop guard. Without it a bad deploy — a missing .env, a database
       * that is not up — restarts for ever at full speed and buries the real
       * error under a hundred megabytes of repeats. Ten restarts inside
       * min_uptime and pm2 marks it `errored`, which is a state you can see.
       */
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      /*
       * NODE_ENV is set here as well as in .env because parts of the app read
       * it before dotenv has finished — the HSTS header and the `secure` flag
       * on the session cookie among them. A production process that boots
       * believing it is in development issues session cookies without `secure`
       * on a site that is entirely HTTPS.
       */
      env: {
        NODE_ENV: 'production',
      },

      // ABSOLUTE log paths: pm2 resolves a relative one against its own working
      // directory, so `logs/error.log` lands somewhere under ~/.pm2 and nobody
      // finds it for a week.
      error_file: `${__dirname}/logs/error.log`,
      out_file: `${__dirname}/logs/out.log`,
      merge_logs: true,
      time: true,

      // Never in production: it watches the whole tree, and a log write inside
      // that tree restarts the app, which writes a log.
      watch: false,

      // Let a sign-in finish rather than cutting somebody off mid-exchange.
      kill_timeout: 5000,
      listen_timeout: 8000,
    },
  ],
};
