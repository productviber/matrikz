/**
 * Constants Module — Integrity Tests
 *
 * Ensures all exported constants have expected types, values,
 * and that no accidental mutations are possible (as const).
 */

import { describe, it, expect } from 'vitest';
import {
  WORKER_NAME,
  WORKER_VERSION,
  TRUSTED_SOURCE,
  EVENT_TYPES,
  CONTACT_STATUS,
  CONTACT_SOURCE,
  EMAIL_STATUS,
  PAYOUT_STATUS,
  NOTE_TYPE,
  APPLICATION_STATUS,
  SECONDS_PER_DAY,
  TTL,
  PAGINATION,
  MAX_LENGTH,
  KV_PREFIX,
  UTM_DEFAULTS,
  BASE_URL,
  APP_URLS,
  EMAIL_CONFIG,
  COOKIE,
  DEFAULTS,
  NOTIFICATION_CHANNEL,
  INTERNAL_BASE_URL,
  CONTENT_TYPE_JSON,
  EMAIL_STYLES,
} from '../../src/constants';

describe('constants', () => {
  describe('worker identity', () => {
    it('exports WORKER_NAME and WORKER_VERSION as strings', () => {
      expect(typeof WORKER_NAME).toBe('string');
      expect(typeof WORKER_VERSION).toBe('string');
      expect(WORKER_NAME).toBe('visibility-marketing');
    });
  });

  describe('TRUSTED_SOURCE', () => {
    it('is visibility-analytics', () => {
      expect(TRUSTED_SOURCE).toBe('visibility-analytics');
    });
  });

  describe('EVENT_TYPES', () => {
    it('has all expected event types', () => {
      expect(EVENT_TYPES.AFFILIATE_CONVERSION).toBe('affiliate.conversion');
      expect(EVENT_TYPES.USER_CONVERTED).toBe('user.converted');
      expect(EVENT_TYPES.USER_SIGNUP).toBe('user.signup');
      expect(EVENT_TYPES.USER_CHURNED).toBe('user.churned');
      expect(EVENT_TYPES.USER_MILESTONE).toBe('user.milestone');
      expect(EVENT_TYPES.AFFILIATE_CLICK).toBe('affiliate.click');
      expect(EVENT_TYPES.INSIGHT_GENERATED).toBe('insight.generated');
      expect(EVENT_TYPES.TRIAL_EXPIRING).toBe('trial.expiring');
      // Share PLG events
      expect(EVENT_TYPES.SHARE_CREATED).toBe('share.created');
      expect(EVENT_TYPES.SHARE_VIEWED).toBe('share.viewed');
      expect(EVENT_TYPES.SHARE_ENGAGED).toBe('share.engaged');
      expect(EVENT_TYPES.SHARE_CTA_CLICKED).toBe('share.cta_clicked');
      expect(EVENT_TYPES.SHARE_CONVERTED).toBe('share.converted');
      expect(EVENT_TYPES.SHARE_REVOKED).toBe('share.revoked');
      expect(EVENT_TYPES.OUTBOUND_PROSPECT_DISCOVERED).toBe('outbound.prospect_discovered');
      expect(EVENT_TYPES.OUTBOUND_PROSPECT_ENRICHED).toBe('outbound.prospect_enriched');
      // Audit funnel events
      expect(EVENT_TYPES.AUDIT_COMPLETED).toBe('audit.completed');
      expect(EVENT_TYPES.LEAD_CAPTURED).toBe('lead.captured');
    });

    it('has 46 event types', () => {
      expect(Object.keys(EVENT_TYPES)).toHaveLength(46);
    });
  });

  describe('CONTACT_STATUS', () => {
    it('has prospect, lead, trial, customer, churned', () => {
      expect(CONTACT_STATUS.PROSPECT).toBe('prospect');
      expect(CONTACT_STATUS.LEAD).toBe('lead');
      expect(CONTACT_STATUS.TRIAL).toBe('trial');
      expect(CONTACT_STATUS.CUSTOMER).toBe('customer');
      expect(CONTACT_STATUS.CHURNED).toBe('churned');
    });
  });

  describe('PAYOUT_STATUS', () => {
    it('has pending, processing, sent, completed, failed', () => {
      expect(PAYOUT_STATUS.PENDING).toBe('pending');
      expect(PAYOUT_STATUS.PROCESSING).toBe('processing');
      expect(PAYOUT_STATUS.SENT).toBe('sent');
      expect(PAYOUT_STATUS.COMPLETED).toBe('completed');
      expect(PAYOUT_STATUS.FAILED).toBe('failed');
    });
  });

  describe('TTL', () => {
    it('correctly calculates day-based TTLs', () => {
      expect(TTL.DAYS_30).toBe(30 * SECONDS_PER_DAY);
      expect(TTL.DAYS_90).toBe(90 * SECONDS_PER_DAY);
      expect(TTL.YEAR_1).toBe(365 * SECONDS_PER_DAY);
    });
  });

  describe('PAGINATION', () => {
    it('has consistent limits', () => {
      expect(PAGINATION.DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(PAGINATION.MAX_PAGE_SIZE);
      expect(PAGINATION.MAX_CAMPAIGN_PAGE_SIZE).toBeLessThanOrEqual(PAGINATION.MAX_PAGE_SIZE);
      expect(PAGINATION.CRON_BATCH_SIZE).toBeGreaterThan(0);
      expect(PAGINATION.PORTAL_RECENT_ITEMS).toBeGreaterThan(0);
    });
  });

  describe('KV_PREFIX', () => {
    it('all prefixes end with colon (except special keys)', () => {
      const specialKeys = ['AFFILIATE_APPLICATIONS_PENDING', 'HEALTH_CHECK', 'GOVERNANCE_MODE_OVERRIDE', 'GOVERNANCE_EXECUTION_MODE_OVERRIDE'];
      for (const [key, value] of Object.entries(KV_PREFIX)) {
        if (!specialKeys.includes(key)) {
          expect(value).toMatch(/:$/);
        }
      }
    });

    it('has all expected prefixes', () => {
      expect(KV_PREFIX.DAILY_CONVERSIONS).toBeDefined();
      expect(KV_PREFIX.DAILY_REVENUE).toBeDefined();
      expect(KV_PREFIX.AFFILIATE_STATS).toBeDefined();
      expect(KV_PREFIX.AFFILIATE_EMAIL).toBeDefined();
      expect(KV_PREFIX.HEALTH_CHECK).toBeDefined();
    });
  });

  describe('APP_URLS', () => {
    it('PRICING_PROMO generates valid URL with promo code', () => {
      const url = APP_URLS.PRICING_PROMO('TESTCODE');
      expect(url).toContain('TESTCODE');
      expect(url).toContain('visibility.clodo.dev');
    });
  });

  describe('EMAIL_CONFIG', () => {
    it('has provider and API URLs', () => {
      expect(EMAIL_CONFIG.DEFAULT_PROVIDER).toBe('brevo');
      expect(EMAIL_CONFIG.BREVO_API_URL).toContain('brevo.com');
      expect(EMAIL_CONFIG.SENDGRID_API_URL).toContain('sendgrid.com');
    });
  });

  describe('CONTENT_TYPE_JSON', () => {
    it('is application/json', () => {
      expect(CONTENT_TYPE_JSON).toBe('application/json');
    });
  });

  describe('EMAIL_STYLES', () => {
    it('has all style constants for email templates', () => {
      expect(EMAIL_STYLES.CONTAINER).toContain('max-width');
      expect(EMAIL_STYLES.CTA_PRIMARY).toContain('background');
      expect(typeof EMAIL_STYLES.FONT_FAMILY).toBe('string');
    });
  });

  describe('NOTE_TYPE', () => {
    it('has conversion, tier_upgrade, payout, general', () => {
      expect(NOTE_TYPE.CONVERSION).toBe('conversion');
      expect(NOTE_TYPE.TIER_UPGRADE).toBe('tier_upgrade');
      expect(NOTE_TYPE.PAYOUT).toBe('payout');
      expect(NOTE_TYPE.GENERAL).toBe('general');
    });
  });

  describe('APPLICATION_STATUS', () => {
    it('has pending and approved', () => {
      expect(APPLICATION_STATUS.PENDING).toBe('pending');
      expect(APPLICATION_STATUS.APPROVED).toBe('approved');
    });
  });

  describe('DEFAULTS', () => {
    it('has all default values', () => {
      expect(DEFAULTS.PLAN_YEARLY).toBe('yearly');
      expect(DEFAULTS.MONTHS_PER_YEAR).toBe(12);
      expect(DEFAULTS.PAYOUT_METHOD).toBe('manual');
      expect(DEFAULTS.NOTIFICATION_EVENT_TYPE).toBe('general');
      expect(typeof DEFAULTS.MRR_HISTORY_START).toBe('string');
    });
  });
});
