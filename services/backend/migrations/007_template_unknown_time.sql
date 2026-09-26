-- Historical templates have no recorded modification time in some source rows.
-- Missing is not the import time. Runtime writes continue using server clocks.
ALTER TABLE ride_templates ALTER COLUMN updated_at DROP NOT NULL;
