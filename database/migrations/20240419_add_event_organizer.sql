-- Add is_organizer column to event_participants table
ALTER TABLE event_participants ADD COLUMN is_organizer INTEGER DEFAULT 0;

-- Update existing records to set is_organizer for organization admins
UPDATE event_participants
SET is_organizer = 1
WHERE EXISTS (
    SELECT 1 FROM organization_admins
    WHERE organization_admins.organization_id = (
        SELECT organization_id FROM events WHERE events.id = event_participants.event_id
    )
    AND organization_admins.user_id = event_participants.user_id
); 