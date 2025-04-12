const express = require('express');
const router = express.Router();

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
        return res.status(401).send('You must be logged in to create an organization');
    }
    
    db.run(
        'INSERT INTO organizations (name, description, admin_id, created_by) VALUES (?, ?, ?, ?)',
        [name, description, adminId, adminId],
        function(err) {
            if (err) {
                console.error('Error creating organization:', err);
                return res.status(500).send('Error creating organization');
            }
            
            const orgId = this.lastID;
            
            // Add admin as member
            db.run(
                'INSERT INTO organization_members (organization_id, user_id) VALUES (?, ?)',
                [orgId, adminId],
                (err) => {
                    if (err) {
                        console.error('Error adding admin to organization:', err);
                        return res.status(500).send('Error adding admin to organization');
                    }
                    
                    res.redirect('/profile');
                }
            );
        }
    );
});

// Organization details route
router.get('/organizations/:id', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const userId = req.session.userId;
    
    // Get organization details with admin and member status
    db.get(`
        SELECT o.*, 
               CASE WHEN o.admin_id = ? THEN 1 ELSE 0 END as is_admin,
               CASE WHEN om.user_id IS NOT NULL THEN 1 ELSE 0 END as is_member,
               CASE WHEN o.created_by = ? THEN 1 ELSE 0 END as is_creator
        FROM organizations o
        LEFT JOIN organization_members om ON o.id = om.organization_id AND om.user_id = ?
        WHERE o.id = ?
    `, [userId, userId, userId, orgId], (err, organization) => {
        if (err) {
            console.error('Error fetching organization details:', err);
            return res.status(500).send('Database error');
        }
        
        // Get organization events
        db.all(`
            SELECT events.*,
                   CASE WHEN o.admin_id = ? THEN 1 ELSE 0 END as is_admin
            FROM events
            JOIN organizations o ON events.organization_id = o.id
            WHERE events.organization_id = ?
            AND (o.admin_id = ? OR events.hidden = 0)
            ORDER BY events.created_at DESC
        `, [userId, orgId, userId], (err, events) => {
            if (err) {
                console.error('Error fetching events:', err);
                return res.status(500).send('Database error');
            }
            
            // Get organization members
            db.all(`
                SELECT u.id, u.username,
                       CASE WHEN o.admin_id = u.id THEN 1 ELSE 0 END as is_admin,
                       CASE WHEN o.created_by = u.id THEN 1 ELSE 0 END as is_creator
                FROM users u
                JOIN organization_members om ON u.id = om.user_id
                JOIN organizations o ON om.organization_id = o.id
                WHERE o.id = ?
            `, [orgId], (err, members) => {
                if (err) {
                    console.error('Error fetching members:', err);
                    return res.status(500).send('Database error');
                }
                
                res.render('organization', {
                    organization,
                    events,
                    members,
                    isAdmin: organization.is_admin,
                    isMember: organization.is_member,
                    isCreator: organization.is_creator,
                    userId: userId
                });
            });
        });
    });
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
            console.error(err);
            return res.status(500).send('Error checking membership');
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
                    console.error(err);
                    return res.status(500).send('Error joining organization');
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
                'SELECT 1 FROM organizations WHERE id = ? AND admin_id = ?',
                [id, currentUserId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: You must be an admin to kick members');
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
                     WHERE event_id IN (
                         SELECT id FROM events WHERE organization_id = ?
                     ) AND (player1_id = ? OR player2_id = ?)`,
                    [id, userId, userId],
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
        res.status(500).send('Error kicking user');
    }
});

// Ban a user from an organization
router.post('/organizations/:id/ban/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const { id, userId } = req.params;
    const currentUserId = req.session.userId;

    try {
        // Check if current user is an admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organizations WHERE id = ? AND admin_id = ?',
                [id, currentUserId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: You must be an admin to ban members');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // First kick the user (which handles events and matches)
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

            // Then add them to the banned list
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO organization_bans (organization_id, user_id) VALUES (?, ?)',
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
        console.error('Error banning user:', error);
        res.status(500).send('Error banning user');
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
            return res.status(403).send('Unauthorized: You must be an admin to promote members');
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
                    'INSERT OR IGNORE INTO organization_admins (organization_id, user_id) VALUES (?, ?)',
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
        res.status(500).send('Error promoting user');
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
            return res.status(403).send('Unauthorized: Only the organization creator can remove admin status');
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
            return res.status(403).send('Cannot remove admin status from organization creator');
        }

        // Remove admin status
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE organizations SET admin_id = ? WHERE id = ? AND admin_id = ?',
                [currentUserId, id, userId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });

        res.redirect(`/organizations/${id}`);
    } catch (error) {
        console.error('Error removing admin status:', error);
        res.status(500).send('Error removing admin status');
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

    // Get user's organizations with pagination
    db.all(`
        SELECT o.*, 
               COUNT(om2.user_id) as member_count,
               CASE WHEN o.admin_id = ? THEN 1 ELSE 0 END as is_admin,
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
            console.error(err);
            return res.status(500).send('Error fetching user organizations');
        }

        // Get total count of user's organizations for pagination
        db.get(`
            SELECT COUNT(DISTINCT o.id) as count
            FROM organizations o
            JOIN organization_members om ON o.id = om.organization_id
            WHERE om.user_id = ?
            AND (o.name LIKE ? OR o.description LIKE ?)
        `, [userId, `%${search}%`, `%${search}%`], (err, userOrgsCount) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error counting user organizations');
            }

            // Get other organizations with pagination
            db.all(`
                SELECT o.*, 
                       COUNT(om.user_id) as member_count,
                       CASE WHEN o.admin_id = ? THEN 1 ELSE 0 END as is_admin,
                       CASE WHEN o.created_by = ? THEN 1 ELSE 0 END as is_creator,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_members 
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_member
                FROM organizations o
                LEFT JOIN organization_members om ON o.id = om.organization_id
                WHERE NOT EXISTS (
                    SELECT 1 FROM organization_members 
                    WHERE organization_id = o.id AND user_id = ?
                )
                AND (o.name LIKE ? OR o.description LIKE ?)
                GROUP BY o.id
                ORDER BY o.created_at DESC
                LIMIT ? OFFSET ?
            `, [userId, userId, userId, userId, `%${search}%`, `%${search}%`, limit, offset], (err, otherOrgs) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Error fetching all organizations');
                }

                // Get total count of other organizations for pagination
                db.get(`
                    SELECT COUNT(DISTINCT o.id) as count
                    FROM organizations o
                    WHERE NOT EXISTS (
                        SELECT 1 FROM organization_members 
                        WHERE organization_id = o.id AND user_id = ?
                    )
                    AND (o.name LIKE ? OR o.description LIKE ?)
                `, [userId, `%${search}%`, `%${search}%`], (err, otherOrgsCount) => {
                    if (err) {
                        console.error(err);
                        return res.status(500).send('Error counting other organizations');
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

module.exports = router; 