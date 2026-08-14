// 1. 同步全屏幕多端时钟
setInterval(() => {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    document.getElementById('clock').innerText = timeStr;
    document.getElementById('header-time-top').innerText = timeStr;
}, 1000);

// 2. 初始化 ECharts 容器
const barChart = echarts.init(document.getElementById('barChart'));
const lineChart = echarts.init(document.getElementById('lineChart'));

let globalHistoryData = []; 

// 3. 右侧：环境温度、相对湿度、WBGT 三大核心要素对比柱形图
const barOption = {
    grid: { top: '15%', bottom: '12%', left: '10%', right: '10%' },
    tooltip: { 
        trigger: 'axis',
        formatter: function(params) {
            let res = params[0].name + '<br/>';
            params.forEach(item => {
                let unit = item.dataIndex === 1 ? '%' : '°C';
                res += item.marker + item.seriesName + ': <b>' + item.value + '</b> ' + unit + '<br/>';
            });
            return res;
        }
    },
    xAxis: { 
        type: 'category', 
        data: ['环境温度 (Ta)', '相对湿度 (RH)', 'WBGT 指数'], 
        axisLabel: { color: '#475569', fontSize: 10, fontWeight: 'bold' } 
    },
    yAxis: [
        { type: 'value', name: '温度 (°C)', position: 'left', axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } } },
        { type: 'value', name: '湿度 (%)', position: 'right', max: 100, axisLabel: { color: '#64748b' }, splitLine: { show: false } }
    ],
    series: [{ 
        name: '环境指标',
        type: 'bar', 
        data: [0, 0, 0], 
        itemStyle: {
            color: function(params) {
                const colorList = ['#0056b3', '#2bc4c2', '#f97316'];
                return colorList[params.dataIndex];
            },
            borderRadius: [4, 4, 0, 0]
        }, 
        barWidth: '40%',
        label: { 
            show: true, 
            position: 'top', 
            fontSize: 11, 
            fontWeight: 'bold',
            color: '#1e293b',
            formatter: function(p) { return p.dataIndex === 1 ? p.value + '%' : p.value + '°C'; }
        }
    }]
};

// 4. 底部右侧：趋势历史演变图
const lineOption = {
    grid: { top: '12%', bottom: '12%', left: '6%', right: '4%' },
    tooltip: { trigger: 'axis' },
    legend: { show: false }, 
    xAxis: { type: 'time', axisLabel: { color: '#64748b', fontSize: 9 }, splitLine: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { color: '#e2e8f0' } } },
    series: [
        { name: '环境温度', type: 'line', smooth: true, showSymbol: false, itemStyle: { color: '#0056b3' }, lineStyle: { width: 2 }, data: [] },
        { name: '相对湿度', type: 'line', smooth: true, showSymbol: false, itemStyle: { color: '#2bc4c2' }, lineStyle: { width: 2 }, data: [] },
        { name: '黑球温度', type: 'line', smooth: true, showSymbol: false, itemStyle: { color: '#805ad5' }, lineStyle: { width: 2 }, data: [] },
        { name: 'WBGT指数', type: 'line', smooth: true, showSymbol: false, itemStyle: { color: '#f97316' }, lineStyle: { width: 3 }, data: [] }
    ]
};

barChart.setOption(barOption);
lineChart.setOption(lineOption);

function applyWbgtChartTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const axis = dark ? '#8fa3bc' : '#64748b';
    const label = dark ? '#e8eef6' : '#1e293b';
    const split = dark ? '#3d4f66' : '#e2e8f0';
    const cat = dark ? '#b8c7da' : '#475569';
    barChart.setOption({
        xAxis: { axisLabel: { color: cat } },
        yAxis: [
            { axisLabel: { color: axis }, splitLine: { lineStyle: { color: split, type: 'dashed' } } },
            { axisLabel: { color: axis } }
        ],
        series: [{ label: { color: label } }]
    });
    lineChart.setOption({
        xAxis: { axisLabel: { color: axis } },
        yAxis: { axisLabel: { color: axis }, splitLine: { lineStyle: { color: split } } }
    });
}
applyWbgtChartTheme();
window.addEventListener('platform-theme-change', applyWbgtChartTheme);

