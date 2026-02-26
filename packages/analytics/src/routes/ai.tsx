export async function renderAIPage(request: Request, env?: any) {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>AI - Visibility Cockpit</title>
        <link rel="stylesheet" href="https://assets.visibility.clodo.dev/styles/globals.css" />
      </head>
      <body>
        <div id="app" data-page="ai">
          <header>
            <h1>AI Assistant</h1>
            <p>AI-powered insights and recommendations</p>
          </header>
          <main>
            <section class="ai-chat">
              <div class="chat-messages">
                <div class="message assistant">
                  <p>Hello! I'm your SEO assistant. I can help you understand your analytics, identify opportunities, and provide actionable recommendations.</p>
                </div>
              </div>
              <div class="chat-input">
                <input type="text" placeholder="Ask me about your SEO..." />
                <button>Send</button>
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
