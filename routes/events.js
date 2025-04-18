const express = require('express');
const router = express.Router();

function formatDescription(description) {
    if (!description) return '';
    
    // Remove all \r characters
    let formatted = description.replace(/\r/g, '');
    
    // Replace \n with <br>
    formatted = formatted.replace(/\n/g, '<br>');
    
    // Replace multiple consecutive <br> with a maximum of two
    formatted = formatted.replace(/(<br>){3,}/g, '<br><br>');
    
    // Truncate to 128 characters and add ellipsis if needed
    if (formatted.length > 128) {
        formatted = formatted.substring(0, 128).trim() + '...';
    }
    
    return formatted;
}

function formatDescriptionNoTruncate(description) {
    if (!description) return '';
    
    // Remove all \r characters
    let formatted = description.replace(/\r/g, '');
    
    // Replace \n with <br>
    formatted = formatted.replace(/\n/g, '<br>');
    
    // Replace multiple consecutive <br> with a maximum of two
    formatted = formatted.replace(/(<br>){3,}/g, '<br><br>');
    
    return formatted;
}

// Event routes
router.get('/events/:id', async (req, res) => {
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;

    try {
        // Get event details with participant status and admin check
        const event = await new Promise((resolve, reject) => {
            db.get(`
                SELECT e.*, 
                       o.name as organization_name,
                       CASE WHEN ep.user_id IS NOT NULL THEN 1 ELSE 0 END as is_participant,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = e.organization_id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin
                FROM events e
                JOIN organizations o ON e.organization_id = o.id
                LEFT JOIN event_participants ep ON e.id = ep.event_id AND ep.user_id = ?
                WHERE e.id = ?
            `, [userId, userId, eventId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!event) {
            return res.status(404).send('Event not found');
        }

        // Format the event description based on admin status
        event.description = event.is_admin ? 
            event.description : 
            formatDescriptionNoTruncate(event.description);

        // Check if user is banned from the event
        const isBanned = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM event_bans
                WHERE event_id = ? AND user_id = ? AND status = 'active'
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (isBanned && !event.is_admin) {
            return res.status(403).send('You are banned from this event');
        }

        // Get event participants
        const participants = await new Promise((resolve, reject) => {
            db.all(`
                SELECT u.id, u.username as display_name,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = e.organization_id AND user_id = u.id
                       ) THEN 1 ELSE 0 END as is_admin,
                       CASE WHEN eb.status = 'active' THEN 1 ELSE 0 END as is_banned,
                       pes.mmr as mmr,
                       pes.matches_played,
                       pes.wins
                FROM users u
                JOIN event_participants ep ON u.id = ep.user_id
                JOIN events e ON e.id = ep.event_id
                LEFT JOIN event_bans eb ON eb.event_id = e.id AND eb.user_id = u.id
                LEFT JOIN player_event_stats pes ON pes.event_id = e.id AND pes.user_id = u.id
                WHERE ep.event_id = ?
                AND (? = 1 OR NOT EXISTS (
                    SELECT 1 FROM event_bans 
                    WHERE event_id = e.id AND user_id = u.id AND status = 'active'
                ))
                ORDER BY u.username
            `, [eventId, event.is_admin], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Get event matches
        const matches = await new Promise((resolve, reject) => {
            db.all(`
                SELECT m.*, 
                       GROUP_CONCAT(u.username) as player_names,
                       GROUP_CONCAT(u.id) as player_ids,
                       GROUP_CONCAT(mp.position) as positions,
                       GROUP_CONCAT(mp.final_score) as final_scores
                FROM matches m
                JOIN match_players mp ON m.id = mp.match_id
                JOIN users u ON mp.user_id = u.id
                WHERE m.event_id = ?
                GROUP BY m.id
                ORDER BY m.created_at DESC
            `, [eventId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Get custom fields if user is admin
        let customFields = [];
        if (event.is_admin) {
            customFields = await new Promise((resolve, reject) => {
                db.all(`
                    SELECT id, field_name, field_description, is_required, is_private
                    FROM event_custom_fields
                    WHERE event_id = ?
                    ORDER BY created_at ASC
                `, [eventId], (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                });
            });
        }

        // Get applications if user is admin
        let applications = [];
        if (event.is_admin) {
            applications = await new Promise((resolve, reject) => {
                db.all(`
                    SELECT ea.*, u.username as display_name
                    FROM event_applications ea
                    JOIN users u ON ea.user_id = u.id
                    WHERE ea.event_id = ?
                    ORDER BY ea.applied_at DESC
                `, [eventId], (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                });
            });
        }

        // Check if user has already applied
        const hasApplied = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM event_applications
                WHERE event_id = ? AND user_id = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        res.render('event', {
            event,
            participants,
            matches,
            customFields,
            applications,
            hasApplied,
            userId,
            isParticipant: event.is_participant,
            isAdmin: event.is_admin
        });
    } catch (error) {
        console.error('Error fetching event details:', error);
        res.status(500).send('Error fetching event details');
    }
});

// Event application route
router.post('/events/:id/apply', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;
    
    // Check if user is already a participant
    db.get(`
        SELECT 1 FROM event_participants
        WHERE event_id = ? AND user_id = ?
    `, [eventId, userId], (err, isParticipant) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error checking participant status');
        }
        
        if (isParticipant) {
            return res.status(400).send('You are already a participant in this event');
        }
        
        // Check if user has already applied
        db.get(`
            SELECT 1 FROM event_applications
            WHERE event_id = ? AND user_id = ?
        `, [eventId, userId], (err, hasApplied) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error checking application status');
            }
            
            if (hasApplied) {
                return res.status(400).send('You have already applied to this event');
            }
            
            // Create application
            db.run(`
                INSERT INTO event_applications (event_id, user_id, applied_at)
                VALUES (?, ?, datetime('now'))
            `, [eventId, userId], (err) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Error submitting application');
                }
                
                res.redirect(`/events/${eventId}`);
            });
        });
    });
});

// Accept event application
router.post('/events/:id/accept/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const currentUserId = req.session.userId;

    try {
        // Verify user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM events e
                JOIN organizations o ON e.organization_id = o.id
                JOIN organization_admins oa ON o.id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, currentUserId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Add user as participant
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO event_participants (event_id, user_id) VALUES (?, ?)',
                    [eventId, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Check if player stats already exist
            const statsExist = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT 1 FROM player_event_stats WHERE event_id = ? AND user_id = ?',
                    [eventId, userId],
                    (err, row) => {
                        if (err) reject(err);
                        resolve(!!row);
                    }
                );
            });

            // Initialize player stats if they don't exist
            if (!statsExist) {
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO player_event_stats (event_id, user_id, mmr) VALUES (?, ?, ?)',
                        [eventId, userId, 1500],
                        (err) => {
                            if (err) reject(err);
                            resolve();
                        }
                    );
                });
            }

            // Remove application
            await new Promise((resolve, reject) => {
                db.run(
                    'DELETE FROM event_applications WHERE event_id = ? AND user_id = ?',
                    [eventId, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/events/${eventId}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error accepting application:', error);
        res.status(500).send('Error accepting application');
    }
});

// Reject event application
router.post('/events/:id/reject/:userId', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const currentUserId = req.session.userId;

    // Verify user is admin of the organization
    db.get(`
        SELECT e.*, e.organization_id
        FROM events e
        WHERE e.id = ? AND EXISTS (
            SELECT 1 FROM organization_admins oa
            WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
        )
    `, [eventId, currentUserId], (err, event) => {
        if (err || !event) {
            return res.status(403).send('Unauthorized');
        }

        // Delete the application
        db.run(`
            DELETE FROM event_applications
            WHERE event_id = ? AND user_id = ?
        `, [eventId, userId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error rejecting application');
            }

            res.redirect(`/events/${eventId}`);
        });
    });
});

