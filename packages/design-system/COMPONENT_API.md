# Component API Reference

## Trust Signals Components

### FreshnessIndicator

Renders data freshness status with optional refresh capability and staleness warning.

```tsx
import { FreshnessIndicator } from '@clodo/design-system/components'

<FreshnessIndicator
  timestamp="2026-02-19T14:30:00Z"
  dataLagDays={2}
  sourceCount={3}
  onRefresh={async () => {
    await fetch('/api/refresh-data')
  }}
/>
```

**Props:**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `timestamp` | `string \| null \| undefined` | — | ISO timestamp of last data extraction |
| `dataLagDays` | `number \| null \| undefined` | — | Days between last data point and now |
| `sourceCount` | `number` | — | Number of connected data sources |
| `onRefresh` | `() => void \| Promise<void>` | — | Callback when refresh is triggered |

**States:**
- Normal: "Updated 2 hours ago [↻]"
- Stale (>48h): "Updated 3 days ago [↻] ⚠"
- Refreshing: "Updating... ⟳"

---

### DataDelayNote

Renders contextual messaging for delayed data (e.g., GSC 2-3 day delay).

```tsx
import { DataDelayNote } from '@clodo/design-system/components'

<DataDelayNote
  timeContext={{
    startDate: '2026-02-06',
    endDate: '2026-02-13',
    days: 7
  }}
  gscEndDate="2026-02-10"
/>
```

**Props:**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `timeContext` | `{ startDate?, endDate?, days? }` | — | Time period context |
| `gscEndDate` | `string \| null` | — | Last GSC data point (YYYY-MM-DD) |

**Behavior:**
- Only renders if period end is within 3 days of now
- Shows specific date range for incomplete data
- Returns `null` if no delay applies

---

### FirstVisitBanner

Respectful, single-sentence orientation for new users.

```tsx
import { FirstVisitBanner } from '@clodo/design-system/components'

<FirstVisitBanner
  visible={!user.hasSeenBanner}
  onDismiss={() => {
    user.markBannerSeen()
  }}
/>
```

**Props:**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `visible` | `boolean` | `false` | Whether banner is shown |
| `onDismiss` | `() => void` | — | Callback when user dismisses |

**Features:**
- Single-sentence orientation (not a tour)
- Respects user intelligence
- Can be dismissed by clicking "Got it"
- Slides in with animation

---

## Enhanced Card Components

### ExpandableCard

Progressive disclosure card with hook text, body, and insight section.

```tsx
import { ExpandableCard } from '@clodo/design-system/components'

<ExpandableCard
  icon="📊"
  title="Search Intent Distribution"
  hook="45 informational (60%), 20 navigational (27%), 8 transactional (11%)"
  defaultOpen={false}
  insight="Transactional searches are buyer-ready. Prioritize these in your content."
  insightIcon="💡"
>
  <IntentBreakdownGrid data={intentData} />
</ExpandableCard>
```

**Props:**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `icon` | `string` | `'📊'` | Emoji or icon shown left of title |
| `title` | `string` | — | Main card title |
| `hook` | `string` | — | Summary text shown when collapsed |
| `children` | `ReactNode` | — | Card body content (shown when expanded) |
| `insight` | `string` | — | "So what?" insight text |
| `insightIcon` | `string` | `'💡'` | Insight section icon |
| `defaultOpen` | `boolean` | `false` | Whether card starts expanded |
| `className` | `string` | — | Additional CSS classes |

**Markup Structure:**
```
<details class="expandableCard">
  <summary class="cardSummary">
    [icon] [title] [hook] [chevron]
  </summary>
  <div class="cardBody">
    [children]
    <div class="soWhatBox">
      [insight]
    </div>
  </div>
</details>
```

---

### EmptyStateCard

Focused empty state with icon, heading, body, and actionable CTA.

```tsx
import { EmptyStateCard } from '@clodo/design-system/components'

<EmptyStateCard
  icon="🧭"
  heading="Search intent analysis for every keyword"
  body="People search with different goals — some want to buy, others want to learn, others want your location. Understanding this drives your content strategy."
  ctaText="Run first analysis →"
  onCTA={() => triggerAnalysis()}
  sectionTitle="Search Intent Distribution"
  sectionIcon="🧭"
/>
```

**Props:**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `icon` | `string` | — | Large emoji (3rem) |
| `heading` | `string` | — | What's missing (what) |
| `body` | `string` | — | Why it matters (why) |
| `ctaText` | `string` | — | Button label (how) |
| `onCTA` | `() => void` | — | Button click handler |
| `sectionTitle` | `string` | — | Title in collapsed state |
| `sectionIcon` | `string` | — | Icon in collapsed state |

**Behavior:**
- Wraps content in ExpandableCard with default open state
- Displays empty state icon centered above heading
- Shows contextual "Setup required" hook in collapsed state

