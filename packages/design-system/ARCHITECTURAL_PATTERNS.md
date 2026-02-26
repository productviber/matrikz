# Design System Architectural Patterns

## Overview

The enhanced design system brings sophisticated patterns from the visibility-analytics visualization codebase into a reusable component library. This enables both the analytics and marketer workers to build data-rich, user-friendly interfaces with consistent patterns.

**Key Principles:**
- **Progressive Disclosure**: Show what's important, hide complexity until needed
- **Data Storytelling**: Narratives that explain what happened and why it matters
- **Trust & Transparency**: Data freshness indicators, delay notes, first-visit guidance
- **Consistent Mental Models**: Reusable card patterns, empty states, visual hierarchies

---

## Component Architecture

### Layer 1: Base Components (Existing)
- `Button` — Semantic actions
- `Input` — Form inputs with validation
- `Card` — Container for related content
- `Badge` — Status and metadata indicators
- `Alert` — Important messages and warnings

### Layer 2: Enhanced Components (New)
- `ExpandableCard` — Progressive disclosure with hook text
- `EmptyStateCard` — Onboarding & setup guidance
- `InsightCard` — Data-rich expandable containers
- `CardGrid` — Responsive multi-card layouts

### Layer 3: Domain Components (New)
- `FreshnessIndicator` — Data recency with refresh capability
- `DataDelayNote` — Contextual messaging for delayed data
- `FirstVisitBanner` — Respectful orientation for new users

### Layer 4: Utilities (New)
- `svgCharts` — Pure SVG visualization functions
- `narrativeEngine` — Template-based storytelling system

---

## Pattern Categories

### 1. Progressive Disclosure Pattern

**Problem**: Dashboards need depth without overwhelming users.

**Solution**: Expandable cards that show key metrics collapsed, detailed analysis when expanded.

```tsx
// Collapsed state shows: Icon + Title + Hook
// Expanded state shows: Hook + Body + Insight section

<ExpandableCard
  icon="📊"
  title="Search Intent Distribution"
  hook="Informational: 45 (60%), Navigational: 20 (27%), Transactional: 8 (11%)"
  defaultOpen={false}
  insight="Transactional searches are buyer-ready. Prioritize these in your content."
>
  {/* Detailed breakdown grid, charts, etc */}
</ExpandableCard>
```

**Used By**: Exploration views, detailed analytics pages, reports

---

### 2. Empty State Pattern

**Problem**: New users encounter blank sections and don't know what to do.

**Solution**: Context-specific guidance with icon, heading, body, and actionable CTA.

```tsx
// Structure:
// - Large icon (emotional connection)
// - Heading: "What's missing"
// - Body: "Why it matters"
// - CTA: "How to get started"

<EmptyStateCard
  icon="🧭"
  heading="Search intent analysis for every keyword"
  body="People search with different goals — some want to buy, others want to learn, others want your location. Understanding this drives your content strategy."
  ctaText="Run first analysis →"
  onCTA={() => triggerAnalysis()}
  sectionTitle="Search Intent Distribution"
/>
```

**Used By**: New dashboards, unset-up data sources, first-time users

---

### 3. Trust Signal Pattern

**Problem**: Users don't know if data is fresh, delayed, or outdated.

**Solution**: Layered indicators that show freshness, delay notes, and orientation guidance.

```tsx
// Freshness Indicator: "Updated 2 hours ago [↻]" with staleness warning

<FreshnessIndicator
  timestamp={lastUpdateTime}
  onRefresh={async () => await refreshData()}
/>

// Data Delay Note: "GSC data through Feb 10 — Feb 11-13 still processing"

<DataDelayNote
  timeContext={{ startDate: '2026-02-06', endDate: '2026-02-13' }}
  gscEndDate="2026-02-10"
/>

// First Visit Banner: Single sentence orientation

<FirstVisitBanner
  visible={isNewUser}
  onDismiss={() => localStorage.setItem('seen-banner', 'true')}
/>
```

**Used By**: Dashboard headers, data sections, onboarding flows

---

### 4. Data Visualization Pattern

