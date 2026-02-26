# Integration Guide: Analytics Worker

## Overview

The analytics worker displays rich dashboards with insights, explorations, and performance data. The enhanced design system provides:

- **Progressive Disclosure** for deep data exploration without overwhelming
- **Trust Signals** to show data freshness and delays
- **SVG Visualizations** for email-safe chart rendering
- **TypeScript Types** for type-safe component usage

---

## Quick Start

### 1. Install Design System (Already Done)

The design system is available at `@clodo/design-system` in the monorepo.

### 2. Import Components

```tsx
// In packages/analytics/src/components/Dashboard.tsx
import {
  ExpandableCard,
  FreshnessIndicator,
  DataDelayNote,
  CardGrid
} from '@clodo/design-system/components'

import {
  renderScatterPlot,
  renderSparklines,
  createNarrativeEngine
} from '@clodo/design-system/utils'
```

### 3. Use in Your Components

---

## Usage Patterns by Feature

### Dashboard Header with Trust Signals

```tsx
import { FreshnessIndicator, DataDelayNote } from '@clodo/design-system/components'

export function DashboardHeader({ data, onRefresh }) {
  return (
    <header>
      <div>
        <h1>Analytics Dashboard</h1>
        <p className="subtitle">Your SEO performance at a glance</p>
      </div>

      {/* Data freshness indicator with refresh */}
      <FreshnessIndicator
        timestamp={data.lastUpdate}
        sourceCount={data.sources?.length}
        onRefresh={async () => {
          await onRefresh()
        }}
      />

      {/* Gently inform about data delays */}
      <DataDelayNote
        timeContext={{
          startDate: data.periodStart,
          endDate: data.periodEnd,
          days: data.periodDays
        }}
        gscEndDate={data.gscLastDate}
      />
    </header>
  )
}
```

---

### Pulse View with Progressive Disclosure

```tsx
import { ExpandableCard, CardGrid } from '@clodo/design-system/components'

export function PulseView({ pulse, narrative }) {
  return (
    <section>
      {/* Main narrative */}
      <ExpandableCard
        icon="📰"
        title="This Week's Story"
        hook={narrative.split('.')[0] + '...'}
        defaultOpen={true}
        insight="Your data tells a story. This is ours to you: what happened, why it matters, what to do next."
      >
        <p className="narrative-body">{narrative}</p>
      </ExpandableCard>

      {/* Key metrics in a grid */}
      <CardGrid columns={3}>
        <ExpandableCard
          icon="📊"
          title="Impressions"
          hook={`${pulse.impressions.toLocaleString()} (${pulse.impressionsDelta > 0 ? '↑' : '↓'}${Math.abs(pulse.impressionsDelta)}%)`}
          insight="Impressions show search visibility. More impressions = more people see you in search."
        >
          <MetricChart data={pulse.impressionHistory} />
        </ExpandableCard>

        <ExpandableCard
          icon="👆"
          title="Clicks"
          hook={`${pulse.clicks.toLocaleString()} (${pulse.clicksDelta > 0 ? '↑' : '↓'}${Math.abs(pulse.clicksDelta)}%)`}
          insight="Clicks are visitors from search. This is the metric that matters most."
        >
          <MetricChart data={pulse.clickHistory} />
        </ExpandableCard>

        <ExpandableCard
          icon="📍"
          title="Average Position"
          hook={`#${pulse.position.toFixed(1)} (${pulse.positionDelta < 0 ? '↑ Improved' : '↓ Declined'})`}
          insight="Position shows your rank. Lower numbers are better—position 1 is the top spot."
        >
          <MetricChart data={pulse.positionHistory} />
        </ExpandableCard>
      </CardGrid>
    </section>
  )
}
```

---

### Explore View with Scatter Plot Visualization

```tsx
import { ExpandableCard } from '@clodo/design-system/components'
import { renderScatterPlot } from '@clodo/design-system/utils'

