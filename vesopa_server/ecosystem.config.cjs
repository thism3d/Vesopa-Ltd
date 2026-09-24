
module.exports = {
    apps: [
        {
            name: 'vesopa_backoffice',
            script: 'src/server.js',
            cwd: __dirname,
            instances: 1,
            // fork, not cluster: the WebSocket dispatcher holds per-user socket
            // state in memory (activeSockets). Under cluster mode a server push
            // would only reach the worker that happens to hold that user's socket.
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production',
                PORT: 5060,
            },
        },
    ],
};