**Problem**: Need rich visualizations that work in email, web, and print.

**Solution**: Pure SVG chart utilities with no dependencies.

```tsx
// Scatter plot with quadrant analysis
const scatterData = {
  points: [
    { query: 'keyword', x: 100, y: 5, ctrGap: 0.15 },
    // ...
  ],
  bounds: { minX: 0, maxX: 500, minY: 0, maxY: 50 }
};

const svg = renderScatterPlot(scatterData, {
  width: 600,
  height: 400,
  title: 'Keyword Opportunities'
});

// Sparklines for trends
const sparklineData: Sparkline[] = [
  {
    label: 'target keyword',
    values: [15, 14, 12, 10, 11, 9, 8],
    currentPosition: 8,
    direction: 'declining'
  }
];

const sparklineSvg = renderSparklines(sparklineData);

// Bar charts for comparisons
const barData: BarChartData = {
  labels: ['Mobile', 'Desktop', 'Tablet'],
  datasets: [{
    label: 'Traffic',
    values: [450, 320, 80],
    color: '#3b82f6'
  }]
};

const barSvg = renderBarChart(barData);
```

**Used By**: Analytics dashboards, email reports, data exploration

---

### 5. Narrative Engine Pattern

**Problem**: Data without story is just numbers. Need consistent, data-driven storytelling.

**Solution**: Template-based narrative generation with priority-ordered matching.

```tsx
// Define context from your data
const narrativeContext: NarrativeContext = {
  pk: {
    clicks: 150,
    impressions: 2000,
    ctr: 0.075,
    clicksDelta: 25,
    impressionsDelta: 15,
    positionDelta: -1.5,
    page1Keywords: 45,
    page1ZeroClickCount: 28,
    nearMissCount: 12,
    potential: 450
  },
  diagnosis: {
    templateId: 'ctr-opportunity-page1',
    signals: { topKeywordSlide: { keyword: 'target keyword', prevPosition: 8, curPosition: 5 } }
  },
  timeContext: { label: 'This week', days: 7 }
};

// Create engine and generate narrative
const engine = createNarrativeEngine();
const narrative = engine.generate(narrativeContext);

// Output:
// "You're ranking on page 1 for 45 searches this week, but 62% of them earn zero clicks.
//  Searchers see your result, evaluate it against competitors, and choose someone else.
//  The good news: your rankings are strong. The fix: rewriting your title tags..."
```

**Used By**: Pulse/dashboard headlines, weekly summaries, email insights

---

## Usage Examples

### Analytics Worker: Dashboard with Enhanced Cards

```tsx
import {
  ExpandableCard,
  FreshnessIndicator,
  CardGrid,
  InsightCard
} from '@clodo/design-system/components'
import { renderScatterPlot } from '@clodo/design-system/utils'

export function ExploreView() {
  return (
    <div>
      {/* Header with trust signals */}
      <header>
        <h1>Explore Your Data</h1>
        <FreshnessIndicator
          timestamp={lastUpdate}
          onRefresh={handleRefresh}
        />
      </header>

      {/* Cards in responsive grid */}
      <CardGrid columns={2}>
        {/* Progressive disclosure card */}
        <ExpandableCard
          icon="🔍"
          title="Search Intent Distribution"
          hook="45 informational, 20 navigational, 8 transactional"
          insight="Transactional searches are ready to convert. Prioritize these."
        >
          <IntentDistributionChart data={intentData} />
        </ExpandableCard>

        {/* SVG visualization */}
        <ExpandableCard
          icon="📊"
          title="Keyword Opportunities"
          hook={`${quickWins.length} quick wins available`}
          insight="Quick Wins have high impressions but low position—easy targets."
        >
          <div
            dangerouslySetInnerHTML={{
              __html: renderScatterPlot(scatterData, { width: 500, height: 300 })
            }}
          />
        </ExpandableCard>
      </CardGrid>
    </div>
  )
}
```

### Marketer Worker: Report with Narratives