// Create new event route
router.get('/organizations/:id/events/new', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    res.render('new-event', { organizationId: req.params.id });
});

// Create a new event
router.post('/organizations/:id/events', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const { name, description, start_date, end_date, hidden, lowest_score_wins } = req.body;
    const userId = req.session.userId;

    if (!userId) {
        return res.status(401).send('You must be logged in to create an event');
    }

    try {
        // Check if user is an admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_admins WHERE organization_id = ? AND user_id = ?',
                [orgId, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can create events');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Create event
            const eventId = await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO events (name, description, organization_id, start_date, end_date, hidden, lowest_score_wins) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [name, description, orgId, start_date, end_date, hidden ? 1 : 0, lowest_score_wins ? 1 : 0],
                    function(err) {
                        if (err) reject(err);
                        resolve(this.lastID);
                    }
                );
            });

            // Add admin as participant
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO event_participants (event_id, user_id) VALUES (?, ?)',
                    [eventId, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Initialize admin's stats
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO player_event_stats (event_id, user_id, mmr) VALUES (?, ?, ?)',
                    [eventId, userId, 1500],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/events/${eventId}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).send('Error creating event');
    }
});

// Search players for event
router.get('/events/:id/search-players', (req, res) => {
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const query = req.query.q;
    
    if (!query || query.length < 2) {
        return res.json([]);
    }
    
    // Search for participants in the event
    db.all(`
        SELECT 
            u.id, 
            u.username as display_name
        FROM users u
        JOIN event_participants ep ON u.id = ep.user_id
        WHERE ep.event_id = ? 
        AND (
            (u.username LIKE ?)
        )
        ORDER BY u.username
        LIMIT 10
    `, [eventId, `%${query}%`], (err, players) => {
        if (err) {
            console.error('Search error:', err);
            return res.status(500).send('Error searching players');
        }
        
        res.json(players);
    });
});

