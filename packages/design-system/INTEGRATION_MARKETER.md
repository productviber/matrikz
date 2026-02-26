# Integration Guide: Marketer Worker

## Overview

The marketer worker creates public-facing reports, landing pages, and growth experiences. The enhanced design system provides:

- **Narrative Engine** for data-driven storytelling in reports
- **Trust Signals** to show data freshness and build credibility
- **Empty States** for signup and upgrade flows
- **Responsive Cards** for feature showcases and case studies

---

## Quick Start

### 1. Import Components & Utilities

```tsx
// In packages/marketer/src/components/Report.tsx
import {
  ExpandableCard,
  EmptyStateCard,
  FirstVisitBanner,
  CardGrid
} from '@clodo/design-system/components'

import {
  renderBarChart,
  renderDonutChart,
  createNarrativeEngine
} from '@clodo/design-system/utils'
```

### 2. Use in Your Templates

---

## Usage Patterns by Feature

### Public Report Header with Narrative

```tsx
import { createNarrativeEngine } from '@clodo/design-system/utils'
import { ExpandableCard, FreshnessIndicator } from '@clodo/design-system/components'

export function PublicReport({ site, reportData }) {
  const engine = createNarrativeEngine()

  // Generate the weekly story
  const narrative = engine.generate({
    pk: reportData.metrics,
    diagnosis: reportData.analysis,
    timeContext: {
      label: 'Last 7 days',
      days: 7,
      startDate: reportData.periodStart,
      endDate: reportData.periodEnd
    }
  })

  return (
    <article>
      {/* Site header */}
      <header className="report-header">
        <h1>{site.domain}</h1>
        <p className="report-subtitle">SEO Performance Report</p>
        <time className="report-date">Week of {reportData.periodLabel}</time>
      </header>

      {/* Data freshness (builds trust) */}
      <FreshnessIndicator
        timestamp={reportData.generatedAt}
        sourceCount={3}
      />

      {/* Main narrative (headline) */}
      <ExpandableCard
        icon="📰"
        title="Executive Summary"
        hook={narrative.split('.')[0]}
        defaultOpen={true}
        insight="Every week has a story. This is the week's SEO story for your site."
      >
        <div className="narrative-container">
          <p className="narrative-text">{narrative}</p>

          {/* CTA to full report */}
          <a href="#full-report" className="cta-btn">
            See Full Analysis →
          </a>
        </div>
      </ExpandableCard>
    </article>
  )
}
```

---

### Feature Showcase with Cards

```tsx
import { ExpandableCard, CardGrid, InsightCard } from '@clodo/design-system/components'

export function FeatureShowcase() {
  return (
    <section className="features">
      <h2>What We Analyze</h2>

      <CardGrid columns={3}>
        <InsightCard
          icon="📊"
          title="Keyword Ranking"
          summary="Track 1000+ keywords across search engines"
          insight="Know exactly where you rank for your most important searches."
        >
          <ul className="feature-list">
            <li>Google Search Console integration</li>
            <li>Bing Webmaster Tools sync</li>
            <li>Real-time position tracking</li>
            <li>Historical trend analysis</li>
          </ul>
        </InsightCard>

        <InsightCard
          icon="🎯"
          title="Search Intent"
          summary="Understand why people search for you"
          insight="People search with different goals. Matching intent drives conversions."
        >
          <ul className="feature-list">
            <li>Intent classification (informational, navigational, transactional)</li>
            <li>Content type recommendations</li>
            <li>Competitive analysis by intent</li>
          </ul>
        </InsightCard>

        <InsightCard
          icon="📱"
          title="Device Performance"
          summary="See how you perform across devices"
          insight="Mobile users have 1/10th the patience. Separate mobile strategy matters."
        >
          <ul className="feature-list">
            <li>Mobile vs. desktop breakdown</li>
            <li>Device-specific recommendations</li>
            <li>Mobile Core Web Vitals</li>
          </ul>
        </InsightCard>
      </CardGrid>
    </section>
  )
}
```

---

### New User Onboarding Flow

