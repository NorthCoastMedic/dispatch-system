let allDevices = [];
let allMarkers = [];

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function jsonAttr(obj) {
    return escapeHtml(JSON.stringify(obj == null ? {} : obj));
}

function readJsonAttr(el) {
    if (!el) return null;
    try {
        return JSON.parse(el.getAttribute('data-json') || 'null');
    } catch (_) {
        return null;
    }
}

// 弹窗内部地图全局变量
let adminModalMap = null;
let adminModalMarker = null;

// 1. 修改后的 loadData 函数
async function loadData() {
    try {
        const [devRes, schedRes, nameRes, markerRes] = await Promise.all([
            fetch('/api/devices'), 
            fetch('/api/schedule'),
            fetch('/api/event-name').catch(() => null),
            fetch('/api/markers').catch(() => null)
        ]);
        
        allDevices = await devRes.json();
        
        // 【新增处理逻辑】解析并同步排程监控数据
        if (schedRes && schedRes.ok) {
            const allSchedules = await schedRes.json();
            renderSchedules(allSchedules);
        }
        
        if (nameRes && nameRes.ok) {
            const nameData = await nameRes.json();
            const elInput = document.getElementById('event-name-input');
            if (elInput) elInput.value = nameData.name || nameData.eventName || '';
        }
        
        if (markerRes && markerRes.ok) {
            allMarkers = await markerRes.json();
        }
        
        renderCards();
        renderMarkers();
    } catch (err) {
        console.error("后台数据联动初始化失败:", err);
    }
}

// 2. 新增：渲染已有排程组件
function renderSchedules(schedules) {
    const container = document.getElementById('schedule-list');
    if (!container) return;
    
    if (!schedules || schedules.length === 0) {
        container.innerHTML = '<div style="color: #94a3b8; font-size: 12px; padding: 4px;">暂无设定排程事件</div>';
        return;
    }
    
    container.innerHTML = schedules.map(sched => {
        // 切割数据库可能自带的 ISO 日期后缀，保持 YYYY-MM-DD
        const dateStr = sched.al_date ? sched.al_date.split('T')[0] : '';
        const timeStr = sched.al_time ? sched.al_time.substring(0, 5) : '';
        return `
            <div class="sched-row" style="display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border: 1px solid transparent; border-radius: 4px; font-size: 13px;">
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75%;">
                    <span class="sched-date" style="font-family: monospace;">${dateStr}</span>
                    <b class="sched-time" style="margin: 0 4px;">${timeStr}</b>
                    <span class="sched-name" style="font-weight: 500;">${escapeHtml(sched.al_name)}</span>
                </div>
                <button type="button" class="primary" style="padding: 2px 8px; font-size: 12px; height: 24px; line-height: 20px; margin: 0;" data-action="edit-schedule" data-json="${jsonAttr({
                    id: sched.id,
                    al_date: sched.al_date,
                    al_time: sched.al_time,
                    al_name: sched.al_name
                })}">编辑</button>
            </div>
        `;
    }).join('');
}

// 3. 新增：点击已有排程的“编辑”，回显到上方的输入框中
window.editSchedule = function(sched) {
    document.getElementById('sched-id').value = sched.id || '';
    if (sched.al_date) {
        document.getElementById('sched-date').value = sched.al_date.split('T')[0];
    }
    document.getElementById('sched-time').value = sched.al_time ? sched.al_time.substring(0, 5) : '';
    document.getElementById('sched-name').value = sched.al_name || '';
};

function renderCards(data = allDevices) {
    const grid = document.getElementById('device-grid');
    if (!grid) return;
    
    if (data.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; padding: 30px; text-align: center; color: #94a3b8; font-size: 14px;">未筛选到符合要求的硬件终端</div>`;
        return;
    }

    grid.innerHTML = data.map(dev => {
        const isEnabled = parseInt(dev.is_enabled) === 1;
        return `
            <div class="device-card ${isEnabled ? 'enabled' : 'disabled'}" data-action="edit-device" data-json="${jsonAttr({
                device_id: dev.device_id,
                nickname: dev.nickname,
                role: dev.role,
                icon_type: dev.icon_type,
                remark: dev.remark,
                is_enabled: dev.is_enabled
            })}">
                <strong>${escapeHtml(dev.nickname || '💡 未命名终端')}</strong>
                <small class="font-mono">硬件ID: ${escapeHtml(dev.device_id)}</small>
                <small>战术角色: ${escapeHtml(dev.role || '未划分')}</small>
                <small style="margin-top:4px; font-weight: bold; color: ${isEnabled ? '#22c55e' : '#ef4444'}">
                    ${isEnabled ? '🟢 已同步大屏' : '🔴 已在地图隐藏'}
                </small>
            </div>
        `;
    }).join('');
}

