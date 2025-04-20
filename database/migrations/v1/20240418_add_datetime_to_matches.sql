-- Add datetime column to matches table
ALTER TABLE matches ADD COLUMN datetime TEXT;

-- Update existing matches to use created_at as datetime
UPDATE matches SET datetime = created_at WHERE datetime IS NULL; 