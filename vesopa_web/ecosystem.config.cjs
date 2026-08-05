module.exports = {
    apps: [
        {
            name: 'vesopa_web',
            script: 'src/server.js',
            cwd: __dirname,
            instances: 1,
            // Fork rather than cluster. Nothing here holds per-connection state
            // the way the back office's WebSocket dispatcher does, but the
            // enquiry-form rate limiter counts submissions in memory, and under
            // cluster mode each worker would keep its own count — multiplying
            // the effective limit by the number of workers. A marketing site
            // does not need the throughput a second process would buy.
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'production',
                PORT: 5065,
            },
        },
    ],
};
