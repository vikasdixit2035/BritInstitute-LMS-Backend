import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 5001,
  nodeEnv: process.env.NODE_ENV || 'development',
  // mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/britInstiuteLMS',
    // mongoUri: process.env.MONGO_URI || "mongodb+srv://hollum79_db_user:KCjVlQihGYjzDh9J@cluster0.ksrcn2b.mongodb.net/test?appName=Cluster0/brit_placement",
   mongoUri: process.env.MONGO_URI || "mongodb+srv://sandeep_db_user:Edtech%404545@cluster0.el7dlkr.mongodb.net/test?retryWrites=true&w=majority",

   
  jwtSecret: process.env.JWT_SECRET || 'brit_secret_key',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  inactivityTimeoutMinutes: Number(process.env.INACTIVITY_TIMEOUT_MINUTES || 30),
  resendApiKey: process.env.RESEND_API_KEY || '',
  zoom: {
    accountId: process.env.ZOOM_ACCOUNT_ID || '',
    clientId: process.env.ZOOM_CLIENT_ID || '',
    clientSecret: process.env.ZOOM_CLIENT_SECRET || '',
    webhookSecretToken: process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '',
  },
};
