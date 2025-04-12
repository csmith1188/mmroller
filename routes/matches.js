const express = require('express');
const router = express.Router();

// Get match details
router.get('/matches/:id', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.id;
    const userId = req.session.userId;
    
    // Get match details with players and event info
    db.get(`
        SELECT m.*, e.name as event_name, e.organization_id,
               CASE WHEN o.admin_id = ? THEN 1 ELSE 0 END as is_admin
        FROM matches m
        JOIN events e ON m.event_id = e.id
        JOIN organizations o ON e.organization_id = o.id
        WHERE m.id = ?
    `, [userId, matchId], (err, match) => {
        if (err) {
            console.error('Error fetching match:', err);
            return res.status(500).send('Error fetching match details');
        }
        
        if (!match) {
            return res.status(404).send('Match not found');
        }
        
        // Get match players
        db.all(`
            SELECT mp.*, u.username
            FROM match_players mp
            JOIN users u ON mp.user_id = u.id
            WHERE mp.match_id = ?
            ORDER BY mp.position
        `, [matchId], (err, players) => {
            if (err) {
                console.error('Error fetching players:', err);
                return res.status(500).send('Error fetching match players');
            }
            
            // Check if current user is a player
            const isPlayer = players.some(player => player.user_id === parseInt(userId));
            
            // Get match submissions
            db.all(`
                SELECT ms.*, u.username
                FROM match_submissions ms
                JOIN users u ON ms.user_id = u.id
                WHERE ms.match_id = ?
                ORDER BY ms.submitted_at DESC
            `, [matchId], (err, submissions) => {
                if (err) {
                    console.error('Error fetching submissions:', err);
                    return res.status(500).send('Error fetching match submissions');
                }
                
                // Parse scores for each submission
                const parsedSubmissions = submissions.map(sub => ({
                    ...sub,
                    scores: JSON.parse(sub.scores)
                }));
                
                // Get current user's submission if any
                const currentSubmission = parsedSubmissions.find(sub => sub.user_id === parseInt(userId));
                
                // Filter submissions based on user role
                const visibleSubmissions = match.is_admin === 1 ? parsedSubmissions : [];
                
                // Add players and user info to match object
                const matchWithPlayers = {
                    ...match,
                    players: players,
                    is_player: isPlayer,
                    current_submission: currentSubmission // Show current submission if it exists
                };
                
                res.render('match', {
                    match: matchWithPlayers,
                    submissions: visibleSubmissions,
                    userId: parseInt(userId)
                });
            });
        });
    });
});

// Submit match scores
router.post('/matches/:id/scores', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.id;
    const userId = req.session.userId;
    const scores = req.body.scores;
    
    // Start transaction
    db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error starting transaction');
        }
        
        // Get match players first
        db.all(`
            SELECT user_id
            FROM match_players
            WHERE match_id = ?
        `, [matchId], (err, players) => {
            if (err) {
                db.run('ROLLBACK');
                console.error(err);
                return res.status(500).send('Error fetching match players');
            }
            
            // Delete previous submissions from this user
            db.run(`
                DELETE FROM match_submissions
                WHERE match_id = ? AND user_id = ?
            `, [matchId, userId], (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    console.error(err);
                    return res.status(500).send('Error deleting previous submissions');
                }
                
                // Insert submission
                db.run(`
                    INSERT INTO match_submissions (match_id, user_id, scores, submitted_at)
                    VALUES (?, ?, ?, datetime('now'))
                `, [matchId, userId, JSON.stringify(scores)], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        console.error(err);
                        return res.status(500).send('Error submitting scores');
                    }
                    
                    // Check if all players have submitted the same scores
                    db.all(`
                        SELECT scores
                        FROM match_submissions
                        WHERE match_id = ?
                        ORDER BY submitted_at DESC
                        LIMIT ?
                    `, [matchId, players.length], (err, recentSubmissions) => {
                        if (err) {
                            db.run('ROLLBACK');
                            console.error(err);
                            return res.status(500).send('Error checking submissions');
                        }
                        
                        if (recentSubmissions.length === players.length) {
                            const allSame = recentSubmissions.every(sub => 
                                JSON.stringify(JSON.parse(sub.scores)) === JSON.stringify(scores)
                            );
                            
                            if (allSame) {
                                // Auto-finalize the match
                                db.run(`
                                    UPDATE matches
                                    SET status = 'completed',
                                        completed_at = datetime('now')
                                    WHERE id = ?
                                `, [matchId], (err) => {
                                    if (err) {
                                        db.run('ROLLBACK');
                                        console.error(err);
                                        return res.status(500).send('Error finalizing match');
                                    }
                                    
                                    // Update player final scores
                                    const updates = Object.entries(scores).map(([playerId, score]) => {
                                        return new Promise((resolve, reject) => {
                                            db.run(`
                                                UPDATE match_players
                                                SET final_score = ?
                                                WHERE match_id = ? AND user_id = ?
                                            `, [score, matchId, playerId], (err) => {
                                                if (err) reject(err);
                                                else resolve();
                                            });
                                        });
                                    });
                                    
                                    Promise.all(updates)
                                        .then(() => {
                                            db.run('COMMIT', (err) => {
                                                if (err) {
                                                    console.error(err);
                                                    return res.status(500).send('Error committing transaction');
                                                }
                                                res.redirect(`/matches/${matchId}`);
                                            });
                                        })
                                        .catch(err => {
                                            db.run('ROLLBACK');
                                            console.error(err);
                                            res.status(500).send('Error updating player scores');
                                        });
                                });
                                return;
                            }
                        }
                        
                        db.run('COMMIT', (err) => {
                            if (err) {
                                console.error(err);
                                return res.status(500).send('Error committing transaction');
                            }
                            res.redirect(`/matches/${matchId}`);
                        });
                    });
                });
            });
        });
    });
});

