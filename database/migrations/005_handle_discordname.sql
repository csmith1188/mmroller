-- First, update usernames with discordnames where username is empty or null
UPDATE users 
SET username = discordname 
WHERE (username IS NULL OR username = '') 
AND discordname IS NOT NULL 
AND discordname != '';

-- Check if discordname column exists
CREATE TABLE IF NOT EXISTS temp_check (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discordname TEXT
);

-- If the above succeeds, discordname column exists
-- Create a temporary table without the discordname column
CREATE TABLE IF NOT EXISTS temp_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,
    discord_id TEXT UNIQUE,
    avatar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    verified INTEGER DEFAULT 0,
    verification_token TEXT,
    last_verification_email DATETIME,
    reset_token TEXT,
    reset_token_expiry DATETIME
);

-- Copy data from old table to new table
INSERT INTO temp_users (
    id, username, email, password_hash, discord_id, avatar, 
    created_at, updated_at, verified, verification_token, 
    last_verification_email, reset_token, reset_token_expiry
)
SELECT 
    id,
    username,
    email, password_hash, discord_id, avatar,
    created_at, updated_at, verified, verification_token,
    last_verification_email, reset_token, reset_token_expiry
FROM users;

-- Drop old table
DROP TABLE users;

-- Rename new table to old name
ALTER TABLE temp_users RENAME TO users;

-- Clean up temporary table
DROP TABLE temp_check; 