```tsx
import { FirstVisitBanner, EmptyStateCard } from '@clodo/design-system/components'

export function OnboardingFlow({ user, hasData }) {
  return (
    <div>
      {/* Respectful orientation banner */}
      <FirstVisitBanner
        visible={!user.hasSeenOnboarding}
        onDismiss={() => {
          user.markOnboardingComplete()
        }}
      />

      {hasData ? (
        <div>Your report is loading...</div>
      ) : (
        <div>
          {/* Step 1: Connect data source */}
          <EmptyStateCard
            icon="🔗"
            heading="Connect Your Data"
            body="We integrate with Google Search Console and Bing Webmaster Tools to pull your real search data. This takes 2 minutes and gives us complete visibility into your performance."
            ctaText="Connect GSC Now →"
            onCTA={() => startGSCAuth()}
            sectionTitle="Step 1: Data Connection"
          />

          {/* Step 2: First analysis */}
          <EmptyStateCard
            icon="🔍"
            heading="Run Your First Analysis"
            body="We'll crawl your site, check for technical issues, analyze your content quality, and identify your biggest opportunities. This happens in the background—no manual work needed."
            ctaText="Start Crawling →"
            onCTA={() => startFirstAnalysis()}
            sectionTitle="Step 2: Site Analysis"
          />

          {/* Step 3: View report */}
          <EmptyStateCard
            icon="📊"
            heading="View Your Report"
            body="Once analysis completes, you'll get a personalized report with insights, opportunities, and a clear roadmap for improving your SEO."
            ctaText="Check Report Status →"
            onCTA={() => viewReportStatus()}
            sectionTitle="Step 3: Your Report"
          />
        </div>
      )}
    </div>
  )
}
```

---

### Metrics Visualization with Charts

```tsx
import { ExpandableCard } from '@clodo/design-system/components'
import { renderBarChart, renderDonutChart } from '@clodo/design-system/utils'

export function MetricsVisualization({ reportData }) {
  // Device breakdown chart
  const deviceSvg = renderBarChart(
    {
      labels: ['Mobile', 'Desktop', 'Tablet'],
      datasets: [
        {
          label: 'Impressions',
          values: [
            reportData.mobile.impressions,
            reportData.desktop.impressions,
            reportData.tablet.impressions
          ],
          color: '#3b82f6'
        },
        {
          label: 'Clicks',
          values: [
            reportData.mobile.clicks,
            reportData.desktop.clicks,
            reportData.tablet.clicks
          ],
          color: '#10b981'
        }
      ]
    },
    {
      width: 500,
      height: 300,
      title: 'Traffic by Device'
    }
  )

  // Intent distribution chart
  const intentSvg = renderDonutChart(
    [
      {
        label: 'Informational',
        value: reportData.intent.informational,
        color: '#3b82f6'
      },
      {
        label: 'Navigational',
        value: reportData.intent.navigational,
        color: '#10b981'
      },
      {
        label: 'Transactional',
        value: reportData.intent.transactional,
        color: '#f59e0b'
      }
    ],
    {
      width: 300,
      height: 300,
      title: 'Search Intent Distribution'
    }
  )

  return (
    <section>
      <ExpandableCard
        icon="📱"
        title="Traffic by Device"
        hook={`Mobile: ${reportData.mobile.clicks} clicks · Desktop: ${reportData.desktop.clicks} clicks`}
        insight="Mobile traffic shows intent strength. High mobile clicks mean your content resonates."
      >
        <div
          dangerouslySetInnerHTML={{ __html: deviceSvg }}
          className="chart-container"
        />
      </ExpandableCard>

      <ExpandableCard
        icon="🧭"
        title="Search Intent Distribution"
        hook={`Transactional: ${reportData.intent.transactional} (highest value searches)`}
        insight="Transactional searches are buyer-ready. If you're invisible here, competitors win."
      >
        <div
          dangerouslySetInnerHTML={{ __html: intentSvg }}
          className="chart-container"
        />
      </ExpandableCard>
    </section>
  )
}
```

---

### Growth Opportunities Showcase

