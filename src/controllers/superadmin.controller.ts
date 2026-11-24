import { Response } from 'express';
import { User } from '../models/User.model';
import { AuthRequest } from '../middleware/auth.middleware';
import { UserSession } from '../models/UserSession.model';
import {
  getErrorMessage,
  getDuplicateKeyMessage,
  normalizeName,
  normalizeUsername,
  validatePassword,
  validateUsername,
} from '../utils/validation';

export const createTeacher = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const name = normalizeName(req.body.name);
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');
    if (!name || !username || !password) {
      res.status(400).json({ success: false, message: 'Name, username and password are required' });
      return;
    }

    const usernameError = validateUsername(username);
    if (usernameError) {
      res.status(400).json({ success: false, message: usernameError });
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      res.status(400).json({ success: false, message: passwordError });
      return;
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      res.status(409).json({ success: false, message: 'Username already taken' });
      return;
    }

    const teacher = await User.create({
      name,
      username,
      password,
      password2: password,
      role: 'teacher',
      isActive: true,
    });

    res.status(201).json({
      success: true,
      teacher: {
        id: teacher._id,
        name: teacher.name,
        username: teacher.username,
        role: teacher.role,
        isActive: teacher.isActive,
      },
    });
  } catch (err) {
    const duplicateMessage = getDuplicateKeyMessage(err);
    res.status(duplicateMessage ? 409 : 500).json({ success: false, message: duplicateMessage || getErrorMessage(err) });
  }
};

export const getTeachers = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const teachers = await User.find({ role: 'teacher' }).sort({ createdAt: -1 });
    res.json({ success: true, teachers });
  } catch (err) {
    const duplicateMessage = getDuplicateKeyMessage(err);
    res.status(duplicateMessage ? 409 : 500).json({ success: false, message: duplicateMessage || getErrorMessage(err) });
  }
};

export const updateTeacher = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { password, isActive } = req.body;
    const name = req.body.name !== undefined ? normalizeName(req.body.name) : undefined;
    const username = req.body.username !== undefined ? normalizeUsername(req.body.username) : undefined;
    const teacher = await User.findOne({ _id: id, role: 'teacher' }).select('+password +password2');

    if (!teacher) {
      res.status(404).json({ success: false, message: 'Teacher not found' });
      return;
    }

    const updates: Record<string, unknown> = {};

    if (name !== undefined) {
      if (!name) {
        res.status(400).json({ success: false, message: 'Name is required' });
        return;
      }
      updates.name = name;
    }

    if (username && username !== teacher.username) {
      const usernameError = validateUsername(username);
      if (usernameError) {
        res.status(400).json({ success: false, message: usernameError });
        return;
      }
      const existingUser = await User.findOne({ username, _id: { $ne: id } });
      if (existingUser) {
        res.status(409).json({ success: false, message: 'Username already taken' });
        return;
      }
      updates.username = username;
    }

    if (isActive !== undefined) {
      const nextActive = Boolean(isActive);
      updates.isActive = nextActive;

      // Instantly terminate any active LMS sessions when deactivated
      if (!nextActive) {
        const now = new Date();
        await UserSession.updateMany(
          { user: teacher._id, status: 'active' },
          {
            $set: {
              status: 'expired',
              logoutAt: now,
              lastActiveAt: now,
              logoutReason: 'deactivated_by_admin',
            },
          }
        );
      }
    }

    // If password is being updated, set password + password2 and call .save() to trigger hashing
    if (password !== undefined && password !== '') {
      const newPassword = String(password);
      const passwordError = validatePassword(newPassword);
      if (passwordError) {
        res.status(400).json({ success: false, message: passwordError });
        return;
      }

      Object.assign(teacher, updates);
      teacher.password = newPassword;
      teacher.password2 = newPassword;
      await teacher.save();

      res.json({
        success: true,
        message: `Teacher ${teacher.isActive ? 'activated' : 'deactivated'} successfully`,
        teacher: {
          id: teacher._id,
          name: teacher.name,
          username: teacher.username,
          role: teacher.role,
          isActive: teacher.isActive,
        },
      });
      return;
    }

    // For Activate/Deactivate toggles or name/username edits without password change
    const updatedTeacher = await User.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true }
    );

    res.json({
      success: true,
      message: `Teacher ${updatedTeacher!.isActive ? 'activated' : 'deactivated'} successfully`,
      teacher: {
        id: updatedTeacher!._id,
        name: updatedTeacher!.name,
        username: updatedTeacher!.username,
        role: updatedTeacher!.role,
        isActive: updatedTeacher!.isActive,
      },
    });
  } catch (err) {
    const duplicateMessage = getDuplicateKeyMessage(err);
    res.status(duplicateMessage ? 409 : 500).json({ success: false, message: duplicateMessage || getErrorMessage(err) });
  }
};

export const deleteTeacher = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const teacher = await User.findOneAndDelete({ _id: req.params.id, role: 'teacher' });
    if (!teacher) {
      res.status(404).json({ success: false, message: 'Teacher not found' });
      return;
    }

    res.json({ success: true, message: 'Teacher deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: getErrorMessage(err) });
  }
};

export const getSuperAdminStats = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [totalTeachers, activeTeachers, totalStudents, totalAdmins] = await Promise.all([
      User.countDocuments({ role: 'teacher' }),
      User.countDocuments({ role: 'teacher', isActive: true }),
      User.countDocuments({ role: 'student' }),
      User.countDocuments({ role: 'admin', isActive: true }),
    ]);

    res.json({ success: true, stats: { totalTeachers, activeTeachers, totalStudents, totalAdmins } });
  } catch (err) {
    res.status(500).json({ success: false, message: getErrorMessage(err) });
  }
};