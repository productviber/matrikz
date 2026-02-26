import React, { forwardRef, HTMLAttributes, ReactNode } from 'react'

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'info' | 'success' | 'warning' | 'danger'
  title?: string
  onDismiss?: () => void
  className?: string
  children?: ReactNode
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  (
    { variant = 'info', title = '', onDismiss, className = '', children, ...props }: AlertProps,
    ref: React.Ref<HTMLDivElement>
  ) => {
    const variantStyles: Record<string, string> = {
      info: 'bg-blue-50 border-blue-200 text-blue-800',
      success: 'bg-green-50 border-green-200 text-green-800',
      warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
      danger: 'bg-red-50 border-red-200 text-red-800',
    }

    const iconColors: Record<string, string> = {
      info: 'text-blue-600',
      success: 'text-green-600',
      warning: 'text-yellow-600',
      danger: 'text-red-600',
    }

    return (
      <div
        ref={ref}
        className={`
          rounded-lg border p-4
          ${variantStyles[variant]}
          ${className || ''}
        `}
        {...props}
      >
        <div className="flex gap-3">
          <div className={`pt-0.5 ${iconColors[variant]}`}>
            {variant === 'info' && '💡'}
            {variant === 'success' && '✓'}
            {variant === 'warning' && '⚠'}
            {variant === 'danger' && '✕'}
          </div>
          <div className="flex-1">
            {title && (
              <h3 className="font-semibold mb-1">{title}</h3>
            )}
            <div className="text-sm">{children}</div>
          </div>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="text-current opacity-60 hover:opacity-100 transition-opacity"
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    )
  }
)

Alert.displayName = 'Alert'
