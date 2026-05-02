import type { Env } from '../../types';
import { APP_URLS, EMAIL_CONFIG, EMAIL_STYLES, MESSAGES } from '../../constants';

/**
 * Simple template renderer. Tries R2 first, then falls back to built-in templates.
 * Supports {{variable}} interpolation.
 */
export async function renderTemplate(
  env: Env,
  templateKey: string,
  vars: Record<string, unknown>
): Promise<string> {
  // Try R2 first
  if (env.R2_ASSETS) {
    try {
      const obj = await env.R2_ASSETS.get(`templates/${templateKey}.html`);
      if (obj) {
        let html = await obj.text();
        html = interpolate(html, { ...vars, unsubscribe: unsubscribeFooter(String(vars.to ?? '')) });
        return injectUtmParams(html, templateKey, String(vars.campaignSlug ?? 'outreach'));
      }
    } catch {
      // Fall through to built-in
    }
  }

  // Built-in fallback templates
  const template = BUILT_IN_TEMPLATES[templateKey] ?? BUILT_IN_TEMPLATES['generic'];
  let html = interpolate(template, { ...vars, unsubscribe: unsubscribeFooter(String(vars.to ?? '')) });
  return injectUtmParams(html, templateKey, String(vars.campaignSlug ?? 'outreach'));
}

/**
 * Resolve a (possibly dot-separated) path against a context object.
 *
 * Examples:
 *   resolvePath(ctx, 'name')              // ctx.name
 *   resolvePath(ctx, 'capabilityHook.headline') // ctx.capabilityHook?.headline
 *
 * Returns `undefined` when any segment is missing so the caller can fall back
 * to an empty string (keeps template output safe when nested data is absent).
 */
function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  if (path.indexOf('.') === -1) return ctx[path];
  let cur: unknown = ctx;
  for (const segment of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/**
 * Merge-field interpolation.
 * Supports both `{{flatKey}}` and `{{nested.key}}` paths.
 * Unresolved paths render as empty strings (template-safe default).
 */
function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => {
    const val = resolvePath(vars, key);
    return val !== undefined && val !== null ? String(val) : '';
  });
}

/**
 * Inject UTM parameters into all CTA links in rendered HTML.
 * Skips unsubscribe links and mailto: links.
 */
export function injectUtmParams(html: string, templateKey: string, campaignSlug: string): string {
  return html.replace(/href="(https?:\/\/[^\"]+)"/g, (match, url: string) => {
    // Don't add UTMs to unsubscribe, gdpr, or external tracking links
    if (url.includes('unsubscribe') || url.includes('gdpr') || url.includes('utm_')) {
      return match;
    }
    const sep = url.includes('?') ? '&' : '?';
    const utmSource = 'outbound';
    const utmMedium = 'email';
    const utmCampaign = encodeURIComponent(campaignSlug);
    const utmContent = encodeURIComponent(templateKey);
    return `href="${url}${sep}utm_source=${utmSource}&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}&utm_content=${utmContent}"`;
  });
}

/** Unsubscribe footer appended to all email templates */
function unsubscribeFooter(to: string): string {
  return `<p style="${EMAIL_STYLES.SMALL_PRINT}; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px;"><a href="${APP_URLS.UNSUBSCRIBE(to)}" style="color: #888;">${MESSAGES.email.unsubscribeText}</a></p>`;
}

