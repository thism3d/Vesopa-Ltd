/**
 * pm2 configuration for vesopa_hosting.
 *
 * `vesopa_hosting` is a separate process from `vesopa_web` and
 * `vesopa_backoffice`, on its own port behind its own nginx server block.
 *
 * THE LIVE BOX RUNS SEVERAL UNRELATED APPLICATIONS UNDER THE SAME ACCOUNT.
 * Every pm2 command must name this app explicitly. `pm2 restart all` on that
 * machine takes down the EPOS API and the main site along with this one, and
 * nothing in pm2 will ask whether you meant it.
 *
 *     pm2 restart vesopa_hosting        <- always
 *     pm2 restart all                   <- never, on this box
 *
 * `.cjs` and not `.js` because package.json does not set a module type and pm2
 * loads this file with require(). A plain `.js` here is read as ESM by newer
 * Node and fails with "module is not defined".
 */
module.exports = {
  apps: [
    {
      name: 'vesopa_hosting',
      script: 'src/server.js',
      cwd: __dirname,

      instances: 1,
      /*
       * fork, not cluster.
       *
       * Three things in this app are per-process, and every one of them breaks
       * QUIETLY under cluster mode rather than loudly:
       *
       *   - the login rate limiter, so N workers means N times the attempts
       *     before anybody is locked out
       *   - the pricing cache, so an admin's price change shows on some
       *     requests and not others for up to a minute
       *   - the geo lookup cache, so the metered ipwho.is quota is spent N
       *     times over
       *
       * None of that produces an error in a log. If this ever needs to scale,
       * those three move to the database or Redis first.
       */
      exec_mode: 'fork',

      autorestart: true,
      max_memory_restart: '400M',

      /*
       * Crash-loop guard. Without it a bad deploy — a missing .env, a database
       * that is not up yet — restarts for ever at full speed, filling the disk
       * with logs and burying the original error in a hundred megabytes of
       * repeats. Ten restarts inside `min_uptime` and pm2 gives up and marks
       * the app `errored`, which is a state you can actually see in `pm2 list`.
       */
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      /*
       * NODE_ENV is set here as well as in .env because parts of the app read
       * it before dotenv has finished — the static-asset cache headers and the
       * `secure` flag on session and cart cookies among them. A production
       * process that boots believing it is in development issues cookies
       * without `secure`, over a site that is entirely HTTPS.
       */
      env: {
        NODE_ENV: 'production',
      },

      /*
       * ABSOLUTE log paths. pm2 resolves a relative log path against its own
       * working directory, not the app's, so `logs/error.log` lands somewhere
       * under ~/.pm2 on a live box and nobody finds it for a week.
       */
      error_file: `${__dirname}/logs/error.log`,
      out_file: `${__dirname}/logs/out.log`,
      merge_logs: true,
      time: true,

      // Never in production: it watches the whole tree, and a log write inside
      // that tree restarts the app, which writes a log.
      watch: false,

      // Let in-flight requests finish on a restart rather than cutting a
      // checkout off mid-transaction.
      kill_timeout: 5000,
      listen_timeout: 8000,
    },
  ],
};
