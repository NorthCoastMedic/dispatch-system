const express = require('express');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const path = require('path');
const { loadLocalEnv, envGet } = require('../_shared/env');

function createApp() {
    const local = loadLocalEnv(__dirname);
    const app = express();

    app.use(express.static(path.join(__dirname, 'public')));

    const latestDataCache = {};
    const lastProcessedTime = {};

    const pool = new Pool({
        host: envGet(local, 'PG_HOST', '127.0.0.1'),
        user: envGet(local, 'PG_USER', 'postgres'),
        password: envGet(local, 'PG_PASSWORD', ''),
        database: envGet(local, 'PG_DATABASE', 'wbgt'),
        port: Number(envGet(local, 'PG_PORT', '5432'))
    });

    pool.query(`
        CREATE TABLE IF NOT EXISTS public.wbgt_logs (
            id SERIAL PRIMARY KEY,
            sensor_id VARCHAR(50),
            wbgt FLOAT, ta FLOAT, tg FLOAT, rh FLOAT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `).then(() => {
        console.log('[WBGT] 数据表状态检查完成：正常');
    }).catch((err) => {
        console.error('[WBGT] 数据表初始化失败:', err.message);
    });

    setInterval(async () => {
        try {
            await pool.query("DELETE FROM public.wbgt_logs WHERE created_at < NOW() - INTERVAL '12 hours'");
        } catch (err) {
            console.error('[WBGT] 清理历史数据失败:', err.message);
        }
    }, 3600000);

    const mqttClient = mqtt.connect(envGet(local, 'MQTT_BROKER', 'mqtt://127.0.0.1:1883'), {
        clientId: 'wbgt_backend_' + Math.random().toString(16).substring(2, 10),
        keepalive: 60,
        reconnectPeriod: 5000
    });

    mqttClient.on('connect', () => {
        console.log(`[WBGT] MQTT 已连接`);
        mqttClient.subscribe('wbgt/#');
    });

    mqttClient.on('error', (err) => {
        console.error('[WBGT] MQTT:', err.message);
    });

    function parseProtocol(str) {
        const match = str.match(/W([\d.]+)C:T([\d.]+)C:T([\d.]+)C:H([\d.]+)%(?:.*)/);
        if (!match) return null;
        const [_, wbgt, ta, tg, rh] = match.map(Number);
        const es = 6.112 * Math.exp((17.67 * ta) / (ta + 243.5));
        const ea = es * (rh / 100);
        const vpd = (es - ea) / 10;
        const tnw = ta * Math.atan(0.151977 * Math.pow(rh + 8.313659, 0.5)) +
            Math.atan(ta + rh) - Math.atan(rh - 1.676331) +
            0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
        const sw = Math.max(0, Math.min(100, (ta - 20) * 4.5 + (100 - vpd * 10) * 0.45));
        return {
            wbgt, ta, tg, rh,
            e: parseFloat(ea.toFixed(1)),
            tnw: parseFloat(tnw.toFixed(1)),
            vpd: parseFloat(vpd.toFixed(2)),
            skin_wettedness: parseFloat(sw.toFixed(1))
        };
    }

    mqttClient.on('message', async (topic, message) => {
        const rawPayload = message.toString().trim();
        const sensorId = topic.split('/')[1] || 'unknown';
        const parsedData = parseProtocol(rawPayload);
        if (!parsedData) return;
        parsedData.sensorId = sensorId;
        latestDataCache[sensorId] = parsedData;

        const now = Date.now();
        if (lastProcessedTime[sensorId] && (now - lastProcessedTime[sensorId] < 300000)) return;
        lastProcessedTime[sensorId] = now;

        try {
            await pool.query(
                'INSERT INTO public.wbgt_logs (sensor_id, wbgt, ta, tg, rh) VALUES ($1, $2, $3, $4, $5)',
                [sensorId, parsedData.wbgt, parsedData.ta, parsedData.tg, parsedData.rh]
            );
        } catch (err) {
            console.error('[WBGT] 归档失败:', err.message);
        }
    });

    app.get('/api/history/:sensorId', async (req, res) => {
        try {
            const result = await pool.query(
                "SELECT * FROM public.wbgt_logs WHERE sensor_id = $1 AND created_at > NOW() - INTERVAL '12 hours' ORDER BY created_at ASC",
                [req.params.sensorId]
            );
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: '数据库内部查询错误' });
        }
    });

    app.get('/api/realtime/:sensorId', (req, res) => res.json(latestDataCache[req.params.sensorId] || null));
    app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
    app.get('/api/db-status', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok' });
        } catch (e) {
            res.json({ status: 'error' });
        }
    });
    app.get('/api/mqtt-status', (req, res) => res.json({ status: mqttClient?.connected ? 'ok' : 'error' }));

    return app;
}

module.exports = { createApp };
