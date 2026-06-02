'use strict';

const nodemailer = require('nodemailer');
const { config } = require('./config');

/**
 * Email transport. In production, SMTP_* env vars configure a real transport.
 * In development without SMTP creds, OTP codes are logged to the console (and, if
 * available, an Ethereal test inbox) so the flow is fully testable offline.
 */
let transporter = null;
let usingConsole = false;

async function getTransport() {
  if (transporter) return transporter;

  // Never send real email during automated tests, regardless of configured creds.
  if (config.env !== 'test' && config.smtp.host && config.smtp.user && config.smtp.pass) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
    return transporter;
  }

  // Dev fallback: log to console (no creds configured).
  usingConsole = true;
  transporter = {
    sendMail: async (msg) => {
      console.log('\n──────── DEV EMAIL (no SMTP configured) ────────');
      console.log('to:', msg.to);
      console.log('subject:', msg.subject);
      console.log('text:', msg.text);
      console.log('────────────────────────────────────────────────\n');
      return { messageId: 'dev-console' };
    },
  };
  return transporter;
}

async function sendOtpEmail(to, code, purpose) {
  const t = await getTransport();
  const subject =
    purpose === 'register' ? 'Verify your web3keys account' : 'Your web3keys login code';
  const text =
    `Your web3keys verification code is: ${code}\n\n` +
    `It expires in ${Math.round(config.otpTtlMs / 60000)} minutes. ` +
    `If you did not request this, ignore this email.`;
  await t.sendMail({ from: config.smtp.from, to, subject, text });
  return { delivered: !usingConsole };
}

module.exports = { sendOtpEmail, getTransport };
