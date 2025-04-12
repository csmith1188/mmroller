# MM Roller - Tournament Management System

A Node.js web application for managing tournaments and matches, built with Express.js, EJS, and SQLite3.

## Features

- User authentication (login/register)
- Organization management
  - Create organizations
  - View organization members
  - Organization admin privileges
- Event management
  - Create events within organizations
  - View event details
- Match management
  - Create matches between event participants
  - Submit scores for matches
  - View match history and scores

## Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd mmroller
```

2. Install dependencies:
```bash
npm install
```

3. Initialize the database:
```bash
node database/init.js
```

4. Start the server:
```bash
node app.js
```

The application will be available at `http://localhost:3000`

## Database Schema

The application uses SQLite3 with the following tables:

- `users`: Stores user information
- `organizations`: Stores organization details
- `organization_members`: Tracks organization membership
- `events`: Stores event information
- `event_participants`: Tracks event participation
- `matches`: Stores match information
- `match_scores`: Tracks match scores and submissions

## Security Features

- Password hashing using bcrypt
- Session-based authentication
- Authorization checks for sensitive operations
- SQL injection prevention through parameterized queries

## Project Structure

```
mmroller/
├── app.js                 # Main application file
├── database/
│   ├── init.js           # Database initialization script
│   ├── init.sql          # Database schema
│   └── database.sqlite   # SQLite database file
├── public/               # Static files
├── views/               # EJS templates
│   ├── layout.ejs       # Main layout template
│   ├── login.ejs        # Login page
│   ├── register.ejs     # Registration page
│   ├── profile.ejs      # User profile page
│   ├── organization.ejs # Organization details page
│   ├── new-event.ejs    # Event creation page
│   ├── new-match.ejs    # Match creation page
│   └── match.ejs        # Match details page
└── package.json         # Project dependencies
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details. 