const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const mqtt = require('mqtt');
const { DOMParser } = require('@xmldom/xmldom');
const { loadLocalEnv, envGet } = require('../_shared/env');
const { ensureUnifiedSession, isAdminUser } = require('../_shared/session');

const local = loadLocalEnv(__dirname);

const app = express();

function requireAdminApi(req, res, next) {
    const user = ensureUnifiedSession(req);
    if (!user) {
        return res.status(401).json({ success: false, message: '未登录' });
    }
    if (!isAdminUser(user)) {
        return res.status(403).json({ success: false, message: '需要管理员权限' });
    }
    next();
}

//数据库连接 (Promise 版本) —— 使用本模块 .env（mqttgps），不覆盖其他模块
const dbPool = mysql.createPool({
    host: envGet(local, 'DB_HOST', '127.0.0.1'),
    user: envGet(local, 'DB_USER', 'root'),
    password: envGet(local, 'DB_PASSWORD', ''),
    database: envGet(local, 'DB_NAME', 'mqttgps'),
    waitForConnections: true,
    connectionLimit: 10
});

const db = dbPool.promise();

async function testDbConnection() {
    try {
        await db.query('SELECT 1');
        console.log('[RTLS] 数据库连接成功');
    } catch (err) {
        console.error('[RTLS] 数据库连接失败！请检查 apps/rtls/.env');
        console.error('[RTLS] 错误详情:', err.message);
    }
}

testDbConnection();

// --- MQTT 核心逻辑：未配置则不连，避免默默连上本机 1883 ---
const mqttBrokerUrl = String(envGet(local, 'MQTT_BROKER_URL', '') || '').trim();
let mqttClient = null;
if (mqttBrokerUrl) {
    mqttClient = mqtt.connect(mqttBrokerUrl);
    mqttClient.on('connect', () => {
        console.log('>>> MQTT Broker 已连接，正在订阅主题...');
        mqttClient.subscribe(envGet(local, 'MQTT_TOPIC_FILTER', 'owntracks/#') || 'owntracks/#');
    });
    mqttClient.on('error', (err) => {
        console.error('[RTLS] MQTT:', err.message);
    });
} else {
    console.log('[RTLS] 未配置 MQTT_BROKER_URL，跳过 MQTT 连接');
}

const deviceStates = {};

if (mqttClient) {
mqttClient.on('message', async (topic, message) => {
    try {
        const messageStr = message.toString();
        let data = {};
        
        try {
            // 尝试按标准 JSON 解析
            data = JSON.parse(messageStr);
        } catch (err) {
            // 如果设备发送的不是 JSON 而是纯文本 (例如: "纬度,经度")
            const parts = messageStr.split(',');
            if (parts.length >= 2) {
                data = {
                    lat: parseFloat(parts[0]),
                    lon: parseFloat(parts[1])
                };
            } else {
                console.error('收到无法解析的消息格式:', messageStr);
                return;
            }
        }

        const topicParts = topic.split('/');
        let deviceId;

        // 核心修改：检测是否为 owntracks/GPSD/xxx 格式
        if (topicParts.length >= 3 && topicParts[0] === 'owntracks' && topicParts[1] === 'GPSD') {
            deviceId = String(topicParts[2]);
        } else {
            // 原有逻辑：优先提取载荷中的 tid，其次取 topic 尾部
            deviceId = String(data.tid || topicParts.pop());
        }

        const now = Date.now();

        // 防止异常空数据
        if (data.lat === undefined || data.lon === undefined || isNaN(data.lat) || isNaN(data.lon)) {
            return; 
        }

        await db.query(`
            INSERT INTO device_config (device_id, nickname, is_enabled, last_update) 
            VALUES (?, ?, ?, ?) 
            ON DUPLICATE KEY UPDATE last_update = ?`, 
            [deviceId, `自动注册_${deviceId}`, 1, now, now]
        );

        // 针对只有经纬度的数据，赋予其他字段安全默认值
        deviceStates[deviceId] = { 
            batt: data.batt !== undefined ? data.batt : 0, 
            lat: data.lat, 
            lon: data.lon, 
            bs: data.bs || '', 
            lastUpdate: now 
        };

    } catch (e) { 
        console.error('MQTT自动注册/解析错误:', e.message); 
    }
});
}