window.filterDevices = function() {
    const query = document.getElementById('search').value.toLowerCase().trim();
    const filtered = allDevices.filter(dev => 
        String(dev.device_id).toLowerCase().includes(query) || 
        (dev.nickname && dev.nickname.toLowerCase().includes(query)) ||
        (dev.role && dev.role.toLowerCase().includes(query))
    );
    renderCards(filtered);
};

window.editDevice = function(dev) {
    const elId = document.getElementById('edit-id');
    if (elId) elId.innerText = dev.device_id;
    
    document.getElementById('edit-nick').value = dev.nickname || '';
    document.getElementById('edit-role').value = dev.role || '';
    document.getElementById('edit-icon-type').value = dev.icon_type || 0;
    document.getElementById('edit-remark').value = dev.remark || '';
    document.getElementById('edit-enabled').value = dev.is_enabled;
    document.getElementById('overlay').style.display = 'flex';
};

window.saveDevice = function() {
    const data = {
        device_id: document.getElementById('edit-id').innerText,
        nickname: document.getElementById('edit-nick').value,
        role: document.getElementById('edit-role').value,
        icon_type: parseInt(document.getElementById('edit-icon-type').value),
        remark: document.getElementById('edit-remark').value,
        is_enabled: parseInt(document.getElementById('edit-enabled').value)
    };
    
    fetch('/api/admin/update-device', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data) 
    }).then(res => {
        if (res.ok) {
            document.getElementById('overlay').style.display = 'none';
            loadData();
        } else {
            alert('设备写入失败，请检查数据库。');
        }
    });
};

window.updateEventName = async function() {
    const nameVal = document.getElementById('event-name-input').value.trim();
    if (!nameVal) { alert('赛事名称不能为空！'); return; }
    
    try {
        const res = await fetch('/api/admin/update-device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 添加 actionType: 'event' 并将字段名修改为 event_name
            body: JSON.stringify({ actionType: 'event', event_name: nameVal }) 
        });
        if (res.ok) alert('✅ 赛事名称已向指挥控制中心同步更新！');
        else alert('更新失败，请确认后端 API 是否响应。');
    } catch (err) {
        alert('接口网络异常');
    }
};

window.uploadKML = async function(input) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    
    // 使用 FileReader 读取文件内容为字符串，以适配后端的 JSON 解析
    const reader = new FileReader();
    reader.onload = async function(e) {
        const kmlContent = e.target.result;
        try {
            const res = await fetch('/api/admin/update-device', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // 对应 server.js 中的 actionType 和 kml_data
                body: JSON.stringify({ actionType: 'kml_storage', kml_data: kmlContent }) 
            });
            if (res.ok) {
                const result = await res.json();
                if (result.success) {
                    alert(`✅ KML 空间地理线路 [${file.name}] 解析并覆盖成功！\n${result.message || ''}`);
                } else {
                    alert(`KML 上传失败：${result.message}`);
                }
            } else {
                alert('KML 上传失败，请检查后端服务日志解析状态。');
            }
        } catch (err) {
            alert('上载失败：通信链路异常');
        }
    };
    reader.onerror = function() {
        alert('读取 KML 文件失败！');
    };
    
    // 以文本形式读取 KML XML 数据
    reader.readAsText(file); 
};

