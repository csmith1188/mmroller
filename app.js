require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const app = express();
const port = 3000;

// Import route files
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const organizationRoutes = require('./routes/organizations');
const eventRoutes = require('./routes/events');
const matchRoutes = require('./routes/matches');

// Database setup
const dbPath = path.join(__dirname, 'database', 'database.db');
console.log('Database path:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
    console.log('Database opened successfully');
});

// Authentication middleware
const requireLogin = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    // Set session userId for compatibility with existing code
    req.session.userId = req.user.id;
    next();
};

// Make db and requireLogin available to route files
app.locals.db = db;
app.locals.requireLogin = requireLogin;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session middleware
app.use(session({
    store: new SQLiteStore({
        db: 'database.db',
        table: 'sessions',
        dir: path.join(__dirname, 'database')
    }),
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Initialize passport
app.use(passport.initialize());
app.use(passport.session());

// Configure passport with Discord strategy
passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/discord/callback',
    scope: ['identify', 'email']
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const db = app.locals.db;
        
        // Check if user exists
        db.get('SELECT * FROM users WHERE discord_id = ?', [profile.id], (err, user) => {
            if (err) {
                console.error('Database error:', err);
                return done(err);
            }
            
            if (user) {
                console.log('Existing user found:', user);
                // Update user's Discord info
                db.run(`
                    UPDATE users 
                    SET username = ?, email = ?, avatar = ?, updated_at = datetime('now')
                    WHERE discord_id = ?
                `, [profile.username, profile.email, profile.avatar, profile.id], (err) => {
                    if (err) {
                        console.error('Update error:', err);
                        return done(err);
                    }
                    return done(null, user);
                });
            } else {
                console.log('Creating new user');
                // Create new user
                db.run(`
                    INSERT INTO users (username, email, discord_id, avatar, created_at)
                    VALUES (?, ?, ?, ?, datetime('now'))
                `, [profile.username, profile.email, profile.id, profile.avatar], function(err) {
                    if (err) {
                        console.error('Insert error:', err);
                        return done(err);
                    }
                    
                    const newUser = {
                        id: this.lastID,
                        username: profile.username,
                        email: profile.email,
                        discord_id: profile.id,
                        avatar: profile.avatar
                    };
                    
                    console.log('New user created:', newUser);
                    return done(null, newUser);
                });
            }
        });
    } catch (err) {
        console.error('Strategy error:', err);
        return done(err);
    }
}));

// Serialize and deserialize user
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser((id, done) => {
    const db = app.locals.db;
    db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
        if (err) {
            console.error('Deserialize error:', err);
            return done(err);
        }
        done(null, user);
    });
});

// Add user to all views
app.use((req, res, next) => {
    if (req.isAuthenticated()) {
        res.locals.user = req.user;
        res.locals.userId = req.user.id;
    } else {
        res.locals.user = null;
        res.locals.userId = null;
    }
    next();
});

// Routes
// Use auth routes first - these should be accessible without login
app.use('/', authRoutes);

// Protected routes - require login
app.get('/', requireLogin, (req, res) => {
    res.redirect('/profile');
});

app.use('/', requireLogin, profileRoutes);
app.use('/', requireLogin, organizationRoutes);
app.use('/', requireLogin, eventRoutes);
app.use('/', requireLogin, matchRoutes);

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Close database connection when the app is shutting down
process.on('SIGINT', () => {
    db.close();
    process.exit();
}); 