-- Add match_blind_sharing column to events table
ALTER TABLE events ADD COLUMN match_blind_sharing BOOLEAN DEFAULT FALSE; 