// 5. 核心联动：风险建议判定
function updateRiskUI(wbgt) {
    const textObj = document.getElementById('riskText');
    document.getElementById('realtime-wbgt-value').innerText = wbgt.toFixed(1);
    
    const levels = ['low', 'medium', 'high', 'very-high', 'extreme'];
    levels.forEach(lvl => {
        const el = document.getElementById(`advice-${lvl}`);
        if(el) el.classList.remove('active');
    });
    
    if (wbgt < 18) { 
        textObj.innerText = '低风险'; textObj.style.backgroundColor = '#22c55e';
        document.getElementById('advice-low').classList.add('active');
    } else if (wbgt < 23) { 
        textObj.innerText = '中等风险'; textObj.style.backgroundColor = '#eab308';
        document.getElementById('advice-medium').classList.add('active');
    } else if (wbgt < 28) { 
        textObj.innerText = '高风险'; textObj.style.backgroundColor = '#f97316';
        document.getElementById('advice-high').classList.add('active');
    } else if (wbgt < 30) { 
        textObj.innerText = '极高风险'; textObj.style.backgroundColor = '#ef4444';
        document.getElementById('advice-very-high').classList.add('active');
    } else { 
        textObj.innerText = '极端风险'; textObj.style.backgroundColor = '#a855f7';
        document.getElementById('advice-extreme').classList.add('active');
    }
}

// 6. 显隐控制逻辑绑定
function syncLineVisibility() {
    lineChart.setOption({
        legend: {
            selected: {
                '环境温度': document.getElementById('chk-ta').checked,
                '相对湿度': document.getElementById('chk-rh').checked,
                '黑球温度': document.getElementById('chk-tg').checked,
                'WBGT指数': document.getElementById('chk-wbgt').checked
            }
        }
    });
}
['chk-ta', 'chk-rh', 'chk-tg', 'chk-wbgt'].forEach(id => {
    document.getElementById(id).addEventListener('change', syncLineVisibility);
});

// 7. 时间拉栏范围切分与清洗
function filterAndRenderTrend() {
    if (!globalHistoryData || globalHistoryData.length === 0) return;
    
    const rangeVal = document.getElementById('time-range-select').value;
    const num = parseInt(rangeVal);
    let cutoffTime = Date.now();
    
    if (rangeVal.endsWith('m')) cutoffTime -= num * 60 * 1000;
    else if (rangeVal.endsWith('h')) cutoffTime -= num * 60 * 60 * 1000;
    
    const filtered = globalHistoryData.filter(item => new Date(item.created_at).getTime() >= cutoffTime);
    
    const taSeries = filtered.map(item => [new Date(item.created_at).getTime(), parseFloat(item.ta)]);
    const rhSeries = filtered.map(item => [new Date(item.created_at).getTime(), parseFloat(item.rh)]);
    const tgSeries = filtered.map(item => [new Date(item.created_at).getTime(), parseFloat(item.tg)]);
    const wbgtSeries = filtered.map(item => [new Date(item.created_at).getTime(), parseFloat(item.wbgt)]);
    
    lineChart.setOption({
        series: [ { data: taSeries }, { data: rhSeries }, { data: tgSeries }, { data: wbgtSeries } ]
    });
}
document.getElementById('time-range-select').addEventListener('change', filterAndRenderTrend);

// 8. 实时数据纯渲染管道 (全公式移除，实现完全零计算)
const baseUrl = window.location.origin; 
const targetSensorId = '1';

function renderDashboard(data) {
    if (!data) return;
    const wbgt = parseFloat(data.wbgt);
    const ta = parseFloat(data.ta);
    const tg = parseFloat(data.tg);
    const rh = parseFloat(data.rh);

    // 1. 基础传感器指标写入
    document.getElementById('val-ta').innerText = ta.toFixed(1);
    document.getElementById('val-tg').innerText = tg.toFixed(1);
    document.getElementById('val-rh').innerText = rh.toFixed(1);

    // 2. 动态检测 API 中是否存在风速(WS)数据流
    const wsVal = data.ws ?? data.WS;
    if (wsVal !== undefined && wsVal !== null) {
        document.getElementById('val-ws').innerText = parseFloat(wsVal).toFixed(1);
    } else {
        document.getElementById('val-ws').innerText = "--.-";
    }

    // 3. 动态检测 API 中是否存在太阳辐射数据流（兼容支持 se / sr 字段名）
    const srVal = data.sr ?? data.se ?? data.SR ?? data.SE;
    if (srVal !== undefined && srVal !== null) {
        document.getElementById('val-sr').innerText = parseFloat(srVal).toFixed(1);
    } else {
        document.getElementById('val-sr').innerText = "--.-";
    }
    
    // 4. 后端全量衍生指标数据注入渲染
    if (data.e !== undefined && data.e !== null) document.getElementById('val-e').innerText = parseFloat(data.e).toFixed(1);
    if (data.tnw !== undefined && data.tnw !== null) document.getElementById('val-tnw').innerText = parseFloat(data.tnw).toFixed(1);
    if (data.vpd !== undefined && data.vpd !== null) document.getElementById('val-vpd').innerText = parseFloat(data.vpd).toFixed(2);
    if (data.skin_wettedness !== undefined && data.skin_wettedness !== null) document.getElementById('val-skin').innerText = parseFloat(data.skin_wettedness).toFixed(1);

    updateRiskUI(wbgt);
    barChart.setOption({ series: [{ data: [ta.toFixed(1), rh.toFixed(1), wbgt.toFixed(1)] }] });
}

