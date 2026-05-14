import { GLOBAL_PAGE_STYLES } from '../lib/pageStyles'

export async function renderActionPage(request: Request, env?: any) {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Action - Visibility Cockpit</title>
        <style>${GLOBAL_PAGE_STYLES}</style>
      </head>
      <body>
        <div id="app" data-page="action">
          <header>
            <h1>Action: Next Steps</h1>
            <p>Prioritized opportunities to improve your SEO</p>
          </header>
          <main>
            <section class="action-list">
              <div class="action-item">
                <h3>Fix Meta Descriptions</h3>
                <p>20 pages missing meta descriptions</p>
                <span class="priority high">High Priority</span>
              </div>
              <div class="action-item">
                <h3>Improve Page Speed</h3>
                <p>Core Web Vitals need improvement</p>
                <span class="priority medium">Medium Priority</span>
              </div>
              <div class="action-item">
                <h3>Update Internal Links</h3>
                <p>Orphaned pages detected</p>
                <span class="priority low">Low Priority</span>
              </div>
            </section>
          </main>
        </div>
        <script src="/app.js"></script>
      </body>
    </html>
  `
  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}
