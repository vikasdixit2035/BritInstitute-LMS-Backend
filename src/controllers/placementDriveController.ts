import { Response } from 'express';
import PlacementDrive from '../models/PlacementDrive';
import { User } from '../models/User.model';
import { AuthRequest } from '../middleware/auth.middleware';

// GET /api/placement-drive/mine
export const getMyPlacementProfile = async (req: AuthRequest, res: Response) => {
  try {
    const profile = await PlacementDrive.findOne({ student: req.user?.id });
    res.json({ profile });
  } catch (error) {
    console.error('Error fetching student placement profile:', error);
    res.status(500).json({ message: 'Failed to load placement profile' });
  }
};

// POST /api/placement-drive/mine
export const saveMyPlacementProfile = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    const { linkedinUrl, githubUrl } = req.body;
    const existing = await PlacementDrive.findOne({ student: userId });

    if (!linkedinUrl || !githubUrl) {
      return res.status(400).json({ message: 'LinkedIn and GitHub links are required.' });
    }

    if (!req.file && !existing?.resumeFileName) {
      return res.status(400).json({ message: 'Please upload your resume (PDF, DOC, or DOCX).' });
    }

    const studentUser = await User.findById(userId);
    if (!studentUser || !studentUser.enrolledCourse) {
      return res.status(400).json({ message: 'Student course enrollment not found.' });
    }

    const updateFields: Record<string, any> = {
      student: userId,
      course: studentUser.enrolledCourse,
      linkedinUrl: linkedinUrl.trim(),
      githubUrl: githubUrl.trim(),
      status: 'pending',
    };

    if (req.file) {
      updateFields.resumeFileName = req.file.originalname;
      updateFields.resumeMimeType = req.file.mimetype;
      updateFields.resumeData = req.file.buffer;
    }

    const profile = await PlacementDrive.findOneAndUpdate(
      { student: userId },
      updateFields,
      { upsert: true, new: true }
    );

    console.log('Saved in MongoDB -> Collection: placementdrives | ID:', profile._id, '| Student:', userId);

    // Ensure resumeUrl always points to the MongoDB streaming endpoint for this document
    const dbResumeUrl = `/api/placement-drive/resume/${profile._id}`;
    if (profile.resumeUrl !== dbResumeUrl) {
      profile.resumeUrl = dbResumeUrl;
      await profile.save();
    }

    res.json({
      profile,
      message: 'Resume, LinkedIn, and GitHub saved directly to the database!',
    });
  } catch (error: any) {
    console.error('Error saving placement profile:', error);
    res.status(500).json({ message: error.message || 'Failed to save placement profile' });
  }
};

// GET /api/placement-drive/resume/:id
export const downloadPlacementResume = async (req: AuthRequest, res: Response) => {
  try {
    const profile = await PlacementDrive.findById(req.params.id).select('+resumeData');
    if (!profile || !profile.resumeData) {
      return res.status(404).json({ message: 'Resume file not found in database' });
    }

    res.setHeader('Content-Type', profile.resumeMimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${profile.resumeFileName}"`);
    res.send(profile.resumeData);
  } catch (error) {
    console.error('Error streaming resume from DB:', error);
    res.status(500).json({ message: 'Failed to load resume' });
  }
};

// GET /api/placement-drive/admin/all
export const getAllPlacementProfiles = async (_req: AuthRequest, res: Response) => {
  try {
    const profiles = await PlacementDrive.find()
      .populate('student', 'name username email')
      .populate('course', 'title')
      .sort({ updatedAt: -1 });

    res.json({ profiles });
  } catch (error) {
    console.error('Error fetching all placement profiles:', error);
    res.status(500).json({ message: 'Failed to fetch placement profiles' });
  }
};

// PATCH /api/placement-drive/admin/:id
export const updatePlacementOptimization = async (req: AuthRequest, res: Response) => {
  try {
    const { status, adminNotes, optimizedResumeUrl } = req.body;

    const profile = await PlacementDrive.findByIdAndUpdate(
      req.params.id,
      { status, adminNotes, optimizedResumeUrl },
      { new: true }
    ).populate('student', 'name username email');

    if (!profile) {
      return res.status(404).json({ message: 'Placement profile not found' });
    }

    res.json({ profile, message: 'Optimization details updated.' });
  } catch (error) {
    console.error('Error updating placement optimization:', error);
    res.status(500).json({ message: 'Failed to update optimization status' });
  }
};