// --- Express 中间件 ---
// 同域挂载，无需开放跨域；KML 上传控制在合理上限
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ limit: '8mb', extended: true }));

// WGS84 TO GCJ02 坐标转换
function wgs84_to_gcj02(lng, lat) {
    const pi = 3.14159265358979324, a = 6378245.0, ee = 0.00669342162296594323;
    let x = lng - 105.0, y = lat - 35.0;
    let dLat = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
    dLat += (20.0*Math.sin(6.0*x*pi) + 20.0*Math.sin(2.0*x*pi)) * 2.0/3.0;
    dLat += (20.0*Math.sin(y*pi) + 40.0*Math.sin(y/3.0*pi)) * 2.0/3.0;
    dLat += (160.0*Math.sin(y/12.0*pi) + 320*Math.sin(y*pi/30.0)) * 2.0/3.0;
    let dLng = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
    dLng += (20.0*Math.sin(6.0*x*pi) + 20.0*Math.sin(2.0*x*pi)) * 2.0/3.0;
    dLng += (20.0*Math.sin(x*pi) + 40.0*Math.sin(x/3.0*pi)) * 2.0/3.0;
    dLng += (150.0*Math.sin(x/12.0*pi) + 300.0*Math.sin(x/30.0*pi)) * 2.0/3.0;
    let radLat = lat/180.0*pi, magic = Math.sin(radLat);
    magic = 1 - ee*magic*magic;
    let sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * pi);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * pi);
    return [lat + dLat, lng + dLng];
}

// --- KML 解析器
function parseKmlCoordinates(kmlString) {
    const xmlDoc = new DOMParser().parseFromString(kmlString, "text/xml");
    const path = [];
    const coordsNodes = xmlDoc.getElementsByTagName("coordinates");
    for (let i = 0; i < coordsNodes.length; i++) {
        const text = coordsNodes[i].textContent.trim();
        if (!text) continue;
        const pointStrings = text.split(/\s+/);
        if (pointStrings.length > 1) {
            pointStrings.forEach(str => {
                const parts = str.split(',');
                if (parts.length >= 2) {
                    const lng = parseFloat(parts[0]);
                    const lat = parseFloat(parts[1]);
                    if (!isNaN(lng) && !isNaN(lat)) {
                        const gcj02Point = wgs84_to_gcj02(lng, lat);
                        path.push(gcj02Point);
                    }
                }
            });
        }
    }
    if (path.length === 0) {
        const gxNodes = xmlDoc.getElementsByTagName("gx:coord");
        for (let i = 0; i < gxNodes.length; i++) {
            const text = gxNodes[i].textContent.trim();
            if (!text) continue;
            const parts = text.split(/\s+/);
            if (parts.length >= 2) {
                const lng = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                if (!isNaN(lng) && !isNaN(lat)) {
                    const gcj02Point = wgs84_to_gcj02(lng, lat);
                    path.push(gcj02Point);
                }
            }
        }
    }
    return path;
}

function getHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function generateDistanceMarkers(pathArray, interval = 500) {
    if (!pathArray || pathArray.length < 2) return [];
    const markers = [];
    let accumulatedDistance = 0;
    let nextTarget = interval;
    for (let i = 1; i < pathArray.length; i++) {
        const p1 = pathArray[i - 1];
        const p2 = pathArray[i];
        const segDist = getHaversineDistance(p1[0], p1[1], p2[0], p2[1]);
        while (accumulatedDistance + segDist >= nextTarget) {
            const remaining = nextTarget - accumulatedDistance;
            const ratio = remaining / segDist;
            const markerLat = p1[0] + (p2[0] - p1[0]) * ratio;
            const markerLon = p1[1] + (p2[1] - p1[1]) * ratio;
            markers.push({
                x: nextTarget / interval,
                distance: nextTarget,
                label: `${(nextTarget / 1000).toFixed(1)} km`,
                lat: markerLat,
                lon: markerLon
            });
            nextTarget += interval;
        }
        accumulatedDistance += segDist;
    }
    return markers;
}

