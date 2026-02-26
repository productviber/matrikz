# @visibility/design-system

Shared design system for Visibility Cockpit platform workers. Provides consistent visual language, components, and design tokens across all platform experiences.

## Structure

```
src/
├── tokens/           # Design tokens (colors, typography, spacing, breakpoints)
├── components/       # Reusable UI components
└── styles/          # Global CSS, utilities, animations
```

## Usage

### Design Tokens

```typescript
import { colors, typography, spacing, breakpoints } from '@visibility/design-system/tokens'

// Use in styles
style={{ color: colors.brand.primary }}
```

### Components

```typescript
import { Button, Card, MetricCard, Badge, Input, Alert } from '@visibility/design-system/components'

<Button variant="primary" size="lg">
  Click me
</Button>

<MetricCard
  label="Impressions"
  value={1250}
  delta="+5%"
  trend="up"
  subtitle="Last 7 days"
/>
```

### Global Styles

```typescript
import '@visibility/design-system/styles'
```

## Components

- **Button**: Primary CTA with variants (primary, secondary, ghost, danger)
- **Card**: Container with optional header and actions
- **MetricCard**: Display key metrics with trends (used in both analytics dashboard and public reports)
- **Badge**: Inline status indicator
- **Input**: Form input with labels and validation states
- **Alert**: Dismissible notification/alert component

## Design Tokens

- **Colors**: Brand, status, neutral palette
- **Typography**: Font families, sizes, weights, line heights
- **Spacing**: Consistent spacing scale (4px base)
- **Breakpoints**: Responsive design breakpoints
- **Shadows**: Elevation system
- **Transitions**: Animation timings

## Shared Design Language

This package ensures visual consistency across all Visibility workers:

- Same color palette everywhere
- Same component styles everywhere
- Same typography everywhere
- Users see one cohesive product

## Contributing

When adding new components:

1. Export from `src/components/index.tsx`
2. Include TypeScript interfaces
3. Support className prop for customization
4. Use forwardRef for component refs
5. Test across both analytics and marketer workers
