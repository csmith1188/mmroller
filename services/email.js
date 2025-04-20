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

/**
 * Send an email
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} text - Email body in plain text
 * @param {string} html - Email body in HTML (optional)
 * @returns {Promise} - Promise that resolves when email is sent
 */
async function sendEmail(to, subject, text, html = null) {
    try {
        const mailOptions = {
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to,
            subject,
            text,
            html
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Email sent:', info.messageId);
        return info;
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
}

/**
 * Send a verification email
 * @param {string} email - User's email address
 * @param {string} token - Verification token
 * @returns {Promise} - Promise that resolves when email is sent
 */
async function sendVerificationEmail(email, token) {
    const verificationUrl = `${process.env.BASE_URL}/verify?token=${token}`;
    const subject = 'Verify your email address';
    const text = `Please click the following link to verify your email address: ${verificationUrl}`;
    const html = `
        <h1>Welcome to MM Roller!</h1>
        <p>Please click the following link to verify your email address:</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <p>If you did not request this verification, please ignore this email.</p>
    `;

    return sendEmail(email, subject, text, html);
}

/**
 * Send a password reset email
 * @param {string} email - User's email address
 * @param {string} token - Reset token
 * @returns {Promise} - Promise that resolves when email is sent
 */
async function sendPasswordResetEmail(email, token) {
    const resetUrl = `${process.env.BASE_URL}/reset-password?token=${token}`;
    const subject = 'Reset your password';
    const text = `Please click the following link to reset your password: ${resetUrl}`;
    const html = `
        <h1>Password Reset Request</h1>
        <p>Please click the following link to reset your password:</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>If you did not request a password reset, please ignore this email.</p>
    `;

    return sendEmail(email, subject, text, html);
}

module.exports = {
    sendEmail,
    sendVerificationEmail,
    sendPasswordResetEmail
}; 