// Toggle event visibility
router.post('/events/:id/toggle-visibility', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;

    // Verify user is admin of the organization
    db.get(`
        SELECT e.*, e.organization_id
        FROM events e
        WHERE e.id = ? AND EXISTS (
            SELECT 1 FROM organization_admins oa
            WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
        )
    `, [eventId, userId], (err, event) => {
        if (err || !event) {
            return res.status(403).send('Unauthorized');
        }

        // Toggle the hidden status
        db.run(`
            UPDATE events
            SET hidden = CASE WHEN hidden = 1 THEN 0 ELSE 1 END
            WHERE id = ?
        `, [eventId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error toggling event visibility');
            }

            res.redirect(`/events/${eventId}`);
        });
    });
});

// Toggle scoring system
router.post('/events/:id/toggle-scoring', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;

    // Verify user is admin
    db.get(`
        SELECT e.*, e.organization_id
        FROM events e
        WHERE e.id = ? AND EXISTS (
            SELECT 1 FROM organization_admins oa
            WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
        )
    `, [eventId, userId], (err, event) => {
        if (err || !event) {
            return res.status(403).send('Unauthorized');
        }

        // Toggle the lowest_score_wins value
        db.run(`
            UPDATE events
            SET lowest_score_wins = CASE WHEN lowest_score_wins = 0 THEN 1 ELSE 0 END
            WHERE id = ?
        `, [eventId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error updating scoring system');
            }
            res.redirect(`/events/${eventId}`);
        });
    });
});

