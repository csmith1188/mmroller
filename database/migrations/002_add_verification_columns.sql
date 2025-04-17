-- Add verification token and last verification email timestamp columns if they don't exist
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

-- Copy data from old table to new table
INSERT INTO temp_users (id, username, email, password_hash, discord_id, avatar, created_at, updated_at, verified)
SELECT id, username, email, password_hash, discord_id, avatar, created_at, updated_at, verified
FROM users;

-- Drop old table
DROP TABLE users;

-- Rename new table to old name
ALTER TABLE temp_users RENAME TO users; 