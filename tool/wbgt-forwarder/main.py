import sys
import json
import os
import serial
import serial.tools.list_ports
import paho.mqtt.client as mqtt
from datetime import datetime
from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QPushButton,
                             QComboBox, QLineEdit, QLabel, QTextEdit)
from PyQt6.QtCore import QThread, pyqtSignal, QTimer, Qt

CONFIG_FILE = "config.json"

# 美化风格定义
STYLE_SHEET = """
QWidget { background-color: #E3F2FD; font-family: 'Microsoft YaHei'; }
QLabel { color: #1565C0; font-weight: bold; }
QPushButton { background-color: #0D47A1; color: white; border-radius: 5px; padding: 8px; }
QPushButton:hover { background-color: #1976D2; }
QPushButton:disabled { background-color: #90A4AE; }
QLineEdit, QComboBox, QTextEdit { border: 1px solid #90A4AE; border-radius: 3px; padding: 5px; background-color: white; }
"""

class Worker(QThread):
    status_signal = pyqtSignal(str)
    data_signal = pyqtSignal(str)

    def __init__(self, port, baud, broker, port_num, sensor_id):
        super().__init__()
        self.port, self.baud, self.broker, self.port_num, self.sensor_id = port, baud, broker, port_num, sensor_id
        self.running = True

    def run(self):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        try:
            client.connect(self.broker, int(self.port_num), 60)
            self.status_signal.emit("已连接服务器")
            client.loop_start()

            ser = serial.Serial(self.port, self.baud, timeout=1)
            while self.running:
                if ser.in_waiting:
                    line = ser.readline().decode('utf-8', errors='ignore').strip()
                    if line:
                        client.publish(f"wbgt/{self.sensor_id}", line)
                        self.data_signal.emit(line)
        except Exception as e:
            self.status_signal.emit(f"错误: {str(e)}")
        finally:
            client.loop_stop()
            client.disconnect()

class WBGTApp(QWidget):
    def __init__(self):
        super().__init__()
        self.setStyleSheet(STYLE_SHEET)
        self.config = self.load_config()
        self.worker = None
        self.init_ui()

    def load_config(self):
        default = {
            "mqtt_broker": "127.0.0.1", "mqtt_port": 1883, "sensor_id": "1",
            "baud_rate": 9600, "app_title": "软件标题",
            "footer_text": "软件底部文字"
        }
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding='utf-8') as f: return json.load(f)
        return default

    def init_ui(self):
        self.setWindowTitle(self.config.get("app_title", "数据发射终端"))
        self.resize(350, 500)
        layout = QVBoxLayout()

        # 顶部时间
        self.time_label = QLabel()
        layout.addWidget(self.time_label, alignment=Qt.AlignmentFlag.AlignCenter)
        self.timer = QTimer()
        self.timer.timeout.connect(lambda: self.time_label.setText(datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
        self.timer.start(1000)

        layout.addWidget(QLabel("选择串口:"))
        self.port_combo = QComboBox()
        self.port_combo.addItems([p.device for p in serial.tools.list_ports.comports()])
        layout.addWidget(self.port_combo)

        layout.addWidget(QLabel("传感器编号:"))
        self.id_input = QLineEdit(str(self.config.get("sensor_id", "1")))
        layout.addWidget(self.id_input)

        self.status_label = QLabel("状态: 等待连接")
        layout.addWidget(self.status_label)

        layout.addWidget(QLabel("实时传输数据流:"))
        self.log_display = QTextEdit()
        self.log_display.setReadOnly(True)
        self.log_display.setMaximumHeight(150)
        layout.addWidget(self.log_display)

        self.btn = QPushButton("开始监测发射")
        self.btn.clicked.connect(self.toggle_transmission)
        layout.addWidget(self.btn)

        layout.addStretch()
        layout.addWidget(QLabel(self.config.get("footer_text", ""), alignment=Qt.AlignmentFlag.AlignCenter))
        layout.addWidget(QLabel(f"© {datetime.now().year} 系统保障架构与维护", alignment=Qt.AlignmentFlag.AlignCenter))

        self.setLayout(layout)

    def toggle_transmission(self):
        if self.worker and self.worker.isRunning():
            self.worker.running = False
            self.btn.setText("开始监测发射")
            self.status_label.setText("状态: 已停止")
        else:
            self.worker = Worker(self.port_combo.currentText(), self.config["baud_rate"],
                                 self.config["mqtt_broker"], self.config["mqtt_port"], self.id_input.text())
            self.worker.status_signal.connect(lambda s: self.status_label.setText(f"状态: {s}"))
            self.worker.data_signal.connect(lambda d: self.log_display.append(f"[{datetime.now().strftime('%H:%M:%S')}] {d}"))
            self.worker.start()
            self.btn.setText("停止转发")

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = WBGTApp()
    window.show()
    sys.exit(app.exec())
