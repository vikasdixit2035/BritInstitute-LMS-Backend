import mongoose, { Schema, Document } from 'mongoose';

export interface IPlacementDrive extends Document {
  student: mongoose.Types.ObjectId;
  course: mongoose.Types.ObjectId;
  resumeUrl: string;
  resumeFileName: string;
  resumeMimeType: string;
  resumeData?: Buffer;
  linkedinUrl: string;
  githubUrl: string;
  status: 'pending' | 'in_review' | 'optimized';
  adminNotes: string;
  optimizedResumeUrl?: string;
  updatedAt: Date;
}

const PlacementDriveSchema = new Schema<IPlacementDrive>(
  {
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    course: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    resumeUrl: { type: String, default: '' },
    resumeFileName: { type: String, required: true },
    resumeMimeType: { type: String, default: 'application/pdf' },
    resumeData: { type: Buffer, select: false },
    linkedinUrl: { type: String, required: true, trim: true },
    githubUrl: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'in_review', 'optimized'],
      default: 'pending',
    },
    adminNotes: { type: String, default: '' },
    optimizedResumeUrl: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model<IPlacementDrive>('PlacementDrive', PlacementDriveSchema);