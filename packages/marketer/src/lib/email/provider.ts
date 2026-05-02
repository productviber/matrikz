import type { Env } from '../../types';
import { APP_URLS, CONTENT_TYPE_JSON, EMAIL_CONFIG } from '../../constants';

interface SendWithProviderOptions {
  skipBulkHeaders?: boolean;
  /**
   * Stable identifier from our side (email_sends.id) threaded into provider
   * tags so webhook handlers can correlate opens/clicks back to the exact row.
   * Also emitted as a custom header for providers that expose headers but not tags.
   */
  sendId?: number | string;
  /** Template key used — also threaded as a Brevo tag for segment-level analysis. */
  templateKey?: string;
}

export interface ProviderSendResult {
  /** Provider-returned message id (Brevo `messageId`, SendGrid `X-Message-Id`). May be null if the API didn't return one. */
  messageId: string | null;
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
): Promise<ProviderSendResult> {
  const provider = env.EMAIL_PROVIDER ?? EMAIL_CONFIG.DEFAULT_PROVIDER;

  if (provider === 'brevo') {
    return sendViaBrevo(env, to, subject, html, options);
  }

  if (provider === 'sendgrid') {
    return sendViaSendGrid(env, to, subject, html);
  }

  return { messageId: null };
}

async function sendViaBrevo(
  env: Env,
  to: string,
  subject: string,
  html: string,
  options?: SendWithProviderOptions,
): Promise<ProviderSendResult> {
  const unsubUrl = APP_URLS.UNSUBSCRIBE(to);

  const payload: Record<string, unknown> = {
    sender: { name: env.FROM_NAME, email: env.FROM_EMAIL },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };

  // Correlator tags (Brevo echoes the first tag back in `payload.tag` on every webhook event).
  // We always include the send id first so the webhook can match by integer lookup.
  const tags: string[] = [];
  if (options?.sendId != null) tags.push(`send:${options.sendId}`);
  if (options?.templateKey) tags.push(`tpl:${options.templateKey}`);
  if (tags.length > 0) payload.tags = tags;

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

  // Brevo returns `{ "messageId": "<abc@smtp-relay.sendinblue.com>" }` on success.
  let messageId: string | null = null;
  try {
    const body = (await res.json()) as { messageId?: string };
    if (body && typeof body.messageId === 'string') {
      messageId = body.messageId;
    }
  } catch {
    /* Non-fatal — some Brevo endpoints return empty bodies */
  }
  return { messageId };
}

async function sendViaSendGrid(
  env: Env,
  to: string,
  subject: string,
  html: string,
): Promise<ProviderSendResult> {
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

  const messageId = res.headers.get('X-Message-Id');
  return { messageId: messageId ?? null };
}
