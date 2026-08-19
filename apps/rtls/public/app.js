document.addEventListener('DOMContentLoaded', function() {
    // 1. 初始化地图
    var map = L.map('map', { zoomControl: false }).setView([38.992, 121.592], 16);
    window.globalLeafletMap = map;
    L.tileLayer('https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}').addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // 屏幕调整时重绘地图保证视口完整
    window.addEventListener('resize', () => { if(window.globalLeafletMap) window.globalLeafletMap.invalidateSize(); });

    // 移动端 UI 控制逻辑
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const floatSidebar = document.querySelector('.float-sidebar-left');
    const mobileOverlay = document.getElementById('mobile-overlay');
    const rightSidebar = document.getElementById('device-sidebar');

    if (mobileMenuBtn && floatSidebar && mobileOverlay) {
        mobileMenuBtn.addEventListener('click', () => {
            floatSidebar.classList.add('mobile-open');
            mobileOverlay.classList.add('active');
        });

        mobileOverlay.addEventListener('click', () => {
            floatSidebar.classList.remove('mobile-open');
            if (rightSidebar) rightSidebar.classList.remove('active');
            mobileOverlay.classList.remove('active');
        });
    }

    var devices = {};
    var deviceConfigs = {};
    var timeOffset = 0;
    var isZooming = false;
    var lastDataHash = ""; 
    let staticMarkerLayers = [];

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    } 
    
    var iconPerson = L.divIcon({ 
        html: `
        <div class="live-marker-wrapper">
            <div class="signal-pulse"></div>
            <div class="live-emoji">🚶</div>
        </div>`, 
        className: 'custom-live-icon',
        iconSize: [80, 80],
        iconAnchor: [50, 50]
    });

    var iconAmbulance = L.divIcon({ 
        html: `
        <div class="live-marker-wrapper">
            <div class="signal-pulse ambulance"></div>
            <div class="live-emoji">🚑</div>
        </div>`, 
        className: 'custom-live-icon',
        iconSize: [80, 80],
        iconAnchor: [50, 50]
    });

    function getMarkerIcon(type) {
        return (type == 1) ? iconAmbulance : iconPerson;
    }

    map.on('zoomstart', () => { isZooming = true; });
    map.on('zoomend', () => { isZooming = false; applyFiltersToMarkers(); });

    window.renderList = function() {
        if (isZooming) return;
        const list = document.getElementById('device-list');
        if (!list) return;

        const activeRoles = Array.from(document.querySelectorAll('.role-filter:checked')).map(cb => cb.value);
        let dynamicHtml = "";

        Object.keys(deviceConfigs).forEach(id => {
            const c = deviceConfigs[id];
            if (c.is_enabled != 1) return; 
            
            const shouldShow = activeRoles.includes(c.role);
            if (!shouldShow) return;

            const statusClass = !c.isOffline ? 'enabled' : 'disabled';
            const statusText = c.isOffline ? '离线' : '在线';
            const lowBattClass = (c.batt !== undefined && c.batt <= 20) ? 'low-batt-flash' : '';

            dynamicHtml += `
                <li class="card ${statusClass}" id="device-${escapeHtml(id)}" data-open-device="${escapeHtml(id)}">
                    <h4>${escapeHtml(c.nickname || id)} <span class="role-badge">${escapeHtml(c.role || '')}</span></h4>
                    <p>电量: <span class="card-batt ${lowBattClass}">${c.batt ?? '--'}%</span> | 状态: <span class="status-text">${statusText}</span></p>
                </li>
            `;
        });

        list.innerHTML = dynamicHtml;
    };

    const deviceListEl = document.getElementById('device-list');
    if (deviceListEl) {
        deviceListEl.addEventListener('click', (e) => {
            const card = e.target.closest('[data-open-device]');
            if (!card) return;
            const id = card.getAttribute('data-open-device');
            if (id && typeof window.openSidebar === 'function') window.openSidebar(id);
        });
    }

    function applyFiltersToMarkers() {
        const activeRoles = Array.from(document.querySelectorAll('.role-filter:checked')).map(cb => cb.value);
        Object.keys(devices).forEach(id => {
            const c = deviceConfigs[id];
            if (c && devices[id].marker) {
                activeRoles.includes(c.role) ? devices[id].marker.addTo(map) : devices[id].marker.remove();
            }
        });
    }

    async function fetchEventName() {
        try {
            const res = await fetch('/api/event-info');
            const data = await res.json();
            const el = document.getElementById('event-name');
            if (el) el.innerText = data.event_name;
        } catch (e) { console.error("获取活动名称失败", e); }
    }

    async function updateAlert() {
        const box = document.getElementById('active-alert');
        try {
            const res = await fetch('/api/active-alert');
            const data = await res.json();
            if (data && data.alertName) {
                if (box) {
                    box.textContent = data.alertName;
                    box.style.color = (data.alertName === "准备就绪...") ? "#94a3b8" : "#ff3b30";
                }
            }
        } catch (e) { console.error("无法连接到预警服务:", e); }
    }

    async function fetchDeviceData() {
        if (isZooming) return;
        try {
            const res = await fetch('/api/devices');
            const data = await res.json();
            
            const currentDataHash = JSON.stringify(data);
            if (currentDataHash === lastDataHash) return; 
            lastDataHash = currentDataHash;

            for (const item of data) {
                const id = String(item.device_id);
                deviceConfigs[id] = item; 
                if (item.is_enabled == 1 && item.lat && item.lon) {
                    if (!devices[id]) {
                        const marker = L.marker([item.lat, item.lon], { icon: getMarkerIcon(item.icon_type) }).addTo(map);
                        marker.on('click', () => window.openSidebar(id));
                        devices[id] = { marker: marker, icon_type: item.icon_type };
                    } else {
                        if (devices[id].icon_type != item.icon_type) {
                            devices[id].marker.setIcon(getMarkerIcon(item.icon_type));
                            devices[id].icon_type = item.icon_type;
                        }
                    }
                    devices[id].marker.setLatLng([item.lat, item.lon]);
                }
            }
            window.renderList();
            applyFiltersToMarkers();
        } catch (err) { console.error("获取设备数据失败", err); }
    }

    async function _apiPost(endpoint, body) {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return await res.json(); 
    }

    async function syncTime() {
        try {
            const start = Date.now();
            const res = await fetch('/api/server-time');
            const data = await res.json();
            timeOffset = data.timestamp - (Date.now() - (Date.now() - start) / 2);
        } catch (e) {}
    }

    function checkSystemStatus() {
        ['api', 'db', 'mqtt'].forEach(type => {
            fetch(`/api/${type === 'api' ? 'health' : type + '-status'}`)
                .then(r => r.json())
                .then(d => {
                    const el = document.getElementById(`status-${type}`);
                    if (el) {
                        el.innerText = `${type.toUpperCase()}: ${d.status === 'ok' ? '正常' : '异常'}`;
                        el.style.color = d.status === 'ok' ? '#10b981' : '#ef4444';
                    }
                }).catch(() => {
                    const el = document.getElementById(`status-${type}`);
                    if (el) { el.innerText = `${type.toUpperCase()}: 离线`; el.style.color = '#ef4444'; }
                });
        });
    }

    async function fetchStats() {
        try {
            const res = await fetch('/api/device-stats');
            const data = await res.json();
            const onlineEl = document.getElementById('online-count');
            const lowBattEl = document.getElementById('low-batt-count');
            if (onlineEl) onlineEl.innerText = data.online ?? 0;
            if (lowBattEl) lowBattEl.innerText = data.lowBatt ?? 0;
        } catch (err) { console.error("获取统计数据失败", err); }
    }

    document.querySelectorAll('.role-filter').forEach(cb => {
        cb.addEventListener('change', () => {
            window.renderList();
            applyFiltersToMarkers();
        });
    });

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

    function generateDistanceMarkers(pathArray, interval) {
        if (!pathArray || pathArray.length < 2 || interval <= 0) return [];
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

    window.kmlLayer = null;
    window.metricMarkersLayer = null; 
    let lastKmlDataHash = ""; 
    let cachedPathArray = []; 

    function renderDynamicMarkers(pathArray, interval) {
        if (window.metricMarkersLayer) {
            map.removeLayer(window.metricMarkersLayer);
        }
        window.metricMarkersLayer = L.layerGroup().addTo(map);

        if (interval <= 0) return;

        const markersArray = generateDistanceMarkers(pathArray, interval);
        
        markersArray.forEach(m => {
            const circleMarker = L.circleMarker([m.lat, m.lon], {
                radius: 5,
                color: '#ffffff',
                weight: 2,
                fillColor: '#38bdf8',
                fillOpacity: 1
            });
            
            circleMarker.bindTooltip(m.label, {
                permanent: true,
                direction: 'top',
                className: 'km-marker-tooltip',
                offset: [0, -5]
            });

            window.metricMarkersLayer.addLayer(circleMarker);
        });
    }

    async function loadEventKml() {
        try {
            const response = await fetch('/api/event-info');
            const data = await response.json();
            
            if (!data.kml_data || data.kml_data === '[]' || data.kml_data === lastKmlDataHash) {
                return; 
            }

            lastKmlDataHash = data.kml_data; 
            cachedPathArray = JSON.parse(data.kml_data); 

            if (cachedPathArray.length === 0) return;

            if (window.kmlLayer) {
                map.removeLayer(window.kmlLayer);
            }

            window.kmlLayer = L.polyline(cachedPathArray, {
                color: '#38bdf8', 
                weight: 5,
                opacity: 0.8,
                lineJoin: 'round'
            }).addTo(map);

            const currentInterval = parseInt(document.getElementById('marker-interval')?.value || 500);
            renderDynamicMarkers(cachedPathArray, currentInterval);

            map.fitBounds(window.kmlLayer.getBounds());
        } catch (error) {
            console.error("拉取或绘制 KML 失败:", error);
        }
    }

    document.getElementById('marker-interval')?.addEventListener('change', function(e) {
        const selectedInterval = parseInt(e.target.value);
        if (cachedPathArray && cachedPathArray.length > 0) {
            renderDynamicMarkers(cachedPathArray, selectedInterval);
        }
    });

    window.openSidebar = (id) => {
        const c = deviceConfigs[id] || {};
        if (c.lat && c.lon) {
            map.setView([c.lat, c.lon], 18);
        }
        const updateText = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
        updateText('info-id', id);
        updateText('info-nickname', c.nickname || '未设置');
        updateText('info-batt', c.batt ?? '--');
        updateText('info-role', c.role || '无');
    
        const remarkEl = document.getElementById('info-remark');
        if (remarkEl) remarkEl.value = c.remark || '';
    
        const timeEl = document.getElementById('info-update-time');
        if (timeEl) timeEl.innerText = c.lastUpdate ? new Date(c.lastUpdate).toLocaleTimeString('zh-CN', { hour12: false }) : '--';
    
        rightSidebar?.classList.add('active');
        
        // 移动端交互：自动显示遮罩，并在详情弹出时隐去左侧列表
        if (window.innerWidth <= 768) {
            if (floatSidebar) floatSidebar.classList.remove('mobile-open');
            if (mobileOverlay) mobileOverlay.classList.add('active');
        }
    };

    window.saveRemark = async function() {
        const id = document.getElementById('info-id')?.innerText;
        const remark = document.getElementById('info-remark')?.value;
        if (!id || id === '--') return;
        const result = await _apiPost('/api/admin/update-device', { device_id: id, remark: remark });
        if (result?.success) { alert('保存成功'); fetchDeviceData(); } else { alert('失败'); }
    };

    window.closeSidebar = function() {
        if (rightSidebar) rightSidebar.classList.remove('active');
        
        // 移动端收起逻辑：如果此时左侧列表未打开，则关闭全局遮罩
        if (window.innerWidth <= 768 && (!floatSidebar || !floatSidebar.classList.contains('mobile-open'))) {
            if (mobileOverlay) mobileOverlay.classList.remove('active');
        }
    };

    async function syncRealWeather() {
        if (!window.globalLeafletMap) return;
        
        try {
            const center = window.globalLeafletMap.getCenter();
            const lat = center.lat.toFixed(4);
            const lng = center.lng.toFixed(4);
            
            const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m`);
            
            if (!response.ok) throw new Error('网络气象数据读取失败');
            const data = await response.json();
            
            if (data && data.current) {
                const c = data.current;
                
                const deg = c.wind_direction_10m;
                let dirText = "微风";
                if (deg >= 337.5 || deg < 22.5) dirText = "北风";
                else if (deg >= 22.5 && deg < 67.5) dirText = "东北风";
                else if (deg >= 67.5 && deg < 112.5) dirText = "东风";
                else if (deg >= 112.5 && deg < 157.5) dirText = "东南风";
                else if (deg >= 157.5 && deg < 202.5) dirText = "南风";
                else if (deg >= 202.5 && deg < 247.5) dirText = "西南风";
                else if (deg >= 247.5 && deg < 292.5) dirText = "西风";
                else if (deg >= 292.5 && deg < 337.5) dirText = "西北风";

                const elTemp = document.getElementById('w-temp');
                const elHum = document.getElementById('w-hum');
                const elFeels = document.getElementById('w-feels');
                const elWind = document.getElementById('w-wind');
                const elDir = document.getElementById('w-dir');

                if (elTemp) elTemp.innerText = c.temperature_2m.toFixed(1);
                if (elHum) elHum.innerText = c.relative_humidity_2m;
                if (elFeels) elFeels.innerText = c.apparent_temperature.toFixed(1);
                if (elWind) elWind.innerText = (c.wind_speed_10m / 3.6).toFixed(1);
                if (elDir) elDir.innerText = dirText;
            }
        } catch (error) {
            console.error("气象接口请求失败或离线:", error);
            const elTemp = document.getElementById('w-temp');
            if (elTemp) elTemp.innerText = "断开";
        }
    }
    
    // ==========================================
    // 大屏前端保障标点渲染逻辑
    // ==========================================
    async function fetchStaticMarkers() {
        try {
            const res = await fetch('/api/markers');
            if (!res.ok) return;
            const markers = await res.json();

            // 清理旧标记层避免残影堆叠
            staticMarkerLayers.forEach(layer => window.globalLeafletMap.removeLayer(layer));
            staticMarkerLayers = [];

            markers.forEach(marker => {
                let typeEmoji = '📍';
                let typeColor = '#1e293b';
                
                if (marker.type === 'water') { typeEmoji = '💧'; typeColor = '#0078D7'; }
                if (marker.type === 'medical') { typeEmoji = '❌'; typeColor = '#ef4444'; }
                if (marker.type === 'hospital') { typeEmoji = '🏥'; typeColor = '#1e293b'; }

                const markerIcon = L.divIcon({
                    html: `<div style="font-size:28px; filter:drop-shadow(0px 3px 5px rgba(0,0,0,0.4));">${typeEmoji}</div>`,
                    className: 'custom-static-icon',
                    iconSize: [34, 34],
                    iconAnchor: [17, 17]
                });

                const leafletMarker = L.marker([marker.lat, marker.lng], { icon: markerIcon })
                    .bindPopup(`
                        <div class="rtls-popup" style="font-family:sans-serif; padding:4px; min-width:180px;">
                            <strong class="rtls-popup-title" style="font-size:15px; color:${typeColor};">${typeEmoji} ${escapeHtml(marker.name)}</strong>
                            <div class="rtls-popup-divider" style="height:1px; margin:8px 0;"></div>
                            <p class="rtls-popup-body" style="margin:0; font-size:13px; line-height:1.5;">
                                <b class="rtls-popup-label">指挥调度备注：</b><br/>
                                <span class="rtls-popup-remark" style="display:block; padding:6px; border-radius:4px; border:1px solid transparent; margin-top:4px;">${escapeHtml(marker.remark || '暂无指派调度记录')}</span>
                            </p>
                        </div>
                    `, { closeButton: false, offset: L.point(0, -10) })
                    .addTo(window.globalLeafletMap);

                staticMarkerLayers.push(leafletMarker);
            });
        } catch (err) {
            console.error("保障标点数据同步读取失败:", err);
        }
    }


    // --- 启动逻辑 ---
    loadEventKml();
    fetchDeviceData();
    fetchStaticMarkers(); // 挂载标点查询
    syncTime();
    fetchEventName();
    checkSystemStatus();
    fetchStats();
    syncRealWeather();
    
    setInterval(fetchDeviceData, 5000); 
    setInterval(fetchStaticMarkers, 20000); // 标点层20秒查库同步刷新
    setInterval(updateAlert, 1000);
    setInterval(checkSystemStatus, 10000);
    setInterval(fetchStats, 10000);
    setInterval(syncRealWeather, 300000); 

    window.globalLeafletMap.on('moveend', () => {
        clearTimeout(window.weatherDebounce);
        window.weatherDebounce = setTimeout(syncRealWeather, 1500);
    });

    setInterval(() => {
        const timeEl = document.getElementById('header-time');
        if (timeEl) timeEl.innerText = new Date(Date.now() + timeOffset).toLocaleTimeString('zh-CN', { hour12: false });
    }, 1000);
});