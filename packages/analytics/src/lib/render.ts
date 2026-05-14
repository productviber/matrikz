// Server-side rendering utilities
import React from 'react'
import { GLOBAL_PAGE_STYLES } from './pageStyles'

export interface RenderOptions {
  title?: string
  description?: string
  lang?: string
}

export function renderToHTML(
  component: React.ReactNode,
  options: RenderOptions = {}
): string {
  const { title = 'Visibility Cockpit', description = 'Analytics Dashboard' } = options

  // Note: In production, you'd use renderToString from react-dom/server
  // For now, this is a placeholder that would be expanded with full SSR support.
  
  const html = `
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <style>${GLOBAL_PAGE_STYLES}</style>
  </head>
  <body>
    <div id="app">${component}</div>
    <script src="/app.js"></script>
  </body>
</html>
  `.trim()

  return html
}

export function createErrorHTML(
  code: number,
  message: string
): string {
  return `
<html>
  <head>
    <meta charset="utf-8" />
    <title>Error ${code}</title>
  </head>
  <body>
    <h1>${code}</h1>
    <p>${message}</p>
  </body>
</html>
  `.trim()
}
