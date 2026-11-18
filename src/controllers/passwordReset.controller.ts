import { createHmac, randomInt, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { User } from '../models/User.model';
import { config } from '../config/env';
import { sendSessionEmail, SESSION_EMAIL_ADDRESS } from '../services/resend.service';
import { normalizeUsername, validateEmail, validatePassword } from '../utils/validation';

const minute = 60_000;
const invalidCode = { success: false, message: 'Invalid or expired code. Request a new code and try again.' };
const accepted = { success: true, message: 'If this account has a registered email, a code will arrive shortly.' };
const codeDigest = (passwordHash: string, email: string, otp: string) =>
  createHmac('sha256', config.jwtSecret).update(JSON.stringify(['password-reset', passwordHash, email, otp])).digest('hex');

export async function requestPasswordReset(req: Request, res: Response) {
  try {
    const username = normalizeUsername(req.body.username);
    if (!username) return res.status(400).json({ success: false, message: 'Enter your username.' });
    const user = await User.findOne({ username, isActive: true }).select('email +password');
    if (user?.email && !validateEmail(user.email)) {
      const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const digest = codeDigest(user.password, user.email, otp);
      const now = Date.now();
      const issued = await User.updateOne({
        _id: user._id, email: user.email, password: user.password, isActive: true,
        $or: [{ passwordReset: { $exists: false } }, { 'passwordReset.sentAt': { $lte: new Date(now - minute) } }],
      }, { $set: { passwordReset: { digest, sentAt: new Date(now), expiresAt: new Date(now + 10 * minute), attempts: 0 } } });
      if (issued.modifiedCount) {
        const text = `Your Brit Institute LMS password reset code is ${otp}. It expires in 10 minutes. If you didn't request this code, you can ignore this email.`;
        try {
          await sendSessionEmail({
            from: SESSION_EMAIL_ADDRESS, to: [user.email], reply_to: SESSION_EMAIL_ADDRESS,
            subject: 'Your LMS password reset code', text, html: `<p>${text}</p>`,
          }, randomUUID());
        } catch {
          console.error('LMS password reset email delivery failed');
          await User.updateOne({ _id: user._id, 'passwordReset.digest': digest }, { $unset: { passwordReset: 1 } });
        }
      }
    }
    return res.json(accepted);
  } catch {
    return res.status(500).json({ success: false, message: 'Unable to request a code. Please try again.' });
  }
}

export async function resetPassword(req: Request, res: Response) {
  try {
    const username = normalizeUsername(req.body.username);
    const { otp, newPassword } = req.body;
    if (!username || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) return res.status(400).json(invalidCode);
    const error = validatePassword(typeof newPassword === 'string' ? newPassword : '');
    if (error) return res.status(400).json({ success: false, message: error });

    const user = await User.findOne({
      username, isActive: true, 'passwordReset.expiresAt': { $gt: new Date() }, 'passwordReset.attempts': { $lt: 5 },
    }).select('email +password +passwordReset');
    if (!user?.email || !user.passwordReset) return res.status(400).json(invalidCode);
    const challenge = {
      _id: user._id, password: user.password, email: user.email, isActive: true,
      'passwordReset.digest': user.passwordReset.digest, 'passwordReset.attempts': { $lt: 5 },
    };
    if (user.passwordReset.digest !== codeDigest(user.password, user.email, otp)) {
      await User.updateOne(challenge, { $inc: { 'passwordReset.attempts': 1 } });
      return res.status(400).json(invalidCode);
    }
    // Query updates bypass the User save hook. Hash before consuming the code atomically.
    const password = await bcrypt.hash(newPassword, 10);
    const result = await User.updateOne({ ...challenge, 'passwordReset.expiresAt': { $gt: new Date() } },
      { $set: { password }, $unset: { passwordReset: 1 } });
    if (!result.modifiedCount) return res.status(400).json(invalidCode);
    return res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
  } catch {
    return res.status(500).json({ success: false, message: 'Unable to reset your password. Please try again.' });
  }
}
