-- RTLS 库：首次安装由系统自动执行

CREATE TABLE IF NOT EXISTS device_config (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id VARCHAR(128) NOT NULL,
  nickname VARCHAR(128) NULL,
  role VARCHAR(64) NULL,
  remark VARCHAR(255) NULL,
  icon_type VARCHAR(64) NULL,
  is_enabled TINYINT NOT NULL DEFAULT 1,
  last_update BIGINT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_device_id (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_config_meta (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_name VARCHAR(255) NOT NULL DEFAULT '指挥大屏',
  kml_data LONGTEXT NULL,
  marker_data LONGTEXT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO event_config_meta (id, event_name, kml_data, marker_data)
VALUES (1, '指挥大屏', '[]', '[]');

CREATE TABLE IF NOT EXISTS schedule_alerts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  al_date DATE NULL,
  al_time TIME NULL,
  al_name VARCHAR(255) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_markers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(64) NULL,
  lat DOUBLE NOT NULL,
  lng DOUBLE NOT NULL,
  remark VARCHAR(255) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
