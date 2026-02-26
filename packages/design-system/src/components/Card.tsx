import React, { forwardRef, ReactNode, HTMLAttributes } from 'react'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string
  subtitle?: string
  actions?: ReactNode
  compact?: boolean
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ title = '', subtitle = '', actions, compact = false, className = '', children, ...props }: CardProps, ref: React.Ref<HTMLDivElement>) => {
    return (
      <div
        ref={ref}
        className={`
          bg-white rounded-lg border border-neutral-200 shadow-sm
          ${className || ''}
        `}
        {...props}
      >
        {(title || subtitle || actions) && (
          <div className="px-6 py-4 border-b border-neutral-200 flex items-center justify-between">
            <div className="flex-1">
              {title && (
                <h3 className="text-lg font-semibold text-neutral-900">
                  {title}
                </h3>
              )}
              {subtitle && (
                <p className="text-sm text-neutral-600 mt-1">{subtitle}</p>
              )}
            </div>
            {actions && <div className="flex gap-2 ml-4">{actions}</div>}
          </div>
        )}
        <div className={compact ? 'px-4 py-3' : 'px-6 py-4'}>{children}</div>
      </div>
    )
  }
)

Card.displayName = 'Card'
