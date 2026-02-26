/**
 * SVG Chart Utilities
 * 
 * Pure server-side SVG generation for charts and visualizations.
 * No external dependencies. Works in email clients and web browsers.
 * 
 * Patterns:
 * - Scatter plots with quadrant analysis
 * - Sparklines for trend visualization
 * - Bar charts for comparisons
 * - Donut charts for distributions
 */

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface ScatterPoint {
  query: string;
  x: number; // X-axis value (impressions)
  y: number; // Y-axis value (position, inverted)
  size?: number;
  color?: string;
  quadrantColor?: string;
  trendColor?: string;
  ctrGap?: number;
}

export interface ScatterPlotData {
  points: ScatterPoint[];
  bounds?: {
    minX?: number;
    maxX?: number;
    minY?: number;
    maxY?: number;
  };
  quadrants?: Record<string, any>;
}

export interface Sparkline {
  label: string;
  values: number[];
  currentPosition?: number;
  color?: string;
  direction?: 'improving' | 'declining' | 'stable' | 'slightly_improving' | 'slightly_declining';
}

export interface BarChartData {
  labels: string[];
  datasets: {
    label: string;
    values: number[];
    color?: string;
  }[];
}

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const DEFAULT_PALETTE = {
  bg: '#ffffff',
  grid: '#e5e7eb',
  text: '#374151',
  textLight: '#6b7280',
  axis: '#9ca3af',
  accent: '#3b82f6'
};

// ═══════════════════════════════════════════════════════════════
// HELPERS — HTML Escaping
// ═══════════════════════════════════════════════════════════════

function esc(str: any): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str: string, maxLen = 30): string {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen - 1) + '…';
}

// ═══════════════════════════════════════════════════════════════
// HELPERS — Coordinate Transforms
// ═══════════════════════════════════════════════════════════════

function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  if (inMax === inMin) return (outMin + outMax) / 2;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

// ═══════════════════════════════════════════════════════════════
// SCATTER PLOT
// ═══════════════════════════════════════════════════════════════

/**
 * Generate an SVG scatter plot of keyword opportunities.
 * X = impressions, Y = position (inverted: position 1 at top).
 * Quadrants: Quick Wins (high impr, low pos), Harvest (high both),
 * Long Shots (low impr, low pos), Maintain (low both)
 */
export function renderScatterPlot(
  data: ScatterPlotData,
  options: { width?: number; height?: number; title?: string } = {}
): string {
  const { width = 600, height = 400, title = 'Keyword Opportunity Map' } = options;
  const { points = [], bounds = {} } = data;

  const margin = { top: 40, right: 20, bottom: 50, left: 60 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const { minX = 0, maxX = 100, minY = 0, maxY = 50 } = bounds;

  // Position is inverted (lower = better = higher on chart)
  const toX = (v: number) => margin.left + mapRange(v, minX, maxX, 0, plotW);
  const toY = (v: number) => margin.top + mapRange(v, minY, maxY, plotH, 0); // Inverted

  const midX = toX(maxX / 2);
  const positionLine = toY(10); // Position 10 divider

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${DEFAULT_PALETTE.bg}">`;

  // Title
  svg += `<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="600" fill="${DEFAULT_PALETTE.text}">${esc(title)}</text>`;

  // Quadrant backgrounds
  svg += `<rect x="${margin.left}" y="${margin.top}" width="${midX - margin.left}" height="${positionLine - margin.top}" fill="#f0fdf4" opacity="0.5"/>`;
  svg += `<rect x="${midX}" y="${margin.top}" width="${width - margin.right - midX}" height="${positionLine - margin.top}" fill="#eff6ff" opacity="0.5"/>`;
  svg += `<rect x="${margin.left}" y="${positionLine}" width="${midX - margin.left}" height="${margin.top + plotH - positionLine}" fill="#fef3c7" opacity="0.3"/>`;
  svg += `<rect x="${midX}" y="${positionLine}" width="${width - margin.right - midX}" height="${margin.top + plotH - positionLine}" fill="#f9fafb" opacity="0.3"/>`;

  // Quadrant labels
  const labelSize = 10;
  svg += `<text x="${margin.left + 5}" y="${margin.top + 15}" font-size="${labelSize}" fill="#22c55e" opacity="0.7">Quick Wins</text>`;
  svg += `<text x="${midX + 5}" y="${margin.top + 15}" font-size="${labelSize}" fill="#3b82f6" opacity="0.7">Harvest</text>`;
  svg += `<text x="${margin.left + 5}" y="${positionLine + 15}" font-size="${labelSize}" fill="#f59e0b" opacity="0.7">Long Shots</text>`;
  svg += `<text x="${midX + 5}" y="${positionLine + 15}" font-size="${labelSize}" fill="#6b7280" opacity="0.7">Maintain</text>`;

  // Grid lines
  const xTicks = 5;
  const yTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const xVal = minX + (maxX - minX) * (i / xTicks);
    const x = toX(xVal);
    svg += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotH}" stroke="${DEFAULT_PALETTE.grid}" stroke-width="0.5"/>`;
    svg += `<text x="${x}" y="${height - 10}" text-anchor="middle" font-size="9" fill="${DEFAULT_PALETTE.textLight}">${Math.round(xVal)}</text>`;
  }
  for (let i = 0; i <= yTicks; i++) {
    const yVal = minY + (maxY - minY) * (i / yTicks);
    const y = toY(yVal);
    svg += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" stroke="${DEFAULT_PALETTE.grid}" stroke-width="0.5"/>`;
    svg += `<text x="${margin.left - 5}" y="${y + 3}" text-anchor="end" font-size="9" fill="${DEFAULT_PALETTE.textLight}">${Math.round(yVal)}</text>`;
  }

  // Axis labels
  svg += `<text x="${width / 2}" y="${height - 2}" text-anchor="middle" font-size="10" fill="${DEFAULT_PALETTE.text}">Impressions</text>`;
  svg += `<text x="12" y="${height / 2}" text-anchor="middle" font-size="10" fill="${DEFAULT_PALETTE.text}" transform="rotate(-90, 12, ${height / 2})">Position (lower = better)</text>`;

  // Plot border
  svg += `<rect x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="none" stroke="${DEFAULT_PALETTE.axis}" stroke-width="1"/>`;

  // Data points
  for (const point of points) {
    const cx = toX(point.x);
    const cy = toY(point.y);
    const r = Math.max(3, Math.min(15, point.size || 5));

    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${point.trendColor || point.quadrantColor || DEFAULT_PALETTE.accent}" opacity="0.7" stroke="${DEFAULT_PALETTE.bg}" stroke-width="1">`;
    svg += `<title>${esc(point.query)}\nPos: ${point.y.toFixed(1)} | Imp: ${point.x} | CTR gap: ${((point.ctrGap || 0) * 100).toFixed(1)}%</title>`;
    svg += `</circle>`;
  }

  svg += `</svg>`;
  return svg;
}