---

### InsightCard

Convenience wrapper for ExpandableCard with emphasis on summary text.

```tsx
import { InsightCard } from '@clodo/design-system/components'

<InsightCard
  icon="💡"
  title="Quick Wins"
  summary="12 keywords ready to rank higher"
  insight="These are lowest-effort opportunities with high ROI."
  insightIcon="✨"
>
  <QuickWinsTable data={quickWins} />
</InsightCard>
```

**Props:** (Same as ExpandableCard but `hook` → `summary`)

---

### CardGrid

Responsive grid layout for multiple cards.

```tsx
import { CardGrid } from '@clodo/design-system/components'

<CardGrid columns={2}>
  <ExpandableCard {...props1} />
  <ExpandableCard {...props2} />
  <ExpandableCard {...props3} />
</CardGrid>
```

**Props:**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | — | Card components to grid |
| `columns` | `1 \| 2 \| 3` | `1` | Number of columns on desktop |

**Responsive:**
- Mobile: 1 column
- Tablet (640px+): auto-fit with 300px minimum
- Desktop (1024px+): Respects `columns` prop

---

## Chart Utilities

### renderScatterPlot

Generate SVG scatter plot with quadrant analysis for keyword opportunities.

```tsx
import { renderScatterPlot } from '@clodo/design-system/utils'

const svg = renderScatterPlot(
  {
    points: [
      { query: 'keyword', x: 100, y: 5, ctrGap: 0.15, trendColor: '#22c55e' },
      { query: 'another keyword', x: 250, y: 12, ctrGap: 0.25, trendColor: '#f59e0b' }
    ],
    bounds: { minX: 0, maxX: 500, minY: 0, maxY: 50 }
  },
  { width: 600, height: 400, title: 'Keyword Opportunities' }
)

// Returns SVG string, safe to use with dangerouslySetInnerHTML
```

**Data Structure:**
```ts
interface ScatterPoint {
  query: string          // Keyword query
  x: number            // X-axis (impressions)
  y: number            // Y-axis (position, inverted)
  size?: number        // Circle radius (3-15)
  color?: string       // Circle color hex
  quadrantColor?: string
  trendColor?: string
  ctrGap?: number      // CTR opportunity 0-1
}

interface ScatterPlotData {
  points: ScatterPoint[]
  bounds: { minX, maxX, minY, maxY }
  quadrants?: Record<string, any>
}
```

**Quadrants:**
- **Quick Wins** (green): High impressions, low position
- **Harvest** (blue): High impressions, high position
- **Long Shots** (yellow): Low impressions, low position
- **Maintain** (gray): Low impressions, high position

---

### renderSparklines

Generate SVG sparklines for keyword position trends.

```tsx
import { renderSparklines } from '@clodo/design-system/utils'

const svg = renderSparklines(
  [
    {
      label: 'target keyword',
      values: [15, 14, 12, 10, 11, 9, 8],  // Last 7 positions
      currentPosition: 8,
      color: '#ef4444',
      direction: 'declining'
    },
    {
      label: 'secondary keyword',
      values: [20, 19, 18, 17, 16, 15, 14],
      currentPosition: 14,
      color: '#3b82f6',
      direction: 'declining'
    }
  ],
  { width: 500, rowHeight: 32, maxRows: 15 }
)
```

**Data Structure:**
```ts
interface Sparkline {
  label: string                                        // Keyword label
  values: number[]                                   // Position values over time
  currentPosition?: number                           // Latest position
  color?: string                                     // Line color hex
  direction?: 'improving' | 'declining' | 'stable' | 'slightly_improving' | 'slightly_declining'
}
```

---

### renderBarChart

Generate SVG bar chart for comparing values across categories.

```tsx
import { renderBarChart } from '@clodo/design-system/utils'

const svg = renderBarChart(
  {
    labels: ['Mobile', 'Desktop', 'Tablet'],
    datasets: [
      { label: 'Impressions', values: [1200, 1900, 400], color: '#3b82f6' },
      { label: 'Clicks', values: [90, 150, 30], color: '#10b981' }
    ]
  },
  { width: 600, height: 300, title: 'Traffic by Device' }
)
```

**Data Structure:**
```ts
interface BarChartData {
  labels: string[]
  datasets: {
    label: string
    values: number[]
    color?: string  // Hex color
  }[]
}
```

---

### renderDonutChart

Generate SVG donut chart for showing distributions.

```tsx
import { renderDonutChart } from '@clodo/design-system/utils'

const svg = renderDonutChart(
  [
    { label: 'Informational', value: 45, color: '#3b82f6' },
    { label: 'Navigational', value: 20, color: '#10b981' },
    { label: 'Transactional', value: 8, color: '#f59e0b' }
  ],
  { width: 300, height: 300, title: 'Search Intent Distribution' }
)
```