// Kick participant from event
router.post('/events/:id/kick/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const adminId = req.session.userId;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, adminId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can kick participants');
        }

        // Check if target user is the organization creator
        const isCreator = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organizations o
                JOIN events e ON e.organization_id = o.id
                WHERE e.id = ? AND o.created_by = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (isCreator) {
            return res.status(403).send('Cannot kick the organization creator');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Mark participant's matches as forfeit
            await new Promise((resolve, reject) => {
                db.run(`
                    UPDATE matches 
                    SET status = 'forfeit'
                    WHERE event_id = ? AND id IN (
                        SELECT match_id FROM match_players 
                        WHERE user_id = ?
                    )
                `, [eventId, userId], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            // Remove participant from event
            await new Promise((resolve, reject) => {
                db.run(`
                    DELETE FROM event_participants 
                    WHERE event_id = ? AND user_id = ?
                `, [eventId, userId], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/events/${eventId}`);
        } catch (err) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw err;
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Error kicking participant');
    }
});

// Ban participant from event
router.post('/events/:id/ban/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const adminId = req.session.userId;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, adminId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can ban participants');
        }

        // Check if target user is the organization creator
        const isCreator = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organizations o
                JOIN events e ON e.organization_id = o.id
                WHERE e.id = ? AND o.created_by = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (isCreator) {
            return res.status(403).send('Cannot ban the organization creator');
        }

        // Add ban record
        await new Promise((resolve, reject) => {
            db.run(`
                INSERT OR REPLACE INTO event_bans (event_id, user_id, status)
                VALUES (?, ?, 'active')
            `, [eventId, userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.redirect(`/events/${eventId}`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error banning participant');
    }
});

// Unban participant from event
router.post('/events/:id/unban/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const adminId = req.session.userId;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, adminId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can unban participants');
        }

        // Update ban status to inactive
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE event_bans
                SET status = 'inactive'
                WHERE event_id = ? AND user_id = ?
            `, [eventId, userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.redirect(`/events/${eventId}`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error unbanning participant');
    }
});

// Organization events route
router.get('/organization/:id', async (req, res) => {
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const userId = req.session.userId;

    try {
        // Get organization events
        const events = await new Promise((resolve, reject) => {
            db.all(`
                SELECT e.*,
                       COUNT(DISTINCT ep.user_id) as participant_count,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = e.organization_id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin
                FROM events e
                LEFT JOIN event_participants ep ON e.id = ep.event_id
                WHERE e.organization_id = ?
                AND (? = 1 OR NOT EXISTS (
                    SELECT 1 FROM event_bans 
                    WHERE event_id = e.id AND user_id = ? AND status = 'active'
                ))
                GROUP BY e.id
                ORDER BY e.start_date DESC
            `, [userId, orgId, userId, userId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Format descriptions for events
        events.forEach(event => {
            event.description = formatDescription(event.description);
        });

        res.render('events', {
            events,
            userId,
            organizationId: orgId
        });
    } catch (error) {
        console.error('Error fetching organization events:', error);
        res.status(500).send('Error fetching organization events');
    }
});

// Update event details
router.post('/events/:id/update', async (req, res) => {
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;
    const { name, description } = req.body;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM events e
                JOIN organization_admins oa ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can update events');
        }

        // Update event
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE events SET name = ?, description = ? WHERE id = ?',
                [name, description, eventId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.redirect(`/events/${eventId}`);
    } catch (error) {
        console.error('Error updating event:', error);
        res.status(500).send('Error updating event');
    }
});

// Add custom field
router.post('/events/:id/custom-fields', async (req, res) => {
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;
    const fields = req.body.fields || {};
    const fieldIds = req.body.field_ids || [];

    console.log('Received form data:', {
        fields,
        fieldIds
    });

    try {
        // Check if user is admin
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM events e
                JOIN organization_admins oa ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can manage custom fields');
        }

        // Get existing field IDs
        const existingFields = await new Promise((resolve, reject) => {
            db.all('SELECT id FROM event_custom_fields WHERE event_id = ?', [eventId], (err, rows) => {
                if (err) reject(err);
                resolve(rows.map(row => row.id));
            });
        });

        // Determine which fields were removed
        const submittedFieldIds = fieldIds.map(id => parseInt(id));
        const removedFieldIds = existingFields.filter(id => !submittedFieldIds.includes(id));

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Delete removed fields
            if (removedFieldIds.length > 0) {
                await new Promise((resolve, reject) => {
                    const placeholders = removedFieldIds.map(() => '?').join(',');
                    const query = `DELETE FROM event_custom_fields WHERE event_id = ? AND id IN (${placeholders})`;
                    db.run(query, [eventId, ...removedFieldIds], (err) => {
                        if (err) reject(err);
                        resolve();
                    });
                });
            }

            // Process remaining and new fields
            for (let i = 0; i < fieldIds.length; i++) {
                const fieldId = fieldIds[i];
                const fieldData = Array.isArray(fields) ? fields[i] : fields[fieldId];
                
                console.log('Processing field:', fieldId, fieldData);
                if (!fieldData || !fieldData.field_name || fieldData.field_name.trim() === '') {
                    continue;
                }

                const isRequired = fieldData.is_required === '1';
                const isPrivate = fieldData.is_private === '1';

                if (fieldId.startsWith('new_')) {
                    // Insert new field
                    await db.run(
                        'INSERT INTO event_custom_fields (event_id, field_name, field_description, field_type, is_required, is_private) VALUES (?, ?, ?, ?, ?, ?)',
                        [eventId, fieldData.field_name, fieldData.field_description, fieldData.field_type, isRequired, isPrivate]
                    );
                } else {
                    // Update existing field
                    await db.run(
                        'UPDATE event_custom_fields SET field_name = ?, field_description = ?, field_type = ?, is_required = ?, is_private = ? WHERE id = ? AND event_id = ?',
                        [fieldData.field_name, fieldData.field_description, fieldData.field_type, isRequired, isPrivate, fieldId, eventId]
                    );
                }
            }

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/events/${eventId}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error updating custom fields:', error);
        res.status(500).send('Error updating custom fields');
    }
});

// Update custom field
router.post('/events/:id/custom-fields/:fieldId', async (req, res) => {
    const db = req.app.locals.db;
    const { id: eventId, fieldId } = req.params;
    const { field_name, field_description, is_private, is_required } = req.body;

    try {
        // Check if user is admin
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, req.session.userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE event_custom_fields
                SET field_name = ?, field_description = ?, is_private = ?, is_required = ?
                WHERE id = ? AND event_id = ?
            `, [field_name, field_description, is_private ? 1 : 0, is_required ? 1 : 0, fieldId, eventId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.redirect(`/events/${eventId}`);
    } catch (error) {
        console.error('Error updating custom field:', error);
        res.status(500).json({ error: 'Error updating custom field' });
    }
});

// Delete custom field
router.post('/events/:id/custom-fields/:fieldId/delete', async (req, res) => {
    const db = req.app.locals.db;
    const { id: eventId, fieldId } = req.params;

    try {
        // Check if user is admin
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, req.session.userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM event_custom_fields WHERE id = ? AND event_id = ?', [fieldId, eventId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.redirect(`/events/${eventId}`);
    } catch (error) {
        console.error('Error deleting custom field:', error);
        res.status(500).json({ error: 'Error deleting custom field' });
    }
});

// View participant details
router.get('/events/:id/participants/:userId', async (req, res) => {
    const db = req.app.locals.db;
    const { id: eventId, userId } = req.params;
    const currentUserId = req.session.userId;
    const isViewingOwnProfile = currentUserId === parseInt(userId);

    try {
        // Get participant details and check if current user is admin
        const participant = await new Promise((resolve, reject) => {
            const query = `
                SELECT u.id, u.username as display_name, u.created_at,
                       pes.mmr, pes.matches_played, pes.wins,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins oa
                           JOIN events e ON e.organization_id = oa.organization_id
                           WHERE e.id = ? AND oa.user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin
                FROM users u
                JOIN event_participants ep ON u.id = ep.user_id
                LEFT JOIN player_event_stats pes ON pes.event_id = ep.event_id AND pes.user_id = u.id
                WHERE u.id = ? AND ep.event_id = ?
            `;
            
            db.get(query, [eventId, currentUserId, userId, eventId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!participant) {
            return res.status(404).render('error', { message: 'Participant not found' });
        }

        // Get matches for this participant
        const matches = await new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    m.id,
                    m.status,
                    m.created_at,
                    m.winner_id,
                    GROUP_CONCAT(u.username) as player_names
                FROM matches m
                JOIN match_players mp ON m.id = mp.match_id
                JOIN users u ON mp.user_id = u.id
                WHERE m.event_id = ?
                AND EXISTS (
                    SELECT 1 FROM match_players 
                    WHERE match_id = m.id AND user_id = ?
                )
                GROUP BY m.id
                ORDER BY m.created_at DESC
            `;
            
            db.all(query, [eventId, userId], (err, rows) => {
                if (err) {
                    console.error('Error fetching matches:', err);
                    resolve([]);
                    return;
                }
                if (!rows) {
                    resolve([]);
                    return;
                }
                rows.forEach(row => {
                    row.player_names = row.player_names.split(',');
                });
                resolve(rows);
            });
        });

        // Get custom fields and responses
        const customFields = await new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    f.id,
                    f.field_name,
                    f.field_description,
                    f.field_type,
                    f.is_required,
                    f.is_private,
                    r.response
                FROM event_custom_fields f
                LEFT JOIN participant_custom_responses r 
                    ON f.id = r.field_id 
                    AND r.user_id = ?
                    AND r.event_id = f.event_id
                WHERE f.event_id = ?
                AND (
                    ? = 1  -- Current user is admin
                    OR ? = 1  -- Viewing own profile
                    OR f.is_private = 0  -- Field is not private
                )
                ORDER BY f.id ASC
            `;
            
            db.all(query, [
                userId,
                eventId,
                participant.is_admin,
                isViewingOwnProfile
            ], (err, rows) => {
                if (err) reject(err);
                console.log('Custom fields data:', JSON.stringify(rows, null, 2));
                resolve(rows);
            });
        });

        // Handle success/error messages from URL parameters
        const messages = [];
        if (req.query.success) {
            messages.push({ type: 'success', text: req.query.success });
        }
        if (req.query.error) {
            messages.push({ type: 'danger', text: req.query.error });
        }

        const templateData = {
            participant,
            customFields,
            matches,
            isViewingOwnProfile,
            eventId,
            userId,
            isAdmin: participant.is_admin,
            messages
        };
        console.log('Template data:', JSON.stringify(templateData, null, 2));

        res.render('participant', templateData);
    } catch (error) {
        console.error('Error fetching participant details:', error);
        res.status(500).render('error', { message: 'Error fetching participant details' });
    }
});

// Update participant response
router.post('/events/:id/participants/:userId/responses', async (req, res) => {
    const db = req.app.locals.db;
    const { id: eventId, userId } = req.params;
    const currentUserId = req.session.userId;

    if (currentUserId !== parseInt(userId)) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const responses = req.body.responses;
        console.log('Received responses:', responses);
        
        if (!responses) {
            return res.status(400).json({ error: 'No responses provided' });
        }

        // Get custom fields for this event
        const customFields = await new Promise((resolve, reject) => {
            db.all(`
                SELECT id, field_name
                FROM event_custom_fields
                WHERE event_id = ?
                ORDER BY id ASC
            `, [eventId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Process each response
            for (const [fieldIndex, response] of Object.entries(responses)) {
                console.log(`Processing response for field index ${fieldIndex}:`, response);
                
                if (response === undefined || response === null || response.trim() === '') {
                    continue;
                }

                const fieldId = customFields[parseInt(fieldIndex)]?.id;
                if (!fieldId) {
                    console.error('Invalid field index:', fieldIndex);
                    continue;
                }
                
                await new Promise((resolve, reject) => {
                    const query = `
                        INSERT INTO participant_custom_responses (event_id, user_id, field_id, response)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(event_id, user_id, field_id) DO UPDATE SET
                            response = excluded.response,
                            updated_at = CURRENT_TIMESTAMP
                    `;
                    
                    console.log('Executing query with params:', [eventId, userId, fieldId, response]);
                    
                    db.run(query, [eventId, userId, fieldId, response], (err) => {
                        if (err) {
                            console.error('Error saving response:', err);
                            reject(err);
                        }
                        resolve();
                    });
                });
            }

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            // Redirect with success message
            res.redirect(`/events/${eventId}/participants/${userId}?success=Responses saved successfully`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error updating participant response:', error);
        res.redirect(`/events/${eventId}/participants/${userId}?error=Failed to save responses`);
    }
});

// Update participant MMR
router.post('/events/:id/participants/:userId/mmr', async (req, res) => {
    const db = req.app.locals.db;
    const { id: eventId, userId } = req.params;
    const { mmr } = req.body;
    const currentUserId = req.session.userId;

    try {
        // Verify user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, currentUserId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        // Update MMR
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE player_event_stats
                SET mmr = ?
                WHERE event_id = ? AND user_id = ?
            `, [mmr, eventId, userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.redirect(`/events/${eventId}`);
    } catch (error) {
        console.error('Error updating MMR:', error);
        res.status(500).json({ error: 'Error updating MMR' });
    }
});

module.exports = router;