import cron from 'node-cron';
import { config } from '../config/env';
import { processDueBookingEmails } from '../services/bookingEmail.service';

export const startBookingEmailJob = (): void => {
  if (!config.resendApiKey) {
    console.warn('Session emails disabled: set RESEND_API_KEY and verify britinstitute.uk in Resend. Booking emails remain queued.');
    return;
  }
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processDueBookingEmails();
    } catch {
      console.error('Session email job failed; pending deliveries will be retried.');
    } finally {
      running = false;
    }
  };
  cron.schedule('* * * * *', run);
  void run();
};
