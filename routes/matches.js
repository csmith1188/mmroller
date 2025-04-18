const express = require('express');
const router = express.Router();

// ELO Rating calculation helper
function calculateEloRating(winnerRating, loserRating, kFactor = 32) {
    const expectedScoreWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedScoreLoser = 1 / (1 + Math.pow(10, (winnerRating - loserRating) / 400));
    
    const newWinnerRating = Math.round(winnerRating + kFactor * (1 - expectedScoreWinner));
    const newLoserRating = Math.round(loserRating + kFactor * (0 - expectedScoreLoser));
    
    return {
        winner: newWinnerRating,
        loser: newLoserRating
    };
}

// Helper to update player stats
async function updatePlayerStats(db, matchId, eventId, players, scores, isUndo = false) {
    // Get current stats for all players
    const stats = await new Promise((resolve, reject) => {
        const placeholders = players.map(() => '?').join(',');
        db.all(`
            SELECT user_id, mmr, matches_played, wins, losses
            FROM player_event_stats
            WHERE event_id = ? AND user_id IN (${placeholders})
        `, [eventId, ...players.map(p => p.user_id)], (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });

    // Sort players by score
    const sortedPlayers = [...players].sort((a, b) => {
        const scoreA = scores[players.indexOf(a)];
        const scoreB = scores[players.indexOf(b)];
        return scores[players.indexOf(b)] - scores[players.indexOf(a)];
    });

    const winner = sortedPlayers[0];
    const loser = sortedPlayers[1];
    
    let winnerStats = stats.find(s => s.user_id === winner.user_id);
    let loserStats = stats.find(s => s.user_id === loser.user_id);
    
    // If either player doesn't have stats, create them
    if (!winnerStats || !loserStats) {
        // Create missing stats
        const missingPlayers = [];
        if (!winnerStats) missingPlayers.push(winner.user_id);
        if (!loserStats) missingPlayers.push(loser.user_id);
        
        await Promise.all(missingPlayers.map(playerId => {
            return new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO player_event_stats (event_id, user_id, mmr, matches_played, wins, losses)
                    VALUES (?, ?, 1500, 0, 0, 0)
                `, [eventId, playerId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }));
        
        // Fetch the newly created stats
        const newStats = await new Promise((resolve, reject) => {
            const placeholders = missingPlayers.map(() => '?').join(',');
            db.all(`
                SELECT user_id, mmr, matches_played, wins, losses
                FROM player_event_stats
                WHERE event_id = ? AND user_id IN (${placeholders})
            `, [eventId, ...missingPlayers], (err, results) => {
                if (err) reject(err);
                else resolve(results);
            });
        });
        
        // Update stats objects
        if (!winnerStats) {
            winnerStats = newStats.find(s => s.user_id === winner.user_id);
        }
        if (!loserStats) {
            loserStats = newStats.find(s => s.user_id === loser.user_id);
        }
    }
    
    // Calculate new ratings
    const newRatings = calculateEloRating(winnerStats.mmr, loserStats.mmr);
    
    // Update stats for both players
    const updates = [winner, loser].map((player, index) => {
        const isWinner = index === 0;
        const playerStats = isWinner ? winnerStats : loserStats;
        const newRating = isWinner ? newRatings.winner : newRatings.loser;
        const mmrChange = newRating - playerStats.mmr;
        
        // Record stat changes in match_players
        const recordChanges = new Promise((resolve, reject) => {
            db.run(`
                UPDATE match_players
                SET mmr_change = ?,
                    matches_change = 1,
                    wins_change = ?,
                    losses_change = ?
                WHERE match_id = ? AND user_id = ?
            `, [
                mmrChange,
                isWinner ? 1 : 0,
                isWinner ? 0 : 1,
                matchId,
                player.user_id
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Update player_event_stats
        const updateStats = new Promise((resolve, reject) => {
            db.run(`
                UPDATE player_event_stats
                SET mmr = mmr + ?,
                    matches_played = matches_played + 1,
                    wins = wins + ?,
                    losses = losses + ?
                WHERE event_id = ? AND user_id = ?
            `, [
                mmrChange,
                isWinner ? 1 : 0,
                isWinner ? 0 : 1,
                eventId,
                player.user_id
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        return Promise.all([recordChanges, updateStats]);
    });
    
    await Promise.all(updates);
}

// Helper to revert player stats
async function revertPlayerStats(db, matchId, eventId) {
    // Get the stat changes from match_players
    const players = await new Promise((resolve, reject) => {
        db.all(`
            SELECT mp.*, u.username as display_name
            FROM match_players mp
            JOIN users u ON mp.user_id = u.id
            WHERE mp.match_id = ?
        `, [matchId], (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });

    // Revert stats for all players
    const updates = players.map(player => {
        return new Promise((resolve, reject) => {
            db.run(`
                UPDATE player_event_stats
                SET mmr = mmr - ?,
                    matches_played = matches_played - ?,
                    wins = wins - ?,
                    losses = losses - ?
                WHERE event_id = ? AND user_id = ?
            `, [
                player.mmr_change || 0,
                player.matches_change || 0,
                player.wins_change || 0,
                player.losses_change || 0,
                eventId,
                player.user_id
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });

    await Promise.all(updates);

    // Clear the recorded changes
    await new Promise((resolve, reject) => {
        db.run(`
            UPDATE match_players
            SET mmr_change = NULL,
                matches_change = 0,
                wins_change = 0,
                losses_change = 0
            WHERE match_id = ?
        `, [matchId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// Get match details
router.get('/matches/:id', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.id;
    const userId = req.session.userId;
    
    // Get match details with players and event info
    db.get(`
        SELECT m.*, e.name as event_name, e.organization_id,
               CASE WHEN EXISTS (
                   SELECT 1 FROM organization_admins oa
                   WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
               ) THEN 1 ELSE 0 END as is_admin
        FROM matches m
        JOIN events e ON m.event_id = e.id
        WHERE m.id = ?
    `, [userId, matchId], (err, match) => {
        if (err) {
            console.error('Error fetching match:', err);
            return res.status(500).render('error', { message: 'Error fetching match details' });
        }
        
        if (!match) {
            return res.status(404).render('error', { message: 'Match not found' });
        }
        
        // Get match players
        db.all(`
            SELECT mp.*, u.username as display_name
            FROM match_players mp
            JOIN users u ON mp.user_id = u.id
            WHERE mp.match_id = ?
            ORDER BY mp.position
        `, [matchId], (err, players) => {
            if (err) {
                console.error('Error fetching players:', err);
                return res.status(500).render('error', { message: 'Error fetching match players' });
            }
            
            // Check if current user is a player
            const isPlayer = players.some(player => player.user_id === parseInt(userId));
            
            // Get match custom fields
            db.all(`
                SELECT mcf.*, 
                       GROUP_CONCAT(mcr.response) as responses,
                       GROUP_CONCAT(mcr.user_id) as response_user_ids,
                       GROUP_CONCAT(u.username) as response_usernames
                FROM match_custom_fields mcf
                LEFT JOIN match_custom_responses mcr ON mcf.id = mcr.field_id AND mcr.match_id = ?
                LEFT JOIN users u ON mcr.user_id = u.id
                WHERE mcf.event_id = ?
                GROUP BY mcf.id
                ORDER BY mcf.created_at ASC
            `, [matchId, match.event_id], (err, customFields) => {
                if (err) {
                    console.error('Error fetching custom fields:', err);
                    return res.status(500).render('error', { message: 'Error fetching custom fields' });
                }

                // Process custom fields to organize responses
                const processedFields = customFields.map(field => {
                    const responses = field.responses ? field.responses.split(',') : [];
                    const responseUserIds = field.response_user_ids ? field.response_user_ids.split(',').map(Number) : [];
                    const responseUsernames = field.response_usernames ? field.response_usernames.split(',') : [];
                    
                    // Create an array of responses with user info
                    const responseData = responses.map((response, index) => ({
                        response,
                        user_id: responseUserIds[index],
                        username: responseUsernames[index]
                    }));

                    // Find current user's response if any
                    const currentUserResponse = responseData.find(r => r.user_id === parseInt(userId));

                    return {
                        ...field,
                        responses: responseData,
                        current_response: currentUserResponse ? currentUserResponse.response : null
                    };
                });

                // Get match submissions
                db.all(`
                    SELECT ms.*, u.username as display_name
                    FROM match_submissions ms
                    JOIN users u ON ms.user_id = u.id
                    WHERE ms.match_id = ?
                    ORDER BY ms.submitted_at DESC
                `, [matchId], (err, submissions) => {
                    if (err) {
                        console.error('Error fetching submissions:', err);
                        return res.status(500).render('error', { message: 'Error fetching match submissions' });
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
                        current_submission: currentSubmission, // Show current submission if it exists
                        custom_fields: processedFields // Add processed custom fields to match object
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
});

// Submit match scores
router.post('/matches/:id/scores', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.id;
    const userId = req.session.userId;
    const scores = req.body.scores;
    
    // Check if user is a player in the match or an admin
    db.get(`
        SELECT 
            CASE WHEN EXISTS (
                SELECT 1 FROM match_players WHERE match_id = ? AND user_id = ?
            ) THEN 1 ELSE 0 END as is_player,
            CASE WHEN EXISTS (
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                JOIN matches m ON m.event_id = e.id
                WHERE m.id = ? AND oa.user_id = ?
            ) THEN 1 ELSE 0 END as is_admin
    `, [matchId, userId, matchId, userId], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).render('error', { message: 'Error checking user permissions' });
        }
        
        if (!result.is_player && !result.is_admin) {
            return res.status(403).render('error', { message: 'Only players in the match or organization admins can submit scores' });
        }
        
        // Start transaction
        db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
                console.error(err);
                return res.status(500).render('error', { message: 'Error starting transaction' });
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
                    return res.status(500).render('error', { message: 'Error fetching match players' });
                }
                
                // Delete previous submissions from this user
                db.run(`
                    DELETE FROM match_submissions
                    WHERE match_id = ? AND user_id = ?
                `, [matchId, userId], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        console.error(err);
                        return res.status(500).render('error', { message: 'Error deleting previous submissions' });
                    }
                    
                    // Insert submission
                    db.run(`
                        INSERT INTO match_submissions (match_id, user_id, scores, submitted_at)
                        VALUES (?, ?, ?, datetime('now'))
                    `, [matchId, userId, JSON.stringify(scores)], (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            console.error(err);
                            return res.status(500).render('error', { message: 'Error submitting scores' });
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
                                return res.status(500).render('error', { message: 'Error checking submissions' });
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
                                            return res.status(500).render('error', { message: 'Error finalizing match' });
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
                                                        return res.status(500).render('error', { message: 'Error committing transaction' });
                                                    }
                                                    res.redirect(`/matches/${matchId}`);
                                                });
                                            })
                                            .catch(err => {
                                                db.run('ROLLBACK');
                                                console.error(err);
                                                res.status(500).render('error', { message: 'Error updating player scores' });
                                            });
                                    });
                                    return;
                                }
                            }
                            
                            db.run('COMMIT', (err) => {
                                if (err) {
                                    console.error(err);
                                    return res.status(500).render('error', { message: 'Error committing transaction' });
                                }
                                res.redirect(`/matches/${matchId}`);
                            });
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
    
    // Verify user is admin and get match details
    db.get(`
        SELECT m.*, e.id as event_id, e.organization_id
        FROM matches m
        JOIN events e ON m.event_id = e.id
        WHERE m.id = ? AND EXISTS (
            SELECT 1 FROM organization_admins oa
            WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
        )
    `, [matchId, userId], async (err, match) => {
        if (err || !match) {
            return res.status(403).render('error', { message: 'Unauthorized' });
        }

        db.run('BEGIN TRANSACTION', async (err) => {
            if (err) {
                console.error(err);
                return res.status(500).render('error', { message: 'Error starting transaction' });
            }

            try {
                // If changing from completed, revert stats
                if (match.status === 'completed' && status !== 'completed') {
                    await revertPlayerStats(db, matchId, match.event_id);
                    
                    // Clear final scores
                    await new Promise((resolve, reject) => {
                        db.run(`
                            UPDATE match_players
                            SET final_score = NULL
                            WHERE match_id = ?
                        `, [matchId], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                }

                // Update match status
                await new Promise((resolve, reject) => {
                    db.run(`
                        UPDATE matches
                        SET status = ?,
                            completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END
                        WHERE id = ?
                    `, [status, status, matchId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                await new Promise((resolve, reject) => {
                    db.run('COMMIT', (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                res.redirect(`/matches/${matchId}`);
            } catch (error) {
                db.run('ROLLBACK');
                console.error(error);
                res.status(500).render('error', { message: 'Error updating match status' });
            }
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
        SELECT m.*, e.id as event_id, e.organization_id
        FROM matches m
        JOIN events e ON m.event_id = e.id
        WHERE m.id = ? AND EXISTS (
            SELECT 1 FROM organization_admins oa
            WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
        )
    `, [matchId, userId], async (err, match) => {
        if (err || !match) {
            return res.status(403).render('error', { message: 'Unauthorized' });
        }
        
        // Start transaction
        db.run('BEGIN TRANSACTION', async (err) => {
            if (err) {
                console.error(err);
                return res.status(500).render('error', { message: 'Error starting transaction' });
            }
            
            try {
                // Get submission scores
                const submission = await new Promise((resolve, reject) => {
                    db.get(`
                        SELECT scores
                        FROM match_submissions
                        WHERE id = ?
                    `, [submissionId], (err, result) => {
                        if (err) reject(err);
                        else resolve(result);
                    });
                });

                // Get match players
                const players = await new Promise((resolve, reject) => {
                    db.all(`
                        SELECT mp.*, u.username as display_name
                        FROM match_players mp
                        JOIN users u ON mp.user_id = u.id
                        WHERE mp.match_id = ?
                        ORDER BY mp.position
                    `, [matchId], (err, results) => {
                        if (err) reject(err);
                        else resolve(results);
                    });
                });

                // Get required custom fields and their responses
                const requiredFields = await new Promise((resolve, reject) => {
                    db.all(`
                        SELECT mcf.id, mcf.field_name, mcf.is_required,
                               GROUP_CONCAT(mcr.user_id) as responded_users
                        FROM match_custom_fields mcf
                        LEFT JOIN match_custom_responses mcr ON mcf.id = mcr.field_id AND mcr.match_id = ?
                        WHERE mcf.event_id = ? AND mcf.is_required = 1
                        GROUP BY mcf.id
                    `, [matchId, match.event_id], (err, results) => {
                        if (err) reject(err);
                        else resolve(results);
                    });
                });

                // Check if all required fields have responses from all players
                const missingResponses = [];
                requiredFields.forEach(field => {
                    const respondedUsers = field.responded_users ? field.responded_users.split(',').map(Number) : [];
                    players.forEach(player => {
                        if (!respondedUsers.includes(player.user_id)) {
                            missingResponses.push({
                                field: field.field_name,
                                player: player.display_name
                            });
                        }
                    });
                });

                if (missingResponses.length > 0) {
                    db.run('ROLLBACK');
                    const errorMessage = 'Cannot finalize match. The following required fields are missing responses:\n' +
                        missingResponses.map(r => `- ${r.player} is missing "${r.field}"`).join('\n');
                    return res.status(400).render('error', { message: errorMessage });
                }

                // Update match status
                await new Promise((resolve, reject) => {
                    db.run(`
                        UPDATE matches
                        SET status = 'completed',
                            completed_at = datetime('now')
                        WHERE id = ?
                    `, [matchId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                const scores = JSON.parse(submission.scores);
                
                // Update player final scores and stats
                await updatePlayerStats(db, matchId, match.event_id, players, scores);
                
                // Update match_players final scores
                const scoreUpdates = players.map((player, index) => {
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

                await Promise.all(scoreUpdates);
                
                await new Promise((resolve, reject) => {
                    db.run('COMMIT', (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                res.redirect(`/matches/${matchId}`);
            } catch (error) {
                db.run('ROLLBACK');
                console.error(error);
                res.status(500).render('error', { message: 'Error updating match and player stats' });
            }
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
        SELECT u.id, u.username as display_name
        FROM users u
        JOIN event_participants ep ON u.id = ep.user_id
        WHERE ep.event_id = ?
    `, [eventId], (err, participants) => {
        if (err) {
            return res.status(500).render('error', { message: 'Database error' });
        }
        
        res.render('new-match', { eventId, participants });
    });
});

router.post('/events/:id/matches', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;
    
    // Get all player IDs from the form
    const playerIds = Object.entries(req.body)
        .filter(([key]) => key.startsWith('player') && key.endsWith('_id'))
        .map(([_, value]) => value);

    // Validate input
    if (playerIds.length < 2) {
        return res.status(400).render('error', { message: 'At least two players are required' });
    }

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).render('error', { message: 'Unauthorized: You must be an admin to create matches' });
        }

        // Verify players are event participants
        const areParticipants = await new Promise((resolve, reject) => {
            const placeholders = playerIds.map(() => '?').join(',');
            db.get(`
                SELECT COUNT(*) as count
                FROM event_participants
                WHERE event_id = ? AND user_id IN (${placeholders})
            `, [eventId, ...playerIds], (err, row) => {
                if (err) reject(err);
                resolve(row.count === playerIds.length);
            });
        });

        if (!areParticipants) {
            return res.status(400).render('error', { message: 'All players must be event participants' });
        }

        // Check if all players have filled out required custom fields
        const missingFields = await new Promise((resolve, reject) => {
            const query = `
                WITH required_fields AS (
                    SELECT id, field_name
                    FROM event_custom_fields
                    WHERE event_id = ? AND is_required = 1
                ),
                missing_responses AS (
                    SELECT 
                        u.id as user_id,
                        u.username as display_name,
                        GROUP_CONCAT(rf.field_name) as missing_fields
                    FROM users u
                    CROSS JOIN required_fields rf
                    LEFT JOIN participant_custom_responses pcr 
                        ON pcr.field_id = rf.id 
                        AND pcr.user_id = u.id
                        AND pcr.event_id = ?
                    WHERE u.id IN (${playerIds.map(() => '?').join(',')})
                    AND (pcr.response IS NULL OR pcr.response = '')
                    GROUP BY u.id, u.username
                    HAVING missing_fields IS NOT NULL
                )
                SELECT * FROM missing_responses;
            `;
            
            db.all(query, [eventId, eventId, ...playerIds], (err, rows) => {
                if (err) reject(err);
                resolve(rows || []);
            });
        });

        if (missingFields.length > 0) {
            const errorMessages = missingFields.map(player => 
                `${player.display_name} needs to fill out: ${player.missing_fields}`
            );
            return res.status(400).render('error', { 
                message: 'Cannot start match. The following players have not filled out required fields:',
                details: errorMessages
            });
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Create the match
            const matchId = await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO matches (event_id, status, created_at, datetime)
                    VALUES (?, 'pending', datetime('now'), ?)
                `, [eventId, req.body.datetime], function(err) {
                    if (err) {
                        console.error('Error creating match:', err);
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                });
            });

            // Add players to match
            const playerInserts = playerIds.map((playerId, index) => {
                return new Promise((resolve, reject) => {
                    db.run(`
                        INSERT INTO match_players (match_id, user_id, position)
                        VALUES (?, ?, ?)
                    `, [matchId, playerId, index + 1], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });

            await Promise.all(playerInserts);

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    else resolve();
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
    } catch (error) {
        console.error('Error creating match:', error);
        return res.status(500).render('error', { message: 'Error creating match' });
    }
});

// Submit match custom field responses
router.post('/matches/:id/custom-responses', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.id;
    const userId = req.session.userId;
    
    // Parse the JSON-encoded responses
    let responses;
    try {
        responses = JSON.parse(req.body.responses);
        console.log('Parsed responses:', responses);
    } catch (err) {
        console.error('Error parsing responses:', err);
        return res.status(400).render('error', { message: 'Invalid responses format' });
    }
    
    // Check if user is a player in the match or an admin
    db.get(`
        SELECT 
            CASE WHEN EXISTS (
                SELECT 1 FROM match_players WHERE match_id = ? AND user_id = ?
            ) THEN 1 ELSE 0 END as is_player,
            CASE WHEN EXISTS (
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                JOIN matches m ON m.event_id = e.id
                WHERE m.id = ? AND oa.user_id = ?
            ) THEN 1 ELSE 0 END as is_admin
    `, [matchId, userId, matchId, userId], (err, result) => {
        if (err) {
            console.error('Error checking user permissions:', err);
            return res.status(500).render('error', { message: 'Error checking permissions' });
        }
        
        if (!result.is_player && !result.is_admin) {
            return res.status(403).render('error', { message: 'Unauthorized: You must be a player or admin to submit responses' });
        }
        
        // Start transaction
        db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
                console.error('Error starting transaction:', err);
                return res.status(500).render('error', { message: 'Error starting transaction' });
            }
            
            // Process each response
            const updates = Object.entries(responses).map(([fieldId, response]) => {
                return new Promise((resolve, reject) => {
                    // Convert fieldId to integer
                    const fieldIdInt = parseInt(fieldId);
                    console.log('Processing field:', {
                        originalFieldId: fieldId,
                        parsedFieldId: fieldIdInt,
                        response: response,
                        responseType: typeof response
                    });
                    
                    if (isNaN(fieldIdInt)) {
                        console.error('Invalid field ID:', fieldId);
                        reject(new Error(`Invalid field ID: ${fieldId}`));
                        return;
                    }

                    // Delete existing response if any
                    db.run(`
                        DELETE FROM match_custom_responses
                        WHERE match_id = ? AND field_id = ? AND user_id = ?
                    `, [matchId, fieldIdInt, userId], (err) => {
                        if (err) {
                            console.error('Error deleting existing response:', err);
                            reject(err);
                            return;
                        }
                        
                        console.log('Deleted existing response for field:', fieldIdInt);
                        
                        // Insert new response
                        db.run(`
                            INSERT INTO match_custom_responses (match_id, field_id, user_id, response)
                            VALUES (?, ?, ?, ?)
                        `, [matchId, fieldIdInt, userId, response], (err) => {
                            if (err) {
                                console.error('Error inserting new response:', err);
                                reject(err);
                            } else {
                                console.log('Successfully inserted response for field:', fieldIdInt);
                                resolve();
                            }
                        });
                    });
                });
            });
            
            if (updates.length === 0) {
                console.log('No responses to process');
                db.run('COMMIT', (err) => {
                    if (err) {
                        console.error('Error committing transaction:', err);
                        return res.status(500).render('error', { message: 'Error saving responses' });
                    }
                    res.redirect(`/matches/${matchId}`);
                });
                return;
            }
            
            Promise.all(updates)
                .then(() => {
                    db.run('COMMIT', (err) => {
                        if (err) {
                            console.error('Error committing transaction:', err);
                            return res.status(500).render('error', { message: 'Error saving responses' });
                        }
                        console.log('Successfully committed all responses');
                        res.redirect(`/matches/${matchId}`);
                    });
                })
                .catch(err => {
                    console.error('Error in Promise.all:', err);
                    db.run('ROLLBACK');
                    console.error('Error saving responses:', err);
                    res.status(500).render('error', { message: 'Error saving responses' });
                });
        });
    });
});

module.exports = router; 