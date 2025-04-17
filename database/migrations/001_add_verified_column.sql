-- Add verified column to users table
ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0;

-- Set verified status for Discord users
UPDATE users SET verified = 1 WHERE discord_id IS NOT NULL; 