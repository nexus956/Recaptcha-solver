module.exports = {
  apps: [
    {
      name: 'recaptcha-solver',
      script: 'recaptcha_solver.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 6868,
        POOL_SIZE: 10,
        TIMEOUT: 35
      }
    }
  ]
};
