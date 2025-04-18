-- Check if datetime column exists and add it if it doesn't
SELECT CASE 
    WHEN NOT EXISTS (SELECT 1 FROM pragma_table_info('matches') WHERE name = 'datetime') 
    THEN 'ALTER TABLE matches ADD COLUMN datetime TEXT;'
    ELSE 'SELECT 1;'
END;

-- Update existing matches to use created_at as datetime
UPDATE matches SET datetime = created_at WHERE datetime IS NULL; 