window.saveSchedule = async function() {
    const payload = {
        actionType: 'schedule', // 新增 actionType 以匹配 server.js 路由路由分支
        id: document.getElementById('sched-id').value || null,
        al_date: document.getElementById('sched-date').value,
        al_time: document.getElementById('sched-time').value,
        al_name: document.getElementById('sched-name').value.trim()
    };
    
    if (!payload.al_date || !payload.al_time || !payload.al_name) {
        alert('排程配置核心参数（日期、时间、指令事件）均不能为空！');
        return;
    }

    // 接口路径从 '/api/markers' 修改为 '/api/admin/update-device'
    const res = await fetch('/api/admin/update-device', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) 
    });
    
    if (res.ok) {
        alert('✅ 战略调度排程发布成功');
        document.getElementById('sched-id').value = ''; // 提交后清空 id 防止下次误修改
        document.getElementById('sched-name').value = '';
        loadData();
    } else {
        alert('❌ 战略调度排程发布失败');
    }
};

function renderMarkers() {
    const tbody = document.getElementById('marker-list-body');
    if (!tbody) return;
    
    if (allMarkers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#94a3b8; padding:20px;">当前赛事没有部署任何固定保障标点</td></tr>`;
        return;
    }
    
    tbody.innerHTML = allMarkers.map(marker => {
        let badge = '';
        if (marker.type === 'water') badge = '<span style="color:#0078D7; font-weight:600;">💧 物资补给点</span>';
        else if (marker.type === 'medical') badge = '<span style="color:#ef4444; font-weight:600;">❌ 医疗急救点</span>';
        else if (marker.type === 'hospital') badge = '<span style="color:#1e293b; font-weight:600;">🏥 合作医院</span>';

        return `
            <tr>
                <td><strong>${escapeHtml(marker.name)}</strong></td>
                <td>${badge}</td>
                <td class="font-mono" style="color:#475569;">${parseFloat(marker.lat).toFixed(6)}, ${parseFloat(marker.lng).toFixed(6)}</td>
                <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(marker.remark || '')}">
                    ${marker.remark ? escapeHtml(marker.remark) : '<span style="color:#cbd5e1;">无任何特殊备注</span>'}
                </td>
                <td style="text-align: center;">
                    <button type="button" class="primary" style="padding: 4px 10px; font-size:12px;" data-action="edit-marker" data-json="${jsonAttr({
                        id: marker.id,
                        name: marker.name,
                        type: marker.type,
                        lat: marker.lat,
                        lng: marker.lng,
                        remark: marker.remark
                    })}">编辑</button>
                    <button type="button" class="danger" style="padding: 4px 10px; font-size:12px; margin-left: 4px;" data-action="delete-marker" data-id="${Number(marker.id) || 0}">撤回</button>
                </td>
            </tr>
        `;
    }).join('');
}

// 可视化选址弹窗控制
window.openMarkerModal = function(markerData = null) {
    if (markerData && markerData.id) {
        document.getElementById('marker-modal-title').innerText = '📝 修正保障点空间信息';
        document.getElementById('marker-id').value = markerData.id;
        document.getElementById('marker-name').value = markerData.name;
        document.getElementById('marker-type').value = markerData.type;
        document.getElementById('marker-lat').value = markerData.lat;
        document.getElementById('marker-lng').value = markerData.lng;
        document.getElementById('marker-remark').value = markerData.remark || '';
    } else {
        document.getElementById('marker-modal-title').innerText = '📍 部署全新空间保障点';
        document.getElementById('marker-id').value = '';
        document.getElementById('marker-name').value = '';
        document.getElementById('marker-type').value = 'water';
        document.getElementById('marker-lat').value = '';
        document.getElementById('marker-lng').value = '';
        document.getElementById('marker-remark').value = '';
    }

    document.getElementById('marker-overlay').style.display = 'flex';

    const hasSavedPos = !!(markerData && markerData.lat && markerData.lng);
    const initLat = hasSavedPos ? markerData.lat : RTLS_DEFAULT_CENTER[0];
    const initLng = hasSavedPos ? markerData.lng : RTLS_DEFAULT_CENTER[1];
    window._rtlsAdminLocateToken = (window._rtlsAdminLocateToken || 0) + 1;
    const locateToken = window._rtlsAdminLocateToken;

    setTimeout(() => {
        if (!adminModalMap) {
            adminModalMap = L.map('modal-map', { zoomControl: false }).setView([initLat, initLng], 14);
            L.tileLayer('https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}').addTo(adminModalMap);
            
            adminModalMap.on('click', function(e) {
                const lat = e.latlng.lat.toFixed(7);
                const lng = e.latlng.lng.toFixed(7);
                document.getElementById('marker-lat').value = lat;
                document.getElementById('marker-lng').value = lng;

                if (adminModalMarker) {
                    adminModalMarker.setLatLng(e.latlng);
                } else {
                    adminModalMarker = L.marker(e.latlng).addTo(adminModalMap);
                }
            });
            // 处理移动端软键盘弹出导致的布局变化重绘地图
            window.addEventListener('resize', () => { if(adminModalMap) adminModalMap.invalidateSize(); });
        } else {
            adminModalMap.setView([initLat, initLng], 14);
            adminModalMap.invalidateSize(); 
        }

        if (markerData && markerData.lat) {
            if (adminModalMarker) {
                adminModalMarker.setLatLng([initLat, initLng]);
            } else {
                adminModalMarker = L.marker([initLat, initLng]).addTo(adminModalMap);
            }
        } else {
            if (adminModalMarker) {
                adminModalMap.removeLayer(adminModalMarker);
                adminModalMarker = null;
            }
        }

        if (!hasSavedPos) {
            locateMapByBrowser(adminModalMap, 16, function () {
                return window._rtlsAdminLocateToken !== locateToken
                    || document.getElementById('marker-overlay').style.display === 'none';
            });
        }
    }, 250); 
};

