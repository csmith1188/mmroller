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

// Organization routes
router.get('/organizations/new', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    res.render('new-organization');
});

router.post('/organizations', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const { name, description } = req.body;
    const adminId = req.session.userId;
    
    if (!adminId) {
        return res.status(401).render('error', { message: 'You must be logged in to create an organization' });
    }
    
    // Start transaction
    db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
            console.error('Error starting transaction:', err);
            return res.status(500).render('error', { message: 'Error creating organization' });
        }
        
        // Create organization
        db.run(
            'INSERT INTO organizations (name, description, created_by) VALUES (?, ?, ?)',
            [name, description, adminId],
            function(err) {
                if (err) {
                    console.error('Error creating organization:', err);
                    db.run('ROLLBACK', (rollbackErr) => {
                        if (rollbackErr) {
                            console.error('Error rolling back transaction:', rollbackErr);
                        }
                        return res.status(500).render('error', { message: 'Error creating organization' });
                    });
                    return;
                }
                
                const orgId = this.lastID;
                
                // Add creator as member
                db.run(
                    'INSERT INTO organization_members (organization_id, user_id) VALUES (?, ?)',
                    [orgId, adminId],
                    (err) => {
                        if (err) {
                            console.error('Error adding creator to organization:', err);
                            db.run('ROLLBACK', (rollbackErr) => {
                                if (rollbackErr) {
                                    console.error('Error rolling back transaction:', rollbackErr);
                                }
                                return res.status(500).render('error', { message: 'Error adding creator to organization' });
                            });
                            return;
                        }
                        
                        // Add creator as admin
                        db.run(
                            'INSERT INTO organization_admins (organization_id, user_id) VALUES (?, ?)',
                            [orgId, adminId],
                            (err) => {
                                if (err) {
                                    console.error('Error adding creator as admin:', err);
                                    db.run('ROLLBACK', (rollbackErr) => {
                                        if (rollbackErr) {
                                            console.error('Error rolling back transaction:', rollbackErr);
                                        }
                                        return res.status(500).render('error', { message: 'Error adding creator as admin' });
                                    });
                                    return;
                                }
                                
                                // Commit transaction
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        console.error('Error committing transaction:', err);
                                        db.run('ROLLBACK', (rollbackErr) => {
                                            if (rollbackErr) {
                                                console.error('Error rolling back transaction:', rollbackErr);
                                            }
                                            return res.status(500).render('error', { message: 'Error creating organization' });
                                        });
                                        return;
                                    }
                                    
                                    res.redirect('/profile');
                                });
                            }
                        );
                    }
                );
            }
        );
    });
});