// ═══════════════════════════════════════════════════════════════
// SPARKLINES
// ═══════════════════════════════════════════════════════════════

/**
 * Generate SVG sparklines for trend visualization.
 * Returns a vertical stack of labeled sparklines with current values.
 */
export function renderSparklines(
  sparklines: Sparkline[],
  options: { width?: number; rowHeight?: number; maxRows?: number } = {}
): string {
  const { width = 500, rowHeight = 32, maxRows = 15 } = options;
  const displayLines = sparklines.slice(0, maxRows);
  const height = 40 + displayLines.length * rowHeight;
  const sparkWidth = 120;
  const sparkX = width - sparkWidth - 100;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${DEFAULT_PALETTE.bg}">`;

  svg += `<text x="10" y="20" font-size="13" font-weight="600" fill="${DEFAULT_PALETTE.text}">Position Trends</text>`;

  for (let i = 0; i < displayLines.length; i++) {
    const line = displayLines[i];
    const y = 35 + i * rowHeight;

    // Background stripe
    if (i % 2 === 0) {
      svg += `<rect x="0" y="${y}" width="${width}" height="${rowHeight}" fill="#f9fafb"/>`;
    }

    // Query label
    svg += `<text x="10" y="${y + rowHeight / 2 + 4}" font-size="10" fill="${DEFAULT_PALETTE.text}">${esc(truncate(line.label, 35))}</text>`;

    // Current value
    svg += `<text x="${sparkX - 40}" y="${y + rowHeight / 2 + 4}" font-size="10" text-anchor="end" fill="${DEFAULT_PALETTE.textLight}">${line.currentPosition?.toFixed(1) || '–'}</text>`;

    // Sparkline
    if (line.values && line.values.length > 1) {
      svg += _renderMiniSparkline(line.values, sparkX, y + 4, sparkWidth, rowHeight - 8, line.color);
    }

    // Direction indicator
    const dirX = sparkX + sparkWidth + 10;
    svg += `<text x="${dirX}" y="${y + rowHeight / 2 + 4}" font-size="10" fill="${line.color || DEFAULT_PALETTE.accent}">${_getDirectionArrow(line.direction)}</text>`;
  }

  svg += `</svg>`;
  return svg;
}