```tsx
import { ExpandableCard, EmptyStateCard, CardGrid } from '@clodo/design-system/components'

export function OpportunitiesSection({ analysis }) {
  if (!analysis.opportunities.length) {
    return (
      <EmptyStateCard
        icon="🔔"
        heading="No major opportunities found yet"
        body="Either your site is already optimized, or we need more data to find keyword gaps. Come back after your next analysis run."
        ctaText="View Full Analysis →"
        onCTA={() => goToFullAnalysis()}
        sectionTitle="Opportunities"
      />
    )
  }

  return (
    <section>
      <h2>Growth Opportunities</h2>
      <CardGrid columns={1}>
        {analysis.opportunities.slice(0, 5).map((opp) => (
          <ExpandableCard
            key={opp.id}
            icon={getOpportunityIcon(opp.type)}
            title={opp.title}
            hook={opp.headline}
            insight={`Estimated impact: +${opp.estimatedVisitors} visitors/month`}
          >
            <div className="opportunity-details">
              <p>{opp.description}</p>

              <div className="opportunity-metrics">
                <div className="metric">
                  <span className="metric-label">Current ROI Cost</span>
                  <span className="metric-value">${opp.estimatedCost}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Time to Implementation</span>
                  <span className="metric-value">{opp.timeToImplement}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Difficulty</span>
                  <span className="metric-value">{opp.difficulty}/10</span>
                </div>
              </div>

              <button className="cta-btn" onClick={() => viewOpportunityDetail(opp.id)}>
                View Details & Action Plan →
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

### Case Study with Narrative

```tsx
import { ExpandableCard, CardGrid } from '@clodo/design-system/components'

export function CaseStudy({ caseStudy }) {
  return (
    <section className="case-study">
      <header>
        <h2>{caseStudy.title}</h2>
        <p className="case-study-subtitle">
          {caseStudy.industry} — {caseStudy.siteType}
        </p>
      </header>

      {/* Before/After Summary */}
      <CardGrid columns={2}>
        <ExpandableCard
          icon="📊"
          title="Before Using Our Tool"
          hook={`${caseStudy.before.impressions.toLocaleString()} impressions/month`}
        >
          <div className="before-stats">
            <p>
              <strong>Impressions:</strong> {caseStudy.before.impressions.toLocaleString()}
            </p>
            <p>
              <strong>Clicks:</strong> {caseStudy.before.clicks.toLocaleString()}
            </p>
            <p>
              <strong>CTR:</strong> {(caseStudy.before.ctr * 100).toFixed(2)}%
            </p>
            <p>
              <strong>Avg Position:</strong> #{caseStudy.before.position.toFixed(1)}
            </p>
          </div>
        </ExpandableCard>

        <ExpandableCard
          icon="🚀"
          title="After 3 Months"
          hook={`${caseStudy.after.impressions.toLocaleString()} impressions/month`}
          insight={`${((caseStudy.after.impressions / caseStudy.before.impressions - 1) * 100).toFixed(0)}% growth in impressions`}
        >
          <div className="after-stats">
            <p>
              <strong>Impressions:</strong> {caseStudy.after.impressions.toLocaleString()} (
              {getGrowthBadge(caseStudy.after.impressions, caseStudy.before.impressions)})
            </p>
            <p>
              <strong>Clicks:</strong> {caseStudy.after.clicks.toLocaleString()} (
              {getGrowthBadge(caseStudy.after.clicks, caseStudy.before.clicks)})
            </p>
            <p>
              <strong>CTR:</strong> {(caseStudy.after.ctr * 100).toFixed(2)}% (
              {getGrowthBadge(caseStudy.after.ctr, caseStudy.before.ctr)})
            </p>
            <p>
              <strong>Avg Position:</strong> #{caseStudy.after.position.toFixed(1)} (
              {getGrowthBadge(caseStudy.before.position, caseStudy.after.position)})
            </p>
          </div>
        </ExpandableCard>
      </CardGrid>

      {/* Journey narrative */}
      <ExpandableCard
        icon="📖"
        title="Their SEO Journey"
        hook="How they found 300+ keyword opportunities and 15% more traffic"
        defaultOpen={true}
      >
        <p>{caseStudy.narrative}</p>
      </ExpandableCard>
    </section>
  )
}
```

---

### Email Report Template

```tsx
// When rendering for email, use renderToStaticMarkup
import { renderToStaticMarkup } from 'react-dom/server'

export async function sendEmailReport(email: string, reportData: any) {
  // Generate narrative
  const engine = createNarrativeEngine()
  const narrative = engine.generate(reportData.context)

  // Render components to HTML
  const emailHTML = renderToStaticMarkup(
    <EmailReportTemplate narrative={narrative} data={reportData} />
  )

  // Send via email service
  await emailService.send({
    to: email,
    subject: `Your Weekly SEO Report for ${reportData.domain}`,
    html: emailHTML
  })
}