// --- API 接口 ---
app.get('/api/devices', async (req, res) => {
    try {
        const sql = req.query.filter === 'enabled' ? 'SELECT * FROM device_config WHERE is_enabled = 1' : 'SELECT * FROM device_config'; 
        const [dbDevices] = await db.query(sql);
        const now = Date.now();
        const result = dbDevices.map(config => {
            const state = deviceStates[String(config.device_id)] || {};
            const [gcjLat, gcjLon] = (state.lat && state.lon) ? wgs84_to_gcj02(state.lon, state.lat) : [config.lat, config.lon];
            return { ...config, ...state, lat: gcjLat, lon: gcjLon, isOffline: !state.lastUpdate || (now - state.lastUpdate > 300000) };
        });
        res.json(result);
    } catch (err) { console.error('[RTLS] devices', err.message); res.status(500).json({ error: '读取设备失败' }); }
});

app.get('/api/server-time', (req, res) => res.json({ timestamp: Date.now() }));

app.get('/api/event-info', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT event_name, kml_data, marker_data FROM event_config_meta LIMIT 1');
        res.json({ 
            event_name: rows[0]?.event_name || '指挥大屏', 
            kml_data: rows[0]?.kml_data || '[]',
            marker_data: rows[0]?.marker_data || '[]'
        });
    } catch (err) { res.status(500).json({ error: "数据库查询失败" }); }
}); 

app.post('/api/admin/update-device', requireAdminApi, async (req, res) => {
    const { actionType } = req.body;
    try {
        if (actionType === 'kml_storage') {
            const { kml_data } = req.body;
            if (!kml_data) return res.status(400).json({ success: false, message: 'KML数据不能为空' });
            const parsedData = parseKmlCoordinates(kml_data);
            const markerData = generateDistanceMarkers(parsedData, 500);
            await db.query(
                'UPDATE event_config_meta SET kml_data = ?, marker_data = ? WHERE id = 1', 
                [JSON.stringify(parsedData), JSON.stringify(markerData)]
            );
            return res.json({ success: true, message: `轨迹解析成功！共生成 ${markerData.length} 个公里标记点。` });
        }
        if (actionType === 'get_schedule') {
            const [rows] = await db.query('SELECT id, al_date, al_time, al_name FROM schedule_alerts ORDER BY al_date ASC, al_time ASC');
            return res.json({ success: true, data: rows });
        }
        if (actionType === 'event') {
            const { event_name } = req.body;
            await db.query('UPDATE event_config_meta SET event_name = ?', [event_name]);
            return res.json({ success: true });
        }
        if (actionType === 'schedule') {
            const { id, al_date, al_time, al_name } = req.body;
            if (id && id !== "0" && id !== 0) {
                await db.query('UPDATE schedule_alerts SET al_date = ?, al_time = ?, al_name = ? WHERE id = ?', [al_date, al_time, al_name, id]);
            } else {
                await db.query('INSERT INTO schedule_alerts (al_date, al_time, al_name) VALUES (?, ?, ?)', [al_date, al_time, al_name]);
            }
            return res.json({ success: true });
        }
        const { device_id, ...fields } = req.body;
        if (!device_id) return res.status(400).json({ success: false });
        const allowedFields = ['nickname', 'role', 'is_enabled', 'remark', 'icon_type'];
        const keys = Object.keys(fields).filter(k => allowedFields.includes(k));
        const sql = `UPDATE device_config SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE device_id = ?`;
        const [result] = await db.query(sql, [...keys.map(k => fields[k]), device_id]);
        res.json({ success: result.affectedRows > 0 });
    } catch (err) {
        console.error("后台接口出错:", err);
        res.status(500).json({ success: false, error: '操作失败' });
    }
});

