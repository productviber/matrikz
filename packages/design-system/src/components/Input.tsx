import React, { forwardRef, InputHTMLAttributes } from 'react'

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  error?: boolean
  helperText?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
  id?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label = '',
      error = false,
      helperText = '',
      size = 'md',
      className = '',
      id = '',
      ...props
    }: InputProps,
    ref: React.Ref<HTMLInputElement>
  ) => {
    const inputId = id || `input-${Math.random().toString(36).slice(2, 9)}`

    const sizeStyles = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-base',
      lg: 'px-4 py-3 text-lg',
    }

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-neutral-700 mb-1"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`
            w-full rounded-lg border-2 transition-colors duration-200
            focus:outline-none
            ${sizeStyles[size]}
            ${
              error
                ? 'border-red-500 focus:border-red-600 focus:ring-red-500/10'
                : 'border-neutral-300 focus:border-blue-500 focus:ring-blue-500/10'
            }
            ${className || ''}
          `}
          {...props}
        />
        {error && (
          <p className="text-sm text-red-600 mt-1">{error}</p>
        )}
        {helperText && !error && (
          <p className="text-sm text-neutral-500 mt-1">{helperText}</p>
        )}
      </div>
    )
  }
)

Input.displayName = 'Input'