**Data Structure:**
```ts
interface DonutData {
  label: string
  value: number
  color?: string  // Hex color (uses palette if not provided)
}[]
```

---

## Narrative Engine

### NarrativeEngine

Template-based narrative generation system.

```tsx
import { createNarrativeEngine, NarrativeContext } from '@clodo/design-system/utils'

const engine = createNarrativeEngine()

const narrative = engine.generate({
  pk: {
    clicks: 150,
    impressions: 2000,
    ctr: 0.075,
    clicksDelta: 25,
    impressionsDelta: 15,
    positionDelta: -1.5
  },
  diagnosis: {
    signals: {
      topKeywordSlide: {
        keyword: 'target keyword',
        prevPosition: 8,
        curPosition: 5
      }
    }
  },
  timeContext: { label: 'This week', days: 7 }
})
```

**Methods:**

#### `generate(context: NarrativeContext): string`
Generate narrative for given context. Evaluates templates in priority order.

#### `register(template: NarrativeTemplate): void`
Register a single custom template.

#### `registerMultiple(templates: NarrativeTemplate[]): void`
Register multiple templates at once.

#### `getTemplates(): NarrativeTemplate[]`
Get all registered templates.

#### `reset(): void`
Clear all templates.

---

### createNarrativeEngine

Factory function that creates a pre-configured engine with built-in templates.

```tsx
import { createNarrativeEngine, BUILT_IN_TEMPLATES } from '@clodo/design-system/utils'

// Create with built-in templates
const engine = createNarrativeEngine()

// Create with built-in + custom templates
const customTemplates = [
  {
    id: 'my-pattern',
    priority: 75,
    match: (ctx) => ctx.pk?.customMetric > 100,
    render: (ctx) => 'Your narrative here...'
  }
]

const engine = createNarrativeEngine(customTemplates)
```

---

### BUILT_IN_TEMPLATES

Pre-configured narrative templates from visibility-analytics patterns:

1. **indexing-impression-drop** (priority: 100)
   - Detects: Impression drop + position improvement + indexing issue
   - Narrative: Explains indexing as root cause, not ranking weakness

2. **ctr-opportunity-page1** (priority: 90)
   - Detects: 10+ page 1 keywords with >50% zero clicks
   - Narrative: Opportunity to improve CTR with title/description changes

3. **broad-improvement** (priority: 80)
   - Detects: Impressions >10%, clicks >5%, position improved
   - Narrative: Celebrates growth and identifies top driver

4. **stable-untapped** (priority: 50)
   - Detects: Stable metrics but >100 potential visitors available
   - Narrative: Identifies near-miss keywords as easy wins

5. **single-keyword-loss** (priority: 85)
   - Detects: Top keyword dropped from page 1 to page 2+
   - Narrative: Calls for immediate page audit

---

## Type Definitions

### FreshnessIndicatorProps
```ts
interface FreshnessIndicatorProps {
  timestamp?: string | null
  dataLagDays?: number | null
  sourceCount?: number
  onRefresh?: () => void | Promise<void>
}
```

### EmptyStateCardProps
```ts
interface EmptyStateCardProps {
  icon: string
  heading: string
  body: string
  ctaText: string
  onCTA: () => void
  sectionTitle?: string
  sectionIcon?: string
}
```

### NarrativeContext
```ts
interface NarrativeContext {
  pk?: {
    clicks?: number
    impressions?: number
    ctr?: number
    position?: number
    potential?: number
    clicksDelta?: number
    impressionsDelta?: number
    positionDelta?: number
    ctrDelta?: number
    page1ZeroClickCount?: number
    page1Keywords?: number
    nearMissCount?: number
    topKeywordSlide?: any
  }
  diagnosis?: {
    templateId?: string
    causeLabel?: string
    signals?: {
      unindexedPageCount?: number
      topKeywordSlide?: { keyword: string; prevPosition: number; curPosition: number }
    }
    primaryActionId?: string
  }
  timeContext?: { label?: string; startDate?: string; endDate?: string; days?: number }
  sessionState?: { isReturning?: boolean; visitsCount?: number }
}
```

---

## Styling & CSS Modules

All components use CSS Modules for style isolation:

- `TrustSignals.module.css` — Trust signal components
- `EnhancedCard.module.css` — Card components
- Component-specific styles are colocated with components

Override styles by:
1. **CSS Custom Properties** (preferred)
2. **Importing and overriding specific classes**
3. **Wrapping components with styled containers**

Example:
```css
:root {
  --primary-color: #3b82f6;
  --border-color: #e5e7eb;
  --text-primary: #111827;
  --text-secondary: #6b7280;
}
```