// 接口：获取所有赛事排程列表（供管理后台及大屏初始化使用）
app.get('/api/schedule', async (req, res) => {
    try {
        // 从数据库中按日期和时间升序读取所有排程
        const [rows] = await db.query('SELECT * FROM schedule_alerts ORDER BY al_date ASC, al_time ASC');
        res.json(rows); // 将数组以 JSON 形式返回给前端
    } catch (err) {
        console.error('读取赛事排程失败:', err.message);
        res.status(500).json({ status: 'error', message: '服务器内部数据库查询出错' });
    }
});

app.get('/api/active-alert', async (req, res) => {
    const now = new Date();
    const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    try {
        const [rows] = await db.query("SELECT al_name FROM schedule_alerts WHERE al_time <= ? ORDER BY al_time DESC LIMIT 1", [currentTimeStr]);
        res.json({ status: 'success', alertName: (rows && rows.length > 0) ? rows[0].al_name : "准备就绪..." });
    } catch (err) { res.status(500).json({ status: 'error', alertName: "查询出错" }); }
});

// 接口：从数据库获取当前展示的赛事名称
app.get('/api/event-name', async (req, res) => {
    try {
        // 从 event_config_meta 表中读取第一个 event_name
        const [rows] = await db.query('SELECT event_name FROM event_config_meta LIMIT 1');
        
        if (rows && rows.length > 0) {
            // rows[0].event_name 对应数据库字段，返回给前端的对象 key 为 name，适配大屏和后台
            res.json({ name: rows[0].event_name });
        } else {
            res.json({ name: "未命名赛事保障" }); // 如果表中没数据，给一个兜底默认名
        }
    } catch (err) {
        console.error('读取赛事名称失败:', err.message);
        res.status(500).json({ status: 'error', message: '读取赛事名称失败' });
    }
});

app.get('/api/device-stats', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT device_id FROM device_config WHERE is_enabled = 1');
        const now = Date.now();
        const stats = rows.reduce((acc, row) => {
            const dev = deviceStates[String(row.device_id)];
            if (dev && (now - dev.lastUpdate < 300000)) {
                acc.online++;
                if (dev.batt <= 20) acc.lowBatt++;
            }
            return acc;
        }, { online: 0, lowBatt: 0 });
        res.json(stats);
    } catch (err) { res.status(500).json({ error: "服务器内部错误" }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/db-status', async (req, res) => { try { await db.query('SELECT 1'); res.json({ status: 'ok' }); } catch(e) { res.json({ status: 'error' }); } });
app.get('/api/mqtt-status', (req, res) => res.json({ status: mqttClient?.connected ? 'ok' : 'error' }));


/* ==========================================================================
   地图标点管理 API (彻底修复 Promise 崩溃与数据读取问题)
   ========================================================================== */

app.get('/api/markers', async (req, res) => {
    try {
        const [results] = await db.query('SELECT * FROM map_markers ORDER BY id DESC');
        res.json(results);
    } catch (err) {
        console.error("读取标点失败:", err.message);
        res.status(500).json({ error: "服务器内部错误" });
    }
});

app.post('/api/markers', requireAdminApi, async (req, res) => {
    const { name, type, lat, lng, remark } = req.body;
    try {
        const [result] = await db.query('INSERT INTO map_markers (name, type, lat, lng, remark) VALUES (?, ?, ?, ?, ?)', [name, type, lat, lng, remark]);
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        console.error("写入标点失败:", err.message);
        res.status(500).json({ error: "写入数据库失败" });
    }
});

app.put('/api/markers/:id', requireAdminApi, async (req, res) => {
    const { id } = req.params;
    const { name, type, lat, lng, remark } = req.body;
    try {
        await db.query('UPDATE map_markers SET name = ?, type = ?, lat = ?, lng = ?, remark = ? WHERE id = ?', [name, type, lat, lng, remark, id]);
        res.json({ success: true });
    } catch (err) {
        console.error("更新标点失败:", err.message);
        res.status(500).json({ error: "更新数据库失败" });
    }
});

app.delete('/api/markers/:id', requireAdminApi, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM map_markers WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error("删除标点失败:", err.message);
        res.status(500).json({ error: "删除数据库失败" });
    }
});

module.exports = { app, local };