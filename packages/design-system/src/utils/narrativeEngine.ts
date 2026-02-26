/**
 * Narrative Engine
 * 
 * Pattern-based storytelling system for generating data-driven narratives.
 * Imported from visibility-analytics narrative-templates patterns.
 * 
 * Architecture:
 * 1. Each template defines a match(context) predicate
 * 2. Templates are evaluated in priority order (highest first)
 * 3. First matching template generates the narrative
 * 4. If no template matches, fallback generates generic narrative
 * 5. Returning-user context can be prepended
 */

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface NarrativeContext {
  /** Period-scoped KPIs */
  pk?: {
    clicks?: number;
    impressions?: number;
    ctr?: number;
    position?: number;
    potential?: number;
    clicksDelta?: number;
    impressionsDelta?: number;
    positionDelta?: number;
    ctrDelta?: number;
    page1ZeroClickCount?: number;
    page1Keywords?: number;
    nearMissCount?: number;
    topKeywordSlide?: any;
  };
  /** Diagnosis results */
  diagnosis?: {
    templateId?: string;
    causeLabel?: string;
    signals?: {
      unindexedPageCount?: number;
      topKeywordSlide?: { keyword: string; prevPosition: number; curPosition: number };
    };
    primaryActionId?: string;
  };
  /** Time context { label, startDate, endDate, days } */
  timeContext?: { label?: string; startDate?: string; endDate?: string; days?: number };
  /** Returning user session state */
  sessionState?: { isReturning?: boolean; visitsCount?: number };
}

export interface NarrativeTemplate {
  id: string;
  priority: number;
  match: (ctx: NarrativeContext) => boolean;
  render: (ctx: NarrativeContext) => string;
}

// ═══════════════════════════════════════════════════════════════
// CORE ENGINE
// ═══════════════════════════════════════════════════════════════

export class NarrativeEngine {
  private templates: NarrativeTemplate[] = [];

  /**
   * Register a new narrative template
   */
  public register(template: NarrativeTemplate): void {
    this.templates.push(template);
  }

  /**
   * Register multiple templates at once
   */
  public registerMultiple(templates: NarrativeTemplate[]): void {
    this.templates.push(...templates);
  }

  /**
   * Generate narrative for given context
   * Evaluates templates in priority order (highest first)
   */
  public generate(context: NarrativeContext): string {
    // Sort by priority descending
    const sorted = [...this.templates].sort((a, b) => b.priority - a.priority);

    // Find first matching template
    for (const template of sorted) {
      if (template.match(context)) {
        return template.render(context);
      }
    }

    // Fallback narrative
    return this._generateFallback(context);
  }

  /**
   * Get all registered templates
   */
  public getTemplates(): NarrativeTemplate[] {
    return [...this.templates];
  }

  /**
   * Clear all templates
   */
  public reset(): void {
    this.templates = [];
  }

  private _generateFallback(context: NarrativeContext): string {
    const pk = context.pk || {};
    const impsDelta = pk.impressionsDelta ?? 0;
    const clicksDelta = pk.clicksDelta ?? 0;

    if (impsDelta === 0 && clicksDelta === 0) {
      return 'This week held steady. Your rankings and traffic remained stable — continue monitoring your near-miss keywords for quick wins.';
    }

    if (impsDelta > 0 && clicksDelta > 0) {
      return `This week was positive. Impressions grew ${Math.round(impsDelta)}% and clicks grew ${Math.round(clicksDelta)}%. Keep monitoring the metrics and maintain your current content strategy.`;
    }

    if (impsDelta < 0 || clicksDelta < 0) {
      return 'This week saw some challenges. Review your rankings for any significant drops and audit your top-performing pages for any recent changes.';
    }

    return 'Review this week\'s performance metrics below for detailed insights.';
  }
}

// ═══════════════════════════════════════════════════════════════
// Built-in Templates (from visibility-analytics patterns)
// ═══════════════════════════════════════════════════════════════

