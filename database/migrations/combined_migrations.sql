-- Initial tables creation
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,
    discord_id TEXT UNIQUE,
    discordname TEXT,
    avatar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    start_date DATETIME,
    end_date DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    player1_id INTEGER NOT NULL,
    player2_id INTEGER NOT NULL,
    winner_id INTEGER,
    score TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (player1_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (player2_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Migration 001: Add verified column to users table
CREATE TABLE IF NOT EXISTS temp_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,
    discord_id TEXT UNIQUE,
    discordname TEXT,
    avatar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    verified INTEGER DEFAULT 0
);

-- Copy data from old table to new table
INSERT INTO temp_users (id, username, email, password_hash, discord_id, discordname, avatar, created_at, updated_at, verified)
SELECT id, username, email, password_hash, discord_id, discordname, avatar, created_at, updated_at,
       CASE WHEN discord_id IS NOT NULL THEN 1 ELSE 0 END as verified
FROM users;

-- Drop old table
DROP TABLE users;

-- Rename new table to old name
ALTER TABLE temp_users RENAME TO users;

-- Migration 002: Add verification token and last verification email timestamp columns
CREATE TABLE IF NOT EXISTS temp_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,
    discord_id TEXT UNIQUE,
    discordname TEXT,
    avatar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    verified INTEGER DEFAULT 0,
    verification_token TEXT,
    last_verification_email DATETIME
);

-- Copy data from old table to new table
INSERT INTO temp_users (id, username, email, password_hash, discord_id, discordname, avatar, created_at, updated_at, verified)
SELECT id, username, email, password_hash, discord_id, discordname, avatar, created_at, updated_at, verified
FROM users;

-- Drop old table
DROP TABLE users;

-- Rename new table to old name
ALTER TABLE temp_users RENAME TO users;

-- Migration 003: Add password reset columns to users table
ALTER TABLE users ADD COLUMN reset_token TEXT;
ALTER TABLE users ADD COLUMN reset_token_expiry DATETIME;

-- Migration 004: Add custom fields tables
CREATE TABLE IF NOT EXISTS event_custom_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    field_description TEXT,
    field_type TEXT NOT NULL DEFAULT 'short',
    is_private INTEGER DEFAULT 0,
    is_required INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS participant_custom_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    field_id INTEGER NOT NULL,
    response TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (field_id) REFERENCES event_custom_fields(id) ON DELETE CASCADE,
    UNIQUE(event_id, user_id, field_id)
);

-- Migration 005: Add match blind sharing to events table
ALTER TABLE events ADD COLUMN match_blind_sharing BOOLEAN DEFAULT FALSE;

-- Migration 006: Add datetime to matches table
ALTER TABLE matches ADD COLUMN datetime TEXT;
UPDATE matches SET datetime = created_at WHERE datetime IS NULL;

-- Migration 007: Handle discordname column
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

-- Copy data from old table to new table, using discordname for username if available
INSERT INTO temp_users (
    id, username, email, password_hash, discord_id, avatar, 
    created_at, updated_at, verified, verification_token, 
    last_verification_email, reset_token, reset_token_expiry
)
SELECT 
    id,
    CASE 
        WHEN discordname IS NOT NULL AND discordname != '' THEN discordname
        ELSE username
    END as username,
    email, password_hash, discord_id, avatar,
    created_at, updated_at, verified, verification_token,
    last_verification_email, reset_token, reset_token_expiry
FROM users;

-- Drop old table
DROP TABLE users;

-- Rename new table to old name
ALTER TABLE temp_users RENAME TO users;

-- Migration 008: Add match custom fields tables
CREATE TABLE IF NOT EXISTS match_custom_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    field_description TEXT,
    field_type TEXT NOT NULL DEFAULT 'text',
    is_required INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS match_custom_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    field_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    response TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
    FOREIGN KEY (field_id) REFERENCES match_custom_fields(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(match_id, field_id, user_id)
);