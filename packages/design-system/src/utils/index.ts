/**
 * Design System Utilities
 * 
 * Exported utilities and chart rendering functions
 */

// SVG Charts
export {
  renderScatterPlot,
  renderSparklines,
  renderBarChart,
  renderDonutChart
} from './svgCharts'
export type { ScatterPoint, ScatterPlotData, Sparkline, BarChartData } from './svgCharts'

// Narrative Engine
export { NarrativeEngine, createNarrativeEngine, BUILT_IN_TEMPLATES } from './narrativeEngine'
export type { NarrativeContext, NarrativeTemplate } from './narrativeEngine'
