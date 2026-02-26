/**
 * Trust Signals Component Library
 * 
 * Renders data freshness, delay indicators, and first-visit orientation.
 * Imported from visibility-analytics cockpit patterns for analytics dashboards.
 * 
 * Patterns:
 * - FreshnessIndicator: Shows "Updated X ago [↻]" with staleness warning
 * - DataDelayNote: Contextual messaging for delayed data with date ranges
 * - FirstVisitBanner: Respectful, single-sentence orientation for new users
 */

import React, { useState, useCallback } from 'react';
import styles from './TrustSignals.module.css';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface FreshnessIndicatorProps {
  /** ISO timestamp of last data extraction */
  timestamp?: string | null;
  /** Number of days between last data point and now */
  dataLagDays?: number | null;
  /** Number of connected data sources */
  sourceCount?: number;
  /** Callback when refresh is triggered */
  onRefresh?: () => void | Promise<void>;
}

export interface DataDelayNoteProps {
  /** Time context with { startDate, endDate, days } */
  timeContext?: { startDate?: string; endDate?: string; days?: number } | null;
  /** Last GSC data point date (YYYY-MM-DD format) */
  gscEndDate?: string | null;
}

export interface FirstVisitBannerProps {
  /** Whether banner should be visible */
  visible?: boolean;
  /** Callback when user dismisses the banner */
  onDismiss?: () => void;
}

// ═══════════════════════════════════════════════════════════════
// FRESHNESS INDICATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Renders data freshness indicator with optional refresh capability.
 * 
 * States:
 * - "Updated 2 hours ago [↻]" – normal
 * - "Updated 3 days ago [↻] ⚠" – stale (>48h)
 * - "Updating... ⟳" – refresh in progress
 * - "Updated just now ✓" – post-refresh
 */
export const FreshnessIndicator: React.FC<FreshnessIndicatorProps> = ({
  timestamp,
  dataLagDays,
  sourceCount,
  onRefresh
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const relativeTime = _getRelativeTime(timestamp);
  const isStale = _isStale(timestamp);

  const handleRefresh = useCallback(async () => {
    if (!onRefresh || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh, isRefreshing]);

  return (
    <span className={`${styles.freshnessIndicator} ${isStale ? styles.stale : ''}`}>
      <span className={styles.freshnessText}>
        {isRefreshing ? 'Updating... ⟳' : `Updated ${relativeTime}`}
      </span>
      {onRefresh && (
        <button
          className={styles.freshnessRefreshBtn}
          onClick={handleRefresh}
          disabled={isRefreshing}
          title="Refresh data from all sources"
          aria-label="Refresh data"
        >
          <RefreshIcon />
        </button>
      )}
      {isStale && <span className={styles.freshnessWarn} title="Data may be outdated">⚠</span>}
    </span>
  );
};

// ═══════════════════════════════════════════════════════════════
// DATA DELAY NOTE
// ═══════════════════════════════════════════════════════════════

/**
 * Renders a GSC data delay disclosure note when current period
 * includes dates within the last 3 days (typical GSC lag).
 * 
 * Only shows when delay applies—otherwise returns null.
 */
export const DataDelayNote: React.FC<DataDelayNoteProps> = ({
  timeContext,
  gscEndDate
}) => {
  if (!timeContext?.days) return null;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  const GSC_DELAY_DAYS = 3;
  const periodEnd = timeContext.endDate || todayStr;
  const periodEndDate = new Date(periodEnd + 'T00:00:00Z');
  const delayBoundary = new Date(now.getTime() - GSC_DELAY_DAYS * 86400000);

  // Only show if period end is more recent than delay boundary
  if (periodEndDate <= delayBoundary) return null;

  const delayStart = new Date(delayBoundary.getTime() + 86400000);
  const delayStartStr = _formatShortDate(delayStart);
  const delayEndStr = _formatShortDate(now);
  const lastDataStr = gscEndDate ? _formatShortDate(new Date(gscEndDate + 'T00:00:00Z')) : null;

  const noteText = lastDataStr
    ? `GSC data through ${lastDataStr} — ${delayStartStr}–${delayEndStr} still processing (this is normal)`
    : `GSC data for ${delayStartStr}–${delayEndStr} is still processing — numbers may be incomplete`;

  return (
    <div className={styles.gscDelayNote}>
      <ClockIcon />
      <span className={styles.gscDelayText}>{noteText}</span>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// FIRST-VISIT BANNER
// ═══════════════════════════════════════════════════════════════

/**
 * Respectful, single-sentence orientation banner for new users.
 * 
 * Not a tour or spotlight—respects the user's intelligence.
 * Can be dismissed or auto-hidden after completing a task.
 */
export const FirstVisitBanner: React.FC<FirstVisitBannerProps> = ({
  visible = false,
  onDismiss
}) => {
  if (!visible) return null;

  return (
    <div className={styles.firstVisitBanner}>
      <span className={styles.firstVisitText}>
        <strong>New here?</strong> This dashboard runs automatically.
        {' '}
        Read the headline for what happened, check the mission card for what to do. That's it.
      </span>
      <button
        className={styles.firstVisitDismiss}
        onClick={onDismiss}
        aria-label="Dismiss introduction"
      >
        Got it
      </button>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function _getRelativeTime(timestamp: string | null | undefined): string {
  if (!timestamp) return 'recently';
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();

  if (diffMs < 0) return 'just now';

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'yesterday';
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

function _isStale(timestamp: string | null | undefined): boolean {
  if (!timestamp) return true;
  const diffMs = Date.now() - new Date(timestamp).getTime();
  return diffMs > 48 * 3600000; // >48 hours
}

function _formatShortDate(date: Date): string {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

// ═══════════════════════════════════════════════════════════════
// ICONS
// ═══════════════════════════════════════════════════════════════

const RefreshIcon: React.FC = () => (
  <svg
    className={styles.icon}
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M13.65 2.35A7.96 7.96 0 0 0 8 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 8 14c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" />
  </svg>
);

const ClockIcon: React.FC = () => (
  <svg
    className={styles.gscDelayIcon}
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M8 4v4.5l3 1.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);