window.closeMarkerModal = function() {
    document.getElementById('marker-overlay').style.display = 'none';
};

window.saveMarker = function() {
    const id = document.getElementById('marker-id').value;
    const data = {
        name: document.getElementById('marker-name').value.trim(),
        type: document.getElementById('marker-type').value,
        lat: parseFloat(document.getElementById('marker-lat').value),
        lng: parseFloat(document.getElementById('marker-lng').value),
        remark: document.getElementById('marker-remark').value
    };

    if (!data.name || isNaN(data.lat) || isNaN(data.lng)) {
        alert('❌ 空间部署失败：请在地图上点击选择位置，并填写保障点名称。');
        return;
    }

    const url = id ? `/api/markers/${id}` : '/api/markers';
    const method = id ? 'PUT' : 'POST';

    const saveBtn = document.getElementById('btn-save-marker');
    if(saveBtn) saveBtn.disabled = true;

    fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(res => {
        if (res.ok) {
            alert('🎉 空间保障标点配置成功写入系统数据库！');
            window.closeMarkerModal();
            loadData();
        } else {
            alert('❌ 写入失败，请查验后端网络路由状态。');
        }
    }).catch(err => {
        alert('❌ 通信异常: ' + err.message);
    }).finally(() => {
        if(saveBtn) saveBtn.disabled = false;
    });
};

window.deleteMarker = function(id) {
    if (confirm('☠️ 确定要将此项应急保障标点从大屏与数据库中永久撤销吗？')) {
        fetch(`/api/markers/${id}`, { method: 'DELETE' }).then(res => {
            if (res.ok) loadData();
            else alert('撤回失败，请检查链路。');
        });
    }
};

function bindAdminDelegates() {
    const sched = document.getElementById('schedule-list');
    if (sched && !sched.dataset.bound) {
        sched.dataset.bound = '1';
        sched.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="edit-schedule"]');
            if (!btn) return;
            const data = readJsonAttr(btn);
            if (data) window.editSchedule(data);
        });
    }
    const grid = document.getElementById('device-grid');
    if (grid && !grid.dataset.bound) {
        grid.dataset.bound = '1';
        grid.addEventListener('click', (e) => {
            const card = e.target.closest('[data-action="edit-device"]');
            if (!card) return;
            const data = readJsonAttr(card);
            if (data) window.editDevice(data);
        });
    }
    const tbody = document.getElementById('marker-list-body');
    if (tbody && !tbody.dataset.bound) {
        tbody.dataset.bound = '1';
        tbody.addEventListener('click', (e) => {
            const editBtn = e.target.closest('[data-action="edit-marker"]');
            if (editBtn) {
                const data = readJsonAttr(editBtn);
                if (data) window.openMarkerModal(data);
                return;
            }
            const delBtn = e.target.closest('[data-action="delete-marker"]');
            if (delBtn) {
                const id = parseInt(delBtn.getAttribute('data-id'), 10);
                if (id) window.deleteMarker(id);
            }
        });
    }
}

bindAdminDelegates();
loadData();