```tsx
import {
  FirstVisitBanner,
  ExpandableCard,
  CardGrid
} from '@clodo/design-system/components'
import { createNarrativeEngine } from '@clodo/design-system/utils'

export function MarketingReport({ siteData }) {
  const engine = createNarrativeEngine()
  const narrative = engine.generate({
    pk: siteData.periodKPIs,
    diagnosis: siteData.diagnosis,
    timeContext: siteData.timeContext
  })

  return (
    <div>
      <FirstVisitBanner
        visible={isNewUser}
        onDismiss={dismissBanner}
      />

      {/* Narrative headline */}
      <ExpandableCard
        icon="📰"
        title="This Week's Story"
        hook={narrative.split('.')[0]}
        defaultOpen={true}
        insight="Read your data's narrative in plain English."
      >
        <p>{narrative}</p>
      </ExpandableCard>

      {/* Supporting cards */}
      <CardGrid columns={3}>
        <MetricCardWithContext metric="impressions" />
        <MetricCardWithContext metric="clicks" />
        <MetricCardWithContext metric="position" />
      </CardGrid>
    </div>
  )
}
```

---

## Integration Checklist

### For Analytics Worker
- [ ] Import enhanced components where exploration/insights are needed
- [ ] Add FreshnessIndicator to dashboard headers
- [ ] Wrap data sections in ExpandableCard for progressive disclosure
- [ ] Use SVG chart utilities for data visualization
- [ ] Test with responsive layouts

### For Marketer Worker
- [ ] Import NarrativeEngine and customize templates if needed
- [ ] Add FirstVisitBanner to new user reports
- [ ] Wrap insights in ExpandableCard containers
- [ ] Use EmptyStateCard for signup flows
- [ ] Validate data freshness messaging

### Design System Maintenance
- [ ] 100% TypeScript coverage
- [ ] All components exported via barrel files
- [ ] CSS Modules for style isolation
- [ ] Storybook documentation (optional)
- [ ] Unit tests for narrative templates

---

## Extensibility

### Adding Custom Narrative Templates

```tsx
const engine = createNarrativeEngine([
  {
    id: 'custom-pattern',
    priority: 75,
    match: (ctx) => {
      // Your condition
      return ctx.pk?.customMetric > 100
    },
    render: (ctx) => {
      // Your narrative
      return `Custom story here...`
    }
  }
])
```

### Creating Custom SVG Charts

```tsx
// Follow the established patterns:
// 1. Input: typed data structure
// 2. Output: SVG string
// 3. Configuration: options object
// 4. No dependencies: pure implementation

export function renderCustomChart(data: CustomData, options = {}): string {
  // Build SVG string...
  return svg
}
```

---

## Performance Considerations

- **SVG Charts**: Generated server-side, streamed to clients (no React overhead)
- **Templates**: Priority-sorted once at creation, lazy evaluated at generation time
- **Components**: Styled with CSS Modules (no runtime CSS-in-JS)
- **Bundle Impact**: ~25KB (svgCharts + narrativeEngine), components ship with design system

---

## Browser & Email Support

- **SVG Charts**: Works in all modern browsers + Outlook, Gmail, Apple Mail
- **CSS Styles**: CSS Modules with fallbacks for older browsers
- **JavaScript**: Requires IE 11+ or modern browsers (async/await for refresh)
- **Email**: Design signals and charts render in email clients

---

## Troubleshooting

**Issue**: Narrative doesn't match expected template
- **Solution**: Check template priority order (higher = evaluated first). Ensure match conditions are specific.

**Issue**: SVG chart looks distorted in email
- **Solution**: Email clients have viewport/width constraints. Use `viewBox` and percentage widths instead of fixed pixels.

**Issue**: Freshness indicator not refreshing
- **Solution**: Ensure `onRefresh` callback is async and returns after refresh completes. Call callback after data update.

---

## See Also

- [Component API Documentation](./COMPONENT_API.md)
- [Narrative Template Reference](./NARRATIVE_REFERENCE.md)
- [SVG Charts Gallery](./CHARTS_GALLERY.md)
- [Integration Guides](./INTEGRATION_GUIDES/)
