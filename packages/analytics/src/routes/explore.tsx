export async function renderExplorePage(request: Request, env?: any) {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Explore - Visibility Cockpit</title>
        <link rel="stylesheet" href="https://assets.visibility.clodo.dev/styles/globals.css" />
      </head>
      <body>
        <div id="app" data-page="explore">
          <header>
            <h1>Explore: Deep Dive Analysis</h1>
            <p>Detailed performance insights and trends</p>
          </header>
          <main>
            <section class="explore-grid">
              <div class="explore-card">
                <h3>Keyword Performance</h3>
                <p>Track ranking changes and traffic impact</p>
              </div>
              <div class="explore-card">
                <h3>Competitive Analysis</h3>
                <p>Compare against your competitors</p>
              </div>
              <div class="explore-card">
                <h3>Content Analysis</h3>
                <p>Evaluate your page quality and coverage</p>
              </div>
              <div class="explore-card">
                <h3>Technical Audit</h3>
                <p>SEO technical health monitoring</p>
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
