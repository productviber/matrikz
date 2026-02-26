import React, { forwardRef, ButtonHTMLAttributes, ReactNode } from 'react'

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  isLoading?: boolean
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      fullWidth = false,
      isLoading = false,
      className = '',
      disabled = false,
      children,
      ...props
    }: ButtonProps,
    ref: React.Ref<HTMLButtonElement>
  ) => {
    const variantStyles: Record<string, string> = {
      primary:
        'bg-blue-600 text-white hover:bg-blue-700 focus:ring-2 focus:ring-blue-500',
      secondary:
        'bg-neutral-100 text-neutral-900 hover:bg-neutral-200 focus:ring-2 focus:ring-neutral-400',
      ghost:
        'bg-transparent text-neutral-700 hover:bg-neutral-100 focus:ring-2 focus:ring-neutral-300',
      danger:
        'bg-red-600 text-white hover:bg-red-700 focus:ring-2 focus:ring-red-500',
    }

    const sizeStyles: Record<string, string> = {
      sm: 'px-3 py-1.5 text-xs font-medium',
      md: 'px-4 py-2 text-sm font-medium',
      lg: 'px-6 py-3 text-base font-semibold',
    }

    return (
      <button
        ref={ref}
        className={`
          ${variantStyles[variant]}
          ${sizeStyles[size]}
          ${fullWidth ? 'w-full' : ''}
          rounded-lg font-medium transition-all duration-200
          disabled:opacity-50 disabled:cursor-not-allowed
          inline-flex items-center justify-center gap-2
          focus:outline-none
          ${className || ''}
        `}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && (
          <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        )}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