const BUILT_IN_TEMPLATES: Record<string, string> = {
  generic: `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">{{subject}}</h2>
      <p>${MESSAGES.email.greeting}</p>
      <p>${MESSAGES.email.genericBody}</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'onboarding-welcome': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Welcome to Visibility! \uD83D\uDE80</h2>
      <p>Hi there,</p>
      <p>You've just unlocked the <strong>{{plan}}</strong> plan. Here's how to get the most out of Visibility:</p>
      <ol>
        <li><strong>Connect your site</strong> \u2014 Add your domain in the Cockpit dashboard</li>
        <li><strong>Link Google Search Console</strong> \u2014 We'll pull in your real performance data</li>
        <li><strong>Check your Pulse</strong> \u2014 Your SEO health score updates daily</li>
      </ol>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Open Your Dashboard \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'onboarding-day1': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Set up your first site in 2 minutes \u23F1\uFE0F</h2>
      <p>Hi there,</p>
      <p>Most users see their first insights within 24 hours of connecting. If you haven't already:</p>
      <ol>
        <li>Go to your <a href="${APP_URLS.COCKPIT}">Cockpit</a></li>
        <li>Click "Add Site" and enter your domain</li>
        <li>Authorize Google Search Console access</li>
      </ol>
      <p>That's it! We'll start analyzing your SEO health immediately.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'onboarding-day3': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Your first insights are ready \uD83D\uDCCA</h2>
      <p>Hi there,</p>
      <p>By now, Visibility has been analyzing your site for a few days. Check your dashboard for:</p>
      <ul>
        <li>Your <strong>SEO Health Score</strong></li>
        <li><strong>Top opportunities</strong> \u2014 pages with quick-win potential</li>
        <li><strong>Action items</strong> \u2014 prioritized fixes for maximum impact</li>
      </ul>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">See Your Insights \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'onboarding-day7': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Pro tips from power users \uD83D\uDCA1</h2>
      <p>Hi there,</p>
      <p>You've been using Visibility for a week! Here are tips from our top users:</p>
      <ul>
        <li><strong>Set up weekly reports</strong> \u2014 Track your progress automatically</li>
        <li><strong>Use the AI assistant</strong> \u2014 Ask it about any metric for deeper analysis</li>
        <li><strong>Share reports</strong> \u2014 Send SEO snapshots to your team or clients</li>
      </ul>
      <p>Questions? Just reply to this email \u2014 we read every message.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'affiliate-commission': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">${MESSAGES.email.commissionTitle}</h2>
      <p>Great news!</p>
      <p>${MESSAGES.email.commissionBody}</p>
      <table style="${EMAIL_STYLES.TABLE}">
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>${MESSAGES.email.labelPlan}</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{plan}}</td></tr>
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>${MESSAGES.email.labelSaleAmount}</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{saleAmount}}</td></tr>
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>${MESSAGES.email.labelCommission}</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{commissionAmount}}</td></tr>
        <tr><td style="${EMAIL_STYLES.TABLE_CELL_LAST}"><strong>${MESSAGES.email.labelTotalEarnings}</strong></td><td style="${EMAIL_STYLES.TABLE_CELL_LAST}">{{totalEarnings}}</td></tr>
      </table>
      <p><a href="${APP_URLS.AFFILIATE_PORTAL}" style="${EMAIL_STYLES.CTA_SUCCESS}">${MESSAGES.email.ctaAffiliateDashboard}</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF_AFFILIATE}</p>
      {{unsubscribe}}
    </div>
  `,
  'welcome-signup': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Welcome to Visibility \uD83D\uDC4B</h2>
      <p>Hi there,</p>
      <p>Thanks for signing up! Visibility gives you real-time insights into your search engine performance.</p>
      <p>Here's what you can do right now:</p>
      <ol>
        <li><strong>Connect your Google Search Console</strong></li>
        <li><strong>Check your SEO Pulse</strong> \u2014 your site's health score</li>
        <li><strong>Explore AI-powered insights</strong></li>
      </ol>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Get Started \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'welcome-day1': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Your first SEO check \u2705</h2>
      <p>Hi there,</p>
      <p>Have you connected your first site yet? It only takes a minute:</p>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Connect a Site \u2192</a></p>
      <p>Once connected, you'll get daily insights on your search performance.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'welcome-day3': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Tips that top users love \uD83C\uDF1F</h2>
      <p>Hi there,</p>
      <p>Our most successful users do these 3 things:</p>
      <ol>
        <li><strong>Check their Pulse daily</strong> \u2014 Even a 1-minute glance keeps you ahead</li>
        <li><strong>Act on the top recommendation</strong> \u2014 Our AI prioritizes what matters most</li>
        <li><strong>Share reports with their team</strong> \u2014 Alignment drives results</li>
      </ol>
      <p>Ready to try the pro features? <a href="${APP_URLS.PRICING}">See our plans \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'winback-day1': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">We miss you \uD83D\uDC4B</h2>
      <p>Hi there,</p>
      <p>We noticed your Visibility subscription has ended. Here's what's new since you left:</p>
      <ul>
        <li>New AI-powered content recommendations</li>
        <li>Improved keyword tracking accuracy</li>
        <li>Faster dashboard loading</li>
      </ul>
      <p><a href="${APP_URLS.PRICING}" style="${EMAIL_STYLES.CTA_PRIMARY}">Reactivate Your Account \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'winback-day3': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Your SEO data is waiting \uD83D\uDCC8</h2>
      <p>Hi there,</p>
      <p>Your historical SEO data is still in our system. Reactivate to pick up right where you left off \u2014 no setup needed.</p>
      <p><a href="${APP_URLS.PRICING}" style="${EMAIL_STYLES.CTA_PRIMARY}">Come Back \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'winback-day7': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">20% off to come back \uD83C\uDF81</h2>
      <p>Hi there,</p>
      <p>We'd love to have you back. Use code <strong>${EMAIL_CONFIG.PROMO_CODE}</strong> for 20% off any plan.</p>
      <p><a href="${APP_URLS.PRICING_PROMO(EMAIL_CONFIG.PROMO_CODE)}" style="${EMAIL_STYLES.CTA_SUCCESS}">Claim 20% Off \u2192</a></p>
      <p style="${EMAIL_STYLES.SMALL_PRINT}">Offer valid for 7 days.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'winback-day14': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Final reminder \u2014 your data expires soon \u23F3</h2>
      <p>Hi there,</p>
      <p>Your historical SEO data will be archived in 14 days. After that, you'll need to start fresh.</p>
      <p>Reactivate now to keep your data and continue tracking your progress.</p>
      <p><a href="${APP_URLS.PRICING_PROMO(EMAIL_CONFIG.PROMO_CODE)}" style="${EMAIL_STYLES.CTA_DANGER}">Reactivate Now \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,

  // ─── Share PLG Email Templates ──────────────────────────────────────────

  'share-engaged-owner': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Someone is exploring your shared insights \uD83D\uDD0D</h2>
      <p>Hi there,</p>
      <p>A visitor just spent <strong>{{dwellSeconds}} seconds</strong> reviewing the SEO data you shared via your link <code>{{token}}</code>.</p>
      <p>That level of engagement means they're genuinely interested. Here's what you can do:</p>
      <ul>
        <li><strong>Follow up directly</strong> \u2014 They're already warm on the value of your insights</li>
        <li><strong>Share more data</strong> \u2014 Create a new share link with additional scopes</li>
        <li><strong>Invite them</strong> \u2014 If they sign up, you both benefit from shared analytics</li>
      </ul>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Manage Your Shares \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'share-cta-dropout': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Still interested? Pick up where you left off \uD83D\uDCCA</h2>
      <p>Hi there,</p>
      <p>You recently explored an SEO insights report and clicked to learn more, but didn't finish signing up.</p>
      <p>Here's what you'll unlock with a free Visibility account:</p>
      <ul>
        <li><strong>Real-time SEO Pulse</strong> \u2014 Daily health score for your site</li>
        <li><strong>AI-powered recommendations</strong> \u2014 Prioritized fixes for maximum impact</li>
        <li><strong>Google Search Console integration</strong> \u2014 All your data in one dashboard</li>
      </ul>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_PRIMARY}">Create Your Free Account \u2192</a></p>
      <p style="${EMAIL_STYLES.SMALL_PRINT}">You received this because you interacted with a shared Visibility report.</p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,
  'share-conversion-owner': `
    <div style="${EMAIL_STYLES.CONTAINER}">
      <h2 style="${EMAIL_STYLES.HEADING}">Someone you shared with just signed up! \uD83C\uDF89</h2>
      <p>Hi there,</p>
      <p>Great news \u2014 a person who viewed your shared insights (link <code>{{token}}</code>) has created a Visibility account.</p>
      <p>Your share stats:</p>
      <table style="${EMAIL_STYLES.TABLE}">
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>Total Shares</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{totalShares}}</td></tr>
        <tr><td style="${EMAIL_STYLES.TABLE_CELL}"><strong>Total Conversions</strong></td><td style="${EMAIL_STYLES.TABLE_CELL}">{{totalConversions}}</td></tr>
      </table>
      <p>Keep sharing your insights \u2014 every conversion strengthens your network.</p>
      <p><a href="${APP_URLS.COCKPIT}" style="${EMAIL_STYLES.CTA_SUCCESS}">View Your Dashboard \u2192</a></p>
      <p style="${EMAIL_STYLES.FOOTER}">${EMAIL_STYLES.SIGN_OFF}</p>
      {{unsubscribe}}
    </div>
  `,

  // ─── Cold Outreach Templates (outbound prospect sequences) ────────────────
  // These are rendered by the sequence engine for outbound.prospect_discovered
  // events. Context variables come from KV (stored by outbound-events.ts).
  // See: docs/OUTBOUND_SYSTEM_ARCHITECTURE.md §8.4

  'cold-outreach-step1': `
    <div style="font-family: sans-serif;">
      <p>{{greetingPrefix}}{{contactNameGreeting}},</p>
      <p>{{bodyVariant}}</p>
      <p>The short version:</p>
      <p>• Score: {{auditScore}}/100 (Grade {{auditGrade}})<br>
      • {{passCount}} things working well<br>
      • {{issueCount}} things that could be improved<br>
      • Audited pages: {{auditedPagesSummary}}</p>
      <p>{{auditedPagesHeadline}}</p>
      {{capabilityHookBlock}}
      <p>Full breakdown is here if you want to take a look: {{auditPageUrl}}</p>
      <p>No obligation — I just thought it might be useful.</p>
      <p style="font-size:12px;color:#999">I found {{domain}} on a public directory. I won't send more than 3 emails about this.</p>
      <p>{{personalSignOff}}</p>
      {{unsubscribe}}
    </div>
  `,

  'cold-outreach-step2': `
    <div style="font-family: sans-serif;">
      <p>{{greetingPrefix}}{{contactNameGreeting}},</p>
      <p>{{bodyVariant}}</p>
      <p>The issue: {{quickWinTitle}}<br>
      What to do: {{quickWinAction}}<br>
      Why it matters: {{quickWinImpact}}</p>
      <p>{{auditedPagesHeadline}}</p>
      <p>Sites in {{primaryTopic}} that fix this tend to see a noticeable bump in search impressions within a few weeks.</p>
      {{capabilityHookBlock}}
      <p>Here's the full breakdown if you want it: {{auditPageUrl}}</p>
      <p style="font-size:12px;color:#999">Not interested? {{unsubscribeLink}}</p>
      <p>{{personalSignOff}}</p>
      {{unsubscribe}}
    </div>
  `,

  'cold-outreach-step3': `
    <div style="font-family: sans-serif;">
      <p>{{greetingPrefix}}{{contactNameGreeting}},</p>
      <p>{{bodyVariant}}</p>
      <p>Quick recap for {{domain}}:</p>
      <p>• Visibility score: {{auditScore}}/100 (Grade {{auditGrade}})<br>
      • {{issueCount}} improvement opportunities<br>
      • Tech detected: {{techStackDisplay}}<br>
      • Audited pages: {{auditedPagesSummary}}</p>
      <p>{{auditedPagesHeadline}}</p>
      <p>Your competitors in {{primaryTopic}} may already be working on theirs.</p>
      {{capabilityHookBlock}}
      <p>Full details: {{auditPageUrl}}</p>
      <p>Either way, I hope this was useful. No more emails from me on this.</p>
      <p>{{personalSignOff}}</p>
      {{unsubscribe}}
    </div>
  `,

  // ─── Warm Audit-Followup Templates (lead.captured sequences) ──────────
  // Sent to contacts who ran a free audit AND confirmed their email.
  // Context variables come from audit-funnel.ts KV storage.
  // These bypass all cold outreach throttling (warmup, business hours, domain gap).

  'audit-followup-step1': `
    <div style="font-family: sans-serif;">
      <p>Hi{{contactNameGreeting}},</p>
      <p>{{bodyVariant}}</p>
      <p>Here's the breakdown:</p>
      <p>• Score: {{auditScore}}/100 (Grade {{auditGrade}})<br>
      • {{passCount}} things working well<br>
      • {{issueCount}} areas to improve</p>
      <p><a href="{{auditPageUrl}}">See your full audit report →</a></p>
      <p>If any of this is useful and you'd like to dig deeper, just reply — happy to walk through it.</p>
      <p>{{personalSignOff}}</p>
      {{unsubscribe}}
    </div>
  `,

  'audit-followup-step2': `
    <div style="font-family: sans-serif;">
      <p>Hi{{contactNameGreeting}},</p>
      <p>{{bodyVariant}}</p>
      <p>The issue: {{quickWinTitle}}<br>
      What to do: {{quickWinAction}}<br>
      Expected impact: {{quickWinImpact}}</p>
      <p>This is the kind of thing that takes 15–30 minutes to fix but moves the needle more than most SEO advice out there.</p>
      <p><a href="{{auditPageUrl}}">Review your full results →</a></p>
      <p>{{personalSignOff}}</p>
      {{unsubscribe}}
    </div>
  `,

  'audit-followup-step3': `
    <div style="font-family: sans-serif;">
      <p>Hi{{contactNameGreeting}},</p>
      <p>{{bodyVariant}}</p>
      <p>Quick recap:</p>
      <p>• {{domain}} scored {{auditScore}}/100 (Grade {{auditGrade}})<br>
      • {{issueCount}} improvement opportunities<br>
      • Top priority: {{quickWinTitle}}</p>
      <p><a href="{{auditPageUrl}}">Your audit results are still here →</a></p>
      <p>No more follow-ups from me on this. If you ever want a second look, the audit is free anytime.</p>
      <p>{{personalSignOff}}</p>
      {{unsubscribe}}
    </div>
  `,
};
