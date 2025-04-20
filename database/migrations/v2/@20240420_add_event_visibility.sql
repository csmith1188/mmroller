-- Add visibility column to events table
ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('hidden', 'private', 'public', 'open'));
 
-- Update existing events to have 'private' visibility
UPDATE events SET visibility = 'private' WHERE visibility IS NULL; 