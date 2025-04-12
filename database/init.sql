-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Organization members table
CREATE TABLE IF NOT EXISTS organization_members (
    organization_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (organization_id, user_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    organization_id INTEGER NOT NULL,
    start_date DATETIME,
    end_date DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

-- Event participants table
CREATE TABLE IF NOT EXISTS event_participants (
    event_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, user_id),
    FOREIGN KEY (event_id) REFERENCES events(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Matches table
CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- Match players table
CREATE TABLE IF NOT EXISTS match_players (
    match_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    position INTEGER NOT NULL, -- Position in the match (1, 2, etc.)
    reported_score TEXT, -- JSON containing scores for all players
    reported_at DATETIME,
    final_score INTEGER,
    PRIMARY KEY (match_id, user_id),
    FOREIGN KEY (match_id) REFERENCES matches(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Sessions table for connect-sqlite3
CREATE TABLE IF NOT EXISTS sessions (
    sid PRIMARY KEY,
    expired,
    sess
);

-- Organization bans table
CREATE TABLE IF NOT EXISTS organization_bans (
    organization_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    banned_by INTEGER NOT NULL,
    banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (organization_id, user_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (banned_by) REFERENCES users(id)
);

-- Organization admins table
CREATE TABLE IF NOT EXISTS organization_admins (
    organization_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    PRIMARY KEY (organization_id, user_id)
);

-- Event applications table
CREATE TABLE IF NOT EXISTS event_applications (
    event_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, user_id),
    FOREIGN KEY (event_id) REFERENCES events(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
); 