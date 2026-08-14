const { createApp } = require('./app');

module.exports = { createApp };

if (require.main === module) {
    throw new Error('请使用统一入口：在项目根目录执行 npm start（node server.js）');
}