export const BUILT_IN_TEMPLATES: NarrativeTemplate[] = [
  // Template 1: Indexing-driven impression drop with rank improvement
  {
    id: 'indexing-impression-drop',
    priority: 100,
    match(ctx): boolean {
      const { pk, diagnosis } = ctx;
      return (
        (pk?.impressionsDelta != null &&
        pk.impressionsDelta < -15 &&
        pk?.positionDelta != null &&
        pk.positionDelta < -5 &&
        (diagnosis?.templateId === 'index-coverage-drop' || diagnosis?.causeLabel === 'indexing')) ?? false
      );
    },
    render(ctx) {
      const { pk, diagnosis } = ctx;
      const impDrop = Math.abs(Math.round(pk?.impressionsDelta || 0));
      const posImprove = Math.abs(Math.round(pk?.positionDelta || 0));
      const unindexed = diagnosis?.signals?.unindexedPageCount || 'several';
      return (
        `Impressions dropped ${impDrop}% this week, but that's not because your rankings weakened — they actually improved by ${posImprove}%. ` +
        `The drop happened because ${unindexed} page${unindexed !== 1 ? 's' : ''} left Google's index, making you invisible for those searches temporarily. ` +
        `Your rankings are intact. Fixing the indexing issue is your top priority and should recover most of the lost impressions within 3–5 days.`
      );
    }
  },

  // Template 2: CTR opportunity on page-1 rankings
  {
    id: 'ctr-opportunity-page1',
    priority: 90,
    match(ctx) {
      const { pk } = ctx;
      const page1Keywords = pk?.page1Keywords || 0;
      const zeroClick = pk?.page1ZeroClickCount || 0;
      return page1Keywords >= 10 && zeroClick >= 10 && zeroClick / page1Keywords > 0.5;
    },
    render(ctx) {
      const { pk } = ctx;
      const page1 = pk?.page1Keywords || 0;
      const zeroPct = Math.round(((pk?.page1ZeroClickCount || 0) / page1) * 100);
      return (
        `You're ranking on page 1 for ${page1} searches this week, but ${zeroPct}% of them earn zero clicks. ` +
        `Searchers see your result, evaluate it against competitors, and choose someone else. ` +
        `The good news: your rankings are strong. The fix: rewriting your title tags and meta descriptions ` +
        `to better match what searchers expect will immediately lift your click-through rate without needing to improve rankings further.`
      );
    }
  },

  // Template 3: Broad metric improvement
  {
    id: 'broad-improvement',
    priority: 80,
    match(ctx) {
      const { pk } = ctx;
      return (
        pk?.impressionsDelta != null &&
        pk.impressionsDelta > 10 &&
        pk?.clicksDelta != null &&
        pk.clicksDelta > 5 &&
        pk?.positionDelta != null &&
        pk.positionDelta < -5
      );
    },
    render(ctx) {
      const { pk, diagnosis } = ctx;
      const impUp = Math.round(pk?.impressionsDelta || 0);
      const clickUp = Math.round(pk?.clicksDelta || 0);
      const posImprove = Math.abs(Math.round(pk?.positionDelta || 0));

      let driverSentence = '';
      if (diagnosis?.signals?.topKeywordSlide?.keyword) {
        const kw = diagnosis.signals.topKeywordSlide;
        driverSentence =
          `The most significant driver was "${kw.keyword}", which moved from position ${Math.round(kw.prevPosition)} to ${Math.round(kw.curPosition)}. `;
      }

      const topAction = diagnosis?.primaryActionId ? 'your next priority action' : 'your highest-priority task';

      return (
        `This was a strong week across the board. Impressions grew ${impUp}%, clicks grew ${clickUp}%, ` +
        `and your average position improved ${posImprove}%. ` +
        driverSentence +
        `Keep doing what you're doing — the momentum is in your favor. Your next lever is ${topAction}.`
      );
    }
  },

  // Template 4: Stable week with untapped potential
  {
    id: 'stable-untapped',
    priority: 50,
    match(ctx) {
      const { pk } = ctx;
      return (
        (pk?.impressionsDelta == null || Math.abs(pk.impressionsDelta) < 5) &&
        (pk?.positionDelta == null || Math.abs(pk.positionDelta) < 5) &&
        (pk?.potential || 0) > 100
      );
    },
    render(ctx) {
      const { pk } = ctx;
      const nearMiss = pk?.nearMissCount || 0;
      const potential = pk?.potential || 0;

      return (
        `No major changes this week — impressions, clicks, and rankings held steady. ` +
        `Your biggest opportunity right now is ${nearMiss} near-miss keyword${nearMiss !== 1 ? 's' : ''} that rank just outside the top 3. ` +
        `Small improvements to these pages would add an estimated ${potential.toLocaleString()} visitors per week. ` +
        `These are the highest-leverage targets because you're already close — a few targeted edits could push them over.`
      );
    }
  },

  // Template 5: Single keyword loss
  {
    id: 'single-keyword-loss',
    priority: 85,
    match(ctx): boolean {
      const { diagnosis } = ctx;
      const kw = diagnosis?.signals?.topKeywordSlide;
      return !!(kw?.keyword && kw.prevPosition <= 10 && kw.curPosition > 20);
    },
    render(ctx) {
      const kw = ctx.diagnosis?.signals?.topKeywordSlide;
      return (
        `Your strongest keyword, "${kw?.keyword}", dropped from position ${Math.round(kw?.prevPosition || 0)} to ${Math.round(kw?.curPosition || 0)} this week. ` +
        `This single loss likely accounts for most of this week's impression drop. ` +
        `Audit this page immediately: check for technical errors, content quality, and backlink changes. ` +
        `If you find the issue, recovery can happen within days of fixing it.`
      );
    }
  }
];

// ═══════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════

/**
 * Create a pre-configured NarrativeEngine with built-in templates
 */
export function createNarrativeEngine(
  customTemplates: NarrativeTemplate[] = []
): NarrativeEngine {
  const engine = new NarrativeEngine();
  engine.registerMultiple(BUILT_IN_TEMPLATES);
  if (customTemplates.length > 0) {
    engine.registerMultiple(customTemplates);
  }
  return engine;
}
