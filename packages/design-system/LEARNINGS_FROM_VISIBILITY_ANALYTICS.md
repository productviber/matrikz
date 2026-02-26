# Learnings from visibility-analytics → Design System Integration

## How We Extracted and Adapted Patterns

This document shows the direct connection between the visibility-analytics codebase and the new design-system components, helping understand the architectural decisions.

---

## 1. Progressive Disclosure Pattern

### Source: visibility-analytics/cockpit/components/card-library.mjs

**Original Pattern:**
```javascript
// From card-library.mjs (line 30-50)
export function buildEmptyStateCard(config) {
  const { icon, heading, body, ctaText, ctaAction, sectionTitle, sectionIcon } = config;

  return `<details class="explore-card" open>
    <summary class="ec-summary">
      <span class="ec-icon">${sectionIcon || icon}</span>
      <div class="ec-info">
        <span class="ec-title">${sectionTitle || heading...}</span>
        <span class="ec-hook">Setup required</span>
      </div>
      <span class="ec-chevron">▸</span>
    </summary>
    <div class="ec-body">
      <!-- content -->
    </div>
  </details>`;
}
```

**Design Pattern:**
- Collapsible `<details>` with visual hook text
- Chevron indicator that rotates on open
- Icon + Title + Hook shown in collapsed state
- Body content revealed on expand

**Adapted To:**
```tsx
// New design-system component: EnhancedCard.tsx
<ExpandableCard
  icon="📊"
  title="Title"
  hook="Hook text"
  children={<BodyContent />}
  insight="So what? text"
/>
```

**Improvements in React:**
- ✅ Type-safe props with TypeScript
- ✅ React composition with children
- ✅ CSS Modules for style isolation
- ✅ Reusable in both workers
- ✅ Accessibility improvements (ARIA labels, semantic HTML)

---

## 2. Empty State Pattern

### Source: visibility-analytics/cockpit/components/card-library.mjs

**Original Pattern:**
```javascript
// From card-library.mjs (line 66-102)
export function buildIntentDistributionCard(intentAnalysis) {
  if (!intentAnalysis?.distribution || ...) {
    return buildEmptyStateCard({
      icon: '🧭',
      heading: 'Search intent analysis for every keyword',
      body: 'People search with different goals...',
      ctaText: 'Run first analysis →',
      ctaAction: 'triggerContentCrawl()',
      sectionTitle: 'Search Intent Distribution',
      sectionIcon: '🧭'
    });
  }
  // ... render actual data
}
```

**Design Pattern:**
- 3-line hierarchy: What (heading) + Why (body) + How (CTA)
- Icon creates emotional connection
- Actionable guidance for users
- Elegant fallback when data unavailable

**Adapted To:**
```tsx
// New design-system component: EnhancedCard.tsx
<EmptyStateCard
  icon="🧭"
  heading="What's missing"
  body="Why it matters"
  ctaText="Action text →"
  onCTA={() => handleAction()}
/>
```

**Key Improvement:**
Added explicit onboarding support—analytics could render this before data loads, marketer could show during signup.

---

## 3. Trust Signals — Freshness Indicator

### Source: visibility-analytics/cockpit/components/trust-signals.mjs

**Original Pattern:**
```javascript
// From trust-signals.mjs (line 33-48)
export function renderFreshnessIndicator({ timestamp, dataLagDays, sourceCount } = {}) {
  const relativeTime = _getRelativeTime(timestamp);
  const isStale = _isStale(timestamp);
  const staleClass = isStale ? ' freshness-stale' : '';

  return `<span class="freshness-indicator${staleClass}" id="freshness-indicator">` +
    `<span class="freshness-text" id="freshness-text">Updated ${esc(relativeTime)}</span>` +
    `<button class="freshness-refresh-btn" onclick="triggerManualRefresh()">↻</button>` +
    `${isStale ? '<span class="freshness-warn">⚠</span>' : ''}` +
  `</span>`;
}
```

**Design Pattern:**
- Relative time formatting ("2 hours ago")
- Staleness detection (>48 hours warning)
- Manual refresh capability
- Visual indicators: color + warning icon

**States Handled:**
- ✅ Fresh: "Updated 2 hours ago"
- ✅ Stale: "Updated 3 days ago ⚠"
- ✅ Refreshing: "Updating... ⟳"

