-- Create temporary table without discordname
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
    last_verification_email DATETIME
);

-- Copy data from old table to new table, using discordname as username if username is null
INSERT INTO temp_users (id, username, email, password_hash, discord_id, avatar, created_at, updated_at, verified, verification_token, last_verification_email)
SELECT 
    id,
    COALESCE(username, discordname) as username,
    email,
    password_hash,
    discord_id,
    avatar,
    created_at,
    updated_at,
    verified,
    verification_token,
    last_verification_email
FROM users;

-- Drop old table
DROP TABLE users;

-- Rename new table to old name
ALTER TABLE temp_users RENAME TO users; 