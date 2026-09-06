/** 北京天安门（高德 / GCJ-02）。浏览器定位失败或非 HTTPS 时使用。 */
var RTLS_DEFAULT_CENTER = [39.908823, 116.39747];
var RTLS_DEFAULT_ZOOM = 16;

function wgs84ToGcj02(lng, lat) {
    var pi = 3.14159265358979324;
    var a = 6378245.0;
    var ee = 0.00669342162296594323;
    var x = lng - 105.0;
    var y = lat - 35.0;
    var dLat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    dLat += (20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0 / 3.0;
    dLat += (20.0 * Math.sin(y * pi) + 40.0 * Math.sin(y / 3.0 * pi)) * 2.0 / 3.0;
    dLat += (160.0 * Math.sin(y / 12.0 * pi) + 320 * Math.sin(y * pi / 30.0)) * 2.0 / 3.0;
    var dLng = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    dLng += (20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0 / 3.0;
    dLng += (20.0 * Math.sin(x * pi) + 40.0 * Math.sin(x / 3.0 * pi)) * 2.0 / 3.0;
    dLng += (150.0 * Math.sin(x / 12.0 * pi) + 300.0 * Math.sin(x / 30.0 * pi)) * 2.0 / 3.0;
    var radLat = lat / 180.0 * pi;
    var magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * pi);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * pi);
    return [lat + dLat, lng + dLng];
}

/**
 * 用浏览器定位把地图挪到当前位置（WGS84 → 高德 GCJ-02）。
 * isStale() 为 true 时丢弃结果（例如已加载赛道、已点选设备、弹窗已关掉）。
 */
function locateMapByBrowser(map, zoom, isStale) {
    if (!map || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
        if (typeof isStale === 'function' && isStale()) return;
        var gcj = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude);
        map.setView(gcj, zoom || RTLS_DEFAULT_ZOOM);
    }, function () {
        /* 拒绝授权、超时、或 HTTP 非安全源：保持默认天安门 */
    }, {
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 60000
    });
}
