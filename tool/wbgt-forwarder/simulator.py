import serial
import time
import random

# 请确保你已经创建了虚拟串口对，并在此处填入发送端的 COM 口（例如 COM1）
PORT = 'COM23'
BAUD_RATE = 9600

def generate_mock_data():
    # 生成模拟数据
    wbgt = random.uniform(24.0, 26.0)
    ta = random.uniform(25.0, 30.0)
    tg = random.uniform(30.0, 35.0)
    rh = random.uniform(40.0, 45.0)

    # 格式: Wxxx.xC:Txxx.xC:Txxx.xC:Hxx.x%LRCCRLF
    # 注意：这里模拟了你要求的协议格式，末尾加上 \r\n (CRLF)
    data = f"W{wbgt:.1f}C:T{ta:.1f}C:T{tg:.1f}C:H{rh:.1f}%LR\r\n"
    return data

try:
    ser = serial.Serial(PORT, BAUD_RATE, timeout=1)
    print(f"模拟器已在 {PORT} 启动，开始发送数据...")

    while True:
        data = generate_mock_data()
        ser.write(data.encode('ascii'))
        print(f"正在发送: {data.strip()}")
        time.sleep(2) # 每2秒发一次
except Exception as e:
    print(f"串口错误: {e}")
