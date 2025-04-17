const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const passport = require('passport');
const { generateVerificationToken, sendVerificationEmail, sendPasswordResetEmail } = require('../services/email');

// Middleware to redirect logged-in users away from auth pages
const redirectIfLoggedIn = (req, res, next) => {
    if (req.session.userId) {
        return res.redirect('/profile');
    }
    next();
};

// Login routes
router.get('/login', redirectIfLoggedIn, (req, res) => {
    const discordEnabled = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
    res.render('login', { error: null, discordEnabled });
});

router.post('/login', redirectIfLoggedIn, (req, res) => {
    const { email, password } = req.body;
    const db = req.app.locals.db;
    const discordEnabled = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
    
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
            console.error('Login error:', err);
            return res.render('login', { error: 'Error during login. Please try again.', discordEnabled });
        }
        
        if (!user) {
            return res.render('login', { error: 'Invalid email or password', discordEnabled });
        }
        
        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (err) {
                console.error('Password comparison error:', err);
                return res.render('login', { error: 'Error during login. Please try again.', discordEnabled });
            }
            
            if (!result) {
                return res.render('login', { error: 'Invalid email or password', discordEnabled });
            }
            
            req.login(user, (err) => {
                if (err) {
                    console.error('Passport login error:', err);
                    return res.render('login', { error: 'Error during login. Please try again.', discordEnabled });
                }
                res.redirect('/profile');
            });
        });
    });
});

// Register routes
router.get('/register', redirectIfLoggedIn, (req, res) => {
    res.render('register');
});

router.post('/register', redirectIfLoggedIn, async (req, res) => {
    const { username, password, email } = req.body;
    const db = req.app.locals.db;
    
    // Validate input
    if (!username || !password || !email) {
        return res.render('register', { error: 'All fields are required' });
    }
    
    const verificationToken = generateVerificationToken();
    
    bcrypt.hash(password, 10, async (err, hash) => {
        if (err) {
            console.error('Password hashing error:', err);
            return res.render('register', { error: 'Error creating account. Please try again.' });
        }
        
        db.run(
            'INSERT INTO users (username, password_hash, email, verified, verification_token) VALUES (?, ?, ?, 0, ?)',
            [username, hash, email, verificationToken],
            async function(err) {
                if (err) {
                    console.error('Registration error:', err);
                    if (err.code === 'SQLITE_CONSTRAINT') {
                        if (err.message.includes('users.username')) {
                            return res.render('register', { error: 'Username already exists' });
                        } else if (err.message.includes('users.email')) {
                            return res.render('register', { error: 'Email already exists' });
                        }
                    }
                    return res.render('register', { error: 'Error creating account. Please try again.' });
                }
                
                const newUser = {
                    id: this.lastID,
                    username: username,
                    email: email
                };
                
                // Send verification email
                const emailSent = await sendVerificationEmail(email, verificationToken);
                if (!emailSent) {
                    console.error('Failed to send verification email');
                    // Continue with registration even if email fails
                }
                
                req.login(newUser, (err) => {
                    if (err) {
                        console.error('Passport login error:', err);
                        return res.render('register', { error: 'Error creating account. Please try again.' });
                    }
                    res.redirect('/profile');
                });
            }
        );
    });
});

// Logout route
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Discord OAuth routes
router.get('/discord', passport.authenticate('discord'));

router.get('/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/login' }),
    (req, res) => {
        // Set session userId for compatibility
        req.session.userId = req.user.id;
        res.redirect('/profile');
    }
);

// Verify email route
router.get('/verify', async (req, res) => {
    const { token } = req.query;
    const db = req.app.locals.db;
    
    if (!token) {
        return res.status(400).render('error', { message: 'Invalid verification link' });
    }
    
    try {
        // Find user with matching token
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE verification_token = ?', [token], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
        
        if (!user) {
            return res.status(400).render('error', { message: 'Invalid verification link' });
        }
        
        // Update user as verified
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE users SET verified = 1, verification_token = NULL WHERE id = ?',
                [user.id],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });
        
        res.render('message', {
            title: 'Email Verified',
            message: 'Your email has been verified successfully!'
        });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).render('error', { message: 'Error verifying email' });
    }
});