export function ExploreView({ keywordOpportunities }) {
  // Prepare scatter plot data
  const scatterData = {
    points: keywordOpportunities.map((kw) => ({
      query: kw.query,
      x: kw.impressions,
      y: kw.position,
      size: Math.min(15, Math.max(3, kw.impressions / 100)),
      trendColor: getQuadrantColor(kw.impressions, kw.position),
      ctrGap: (kw.maxCtr - kw.currentCtr) / kw.maxCtr
    })),
    bounds: {
      minX: 0,
      maxX: Math.max(...keywordOpportunities.map((k) => k.impressions)),
      minY: 0,
      maxY: 50
    }
  }

  const scatterSvg = renderScatterPlot(scatterData, {
    width: 700,
    height: 450,
    title: 'Keyword Opportunities by Quadrant'
  })

  return (
    <section>
      <ExpandableCard
        icon="🗺️"
        title="Opportunity Map"
        hook={`${keywordOpportunities.length} keywords analyzed across 4 opportunity zones`}
        insight="Use this map to prioritize your content strategy. Quick Wins have the highest ROI."
      >
        <div
          dangerouslySetInnerHTML={{ __html: scatterSvg }}
          className="chart-container"
        />

        {/* Legend */}
        <div className="opportunity-legend">
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#22c55e' }} />
            <span>Quick Wins: High visibility, low position</span>
          </div>
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#3b82f6' }} />
            <span>Harvest: High visibility, high position</span>
          </div>
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#f59e0b' }} />
            <span>Long Shots: Low visibility, low position</span>
          </div>
          <div className="legend-item">
            <span className="legend-color" style={{ backgroundColor: '#6b7280' }} />
            <span>Maintain: Low visibility, high position</span>
          </div>
        </div>
      </ExpandableCard>

      {/* Search Intent Distribution */}
      <ExpandableCard
        icon="🧭"
        title="Search Intent Distribution"
        hook={`Informational: ${intentData.informational} · Navigational: ${intentData.navigational} · Transactional: ${intentData.transactional}`}
        insight="Prioritize transactional searches—those searchers are ready to take action."
      >
        <IntentDistributionGrid data={intentData} />
      </ExpandableCard>

      {/* Device Breakdown */}
      <ExpandableCard
        icon="📱"
        title="Device Breakdown"
        hook={`Mobile: ${deviceData.mobile.clicks} visitors · Desktop: ${deviceData.desktop.clicks} visitors`}
        insight="Mobile users are impatient. If your mobile CTR is lower, improve your page speed and titles."
      >
        <DeviceBreakdownChart data={deviceData} />
      </ExpandableCard>
    </section>
  )
}
```

---

### Sparkline Trends View

```tsx
import { ExpandableCard } from '@clodo/design-system/components'
import { renderSparklines } from '@clodo/design-system/utils'

export function TrendsView({ topKeywords }) {
  const sparklineData = topKeywords.map((kw) => ({
    label: kw.query,
    values: kw.positionHistory, // Last 30 days
    currentPosition: kw.position,
    color: kw.position <= 3 ? '#10b981' : kw.position <= 10 ? '#3b82f6' : '#f59e0b',
    direction:
      kw.position < kw.prevPosition ? 'declining' : kw.position > kw.prevPosition ? 'improving' : 'stable'
  }))

  const sparklineSvg = renderSparklines(sparklineData, {
    width: 700,
    rowHeight: 40,
    maxRows: 15
  })

  return (
    <section>
      <ExpandableCard
        icon="📈"
        title="Position Trends (Last 30 Days)"
        hook={`${topKeywords.length} top keywords tracked`}
        insight="Watch for sustained trends. A keyword improving across multiple days shows progress."
        defaultOpen={true}
      >
        <div
          dangerouslySetInnerHTML={{ __html: sparklineSvg }}
          className="chart-container"
        />
      </ExpandableCard>
    </section>
  )
}
```

---

### Action View with Empty States

```tsx
import { EmptyStateCard, ExpandableCard, CardGrid } from '@clodo/design-system/components'