function _renderMiniSparkline(
  values: number[],
  x: number,
  y: number,
  w: number,
  h: number,
  color = DEFAULT_PALETTE.accent
): string {
  if (!values.length) return '';

  const min = Math.min(...values);
  const max = Math.max(...values);

  const points = values
    .map((v, i) => {
      const px = x + (i / (values.length - 1)) * w;
      const py = y + mapRange(v, min, max, h, 0); // Inverted for position
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');

  return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
}

function _getDirectionArrow(direction?: string): string {
  if (direction === 'improving' || direction === 'slightly_improving') return '↑';
  if (direction === 'declining' || direction === 'slightly_declining') return '↓';
  return '→';
}

// ═══════════════════════════════════════════════════════════════
// BAR CHART
// ═══════════════════════════════════════════════════════════════

/**
 * Generate an SVG bar chart for comparing values across categories.
 */
export function renderBarChart(
  data: BarChartData,
  options: { width?: number; height?: number; title?: string } = {}
): string {
  const { width = 600, height = 300, title } = options;
  const { labels = [], datasets = [] } = data;

  if (!labels.length || !datasets.length) return '';

  const margin = { top: title ? 40 : 20, right: 20, bottom: 60, left: 50 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const barGroupWidth = plotW / labels.length;
  const barsPerGroup = datasets.length;
  const barWidth = (barGroupWidth * 0.8) / Math.max(1, barsPerGroup);
  const maxValue = Math.max(
    ...datasets.flatMap((ds) => ds.values).filter((v) => typeof v === 'number')
  );

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${DEFAULT_PALETTE.bg}">`;

  if (title) {
    svg += `<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="600" fill="${DEFAULT_PALETTE.text}">${esc(title)}</text>`;
  }

  // Y-axis grid lines
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const yVal = (maxValue / yTicks) * i;
    const y = margin.top + plotH - (i / yTicks) * plotH;
    svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${DEFAULT_PALETTE.grid}" stroke-width="0.5"/>`;
    svg += `<text x="${margin.left - 5}" y="${y + 3}" text-anchor="end" font-size="9" fill="${DEFAULT_PALETTE.textLight}">${Math.round(yVal)}</text>`;
  }

  // Bars
  datasets.forEach((dataset, datasetIdx) => {
    dataset.values.forEach((value, labelIdx) => {
      const x = margin.left + barGroupWidth * labelIdx + (barWidth * datasetIdx + (barGroupWidth - barWidth * barsPerGroup) / 2);
      const barHeight = (value / maxValue) * plotH;
      const y = margin.top + plotH - barHeight;

      svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${dataset.color || DEFAULT_PALETTE.accent}" opacity="0.8"/>`;
    });
  });

  // X-axis labels
  labels.forEach((label, i) => {
    const x = margin.left + barGroupWidth * i + barGroupWidth / 2;
    svg += `<text x="${x}" y="${height - 10}" text-anchor="middle" font-size="9" fill="${DEFAULT_PALETTE.text}">${esc(label)}</text>`;
  });

  // Axis lines
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="${DEFAULT_PALETTE.axis}" stroke-width="1"/>`;
  svg += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="${DEFAULT_PALETTE.axis}" stroke-width="1"/>`;

  svg += `</svg>`;
  return svg;
}

// ═══════════════════════════════════════════════════════════════
// DONUT CHART
// ═══════════════════════════════════════════════════════════════

/**
 * Generate an SVG donut chart for showing distributions.
 */
export function renderDonutChart(
  data: { label: string; value: number; color?: string }[],
  options: { width?: number; height?: number; title?: string } = {}
): string {
  const { width = 300, height = 300, title } = options;

  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(cx, cy) - 20;
  const innerR = r * 0.6;

  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return '';

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${DEFAULT_PALETTE.bg}">`;

  if (title) {
    svg += `<text x="${cx}" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="${DEFAULT_PALETTE.text}">${esc(title)}</text>`;
  }

  let startAngle = 0;
  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

  data.forEach((item, idx) => {
    const sliceAngle = (item.value / total) * (2 * Math.PI);
    const endAngle = startAngle + sliceAngle;

    const x1 = cx + r * Math.cos(startAngle - Math.PI / 2);
    const y1 = cy + r * Math.sin(startAngle - Math.PI / 2);
    const x2 = cx + r * Math.cos(endAngle - Math.PI / 2);
    const y2 = cy + r * Math.sin(endAngle - Math.PI / 2);

    const ix1 = cx + innerR * Math.cos(startAngle - Math.PI / 2);
    const iy1 = cy + innerR * Math.sin(startAngle - Math.PI / 2);
    const ix2 = cx + innerR * Math.cos(endAngle - Math.PI / 2);
    const iy2 = cy + innerR * Math.sin(endAngle - Math.PI / 2);

    const largeArc = sliceAngle > Math.PI ? 1 : 0;

    const pathData = `M ${ix1} ${iy1} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix1} ${iy1}`;

    const color = item.color || colors[idx % colors.length];
    svg += `<path d="${pathData}" fill="${color}" opacity="0.8" stroke="white" stroke-width="1">`;
    svg += `<title>${esc(item.label)}: ${item.value}</title>`;
    svg += `</path>`;

    startAngle = endAngle;
  });

  svg += `</svg>`;
  return svg;
}
