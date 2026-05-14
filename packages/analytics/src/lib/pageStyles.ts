export const GLOBAL_PAGE_STYLES = `
  :root {
    --bg: #f4f7fb;
    --surface: #ffffff;
    --text: #101828;
    --muted: #475467;
    --border: #d0d5dd;
    --brand: #2563eb;
    --good: #15803d;
    --warn: #b45309;
    --bad: #b42318;
    --shadow: 0 10px 30px rgba(16, 24, 40, 0.08);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", "Inter", "SF Pro Text", system-ui, -apple-system, sans-serif;
    color: var(--text);
    background: radial-gradient(circle at 0 0, #e7eefc 0%, var(--bg) 40%, #f8fafc 100%);
    line-height: 1.5;
  }

  #app {
    max-width: 1080px;
    margin: 0 auto;
    padding: 24px;
  }

  header {
    margin-bottom: 20px;
  }

  h1 {
    margin: 0 0 6px;
    font-size: clamp(1.45rem, 2.5vw, 2.1rem);
    letter-spacing: -0.02em;
  }

  h2, h3 {
    margin: 0 0 8px;
    letter-spacing: -0.015em;
  }

  p { margin: 0; color: var(--muted); }

  main {
    display: grid;
    gap: 16px;
  }

  .metrics-grid,
  .explore-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }

  .metric-card,
  .explore-card,
  .action-item,
  .weekly-mission,
  .ai-chat {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 14px;
    box-shadow: var(--shadow);
    padding: 14px;
  }

  .label {
    display: block;
    font-size: 0.85rem;
    color: var(--muted);
    margin-bottom: 4px;
  }

  .value {
    display: block;
    font-size: 1.55rem;
    font-weight: 700;
    line-height: 1.15;
    margin-bottom: 6px;
  }

  .delta { font-size: 0.85rem; font-weight: 600; color: var(--warn); }
  .trend-down { color: var(--bad); }

  .action-list {
    display: grid;
    gap: 12px;
  }

  .priority {
    display: inline-block;
    margin-top: 8px;
    padding: 4px 8px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 700;
    border: 1px solid transparent;
  }
  .priority.high { background: #fef3f2; color: #b42318; border-color: #fecdca; }
  .priority.medium { background: #fffaeb; color: #b54708; border-color: #fedf89; }
  .priority.low { background: #ecfdf3; color: #027a48; border-color: #abefc6; }

  .chat-messages {
    border: 1px dashed var(--border);
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
    background: #fafcff;
  }

  .chat-input {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
  }

  input {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    font: inherit;
  }

  button {
    border: 1px solid #1d4ed8;
    background: linear-gradient(180deg, #3b82f6 0%, #2563eb 100%);
    color: #fff;
    font: inherit;
    font-weight: 600;
    border-radius: 10px;
    padding: 10px 14px;
    cursor: pointer;
  }

  button:hover { filter: brightness(0.97); }

  @media (max-width: 900px) {
    .metrics-grid,
    .explore-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  @media (max-width: 640px) {
    #app { padding: 16px; }
    .metrics-grid,
    .explore-grid {
      grid-template-columns: 1fr;
    }
    .chat-input { grid-template-columns: 1fr; }
  }
`;