**Adapted To:**
```tsx
// New design-system component: TrustSignals.tsx
<FreshnessIndicator
  timestamp={lastUpdate}
  onRefresh={async () => await refreshData()}
/>
```

**Improvements:**
- ✅ Async refresh handling with React state management
- ✅ Disabled state during refresh (loading animation)
- ✅ TypeScript instead of vanilla JS
- ✅ CSS Module styled (configurable via CSS custom properties)
- ✅ Accessible (aria-labels, semantic button)

---

## 4. Trust Signals — Data Delay Note

### Source: visibility-analytics/cockpit/components/trust-signals.mjs

**Original Pattern:**
```javascript
// From trust-signals.mjs (line 66-90)
export function renderGscDelayNote({ timeContext, gscEndDate } = {}) {
  if (!timeContext?.days) return '';

  const GSC_DELAY_DAYS = 3;
  // ... date calculations ...
  
  const noteText = lastDataStr
    ? `GSC data through ${lastDataStr} — ${delayStartStr}–${delayEndStr} still processing`
    : `GSC data for ${delayStartStr}–${delayEndStr} is still processing`;

  return `<div class="gsc-delay-note">` +
    `<svg class="gsc-delay-icon">...</svg>` +
    `<span class="gsc-delay-text">${noteText}</span>` +
  `</div>`;
}
```

**Design Pattern:**
- Context-aware messaging (only shows when relevant)
- Specific date ranges (e.g., "Feb 11-13")
- Explanation: "GSC is normally 2-3 days behind"
- Icon + text for visual clarity

**Adapted To:**
```tsx
// New design-system component: TrustSignals.tsx
<DataDelayNote
  timeContext={{ startDate: '2026-02-06', endDate: '2026-02-13' }}
  gscEndDate="2026-02-10"
/>
```

**Key Value:**
Prevents user frustration—they understand data delay is normal, not a bug.

---

## 5. SVG Charts — Pure Generation

### Source: visibility-analytics/src/visualization/svg-charts.mjs

**Original Pattern:**
```javascript
// From svg-charts.mjs (line 40-80)
export function renderScatterPlot(scatterData, options = {}) {
  const { width = 600, height = 400, title = 'Keyword Opportunity Map' } = options;
  const { points = [], bounds = {} } = scatterData;

  // No external dependencies
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" ...>`;
  
  // Build SVG entirely as string
  svg += `<rect ... />`;  // quadrant backgrounds
  svg += `<text ... />`;  // axis labels
  svg += `...`;
  
  // Render data points
  for (const point of points) {
    svg += `<circle cx="${cx}" cy="${cy}" ... />`;
  }
  
  svg += `</svg>`;
  return svg;
}
```

**Design Pattern:**
- Pure string generation (no dependencies)
- Server-side rendering
- Email-compatible SVG
- Quadrant analysis for keyword opportunities

**Four Chart Types:**
1. Scatter plots (quadrant analysis)
2. Sparklines (trend visualization)
3. Bar charts (comparisons)
4. Donut charts (distributions)

**Adapted To:**
```tsx
// New design-system utility: svgCharts.ts
export function renderScatterPlot(data: ScatterPlotData, options?): string
export function renderSparklines(data: Sparkline[], options?): string
export function renderBarChart(data: BarChartData, options?): string
export function renderDonutChart(data, options?): string
```

**Improvements:**
- ✅ Full TypeScript typing
- ✅ Proper bounds handling with optional defaults
- ✅ Exported data types for type safety
- ✅ Works in React with `dangerouslySetInnerHTML`
- ✅ Email-safe (no dependencies, pure SVG)

---

## 6. Narrative Templates — Pattern-Based Storytelling

### Source: visibility-analytics/cockpit/components/narrative-templates.mjs

**Original Pattern:**
```javascript
// From narrative-templates.mjs (line 47-100)
const NARRATIVE_TEMPLATES = [
  {
    id: 'indexing-impression-drop',
    priority: 100,
    match(ctx) {
      const { pk, diagnosis } = ctx;
      return (pk.impressionsDelta < -15) &&
             (pk.positionDelta < -5) &&
             (diagnosis?.causeLabel === 'indexing');
    },
    render(ctx) {
      const impDrop = Math.abs(pk.impressionsDelta);
      const posImprove = Math.abs(pk.positionDelta);
      return `Impressions dropped ${impDrop}% but that's not because rankings weakened...`;
    }
  },
  // ... more templates ...
];
```

**Design Pattern:**
- Template objects with `id`, `priority`, `match()`, `render()`
- Priority-ordered evaluation (highest first)
- First matching template generates narrative
- Generic fallback if no match

**Key Innovation:**
Each template is a complete story—not just metrics, but **why** they matter and **what to do**.

**Adapted To:**
```tsx
// New design-system utility: narrativeEngine.ts
class NarrativeEngine {
  register(template: NarrativeTemplate): void
  generate(context: NarrativeContext): string
}

