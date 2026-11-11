import { config } from '../config/env';

export const SESSION_EMAIL_ADDRESS = 'info@britinstitute.uk';

export interface SessionEmailPayload {
  from: string;
  to: string[];
  reply_to: string;
  subject: string;
  text: string;
  html: string;
}

export class ResendEmailError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly retryAfterSeconds = 60) {
    super(`Resend email request failed (${status}, ${code})`);
  }
}

export const sendSessionEmail = async (payload: SessionEmailPayload, idempotencyKey: string): Promise<string> => {
  if (!config.resendApiKey) throw new Error('RESEND_API_KEY is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as { id?: string; name?: string };
  if (!response.ok) {
    throw new ResendEmailError(response.status, body.name || 'unknown_error', Number(response.headers.get('retry-after')) || 60);
  }
  if (!body.id) throw new Error('Resend returned no email ID');
  return body.id;
};
