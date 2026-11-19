-- Additive only: nothing here changes or removes existing data.
-- Optional per-seat label placement on the map (NULL = chosen automatically).
ALTER TABLE resources ADD COLUMN IF NOT EXISTS label_side TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resources_label_side_check') THEN
    ALTER TABLE resources ADD CONSTRAINT resources_label_side_check CHECK (label_side IS NULL OR label_side IN ('top', 'bottom', 'left', 'right'));
  END IF;
END $$;

-- The "who is booked on this day" lookup behind GET /api/availability.
CREATE INDEX IF NOT EXISTS bookings_confirmed_time_idx ON bookings(starts_at, ends_at) WHERE status = 'confirmed';

-- Version counter that tells browsers when settings, teams or the map changed (see server/config-version.js).
INSERT INTO app_settings (key, value) VALUES ('config_version', '1'::jsonb) ON CONFLICT (key) DO NOTHING;
