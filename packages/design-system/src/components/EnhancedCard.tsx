/**
 * Enhanced Card Components
 * 
 * Progressive disclosure cards with collapsible depth and empty states.
 * Imported from visibility-analytics card-library patterns.
 * 
 * Patterns:
 * - ExpandableCard: Collapsible <details> container with hook text
 * - EmptyStateCard: Icon + heading + body + actionable CTA
 * - InsightCard: Summary + expandable detailed body
 */

import React, { ReactNode } from 'react';
import styles from './EnhancedCard.module.css';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface ExpandableCardProps {
  /** Card icon/emoji (left of title) */
  icon?: string;
  /** Main card title */
  title: string;
  /** Hook text shown in collapsed state */
  hook?: string;
  /** Card body content (rendered when expanded) */
  children: ReactNode;
  /** Insight text shown in a "so what?" section */
  insight?: string;
  /** Insight icon */
  insightIcon?: string;
  /** Whether card starts in expanded state */
  defaultOpen?: boolean;
  /** CSS class names */
  className?: string;
}

export interface EmptyStateCardProps {
  /** Large icon/emoji */
  icon: string;
  /** Heading: what functionality is missing */
  heading: string;
  /** Body: why it matters */
  body: string;
  /** CTA button text */
  ctaText: string;
  /** CTA button onclick handler */
  onCTA: () => void;
  /** Section title shown in the card header (when used inside ExpandableCard) */
  sectionTitle?: string;
  /** Section icon shown in the card header */
  sectionIcon?: string;
}

export interface InsightCardProps {
  /** Card icon/emoji */
  icon: string;
  /** Card title */
  title: string;
  /** Summary text shown in collapsed state */
  summary?: string;
  /** Detailed body content (shown when expanded) */
  children: ReactNode;
  /** "So what?" insight text */
  insight?: string;
  /** Insight icon */
  insightIcon?: string;
  /** Whether card starts expanded */
  defaultOpen?: boolean;
  /** CSS class names */
  className?: string;
}

// ═══════════════════════════════════════════════════════════════
// EXPANDABLE CARD
// ═══════════════════════════════════════════════════════════════

/**
 * Collapsible card with progressive disclosure pattern.
 * 
 * Collapsed state shows:
 * - Icon + Title + Hook text + Chevron
 * 
 * Expanded state shows:
 * - Collapsed state above
 * - Body content
 * - "So what?" insight callout
 */
export const ExpandableCard: React.FC<ExpandableCardProps> = ({
  icon = '📊',
  title,
  hook,
  children,
  insight,
  insightIcon = '💡',
  defaultOpen = false,
  className
}) => {
  return (
    <details className={`${styles.expandableCard} ${className || ''}`} open={defaultOpen}>
      <summary className={styles.cardSummary}>
        {icon && <span className={styles.cardIcon}>{icon}</span>}
        <div className={styles.cardInfo}>
          <span className={styles.cardTitle}>{title}</span>
          {hook && <span className={styles.cardHook}>{hook}</span>}
        </div>
        <span className={styles.cardChevron}>▸</span>
      </summary>

      <div className={styles.cardBody}>
        {children}

        {insight && (
          <div className={styles.soWhatBox}>
            {insightIcon && <span className={styles.soWhatIcon}>{insightIcon}</span>}
            <span>{insight}</span>
          </div>
        )}
      </div>
    </details>
  );
};

// ═══════════════════════════════════════════════════════════════
// EMPTY STATE CARD
// ═══════════════════════════════════════════════════════════════

/**
 * Renders a focused empty state with guidance to the user.
 * 
 * Structure:
 * - Icon (large)
 * - Heading: What's missing
 * - Body: Why it matters
 * - CTA button: How to get started
 * 
 * Can be standalone or wrapped inside an ExpandableCard.
 */
export const EmptyStateCard: React.FC<EmptyStateCardProps> = ({
  icon,
  heading,
  body,
  ctaText,
  onCTA,
  sectionTitle,
  sectionIcon
}) => {
  return (
    <ExpandableCard
      icon={sectionIcon || icon}
      title={sectionTitle || heading.split(' ').slice(0, 3).join(' ')}
      hook="Setup required"
      defaultOpen={true}
      insight="New data will populate automatically on your next analysis run."
      insightIcon="⏳"
    >
      <div className={styles.emptyStateContainer}>
        <div className={styles.emptyStateIcon}>{icon}</div>
        <h3 className={styles.emptyStateHeading}>{heading}</h3>
        <p className={styles.emptyStateBody}>{body}</p>
        <button className={styles.emptyStateCTA} onClick={onCTA}>
          {ctaText}
        </button>
      </div>
    </ExpandableCard>
  );
};

// ═══════════════════════════════════════════════════════════════
// INSIGHT CARD (convenience wrapper)
// ═══════════════════════════════════════════════════════════════

/**
 * Convenience wrapper for ExpandableCard with summary rendering.
 * Similar to ExpandableCard but emphasizes the summary text.
 */
export const InsightCard: React.FC<InsightCardProps> = ({
  icon,
  title,
  summary,
  children,
  insight,
  insightIcon,
  defaultOpen = false,
  className
}) => {
  return (
    <ExpandableCard
      icon={icon}
      title={title}
      hook={summary}
      children={children}
      insight={insight}
      insightIcon={insightIcon}
      defaultOpen={defaultOpen}
      className={className}
    />
  );
};

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Shared card wrapper for consistent content grid layout
 */
export const CardGrid: React.FC<{ children: ReactNode; columns?: 1 | 2 | 3 }> = ({
  children,
  columns = 1
}) => (
  <div
    className={styles.cardGrid}
    style={{
      '--grid-cols': columns
    } as React.CSSProperties & { '--grid-cols': number }}
  >
    {children}
  </div>
);
