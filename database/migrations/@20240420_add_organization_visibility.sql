-- Add visibility column to organizations table
ALTER TABLE organizations ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('hidden', 'private', 'public', 'open'));

-- Update existing organizations to have 'private' visibility
UPDATE organizations SET visibility = 'private' WHERE visibility IS NULL; 