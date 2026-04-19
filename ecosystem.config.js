module.exports = {
    apps: [
        {
            name: 'gpu-rental',
            script: 'server/index.js',
            cwd: 'F:/antigravity/gpu-platform',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            restart_delay: 3000,
            max_restarts: 10,
            env: {
                NODE_ENV: 'production',
                PORT: 3000,
            },
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            error_file: 'F:/gpu-rental/logs/pm2-error.log',
            out_file: 'F:/gpu-rental/logs/pm2-out.log',
            merge_logs: true,
        },
    ],
};