export const BUILT_IN_TEMPLATES: NarrativeTemplate[] = [
  {
    id: 'indexing-impression-drop',
    priority: 100,
    match: (ctx: NarrativeContext): boolean => { ... },
    render: (ctx: NarrativeContext): string => { ... }
  }
  // ... 4 more templates ...
]
```

**Improvements:**
- ✅ Class-based architecture for extensibility
- ✅ Full TypeScript with NarrativeContext type
- ✅ Factory pattern: `createNarrativeEngine()`
- ✅ Support for custom templates
- ✅ Explicit return type enforcement

---

## 7. First-Visit Banner

### Source: visibility-analytics/cockpit/components/trust-signals.mjs

**Original Pattern:**
```javascript
// From trust-signals.mjs (line 99-121)
export function renderFirstVisitBanner() {
  return `<div class="first-visit-banner" id="first-visit-banner" style="display:none">` +
    `<span class="first-visit-text">` +
      `<strong>New here?</strong> This dashboard runs automatically. ` +
      `Read the headline for what happened, check the mission card for what to do. That's it.` +
    `</span>` +
    `<button class="first-visit-dismiss" onclick="dismissFirstVisitBanner()">Got it</button>` +
  `</div>`;
}
```

**Design Pattern:**
- **Not a tour or spotlight**—respects user intelligence
- Single actionable sentence
- Clear dismissal path
- Simple "Got it" button

**Why This Matters:**
Most users hate tutorials. This is minimal guidance that actually helps.

**Adapted To:**
```tsx
// New design-system component: TrustSignals.tsx
<FirstVisitBanner
  visible={!user.hasSeenBanner}
  onDismiss={() => markBannerDismissed()}
/>
```

**Improvements:**
- ✅ React state management
- ✅ Animated slide-in
- ✅ Conditional rendering
- ✅ Accessibility support

---

## Architecture Insights From visibility-analytics

### 1. Modular Card Library

**What visibility-analytics Did:**
```
cockpit/components/card-library.mjs (404 lines)
├── buildEmptyStateCard()
├── buildIntentDistributionCard()
├── buildDeviceBreakdownCard()
├── buildIndexingCard()
├── buildCompetitorCard()
├── buildMismatchCard()
├── buildVitalsCard()
└── buildBriefsCard()
```

**Why This Pattern Works:**
Single file = single source of truth for card rendering. Any view can import and use.

**How We Adapted:**
```
design-system/src/components/
├── EnhancedCard.tsx (generic, reusable)
    ├── ExpandableCard (framework)
    ├── EmptyStateCard (pattern)
    └── InsightCard (convenience)
