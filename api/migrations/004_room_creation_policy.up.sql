CREATE TABLE IF NOT EXISTS application_settings (
  setting_key VARCHAR(80) PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO application_settings (setting_key, enabled)
VALUES ('registered_room_creation', true)
ON CONFLICT (setting_key) DO NOTHING;
