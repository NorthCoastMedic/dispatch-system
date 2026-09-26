const { app, local } = require('./app.core');

function createApp() {
    return app;
}

module.exports = { createApp, app, local };
