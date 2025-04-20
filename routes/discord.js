router.get('/callback', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) {
            return res.redirect('/login?error=no_code');
        }

        // Exchange code for access token
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', 
            querystring.stringify({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.DISCORD_REDIRECT_URI
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token } = tokenResponse.data;

        // Get user info from Discord
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `Bearer ${access_token}`
            }
        });

        const { id, username, email, avatar } = userResponse.data;

        // Check if user exists with this Discord ID
        const existingUser = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE discord_id = ?', [id], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        let user;
        if (existingUser) {
            // Update existing user
            user = await new Promise((resolve, reject) => {
                db.run(`
                    UPDATE users 
                    SET username = ?, 
                        email = ?, 
                        avatar = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE discord_id = ?
                `, [username, email, avatar, id], function(err) {
                    if (err) reject(err);
                    resolve(existingUser);
                });
            });
        } else {
            // Create new user
            user = await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO users (
                        username, email, discord_id, avatar, verified
                    ) VALUES (?, ?, ?, ?, 1)
                `, [username, email, id, avatar], function(err) {
                    if (err) {
                        console.error('Error creating user:', err);
                        reject(err);
                    }
                    resolve({
                        id: this.lastID,
                        username,
                        email,
                        discord_id: id,
                        avatar
                    });
                });
            });
        }

        // Set session
        req.session.userId = user.id;
        req.session.username = user.username;

        res.redirect('/');
    } catch (error) {
        console.error('Discord OAuth error:', error);
        res.redirect('/login?error=oauth_failed');
    }
}); 