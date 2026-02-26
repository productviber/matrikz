import React, { forwardRef, HTMLAttributes } from 'react'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'info' | 'success' | 'warning' | 'danger' | 'default'
  size?: 'sm' | 'md' | 'lg'
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = 'default', size = 'md', className = '', children, ...props }: BadgeProps, ref: React.Ref<HTMLSpanElement>) => {
    const variantStyles: Record<string, string> = {
      info: 'bg-blue-100 text-blue-800',
      success: 'bg-green-100 text-green-800',
      warning: 'bg-yellow-100 text-yellow-800',
      danger: 'bg-red-100 text-red-800',
      default: 'bg-neutral-100 text-neutral-800',
    }

    const sizeStyles: Record<string, string> = {
      sm: 'px-2 py-0.5 text-xs font-medium rounded',
      md: 'px-3 py-1 text-sm font-medium rounded-md',
      lg: 'px-3.5 py-1.5 text-base font-semibold rounded-lg',
    }

    return (
      <span
        ref={ref}
        className={`
          inline-flex items-center gap-1
          ${variantStyles[variant]}
          ${sizeStyles[size]}
          ${className || ''}
        `}
        {...props}
      >
        {children}
      </span>
    )
  }
)

Badge.displayName = 'Badge'