design-system/src/utils/
├── narrativeEngine.ts (generic, extensible)
```

Different approach: We made **generic, reusable** components that work with any data, rather than domain-specific cards.

### 2. Utilities as Separate Modules

**What visibility-analytics Did:**
```
cockpit/utils/
├── escaping.mjs (HTML escaping)
├── formatters.mjs (format CTR, trends, etc.)
├── data-helpers.mjs (extract journey lenses, etc.)
└── component-renderers.mjs (render KPI cards, etc.)
```

**Why This Pattern Works:**
Concerns separated: escaping ≠ formatting ≠ data processing ≠ rendering.

**How We Adapted:**
```
design-system/src/utils/
├── svgCharts.ts (chart rendering—pure SVG)
├── narrativeEngine.ts (narrative generation—storage pattern)
└── [potential] formatters.ts (future expansion)
```

### 3. Documentation-First Approach

**What visibility-analytics Did:**
```
cockpit/
├── FILE_MANIFEST.md (what each file does)
├── QUICK_REFERENCE.md (fast lookup)
└── REFACTORING_GUIDE.md (how to add features)
```

**Why This Matters:**
Future developers onboard faster. Code architecture is self-documenting.

**How We Adapted:**
```
design-system/
├── ARCHITECTURAL_PATTERNS.md (overview + patterns)
├── COMPONENT_API.md (complete API reference)
├── INTEGRATION_ANALYTICS.md (analytics-specific guide)
├── INTEGRATION_MARKETER.md (marketer-specific guide)
└── IMPLEMENTATION_COMPLETE.md (this summary)
```

---

## Key Learnings Applied

### 1. **Progressive Disclosure Over Information Overload**
"Show the headline, let users expand for details."
- visibility-analytics: `<details>` cards with hooks
- Design system: `<ExpandableCard />` component

### 2. **Trust Through Transparency**
"Tell users when data is delayed, when it's fresh, when you don't have it yet."
- visibility-analytics: FreshnessIndicator, DataDelayNote, FirstVisitBanner
- Design system: Full trust signals component suite

### 3. **Pure Functions, No Dependencies**
"SVG charts work in email, electron apps, RSS readers—anywhere."
- visibility-analytics: `renderScatterPlot()` → string
- Design system: Same approach, TypeScript wrapped

### 4. **Stories Over Statistics**
"Data is boring. Context makes it meaningful."
- visibility-analytics: 5 narrative templates for different scenarios
- Design system: NarrativeEngine with extensible templates

### 5. **Documentation as Code**
"If you don't document the pattern, others will reinvent it."
- visibility-analytics: FILE_MANIFEST.md + QUICK_REFERENCE.md
- Design system: 4 comprehensive guides + inline documentation

---

## Comparison: Before → After

| Aspect | visibility-analytics | Design System |
|--------|---------------------|---------------|
| **Card Rendering** | HTML strings (vanilla JS) | React components + TypeScript |
| **Styling** | Inline CSS classes | CSS Modules |
| **Trust Signals** | Vanilla JS implementations | React components |
| **Charts** | Pure SVG strings | Typed utility functions |
| **Narratives** | HTML template strings | Class-based engine |
| **Type Safety** | None | Full TypeScript |
| **Reusability** | Worker-specific | Shared across workers |
| **Documentation** | 3 guides | 4 comprehensive guides |
| **Accessibility** | Basic semantic HTML | ARIA labels, semantic HTML |
| **Testing** | Manual | Type system covers many cases |

---

## Why This Matters

### For Analytics Worker
- Can now build sophisticated dashboards with consistent patterns
- Narrative engine helps explain complex metrics to users
- SVG charts work in email reports without external dependencies
- Trust signals build user confidence in data freshness

### For Marketer Worker
- Can tell data stories in public reports
- Empty state cards guide users through signup/onboarding
- SVG charts in email reports (no images, native format)
- Consistent component library with analytics worker

### For Future Development
- Both workers have proven patterns to build on
- New features follow existing precedents
- Documentation explains "why" not just "how"
- Extensible design means no rewrites

---

## Conclusion

The design system doesn't just copy patterns from visibility-analytics—it **extracts the underlying architecture** and makes it:

- ✅ Generic enough to work with both workers
- ✅ Type-safe with full TypeScript support
- ✅ Accessible and semantic
- ✅ Well-documented with examples
- ✅ Production-ready

The result is a **shared component vocabulary** that enables:
1. Faster feature development
2. Consistent user experience
3. Reduced code duplication
4. Easier maintenance and evolution

---

## Next Steps

1. **Analytics Worker:** Use enhanced cards for dashboard sections
2. **Marketer Worker:** Use narrative engine for weekly reports
3. **Both Workers:** Leverage SVG charts in email content
4. **All Teams:** Refer to documentation guides during development

---

**See Also:**
- [ARCHITECTURAL_PATTERNS.md](./ARCHITECTURAL_PATTERNS.md) — Pattern overview
- [COMPONENT_API.md](./COMPONENT_API.md) — Complete API reference
- [INTEGRATION_ANALYTICS.md](./INTEGRATION_ANALYTICS.md) — Analytics guide
- [INTEGRATION_MARKETER.md](./INTEGRATION_MARKETER.md) — Marketer guide