function EmailReportTemplate({ narrative, data }) {
  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '600px' }}>
      <h2>{data.domain}</h2>
      <p style={{ fontSize: '14px', color: '#666' }}>Week of {data.periodLabel}</p>

      {/* Narrative as main message */}
      <div style={{ backgroundColor: '#f0f4f8', padding: '20px', borderRadius: '8px', margin: '20px 0' }}>
        <p style={{ margin: 0 }}>{narrative}</p>
      </div>

      {/* SVG charts (work in email) */}
      <div
        dangerouslySetInnerHTML={{
          __html: renderScatterPlot(data.scatter, { width: 500, height: 300 })
        }}
        style={{ margin: '20px 0' }}
      />

      {/* Metrics table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', margin: '20px 0' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
            <th style={{ textAlign: 'left', padding: '10px' }}>Metric</th>
            <th style={{ textAlign: 'right', padding: '10px' }}>This Week</th>
            <th style={{ textAlign: 'right', padding: '10px' }}>Last Week</th>
            <th style={{ textAlign: 'right', padding: '10px' }}>Change</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
            <td style={{ padding: '10px' }}>Impressions</td>
            <td style={{ textAlign: 'right', padding: '10px' }}>{data.metrics.impressions.toLocaleString()}</td>
            <td style={{ textAlign: 'right', padding: '10px' }}>{data.metrics.impressionsPrev.toLocaleString()}</td>
            <td style={{ textAlign: 'right', padding: '10px', color: data.metrics.impressionsDelta > 0 ? '#10b981' : '#ef4444' }}>
              {data.metrics.impressionsDelta > 0 ? '↑' : '↓'} {Math.abs(data.metrics.impressionsDelta)}%
            </td>
          </tr>
          {/* More rows... */}
        </tbody>
      </table>

      {/* CTA */}
      <div style={{ textAlign: 'center', margin: '30px 0' }}>
        <a
          href={data.reportUrl}
          style={{
            display: 'inline-block',
            backgroundColor: '#3b82f6',
            color: 'white',
            padding: '12px 24px',
            borderRadius: '6px',
            textDecoration: 'none',
            fontWeight: 'bold'
          }}
        >
          View Full Report →
        </a>
      </div>
    </div>
  )
}
```

---

## TypeScript Examples

```tsx
import type { NarrativeContext } from '@clodo/design-system/utils'
import type { ExpandableCardProps } from '@clodo/design-system/components'

// Type-safe report generation
export async function generateReport(siteId: string): Promise<string> {
  const data = await fetchReportData(siteId)

  const context: NarrativeContext = {
    pk: data.metrics,
    diagnosis: data.analysis,
    timeContext: data.timeContext,
    sessionState: data.userSession
  }

  const engine = createNarrativeEngine()
  return engine.generate(context)
}

// Type-safe card props
const cardProps: ExpandableCardProps = {
  icon: '📊',
  title: 'Report Title',
  hook: 'Summary text',
  children: <div>Content</div>,
  insight: 'Why this matters'
}
```

---

## Performance Tips

1. **Server-side rendering**: Render components via `renderToStaticMarkup` for emails
2. **SVG optimization**: Charts are pure strings—cache them if data hasn't changed
3. **Narrative caching**: Store generated narratives with a hash of input data
4. **Lazy loading cards**: Use `defaultOpen={false}` for expanded sections

---

## Troubleshooting

**Q: Narrative seems generic/doesn't fit my case study**
A: Create custom templates specific to your use case. Use higher priority (100+) to make them evaluate first.

**Q: Email shows broken charts**
A: Email clients don't support all SVG features. Keep SVG simple, use viewBox for responsiveness, avoid nested <g> elements in some clients.

**Q: FirstVisitBanner shows on every page load**
A: Store visibility state in localStorage or user preferences, not just React state.

---

## See Also

- [Architectural Patterns Guide](./ARCHITECTURAL_PATTERNS.md)
- [Component API Reference](./COMPONENT_API.md)
- [Narrative Template Reference](./NARRATIVE_REFERENCE.md)
- [Analytics Integration Guide](./INTEGRATION_ANALYTICS.md)