// Organization details route
router.get('/organizations/:id', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const userId = req.session.userId;

    try {
        // Get organization details
        const organization = await new Promise((resolve, reject) => {
            db.get(
                'SELECT o.*, u.username as creator_name FROM organizations o JOIN users u ON o.created_by = u.id WHERE o.id = ?',
                [orgId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });

        if (!organization) {
            return res.status(404).render('error', { message: 'Organization not found' });
        }

        // Check if user is admin
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

        // Check if user is member
        const isMember = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?',
                [orgId, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        // Enforce visibility rules
        if (!isAdmin && !isMember) {
            if (organization.visibility === 'hidden') {
                return res.status(404).render('error', { message: 'Organization not found' });
            }
        }

        // Check if user has applied
        const hasApplied = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_applications WHERE organization_id = ? AND user_id = ?',
                [orgId, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        // Get organization members
        const members = await new Promise((resolve, reject) => {
            db.all(`
                SELECT u.id, u.username as display_name, 
                       CASE WHEN oa.user_id IS NOT NULL THEN 1 ELSE 0 END as is_admin,
                       CASE WHEN o.created_by = u.id THEN 1 ELSE 0 END as is_creator
                FROM users u
                JOIN organization_members om ON u.id = om.user_id
                LEFT JOIN organization_admins oa ON oa.organization_id = om.organization_id AND oa.user_id = om.user_id
                JOIN organizations o ON o.id = om.organization_id
                WHERE om.organization_id = ?
                ORDER BY u.username
            `, [orgId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Get organization events
        const events = await new Promise((resolve, reject) => {
            db.all(`
                SELECT e.*, 
                       CASE WHEN ep.user_id IS NOT NULL THEN 1 ELSE 0 END as is_participant,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = e.organization_id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin
                FROM events e
                LEFT JOIN event_participants ep ON e.id = ep.event_id AND ep.user_id = ?
                WHERE e.organization_id = ?
                AND (
                    e.visibility != 'hidden'  -- Show non-hidden events
                    OR EXISTS (  -- Show hidden events if user is admin
                        SELECT 1 FROM organization_admins oa
                        WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
                    )
                    OR EXISTS (  -- Show hidden events if user is participant
                        SELECT 1 FROM event_participants ep2
                        WHERE ep2.event_id = e.id AND ep2.user_id = ?
                    )
                )
                ORDER BY e.start_date DESC
            `, [userId, userId, orgId, userId, userId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Get organization applications if user is admin
        let applications = [];
        if (isAdmin) {
            applications = await new Promise((resolve, reject) => {
                db.all(`
                    SELECT oa.*, u.username as display_name
                    FROM organization_applications oa
                    JOIN users u ON oa.user_id = u.id
                    WHERE oa.organization_id = ?
                    ORDER BY oa.applied_at DESC
                `, [orgId], (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                });
            });
        }

        // Determine if user can apply based on visibility rules
        const canApply = !isMember && !hasApplied && userId && 
                        (organization.visibility === 'public' || organization.visibility === 'open');

        res.render('organization', {
            organization: {
                ...organization,
                is_admin: isAdmin,
                is_creator: organization.created_by === userId
            },
            members,
            applications,
            events,
            isAdmin,
            isMember,
            hasApplied,
            canApply,
            userId
        });
    } catch (error) {
        console.error('Error fetching organization details:', error);
        res.status(500).render('error', { message: 'Error fetching organization details' });
    }
});

// Organization join route
router.post('/organizations/:id/join', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const userId = req.session.userId;
    
    // Check if user is already a member
    db.get(`
        SELECT 1 FROM organization_members 
        WHERE organization_id = ? AND user_id = ?
    `, [orgId, userId], (err, result) => {
        if (err) {
            console.error('Error checking membership:', err);
            return res.status(500).render('error', { message: 'Error checking membership' });
        }
        
        if (result) {
            return res.redirect(`/organizations/${orgId}`);
        }
        
        // Add user as member
        db.run(
            'INSERT INTO organization_members (organization_id, user_id) VALUES (?, ?)',
            [orgId, userId],
            (err) => {
                if (err) {
                    console.error('Error joining organization:', err);
                    return res.status(500).render('error', { message: 'Error joining organization' });
                }
                
                res.redirect(`/organizations/${orgId}`);
            }
        );
    });
});

// Kick a user from an organization
router.post('/organizations/:id/kick/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const { id, userId } = req.params;
    const currentUserId = req.session.userId;

    try {
        // Check if current user is an admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_admins WHERE organization_id = ? AND user_id = ?',
                [id, currentUserId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).render('error', { message: 'Unauthorized: You must be an admin to kick members' });
        }

        // Check if target user is the organization creator
        const isCreator = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organizations WHERE id = ? AND created_by = ?',
                [id, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (isCreator) {
            return res.status(403).render('error', { message: 'Unauthorized: Cannot kick the organization creator' });
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Remove user from organization
            await new Promise((resolve, reject) => {
                db.run(
                    'DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?',
                    [id, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Remove user from all organization events
            await new Promise((resolve, reject) => {
                db.run(
                    `DELETE FROM event_participants 
                     WHERE user_id = ? AND event_id IN (
                         SELECT id FROM events WHERE organization_id = ?
                     )`,
                    [userId, id],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Update matches where user was a player to forfeit
            await new Promise((resolve, reject) => {
                db.run(
                    `UPDATE matches 
                     SET status = 'forfeit'
                     WHERE id IN (
                         SELECT match_id FROM match_players 
                         WHERE user_id = ? AND match_id IN (
                             SELECT id FROM matches 
                             WHERE event_id IN (
                                 SELECT id FROM events 
                                 WHERE organization_id = ?
                             )
                         )
                     )`,
                    [userId, id],
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

            res.redirect(`/organizations/${id}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error kicking user:', error);
        return res.status(500).render('error', { message: 'Error kicking user' });
    }
});

// Ban member from organization
router.post('/organizations/:id/ban/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const targetUserId = req.params.userId;
    const adminId = req.session.userId;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins
                WHERE organization_id = ? AND user_id = ?
            `, [orgId, adminId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).render('error', { message: 'Unauthorized: Only organization admins can ban members' });
        }

        // Check if target user is the organization creator
        const isCreator = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organizations
                WHERE id = ? AND created_by = ?
            `, [orgId, targetUserId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (isCreator) {
            return res.status(403).render('error', { message: 'Cannot ban the organization creator' });
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Add ban record
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT OR REPLACE INTO organization_bans (organization_id, user_id, status)
                    VALUES (?, ?, 'active')
                `, [orgId, targetUserId], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            // Remove user from all organization events
            await new Promise((resolve, reject) => {
                db.run(`
                    DELETE FROM event_participants
                    WHERE user_id = ? AND event_id IN (
                        SELECT id FROM events WHERE organization_id = ?
                    )
                `, [targetUserId, orgId], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            // Ban user from all organization events
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT OR REPLACE INTO event_bans (event_id, user_id, status)
                    SELECT id, ?, 'active'
                    FROM events
                    WHERE organization_id = ?
                `, [targetUserId, orgId], (err) => {
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

            res.redirect(`/organizations/${orgId}`);
        } catch (err) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw err;
        }
    } catch (err) {
        console.error('Error banning member:', err);
        return res.status(500).render('error', { message: 'Error banning member' });
    }
});

// Unban member from organization
router.post('/organizations/:id/unban/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const userId = req.params.userId;
    const adminId = req.session.userId;

    try {
        // Check if user is admin
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins
                WHERE organization_id = ? AND user_id = ?
            `, [orgId, adminId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).render('error', { message: 'Unauthorized: Only organization admins can unban members' });
        }

        // Update ban status to inactive
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE organization_bans
                SET status = 'inactive'
                WHERE organization_id = ? AND user_id = ?
            `, [orgId, userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.redirect(`/organizations/${orgId}`);
    } catch (err) {
        console.error('Error unbanning member:', err);
        return res.status(500).render('error', { message: 'Error unbanning member' });
    }
});

// Promote a user to admin
router.post('/organizations/:id/promote/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const { id, userId } = req.params;
    const currentUserId = req.session.userId;

    try {
        // Check if current user is an admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_admins WHERE organization_id = ? AND user_id = ?',
                [id, currentUserId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).render('error', { message: 'Unauthorized: You must be an admin to promote members' });
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Add the new admin to the organization_members table if not already a member
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR IGNORE INTO organization_members (organization_id, user_id) VALUES (?, ?)',
                    [id, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Add the user as an admin
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO organization_admins (organization_id, user_id) VALUES (?, ?)',
                    [id, userId],
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

            res.redirect(`/organizations/${id}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error promoting user:', error);
        return res.status(500).render('error', { message: 'Error promoting user' });
    }
});

// Remove admin status from a member
router.post('/organizations/:id/remove-admin/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const { id, userId } = req.params;
    const currentUserId = req.session.userId;

    try {
        // Check if current user is the creator of the organization
        const isCreator = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organizations WHERE id = ? AND created_by = ?',
                [id, currentUserId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isCreator) {
            return res.status(403).render('error', { message: 'Unauthorized: Only the organization creator can remove admin status' });
        }

        // Check if target user is the creator
        const isTargetCreator = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organizations WHERE id = ? AND created_by = ?',
                [id, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (isTargetCreator) {
            return res.status(403).render('error', { message: 'Cannot remove admin status from organization creator' });
        }

        // Remove admin status
        await new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM organization_admins WHERE organization_id = ? AND user_id = ?',
                [id, userId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.redirect(`/organizations/${id}`);
    } catch (error) {
        console.error('Error removing admin status:', error);
        return res.status(500).render('error', { message: 'Error removing admin status' });
    }
});

// List all organizations
router.get('/organizations', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.session.userId;
    const search = req.query.search || '';
    const page = parseInt(req.query.page) || 1;
    const limit = 10; // Number of items per page
    const offset = (page - 1) * limit;

    // Get user's organizations with pagination (including hidden ones since user is a member)
    db.all(`
        SELECT o.*, 
               COUNT(om2.user_id) as member_count,
               CASE WHEN EXISTS (
                   SELECT 1 FROM organization_admins 
                   WHERE organization_id = o.id AND user_id = ?
               ) THEN 1 ELSE 0 END as is_admin,
               CASE WHEN o.created_by = ? THEN 1 ELSE 0 END as is_creator,
               CASE WHEN EXISTS (
                   SELECT 1 FROM organization_members 
                   WHERE organization_id = o.id AND user_id = ?
               ) THEN 1 ELSE 0 END as is_member
        FROM organizations o
        LEFT JOIN organization_members om ON o.id = om.organization_id
        LEFT JOIN organization_members om2 ON o.id = om2.organization_id
        WHERE EXISTS (
            SELECT 1 FROM organization_members 
            WHERE organization_id = o.id AND user_id = ?
        )
        AND (o.name LIKE ? OR o.description LIKE ?)
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
    `, [userId, userId, userId, userId, `%${search}%`, `%${search}%`, limit, offset], (err, userOrgs) => {
        if (err) {
            console.error('Error fetching user organizations:', err);
            return res.status(500).render('error', { message: 'Error fetching user organizations' });
        }

        // Format descriptions for user's organizations
        userOrgs.forEach(org => {
            org.description = formatDescription(org.description);
        });

        // Get total count of user's organizations for pagination
        db.get(`
            SELECT COUNT(DISTINCT o.id) as count
            FROM organizations o
            JOIN organization_members om ON o.id = om.organization_id
            WHERE om.user_id = ?
            AND (o.name LIKE ? OR o.description LIKE ?)
        `, [userId, `%${search}%`, `%${search}%`], (err, userOrgsCount) => {
            if (err) {
                console.error('Error counting user organizations:', err);
                return res.status(500).render('error', { message: 'Error counting user organizations' });
            }

            // Get other organizations with pagination (excluding hidden ones)
            db.all(`
                SELECT o.*, 
                       COUNT(om.user_id) as member_count,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin,
                       CASE WHEN o.created_by = ? THEN 1 ELSE 0 END as is_creator,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_members 
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_member,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_applications
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as has_applied
                FROM organizations o
                LEFT JOIN organization_members om ON o.id = om.organization_id
                WHERE NOT EXISTS (
                    SELECT 1 FROM organization_members 
                    WHERE organization_id = o.id AND user_id = ?
                )
                AND o.visibility != 'hidden'
                AND (o.name LIKE ? OR o.description LIKE ?)
                GROUP BY o.id
                ORDER BY o.created_at DESC
                LIMIT ? OFFSET ?
            `, [userId, userId, userId, userId, userId, `%${search}%`, `%${search}%`, limit, offset], (err, otherOrgs) => {
                if (err) {
                    console.error('Error fetching all organizations:', err);
                    return res.status(500).render('error', { message: 'Error fetching all organizations' });
                }

                // Format descriptions for other organizations
                otherOrgs.forEach(org => {
                    org.description = formatDescription(org.description);
                });

                // Get total count of other organizations for pagination (excluding hidden ones)
                db.get(`
                    SELECT COUNT(DISTINCT o.id) as count
                    FROM organizations o
                    WHERE NOT EXISTS (
                        SELECT 1 FROM organization_members 
                        WHERE organization_id = o.id AND user_id = ?
                    )
                    AND o.visibility != 'hidden'
                    AND (o.name LIKE ? OR o.description LIKE ?)
                `, [userId, `%${search}%`, `%${search}%`], (err, otherOrgsCount) => {
                    if (err) {
                        console.error('Error counting other organizations:', err);
                        return res.status(500).render('error', { message: 'Error counting other organizations' });
                    }

                    const totalUserPages = Math.ceil(userOrgsCount.count / limit);
                    const totalOtherPages = Math.ceil(otherOrgsCount.count / limit);

                    res.render('organizations', { 
                        userOrgs,
                        otherOrgs,
                        userId,
                        search,
                        currentPage: page,
                        totalPages: Math.max(totalUserPages, totalOtherPages),
                        hasNextPage: page < Math.max(totalUserPages, totalOtherPages),
                        hasPrevPage: page > 1
                    });
                });
            });
        });
    });
});

// Update organization
router.post('/organizations/:id/update', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const { id } = req.params;
    const { name, description, visibility } = req.body;
    const userId = req.session.userId;

    try {
        // Check if user is an admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_admins WHERE organization_id = ? AND user_id = ?',
                [id, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).render('error', { message: 'Unauthorized: You must be an admin to update the organization' });
        }

        // Validate visibility value
        const validVisibilities = ['hidden', 'private', 'public', 'open'];
        if (visibility && !validVisibilities.includes(visibility)) {
            return res.status(400).render('error', { message: 'Invalid visibility value' });
        }

        // Update organization
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE organizations SET name = ?, description = ?, visibility = ? WHERE id = ?',
                [name, description, visibility || 'private', id],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.redirect(`/organizations/${id}`);
    } catch (error) {
        console.error('Error updating organization:', error);
        return res.status(500).render('error', { message: 'Error updating organization' });
    }
});

// Leave organization
router.post('/organizations/:id/leave', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.session.userId;
    const organizationId = req.params.id;

    try {
        // Check if user is the creator
        const org = await new Promise((resolve, reject) => {
            db.get('SELECT created_by FROM organizations WHERE id = ?', [organizationId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!org) {
            return res.status(404).render('error', { message: 'Organization not found' });
        }

        if (org.created_by === userId) {
            return res.status(403).render('error', { message: 'Organization creator cannot leave the organization' });
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        try {
            // Remove user from organization
            await new Promise((resolve, reject) => {
                db.run('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?', 
                    [organizationId, userId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });

            // Remove user from organization admins if they are one
            await new Promise((resolve, reject) => {
                db.run('DELETE FROM organization_admins WHERE organization_id = ? AND user_id = ?', 
                    [organizationId, userId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });

            // Get all events in the organization
            const events = await new Promise((resolve, reject) => {
                db.all('SELECT id FROM events WHERE organization_id = ?', [organizationId], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });

            // Remove user from all organization events
            for (const event of events) {
                await new Promise((resolve, reject) => {
                    db.run('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?', 
                        [event.id, userId], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                });

                // Mark user's matches as forfeit
                await new Promise((resolve, reject) => {
                    db.run(`
                        UPDATE matches 
                        SET status = 'forfeit' 
                        WHERE event_id = ? 
                        AND id IN (
                            SELECT match_id 
                            FROM match_players 
                            WHERE user_id = ?
                        )
                    `, [event.id, userId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            res.redirect('/organizations');
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error leaving organization:', error);
        return res.status(500).render('error', { message: 'Error leaving organization' });
    }
});

// Apply to join organization
router.post('/organizations/:id/apply', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const userId = req.session.userId;

    if (!userId) {
        return res.status(401).render('error', { message: 'You must be logged in to apply to an organization' });
    }

    try {
        // Get organization details and check if user is banned
        const org = await new Promise((resolve, reject) => {
            db.get(`
                SELECT o.*, 
                       CASE WHEN ob.user_id IS NOT NULL AND ob.status = 'active' THEN 1 ELSE 0 END as is_banned
                FROM organizations o
                LEFT JOIN organization_bans ob ON o.id = ob.organization_id AND ob.user_id = ?
                WHERE o.id = ?
            `, [userId, orgId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!org) {
            return res.status(404).render('error', { message: 'Organization not found' });
        }

        // Check if user is banned
        if (org.is_banned) {
            return res.status(403).render('error', { message: 'You are banned from this organization' });
        }

        // Check if user is already a member
        const isMember = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?',
                [orgId, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (isMember) {
            return res.status(400).render('error', { message: 'You are already a member of this organization' });
        }

        // Check if user has already applied
        const hasApplied = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_applications WHERE organization_id = ? AND user_id = ?',
                [orgId, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (hasApplied) {
            return res.status(400).render('error', { message: 'You have already applied to this organization' });
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            if (org.visibility === 'open') {
                // For open organizations, automatically add as member
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO organization_members (organization_id, user_id) VALUES (?, ?)',
                        [orgId, userId],
                        (err) => {
                            if (err) reject(err);
                            resolve();
                        }
                    );
                });
            } else {
                // For other organizations, create application
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO organization_applications (organization_id, user_id, applied_at) VALUES (?, ?, datetime("now"))',
                        [orgId, userId],
                        (err) => {
                            if (err) reject(err);
                            resolve();
                        }
                    );
                });
            }

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/organizations/${orgId}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error processing application:', error);
        res.status(500).render('error', { message: 'Error processing application' });
    }
});

// Accept organization application
router.post('/organizations/:id/accept/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const userId = req.params.userId;
    const currentUserId = req.session.userId;

    try {
        // Verify user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_admins WHERE organization_id = ? AND user_id = ?',
                [orgId, currentUserId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).render('error', { message: 'Unauthorized: Only organization admins can accept applications' });
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Add user as member
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO organization_members (organization_id, user_id) VALUES (?, ?)',
                    [orgId, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Remove application
            await new Promise((resolve, reject) => {
                db.run(
                    'DELETE FROM organization_applications WHERE organization_id = ? AND user_id = ?',
                    [orgId, userId],
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

            res.redirect(`/organizations/${orgId}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error accepting application:', error);
        res.status(500).render('error', { message: 'Error accepting application' });
    }
});

// Reject organization application
router.post('/organizations/:id/reject/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const userId = req.params.userId;
    const currentUserId = req.session.userId;

    try {
        // Verify user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_admins WHERE organization_id = ? AND user_id = ?',
                [orgId, currentUserId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).render('error', { message: 'Unauthorized: Only organization admins can reject applications' });
        }

        // Delete the application
        await new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM organization_applications WHERE organization_id = ? AND user_id = ?',
                [orgId, userId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.redirect(`/organizations/${orgId}`);
    } catch (error) {
        console.error('Error rejecting application:', error);
        res.status(500).render('error', { message: 'Error rejecting application' });
    }
});

module.exports = router; 