export function ActionView({ missions, analysis }) {
  // Handle empty state: no analysis yet
  if (!analysis.completed) {
    return (
      <section>
        <h2>Action Items</h2>
        <EmptyStateCard
          icon="🚀"
          heading="Ready to analyze your site?"
          body="We'll crawl your top pages, check for technical issues, and identify quick wins. Takes about 5 minutes."
          ctaText="Start Analysis →"
          onCTA={() => startAnalysis()}
          sectionTitle="Site Analysis"
          sectionIcon="🔍"
        />
      </section>
    )
  }

  // Show action missions
  return (
    <section>
      <h2>Your Weekly Missions</h2>
      <CardGrid columns={2}>
        {missions.map((mission) => (
          <ExpandableCard
            key={mission.id}
            icon={mission.icon}
            title={mission.title}
            hook={mission.description}
            insight={`Estimated impact: ${mission.impactEstimate}`}
            defaultOpen={!mission.completed}
          >
            <div className="mission-details">
              <p>{mission.detailedDescription}</p>
              <button
                className={mission.completed ? 'btn btn-success' : 'btn btn-primary'}
                onClick={() => toggleMission(mission.id)}
              >
                {mission.completed ? '✓ Completed' : 'Mark Complete'}
              </button>
            </div>
          </ExpandableCard>
        ))}
      </CardGrid>
    </section>
  )
}
```

---

### Data Delay Messaging Example

In your periodic data update handler:

```tsx
export async function renderDashboard(params) {
  const data = await fetchAnalyticsData(params)
  const engine = createNarrativeEngine()

  // Generate narrative taking analysis into account
  const narrative = engine.generate({
    pk: data.periodKPIs,
    diagnosis: data.analysis,
    timeContext: {
      label: data.periodLabel,
      startDate: data.periodStart,
      endDate: data.periodEnd,
      days: data.periodDays
    }
  })

  return (
    <div>
      {/* Trust signals */}
      <DashboardHeader
        data={data}
        onRefresh={async () => {
          // Call your refresh API
          await fetch('/api/analytics/refresh?siteId=' + params.siteId)
          // Revalidate/refresh the page
          window.location.reload()
        }}
      />

      {/* Data delay warning if applicable */}
      <DataDelayNote
        timeContext={{
          startDate: data.gscPeriodStart,
          endDate: data.gscPeriodEnd,
          days: data.gscPeriodDays
        }}
        gscEndDate={data.gscLastDate}
      />

      {/* Main content */}
      <PulseView pulse={data.pulse} narrative={narrative} />
      <ExploreView keywordOpportunities={data.opportunities} />
      <TrendsView topKeywords={data.topKeywords} />
      <ActionView missions={data.missions} analysis={data.analysis} />
    </div>
  )
}
```

---

## TypeScript Best Practices

All components are fully typed:

```tsx
import type {
  ExpandableCardProps,
  FreshnessIndicatorProps,
  EmptyStateCardProps
} from '@clodo/design-system/components'

import type {
  NarrativeContext,
  NarrativeTemplate,
  ScatterPlotData,
  Sparkline
} from '@clodo/design-system/utils'

// Your component is now type-safe
export const MyDashboard: React.FC<DashboardProps> = ({ data }) => {
  const contextData: NarrativeContext = {
    pk: data.kpis,
    diagnosis: data.diagnosis,
    timeContext: data.timeContext
  }

  const engine = createNarrativeEngine()
  const narrative = engine.generate(contextData)

  return (
    <ExpandableCard
      icon="📊"
      title="Analysis"
      hook={narrative.split('.')[0]}
    >
      {narrative}
    </ExpandableCard>
  )
}
```

---

## CSS Customization

Override design tokens:

```css
/* In your global CSS */
:root {
  /* Colors */
  --primary-color: #3b82f6;
  --primary-dark: #2563eb;
  --primary-light: #60a5fa;

  /* Backgrounds */
  --bg-primary: #ffffff;
  --bg-secondary: #f9fafb;
  --bg-tertiary: #f3f4f6;

  /* Text */
  --text-primary: #111827;
  --text-secondary: #6b7280;
  --text-tertiary: #9ca3af;

  /* Borders */
  --border-color: #e5e7eb;
  --border-hover: #d1d5db;

  /* Status colors */
  --success: #10b981;
  --warning: #f59e0b;
  --error: #ef4444;
  --info: #3b82f6;

  /* Info backgrounds */
  --info-bg: #eff6ff;
  --info-text: #1e40af;
  --warning-bg: #fef3c7;
  --warning-text: #92400e;
}
```

---

## Performance Tips

1. **Lazy load visualizations**: Render SVG charts only when user expands cards
2. **Memoize narratives**: Cache engine.generate() result if context doesn't change
3. **Stream templates**: Pre-register custom templates on app startup
4. **Paginate sparklines**: Limit maxRows to 15-20 for large datasets

---

## Troubleshooting

**Q: Chart looks cut off in email preview**
A: Email clients have viewport constraints. Use percentage-based SVG viewBox and responsive containers.

**Q: Narrative doesn't match what I see in data**
A: Check the match() conditions of your templates. Priority order matters (higher evaluated first). Add logging to debug.

**Q: FreshnessIndicator refresh icon not working**
A: Make sure your `onRefresh` callback is `async` and completes before returning.

---

## See Also

- [Architectural Patterns Guide](./ARCHITECTURAL_PATTERNS.md)
- [Component API Reference](./COMPONENT_API.md)
- [Narrative Template Reference](./NARRATIVE_REFERENCE.md)