// Update match status
router.post('/matches/:id/status', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.id;
    const userId = req.session.userId;
    const status = req.body.status;
    
    // Verify user is admin
    db.get(`
        SELECT 1 FROM matches m
        JOIN events e ON m.event_id = e.id
        JOIN organizations o ON e.organization_id = o.id
        WHERE m.id = ? AND o.admin_id = ?
    `, [matchId, userId], (err, isAdmin) => {
        if (err || !isAdmin) {
            return res.status(403).send('Unauthorized');
        }
        
        db.run(`
            UPDATE matches
            SET status = ?,
                completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END
            WHERE id = ?
        `, [status, status, matchId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error updating match status');
            }
            
            res.redirect(`/matches/${matchId}`);
        });
    });
});

// Finalize match with specific submission
router.post('/matches/:id/finalize', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.id;
    const userId = req.session.userId;
    const submissionId = req.body.submission_id;
    
    // Verify user is admin
    db.get(`
        SELECT 1 FROM matches m
        JOIN events e ON m.event_id = e.id
        JOIN organizations o ON e.organization_id = o.id
        WHERE m.id = ? AND o.admin_id = ?
    `, [matchId, userId], (err, isAdmin) => {
        if (err || !isAdmin) {
            return res.status(403).send('Unauthorized');
        }
        
        // Start transaction
        db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error starting transaction');
            }
            
            // Get submission scores
            db.get(`
                SELECT scores
                FROM match_submissions
                WHERE id = ?
            `, [submissionId], (err, submission) => {
                if (err) {
                    db.run('ROLLBACK');
                    console.error(err);
                    return res.status(500).send('Error fetching submission');
                }
                
                // Update match status and final scores
                db.run(`
                    UPDATE matches
                    SET status = 'completed',
                        completed_at = datetime('now')
                    WHERE id = ?
                `, [matchId], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        console.error(err);
                        return res.status(500).send('Error updating match status');
                    }
                    
                    // Get players in order to update their scores
                    db.all(`
                        SELECT user_id, position
                        FROM match_players
                        WHERE match_id = ?
                        ORDER BY position
                    `, [matchId], (err, players) => {
                        if (err) {
                            db.run('ROLLBACK');
                            console.error(err);
                            return res.status(500).send('Error fetching players');
                        }

                        // Parse scores array from submission
                        const scores = JSON.parse(submission.scores);
                        
                        // Update each player's final score based on their position
                        const updates = players.map((player, index) => {
                            return new Promise((resolve, reject) => {
                                db.run(`
                                    UPDATE match_players
                                    SET final_score = ?
                                    WHERE match_id = ? AND user_id = ?
                                `, [scores[index], matchId, player.user_id], (err) => {
                                    if (err) reject(err);
                                    else resolve();
                                });
                            });
                        });
                        
                        Promise.all(updates)
                            .then(() => {
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        console.error(err);
                                        return res.status(500).send('Error committing transaction');
                                    }
                                    res.redirect(`/matches/${matchId}`);
                                });
                            })
                            .catch(err => {
                                db.run('ROLLBACK');
                                console.error(err);
                                res.status(500).send('Error updating player scores');
                            });
                    });
                });
            });
        });
    });
});

// Create new match route
router.get('/events/:id/matches/new', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    
    // Get event participants
    db.all(`
        SELECT u.id, u.username
        FROM users u
        JOIN event_participants ep ON u.id = ep.user_id
        WHERE ep.event_id = ?
    `, [eventId], (err, participants) => {
        if (err) {
            return res.status(500).send('Database error');
        }
        
        res.render('new-match', { eventId, participants });
    });
});

router.post('/events/:id/matches', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const playerIds = req.body.player_ids; // Array of player IDs in order
    const userId = req.session.userId;
    
    // Verify user is admin of the organization that owns the event
    db.get(`
        SELECT 1 FROM events e
        JOIN organizations o ON e.organization_id = o.id
        WHERE e.id = ? AND o.admin_id = ?
    `, [eventId, userId], (err, result) => {
        if (err || !result) {
            return res.status(403).send('Unauthorized: Only organization admins can create matches');
        }
        
        // Verify all players are event participants
        db.get(`
            SELECT COUNT(DISTINCT user_id) as count
            FROM event_participants
            WHERE event_id = ? AND user_id IN (${playerIds.map(() => '?').join(',')})
        `, [eventId, ...playerIds], (err, result) => {
            if (err || result.count !== playerIds.length) {
                return res.status(400).send('Invalid players: All players must be event participants');
            }
            
            // Create match
            db.run(`
                INSERT INTO matches (event_id)
                VALUES (?)
            `, [eventId], function(err) {
                if (err) {
                    return res.status(500).send('Error creating match');
                }
                
                const matchId = this.lastID;
                
                // Add players to match
                const playerValues = playerIds.map((playerId, index) => 
                    `(${matchId}, ${playerId}, ${index + 1})`
                ).join(',');
                
                db.run(`
                    INSERT INTO match_players (match_id, user_id, position)
                    VALUES ${playerValues}
                `, function(err) {
                    if (err) {
                        return res.status(500).send('Error adding players to match');
                    }
                    
                    res.redirect(`/events/${eventId}`);
                });
            });
        });
    });
});

module.exports = router; 