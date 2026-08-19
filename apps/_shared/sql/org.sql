-- 组织主库（门户 + RMS 共用）：首次安装由系统自动执行
-- CREATE DATABASE 由安装程序完成，本文件只建表

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  volunteer_id INT UNSIGNED NULL,
  status TINYINT NOT NULL DEFAULT 1 COMMENT '1待命 2不可用 3响应中 4到达现场 5紧急 6离线',
  current_event_id INT NULL DEFAULT NULL,
  pending_event_id INT NULL DEFAULT NULL,
  last_login DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_volunteer (volunteer_id),
  KEY idx_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS volunteers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(128) NOT NULL,
  badge_number VARCHAR(64) NULL,
  blood_type VARCHAR(16) NULL,
  phone VARCHAR(20) NULL,
  agency VARCHAR(64) NOT NULL DEFAULT '',
  avatar_url VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  join_date DATE NULL,
  PRIMARY KEY (id),
  KEY idx_vol_badge (badge_number),
  KEY idx_vol_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS certs_internal (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  volunteer_id INT UNSIGNED NOT NULL,
  cert_name VARCHAR(255) NOT NULL,
  issue_date DATE NULL,
  image_url VARCHAR(255) NULL,
  show_on_dispatch TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_ci_vol (volunteer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS certs_external (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  volunteer_id INT UNSIGNED NOT NULL,
  cert_name VARCHAR(255) NOT NULL,
  issue_date DATE NULL,
  expiry_date DATE NULL,
  image_url VARCHAR(255) NULL,
  show_on_dispatch TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_ce_vol (volunteer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  priority TINYINT NOT NULL DEFAULT 3,
  status VARCHAR(32) NOT NULL DEFAULT '未完成',
  responder_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_events_status (status),
  KEY idx_events_priority (priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category VARCHAR(64) NOT NULL COMMENT '分类，如 branding / rms',
  setting_key VARCHAR(128) NOT NULL COMMENT '键名',
  setting_value TEXT NOT NULL COMMENT '值',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_settings_cat_key (category, setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='统一平台系统设置';

CREATE TABLE IF NOT EXISTS org_settings_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  action VARCHAR(64) NOT NULL DEFAULT 'update_settings',
  actor_user_id INT NULL,
  actor_username VARCHAR(64) NULL,
  category VARCHAR(64) NULL,
  summary VARCHAR(500) NOT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  detail JSON NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_osl_time (created_at),
  KEY idx_osl_actor (actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS org_profile_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  action VARCHAR(64) NOT NULL,
  actor_user_id INT NULL,
  actor_username VARCHAR(64) NULL,
  volunteer_id INT NOT NULL,
  volunteer_name VARCHAR(128) NULL,
  target_user_id INT NULL,
  entity_type VARCHAR(32) NULL,
  entity_id INT NULL,
  summary VARCHAR(500) NOT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  detail JSON NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_opl_vol_time (volunteer_id, created_at),
  KEY idx_opl_action_time (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rms_status_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  action VARCHAR(64) NOT NULL,
  from_status TINYINT NULL,
  to_status TINYINT NULL,
  actor_user_id INT NULL,
  actor_username VARCHAR(64) NULL,
  target_user_id INT NOT NULL,
  target_username VARCHAR(64) NULL,
  event_id INT NULL,
  event_title VARCHAR(255) NULL,
  summary VARCHAR(500) NOT NULL,
  detail JSON NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rsl_target_time (target_user_id, created_at),
  KEY idx_rsl_action_time (action, created_at),
  KEY idx_rsl_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rms_event_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  action VARCHAR(64) NOT NULL,
  actor_user_id INT NULL,
  actor_username VARCHAR(64) NULL,
  target_user_id INT NULL,
  target_username VARCHAR(64) NULL,
  event_id INT NOT NULL,
  event_title VARCHAR(255) NULL,
  summary VARCHAR(500) NOT NULL,
  detail JSON NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rel_event_time (event_id, created_at),
  KEY idx_rel_action_time (action, created_at),
  KEY idx_rel_target_time (target_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dispatch_message_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind ENUM('unicast','broadcast','emergency') NOT NULL,
  channel VARCHAR(16) NOT NULL DEFAULT 'terminal',
  batch_id CHAR(36) NULL,
  actor_user_id INT NULL,
  actor_username VARCHAR(64) NULL,
  recipient_user_id INT NOT NULL,
  recipient_username VARCHAR(64) NULL,
  recipient_display_name VARCHAR(128) NULL,
  scope VARCHAR(32) NULL,
  scope_label VARCHAR(255) NULL,
  message TEXT NOT NULL,
  detail JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dml_recipient_time (recipient_user_id, created_at),
  KEY idx_dml_kind_time (kind, created_at),
  KEY idx_dml_batch (batch_id),
  KEY idx_dml_actor_time (actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) NOT NULL,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT,
  PRIMARY KEY (session_id),
  KEY idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  jti VARCHAR(64) NOT NULL,
  user_id INT NOT NULL,
  username VARCHAR(64) NULL,
  role VARCHAR(32) NULL,
  volunteer_id INT NULL,
  family_id VARCHAR(64) NOT NULL,
  exp INT UNSIGNED NOT NULL,
  revoked TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (jti),
  KEY idx_art_user (user_id),
  KEY idx_art_exp (exp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