// 9. 数据初始化及长轮询
function loadHistoryData() {
    fetch(`${baseUrl}/api/history/${targetSensorId}`)
        .then(res => res.json())
        .then(history => {
            if (!Array.isArray(history)) return;
            globalHistoryData = history;
            filterAndRenderTrend();
            syncLineVisibility();
            if (history.length > 0) renderDashboard(history[history.length - 1]);
        })
        .catch(err => console.error("趋势链路通讯故障:", err));
}

function pollRealtimeData() {
    fetch(`${baseUrl}/api/realtime/${targetSensorId}`)
        .then(res => res.json())
        .then(data => {
            if (data) {
                renderDashboard(data);
                if (globalHistoryData.length > 0) {
                    const lastSec = globalHistoryData[globalHistoryData.length - 1];
                    if (!data.created_at || new Date(data.created_at).getTime() > new Date(lastSec.created_at).getTime()) {
                        data.created_at = new Date().toISOString(); 
                        globalHistoryData.push(data);
                        filterAndRenderTrend();
                    }
                }
            }
        })
        .catch(err => console.error("实时管道读取异常:", err));
}

// ================= 10. 系统多模块健康状态检查 =================
function checkSystemStatus() {
    const badge = document.getElementById('system-status-badge');
    if (!badge) return;

    // 统一使用 .json() 解析后端传来的 { status: 'ok' } 数据
    Promise.all([
        fetch(`${baseUrl}/api/health`).then(res => res.json()).catch(() => ({ status: 'error' })),
        fetch(`${baseUrl}/api/db-status`).then(res => res.json()).catch(() => ({ status: 'error' })),
        fetch(`${baseUrl}/api/mqtt-status`).then(res => res.json()).catch(() => ({ status: 'error' }))
    ]).then(([healthData, dbData, mqttData]) => {
        // 安全读取状态字段
        const isHealthOk = healthData?.status === 'ok';
        const isDbOk = dbData?.status === 'ok';
        const isMqttOk = mqttData?.status === 'ok';

        let notOkCount = 0;
        if (!isHealthOk) notOkCount++;
        if (!isDbOk) notOkCount++;
        if (!isMqttOk) notOkCount++;

        // 逻辑判定 1：两个及以上模块没有 OK -> 显示系统运行降级
        if (notOkCount >= 2) {
            badge.innerText = '● 系统运行降级';
            badge.style.color = '#ef4444'; 
            return;
        }

        // 逻辑判定 2：全部正常 -> 显示系统运行正常
        if (notOkCount === 0) {
            badge.innerText = '● 系统运行正常';
            badge.style.color = '#4ade80'; 
            return;
        }

        // 逻辑判定 3：只有一个模块没有 OK，精准提示单点错误
        if (!isHealthOk) {
            badge.innerText = '● 系统错误';
            badge.style.color = '#f97316'; 
        } else if (!isDbOk) {
            badge.innerText = '● DB错误';
            badge.style.color = '#f97316';
        } else if (!isMqttOk) {
            badge.innerText = '● MQTT错误';
            badge.style.color = '#f97316';
        }
    }).catch(err => {
        console.error("健康检查异常:", err);
    });
}

// 绑定手动刷新事件
const manualRefreshBtn = document.getElementById('btn-manual-refresh');
if (manualRefreshBtn) {
    manualRefreshBtn.addEventListener('click', () => {
        manualRefreshBtn.classList.add('refreshing');
        pollRealtimeData();
        // 动画控制
        setTimeout(() => {
            manualRefreshBtn.classList.remove('refreshing');
        }, 800);
    });
}

// 初始化执行一次，之后每 5 秒自动轮询检查一次状态
checkSystemStatus();
setInterval(checkSystemStatus, 5000);

loadHistoryData();
// 变更为 5 分钟 (300000毫秒) 常规自动刷新机制
setInterval(pollRealtimeData, 300000);

window.addEventListener('resize', () => { barChart.resize(); lineChart.resize(); });