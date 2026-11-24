import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import {
  getMyPlacementProfile,
  saveMyPlacementProfile,
  getAllPlacementProfiles,
  updatePlacementOptimization,
  downloadPlacementResume,
} from '../controllers/placementDriveController';
import { protect, authorize } from '../middleware/auth.middleware';

const router = Router();

// Store uploaded file in memory so controller can save it directly into MongoDB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, and DOCX files are allowed'));
    }
  },
});

// Student endpoints
router.get('/mine', protect, getMyPlacementProfile);
router.post('/mine', protect, upload.single('resume'), saveMyPlacementProfile);

// Stream resume directly from MongoDB (used by both Student & Admin)
router.get('/resume/:id', downloadPlacementResume);

// Admin / Teacher endpoints
router.get('/admin/all', protect, authorize(['admin', 'superadmin', 'teacher']), getAllPlacementProfiles);
router.patch('/admin/:id', protect, authorize(['admin', 'superadmin', 'teacher']), updatePlacementOptimization);

export default router;