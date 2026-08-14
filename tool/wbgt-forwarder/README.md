# WBGT 串口转发器

把现场湿球黑球温度探头的 **USB 串口数据** 发到 MQTT，供 **统一组织系统** 的 `/wbgt/` 大屏使用。发布到 GitHub 后把平台仓库地址填在这里。

安装包对外名称是「WBGT串口转发工具」，成品文件常叫 `端口转发.exe`。  
**不是路由器端口映射 / NAT。** 「转发」指：串口一行 → MQTT 主题 `wbgt/{传感器编号}`。

| | |
|---|---|
| 语言 | Python 3 |
| 界面 | PyQt6 |
| 总线 | MQTT（paho-mqtt） |
| 探头 | 串口 9600 8N1（pyserial） |

---

## 它做什么

```text
探头 USB
  → 本程序读一行
  → publish  wbgt/{sensor_id}
  → 统一平台 WBGT 订阅 wbgt/#
  → 浏览器 /wbgt/
```

没有真探头时，可用同目录 `simulator.py` + 虚拟串口对做联调。

---

## 协议

探头（或模拟器）每行：

```text
W25.3C:T28.1C:T32.4C:H42.0%LR
```

| 字段 | 含义 |
|------|------|
| `W` | WBGT ℃ |
| 第一个 `T` | 环境温度 Ta ℃ |
| 第二个 `T` | 黑球温度 Tg ℃ |
| `H` | 相对湿度 % |

平台侧正则：`W([\d.]+)C:T([\d.]+)C:T([\d.]+)C:H([\d.]+)%`  
大屏默认读取传感器编号 **`1`**。

---

## 快速开始

```bash
cd 端口转发源码
pip install -r requirements.txt
copy config.example.json config.json
python main.py
```

1. 改 `config.json` 里的 `mqtt_broker` / `mqtt_port`，与平台 `apps/wbgt/.env` 的 `MQTT_BROKER` **同一台**
2. 选 COM 口，传感器编号填 `1`
3. 点「开始监测发射」

无探头：

1. 安装虚拟串口对（两个 COM 互相连通）
2. 改 `simulator.py` 的 `PORT` 为其中一端，运行 `python simulator.py`
3. 本程序选另一端

---

## 配置 `config.json`

```json
{
    "mqtt_broker": "127.0.0.1",
    "mqtt_port": 1883,
    "sensor_id": "1",
    "baud_rate": 9600,
    "app_title": "WBGT串口转发工具",
    "footer_text": "技术支持：北岸救援"
}
```

| 键 | 说明 |
|----|------|
| `mqtt_broker` | Broker 主机名或 IP，不要带 `mqtt://` |
| `mqtt_port` | 一般为 `1883` |
| `sensor_id` | 对应主题 `wbgt/{id}`，须与大屏一致 |
| `baud_rate` | 探头波特率，常见 `9600` |

本机调试用 `127.0.0.1`。活动现场若 Mosquitto 在内网某台机器上，填那台内网 IP。  
只有赛场电脑在公网、broker 在内网时，才需要在 **路由器** 上把 WAN `1883` 转到内网 Mosquitto——那是网络部署，不是本程序。

---

## 对接统一平台

1. 平台已安装，且 `apps/wbgt/.env` 配了 PostgreSQL + `MQTT_BROKER`
2. 那台 MQTT 已在跑（如 Mosquitto 监听 1883）
3. 两边地址一致，例如都是 `127.0.0.1:1883` 或都是 `192.168.x.x:1883`
4. 登录后打开 `/wbgt/`，右上角 MQTT 应为正常；发射后指数会变

实时画面进内存即可显示；历史曲线按平台规则约每 5 分钟落库一条。

---

## 打包 Windows 程序

```bash
pip install pyinstaller
pyinstaller 端口转发.spec
```

产物：`dist/端口转发.exe`。运行目录旁需有 `config.json`。

历史上 `EXE成品/端口转发.exe` 与 `dist/北岸医疗-数据终端.exe` 是同一份 PyInstaller 构建（仅文件名不同），源码即本目录 `main.py`，无需反编译。

安装包脚本（Inno Setup）在上一级 `EXE安装包/`，应用名「WBGT串口转发工具」。

---

## 依赖

见 `requirements.txt`：

```text
paho-mqtt
pyserial
PyQt6
```

---

## 源码说明

| 文件 | 作用 |
|------|------|
| `main.py` | 界面 + 串口读取 + MQTT 发布 |
| `simulator.py` | 虚拟探头 |
| `config.example.json` | 配置模板 |
| `端口转发.spec` | PyInstaller |

上一级目录里的 `main.py` 是同一份程序的原件；本文件夹是整理后的开源副本。

---

## 许可证

与统一组织系统一并发布时，请补上 `LICENSE`。未放许可证文件时，默认保留著作权。
