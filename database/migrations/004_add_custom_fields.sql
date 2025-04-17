-- Create table for custom fields
CREATE TABLE IF NOT EXISTS event_custom_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    field_description TEXT,
    is_private INTEGER DEFAULT 0,
    is_required INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- Create table for participant responses to custom fields
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