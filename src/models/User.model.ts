import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  name: string;
  username: string;
  password2: string;
  password: string;
  passwordReset?: { digest: string; expiresAt: Date; sentAt: Date; attempts: number };
  role: 'superadmin' | 'admin' | 'teacher' | 'student';
  phone?: string;
  email?: string;
  enrolledCourse?: mongoose.Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
  resetPasswordToken?: string;
resetPasswordExpires?: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    // new update
    password2: { type: String, required: true, select: false },
    passwordReset: {
      type: new Schema({
        digest: String, expiresAt: Date, sentAt: Date, attempts: Number,
      }, { _id: false }),
      select: false,
    },
    role: { type: String, enum: ['superadmin', 'admin', 'teacher', 'student'], default: 'student' },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true },
    enrolledCourse: { type: Schema.Types.ObjectId, ref: 'Course' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
// Hash password before saving
// userSchema.pre('save', async function (next) {
//   if (!this.isModified('password')) return next();
//   const salt = await bcrypt.genSalt(10);
//   this.password = await bcrypt.hash(this.password, salt);
//   next();
// });
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model<IUser>('User', userSchema);
