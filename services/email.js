const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Create a transporter using environment variables
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Generate a verification token
function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Send verification email
async function sendVerificationEmail(email, token) {
    const verificationUrl = `${process.env.BASE_URL}/verify?token=${token}`;
    
    const mailOptions = {
        from: process.env.SMTP_FROM,
        to: email,
        subject: 'Verify your MMRoller account',
        html: `
            <h1>Welcome to MMRoller!</h1>
            <p>Please click the link below to verify your email address:</p>
            <a href="${verificationUrl}">${verificationUrl}</a>
            <p>If you did not create an account, you can safely ignore this email.</p>
        `
    };
    
    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Error sending verification email:', error);
        return false;
    }
}

module.exports = {
    generateVerificationToken,
    sendVerificationEmail
}; 