// Resend verification email route
router.post('/resend-verification', async (req, res) => {
    const db = req.app.locals.db;
    const userId = req.session.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'Not logged in' });
    }
    
    try {
        // Get user details
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.verified) {
            return res.status(400).json({ error: 'Email already verified' });
        }
        
        // Check if enough time has passed since last email
        const now = new Date();
        const lastEmail = user.last_verification_email ? new Date(user.last_verification_email) : null;
        const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
        
        if (lastEmail && (now - lastEmail) < fiveMinutes) {
            return res.status(429).json({ error: 'Please wait before requesting another verification email' });
        }
        
        // Generate new token
        const verificationToken = generateVerificationToken();
        
        // Update user with new token and timestamp
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE users SET verification_token = ?, last_verification_email = datetime("now") WHERE id = ?',
                [verificationToken, userId],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });
        
        // Send verification email
        const emailSent = await sendVerificationEmail(user.email, verificationToken);
        if (!emailSent) {
            return res.status(500).json({ error: 'Failed to send verification email' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ error: 'Error sending verification email' });
    }
});

// Forgot password routes
router.get('/forgot-password', redirectIfLoggedIn, (req, res) => {
    res.render('forgot-password');
});

router.post('/forgot-password', redirectIfLoggedIn, async (req, res) => {
    const { email } = req.body;
    const db = req.app.locals.db;
    
    try {
        // Check if user exists
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
        
        if (!user) {
            // Don't reveal if email exists or not
            return res.render('forgot-password', {
                success: 'If an account exists with that email, a password reset link has been sent.'
            });
        }
        
        // Generate reset token
        const resetToken = generateVerificationToken();
        
        // Store reset token and expiry in database
        const expiry = new Date();
        expiry.setHours(expiry.getHours() + 1); // Token expires in 1 hour
        
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
                [resetToken, expiry.toISOString(), user.id],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });
        
        // Send reset email
        const emailSent = await sendPasswordResetEmail(email, resetToken);
        if (!emailSent) {
            throw new Error('Failed to send reset email');
        }
        
        res.render('forgot-password', {
            success: 'If an account exists with that email, a password reset link has been sent.'
        });
    } catch (error) {
        console.error('Password reset error:', error);
        res.render('forgot-password', {
            error: 'An error occurred. Please try again.'
        });
    }
});

// Reset password routes
router.get('/reset-password', redirectIfLoggedIn, async (req, res) => {
    const { token } = req.query;
    const db = req.app.locals.db;
    
    if (!token) {
        return res.status(400).render('error', { message: 'Invalid reset link' });
    }
    
    try {
        // Check if token exists and is not expired
        const user = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM users WHERE reset_token = ? AND reset_token_expiry > datetime("now")',
                [token],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });
        
        if (!user) {
            return res.status(400).render('error', { message: 'Invalid or expired reset link' });
        }
        
        res.render('reset-password', { token });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).render('error', { message: 'Error processing reset request' });
    }
});

router.post('/reset-password', redirectIfLoggedIn, async (req, res) => {
    const { token, password, confirmPassword } = req.body;
    const db = req.app.locals.db;
    
    if (password !== confirmPassword) {
        return res.render('reset-password', {
            token,
            error: 'Passwords do not match'
        });
    }
    
    try {
        // Check if token exists and is not expired
        const user = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM users WHERE reset_token = ? AND reset_token_expiry > datetime("now")',
                [token],
                (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                }
            );
        });
        
        if (!user) {
            return res.status(400).render('error', { message: 'Invalid or expired reset link' });
        }
        
        // Hash new password
        const hash = await new Promise((resolve, reject) => {
            bcrypt.hash(password, 10, (err, hash) => {
                if (err) reject(err);
                resolve(hash);
            });
        });
        
        // Update password and clear reset token
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
                [hash, user.id],
                (err) => {
                    if (err) reject(err);
                    resolve();
                }
            );
        });
        
        res.render('message', {
            title: 'Password Reset',
            message: 'Your password has been reset successfully. You can now login with your new password.'
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).render('error', { message: 'Error resetting password' });
    }
});

module.exports = router; 