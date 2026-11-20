-- Migration 009: per-event RSVP toggle ("I am going")
ALTER TABLE events ADD COLUMN IF NOT EXISTS rsvp_enabled BOOLEAN NOT NULL DEFAULT TRUE;
