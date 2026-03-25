import type { Env } from '../../types';
import { APP_URLS, CONTENT_TYPE_JSON, EMAIL_CONFIG } from '../../constants';

interface SendWithProviderOptions {
  skipBulkHeaders?: boolean;
}

/**
 * Provider adapter for transactional email transport.
 * Keeps HTTP details out of orchestration/service layers.
 */
export async function sendWithProvider(
  env: Env,
  to: string,
  subject: string,
  html: string,
  options?: SendWithProviderOptions,
): Promise<void> {
  const provider = env.EMAIL_PROVIDER ?? EMAIL_CONFIG.DEFAULT_PROVIDER;

  if (provider === 'brevo') {
    await sendViaBrevo(env, to, subject, html, options);
    return;
  }

  if (provider === 'sendgrid') {
    await sendViaSendGrid(env, to, subject, html);
  }
}

async function sendViaBrevo(
  env: Env,
  to: string,
  subject: string,
  html: string,
  options?: SendWithProviderOptions,
): Promise<void> {
  const unsubUrl = APP_URLS.UNSUBSCRIBE(to);

  const payload: Record<string, unknown> = {
    sender: { name: env.FROM_NAME, email: env.FROM_EMAIL },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };

  if (!options?.skipBulkHeaders) {
    payload.headers = {
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }

  const res = await fetch(EMAIL_CONFIG.BREVO_API_URL, {
    method: 'POST',
    headers: {
      [EMAIL_CONFIG.BREVO_AUTH_HEADER]: env.EMAIL_API_KEY!,
      'Content-Type': CONTENT_TYPE_JSON,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${errBody}`);
  }
}

async function sendViaSendGrid(
  env: Env,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const unsubUrl = APP_URLS.UNSUBSCRIBE(to);
  const res = await fetch(EMAIL_CONFIG.SENDGRID_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY!}`,
      'Content-Type': CONTENT_TYPE_JSON,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.FROM_EMAIL, name: env.FROM_NAME },
      subject,
      content: [{ type: EMAIL_CONFIG.SENDGRID_CONTENT_TYPE, value: html }],
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`SendGrid API error ${res.status}: ${errBody}`);
  }
}
