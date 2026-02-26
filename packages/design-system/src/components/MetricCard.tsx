import React, { forwardRef, ReactNode } from 'react'
import { Card } from './Card'

export interface MetricCardProps {
  label?: string
  value?: string | number
  delta?: string
  trend?: 'up' | 'down' | 'neutral'
  subtitle?: string
  icon?: ReactNode
  className?: string
}

export const MetricCard = forwardRef<HTMLDivElement, MetricCardProps>(
  (
    {
      label = '',
      value = '',
      delta = '',
      trend = 'neutral',
      subtitle = '',
      icon,
      className = '',
    }: MetricCardProps,
    ref: React.Ref<HTMLDivElement>
  ) => {
    const trendColors: Record<string, string> = {
      up: 'text-green-600',
      down: 'text-red-600',
      neutral: 'text-neutral-600',
    }

    const trendIcon: Record<string, string> = {
      up: '↑',
      down: '↓',
      neutral: '→',
    }

    return (
      <Card ref={ref} className={className}>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <p className="text-sm font-medium text-neutral-600">{label}</p>
            <p className="text-3xl font-bold text-neutral-900 mt-2">{value}</p>
            {delta && trend && (
              <p className={`text-sm mt-1 font-medium ${trendColors[trend]}`}>
                {trendIcon[trend]} {delta}
              </p>
            )}
            {subtitle && (
              <p className="text-xs text-neutral-500 mt-2">{subtitle}</p>
            )}
          </div>
          {icon && (
            <div className="text-neutral-400 ml-4 flex-shrink-0">{icon}</div>
          )}
        </div>
      </Card>
    )
  }
)

MetricCard.displayName = 'MetricCard'
