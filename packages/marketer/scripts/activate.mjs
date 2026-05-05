#!/usr/bin/env node
/**
 * Activation Script — visibility-marketing worker
 *
 * Checks local (wrangler.toml) and remote (Cloudflare API via wrangler CLI)
 * configuration status, then guides you through completing any missing steps.
 *
 * Usage:
 *   node scripts/activate.mjs             # check + interactive configure
 *   node scripts/activate.mjs --check     # status report only, no prompts
 *
 * What it covers:
 *   1. Payout provider selection (stub / razorpay / stripe)
 *   2. Required secrets per provider
 *   3. Optional notification secrets (Slack / Discord)
 *   4. D1 migration status + apply pending migrations
 *   5. Affiliate payout-details setup guidance
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Paths ──────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const TOML_PATH = resolve(ROOT, 'wrangler.toml');

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
};

const ok = (s) => `${C.green}✔${C.reset} ${s}`;
const fail = (s) => `${C.red}✘${C.reset} ${s}`;
const warn = (s) => `${C.yellow}⚠${C.reset} ${s}`;
const info = (s) => `${C.cyan}ℹ${C.reset} ${s}`;
const bold = (s) => `${C.bold}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;

// ─── CLI flags ────────────────────────────────────────────────────────────────

const CHECK_ONLY = process.argv.includes('--check');

// ─── Readline ────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultValue = '') {
  return new Promise((resolve) => {
    const hint = defaultValue ? dim(` [${defaultValue}]`) : '';
    rl.question(`  ${question}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function confirm(question, defaultYes = false) {
  return new Promise((resolve) => {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`  ${question} ${dim(hint)}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      resolve(a === '' ? defaultYes : a === 'y' || a === 'yes');
    });
  });
}

// ─── Wrangler helpers ─────────────────────────────────────────────────────────

function wrangler(...args) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok: result.status === 0,
  };
}

/** Run a wrangler command that produces output. Throws on failure. */
function wranglerOrThrow(...args) {
  const r = wrangler(...args);
  if (!r.ok) throw new Error(r.stderr.trim() || `wrangler ${args[0]} failed`);
  return r.stdout;
}

// ─── TOML helpers (no external parser) ───────────────────────────────────────

function readToml() {
  return readFileSync(TOML_PATH, 'utf-8');
}

function tomlGet(source, key) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

function tomlSet(source, key, value) {
  const escaped = value.replace(/"/g, '\\"');
  const re = new RegExp(`(^${key}\\s*=\\s*)"[^"]*"`, 'm');
  if (re.test(source)) {
    return source.replace(re, `$1"${escaped}"`);
  }
  // Key not found — append under [vars]
  return source.replace(/(\[vars\][^\[]*)/s, `$1${key} = "${escaped}"\n`);
}

// ─── Parse local config ───────────────────────────────────────────────────────

function readLocalConfig() {
  const toml = readToml();
  return {
    workerName:          tomlGet(toml, 'name') ?? 'visibility-marketing',
    dbName:              tomlGet(toml, 'database_name') ?? 'visibility-marketing-db',
    payoutProvider:      tomlGet(toml, 'PAYOUT_PROVIDER') ?? 'stub',
    razorpayAccountNum:  tomlGet(toml, 'RAZORPAY_ACCOUNT_NUMBER'),
    environment:         tomlGet(toml, 'ENVIRONMENT') ?? 'production',
  };
}

// ─── Remote: secrets list ─────────────────────────────────────────────────────

function fetchRemoteSecrets(workerName) {
  try {
    const out = wranglerOrThrow('secret', 'list', '--name', workerName);
    // Output is a JSON array: [{"name":"ADMIN_TOKEN","type":"secret_text"}, ...]
    const parsed = JSON.parse(out);
    return new Set(parsed.map((s) => s.name));
  } catch (err) {
    // wrangler may return table-formatted text in older versions
    try {
      const out = wrangler('secret', 'list', '--name', workerName).stdout;
      const names = Array.from(out.matchAll(/^\s*(\w+)\s/gm)).map((m) => m[1]);
      return new Set(names.filter((n) => n !== 'Name' && n !== 'Type'));
    } catch {
      return null; // offline / not authenticated
    }
  }
}

// ─── Remote: migration status ─────────────────────────────────────────────────

function fetchMigrationStatus(dbName) {
  try {
    const out = wranglerOrThrow('d1', 'migrations', 'list', dbName);
    // Parse the table output looking for "Applied" markers
    const applied = new Set();
    for (const line of out.split('\n')) {
      const match = line.match(/│\s*(0+\w+[^│]*?)\s*│[^│]*│\s*(Yes|Applied)\s*│/i);
      if (match) applied.add(match[1].trim());
      // JSON output alternative
      const json = line.match(/"name"\s*:\s*"([^"]+)"/);
      const applied2 = line.match(/"applied"\s*:\s*true/);
      if (json && applied2) applied.add(json[1]);
    }
    return { ok: true, applied };
  } catch {
    return { ok: false, applied: new Set() };
  }
}

// ─── Status model ─────────────────────────────────────────────────────────────

const REQUIRED_SECRETS = [
  // Core auth tokens
  'ADMIN_TOKEN', 'ADMIN_TOKEN_ROLLOVER',
  'SYSTEM_TOKEN', 'SYSTEM_TOKEN_ROLLOVER',
  'AGENT_TOKEN', 'AGENT_TOKEN_ROLLOVER',
  'WEBHOOK_TOKEN', 'WEBHOOK_TOKEN_ROLLOVER',
  'AFFILIATE_AUTH_SECRET',
  'WEBHOOK_SIGNING_SECRET',
  // Email
  'EMAIL_API_KEY',
  // AI Engine
  'INTERNAL_SECRET', 'INTERNAL_SECRET_ROLLOVER',
  // Skrip integration
  'SKRIP_SERVICE_TOKEN',
  'SKRIP_WEBHOOK_SIGNING_SECRET',
];
const OPTIONAL_SECRETS = [
  'SLACK_WEBHOOK_URL',
  'DISCORD_WEBHOOK_URL',
  'SKRIP_SIGNING_SECRET',   // falls back to WEBHOOK_SIGNING_SECRET when absent
];
const RAZORPAY_SECRETS = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
const STRIPE_SECRETS   = ['STRIPE_SECRET_KEY'];
const MIGRATIONS       = [
  '0001_init.sql',
  '0002_payout_events.sql',
  '0003_share_leads.sql',
  '0004_cold_outreach_sequence.sql',
  '0005_outbound_campaigns.sql',
  '0006_campaign_warmup_schedule.sql',
  '0007_prospect_channels.sql',
  '0008_audit_followup_sequence.sql',
  '0009_suppression_list.sql',
  '0010_email_sends_capability_hook.sql',
  '0011_email_sends_engagement.sql',
  '0012_email_sends_framing_tier.sql',
  '0013_skrip_integration_foundation.sql',
  '0014_agentic_growth_foundation.sql',
  '0015_skrip_contact_address.sql',
  '0016_push_receipts_status.sql',
  '0017_agent_action_linkage_and_tokens.sql',
  '0018_campaign_objectives.sql',
  '0019_campaign_planning.sql',
];

// ─── Print status report ──────────────────────────────────────────────────────

function printBanner() {
  console.log();
  console.log(`${C.bold}${C.bgBlue}  Visibility Marketing — Activation Checklist  ${C.reset}`);
  console.log();
}

function printSection(title) {
  console.log(`\n${bold(title)}`);
  console.log(dim('─'.repeat(50)));
}

function printStatus(local, secrets, migrations) {
  const provider = local.payoutProvider;

  printSection('Local Configuration  (wrangler.toml)');
  console.log(`  Payout provider : ${provider === 'stub'
    ? warn(`${provider}  ← not real money`)
    : ok(provider)}`);

  if (provider === 'razorpay') {
    const hasNum = !!local.razorpayAccountNum && local.razorpayAccountNum !== 'your-razorpay-account-number';
    console.log(`  RAZORPAY_ACCOUNT_NUMBER : ${hasNum ? ok(local.razorpayAccountNum) : fail('not set in wrangler.toml [vars]')}`);
  }

  printSection('Remote Secrets  (Cloudflare)');
  if (!secrets) {
    console.log(`  ${warn('Could not reach Cloudflare — run: wrangler login')}`);
  } else {
    const allSecrets = [
      ...REQUIRED_SECRETS,
      ...(provider === 'razorpay' ? RAZORPAY_SECRETS : []),
      ...(provider === 'stripe'   ? STRIPE_SECRETS   : []),
      ...OPTIONAL_SECRETS,
    ];

    // Required
    for (const s of REQUIRED_SECRETS) {
      console.log(`  ${secrets.has(s) ? ok(s) : fail(`${s}  ← required`)}`);
    }

    // Provider-specific
    if (provider === 'razorpay') {
      console.log(dim('\n  Razorpay X2B secrets:'));
      for (const s of RAZORPAY_SECRETS) {
        console.log(`  ${secrets.has(s) ? ok(s) : fail(`${s}  ← required for razorpay`)}`);
      }
    }
    if (provider === 'stripe') {
      console.log(dim('\n  Stripe secrets:'));
      for (const s of STRIPE_SECRETS) {
        console.log(`  ${secrets.has(s) ? ok(s) : fail(`${s}  ← required for stripe`)}`);
      }
    }

    // Optional
    console.log(dim('\n  Optional notifications:'));
    for (const s of OPTIONAL_SECRETS) {
      console.log(`  ${secrets.has(s) ? ok(s) : dim(`○ ${s}  (optional)`)}`);
    }
  }

  printSection('D1 Migrations  (visibility-marketing-db)');
  if (!migrations.ok) {
    console.log(`  ${warn('Could not check migrations — offline or not authenticated')}`);
  } else {
    for (const m of MIGRATIONS) {
      const baseName = m.replace('.sql', '');
      const isApplied = [...migrations.applied].some((a) =>
        a.replace('.sql', '').startsWith(baseName.split('_')[0])
      );
      console.log(`  ${isApplied ? ok(m) : fail(`${m}  ← pending`)}`);
    }
  }

  printSection('Affiliate Payout Details');
  console.log(`  ${info('Set per-affiliate payout methods via admin API (after deploy):')}`);
  console.log(dim(`  PUT /api/affiliate/:code/payout-details`));
  console.log(dim(`  Body: { "method": "upi"|"bank"|"stripe", ...fields }`));
  console.log(dim(`  Required before running a real payout batch`));
}

// ─── Detect what needs doing ──────────────────────────────────────────────────

function buildTodoList(local, secrets, migrations) {
  const todos = [];

  if (local.payoutProvider === 'stub') {
    todos.push({ id: 'provider', label: 'Set real payout provider (razorpay or stripe)' });
  }

  if (local.payoutProvider === 'razorpay') {
    const hasNum = !!local.razorpayAccountNum && local.razorpayAccountNum !== 'your-razorpay-account-number';
    if (!hasNum) todos.push({ id: 'razorpay_account_number', label: 'Set RAZORPAY_ACCOUNT_NUMBER in wrangler.toml [vars]' });
  }

  if (secrets) {
    for (const s of REQUIRED_SECRETS) {
      if (!secrets.has(s)) todos.push({ id: `secret_${s}`, label: `Set secret: ${s}`, secret: s });
    }
    if (local.payoutProvider === 'razorpay') {
      for (const s of RAZORPAY_SECRETS) {
        if (!secrets.has(s)) todos.push({ id: `secret_${s}`, label: `Set secret: ${s}`, secret: s });
      }
    }
    if (local.payoutProvider === 'stripe') {
      for (const s of STRIPE_SECRETS) {
        if (!secrets.has(s)) todos.push({ id: `secret_${s}`, label: `Set secret: ${s}`, secret: s });
      }
    }
    for (const s of OPTIONAL_SECRETS) {
      if (!secrets.has(s)) todos.push({ id: `secret_${s}`, label: `Set secret: ${s} (optional)`, secret: s, optional: true });
    }
  }

  if (migrations.ok) {
    for (const m of MIGRATIONS) {
      const baseName = m.replace('.sql', '');
      const isApplied = [...migrations.applied].some((a) =>
        a.replace('.sql', '').startsWith(baseName.split('_')[0])
      );
      if (!isApplied) {
        todos.push({ id: `migration_${m}`, label: `Apply migration: ${m}`, migration: m });
      }
    }
  }

  return todos;
}

// ─── Interactive configure ────────────────────────────────────────────────────

async function configure(local, todos) {
  if (todos.length === 0) {
    console.log(`\n${ok(bold('All required items are configured!'))} Nothing to do.\n`);
    return;
  }

  console.log(`\n${bold('Items to configure:')}`);
  const required = todos.filter((t) => !t.optional);
  const optional = todos.filter((t) => t.optional);

  required.forEach((t, i) => console.log(`  ${C.yellow}${i + 1}.${C.reset} ${t.label}`));
  if (optional.length) {
    console.log(dim('  Optional:'));
    optional.forEach((t, i) => console.log(`  ${C.dim}${required.length + i + 1}.${C.reset} ${C.dim}${t.label}${C.reset}`));
  }

  console.log();
  const doAll = await confirm('Configure all required items now?', true);
  const toProcess = doAll
    ? todos.filter((t) => !t.optional)
    : [];

  if (!doAll) {
    for (const t of required) {
      if (await confirm(`Configure: ${t.label}?`, true)) toProcess.push(t);
    }
  }

  // Always offer optional separately
  if (optional.length && !doAll) {
    for (const t of optional) {
      if (await confirm(`Configure: ${t.label}?`, false)) toProcess.push(t);
    }
  } else if (doAll) {
    for (const t of optional) {
      if (await confirm(`Also set optional: ${t.label}?`, false)) toProcess.push(t);
    }
  }

  if (toProcess.length === 0) {
    console.log(dim('\n  Nothing selected. Run the script again when ready.\n'));
    return;
  }

  console.log();
  const toml = readToml();
  let tomlUpdated = toml;

  for (const task of toProcess) {
    console.log(`\n${bold(`→ ${task.label}`)}`);

    // ── Payout provider ──
    if (task.id === 'provider') {
      console.log(info('  stub      — no real money, safe for dev'));
      console.log(info('  razorpay  — Razorpay X2B (INR, UPI / bank)'));
      console.log(info('  stripe    — Stripe Transfers (USD, connected account)'));
      const choice = await ask('  Choose provider', 'stub');
      if (!['stub', 'razorpay', 'stripe'].includes(choice)) {
        console.log(warn(`  Unknown provider "${choice}" — skipping`));
        continue;
      }
      tomlUpdated = tomlSet(tomlUpdated, 'PAYOUT_PROVIDER', choice);
      local.payoutProvider = choice;

      // Add provider-specific required todos if not already there
      if (choice === 'razorpay') {
        for (const s of RAZORPAY_SECRETS) {
          if (!toProcess.find((t) => t.secret === s)) {
            toProcess.push({ id: `secret_${s}`, label: `Set secret: ${s}`, secret: s });
          }
        }
        if (!toProcess.find((t) => t.id === 'razorpay_account_number')) {
          toProcess.push({ id: 'razorpay_account_number', label: 'Set RAZORPAY_ACCOUNT_NUMBER in wrangler.toml' });
        }
      }
      if (choice === 'stripe') {
        for (const s of STRIPE_SECRETS) {
          if (!toProcess.find((t) => t.secret === s)) {
            toProcess.push({ id: `secret_${s}`, label: `Set secret: ${s}`, secret: s });
          }
        }
      }
      console.log(ok(`  PAYOUT_PROVIDER set to "${choice}" in wrangler.toml`));
    }

    // ── Razorpay account number (plain var, not secret) ──
    else if (task.id === 'razorpay_account_number') {
      const num = await ask('  Razorpay account/balance number');
      if (!num) { console.log(warn('  Skipped (empty)')); continue; }
      tomlUpdated = tomlSet(tomlUpdated, 'RAZORPAY_ACCOUNT_NUMBER', num);
      console.log(ok(`  RAZORPAY_ACCOUNT_NUMBER set in wrangler.toml`));
    }

    // ── Secret ──
    else if (task.secret) {
      const hints = {
        ADMIN_TOKEN: 'generate a strong random token (e.g. openssl rand -hex 32)',
        ADMIN_TOKEN_ROLLOVER: 'generate a strong random token — set before rotating ADMIN_TOKEN',
        SYSTEM_TOKEN: 'generate a strong random token',
        SYSTEM_TOKEN_ROLLOVER: 'generate a strong random token — set before rotating SYSTEM_TOKEN',
        AGENT_TOKEN: 'generate a strong random token — used by growth-agent for agentic API calls',
        AGENT_TOKEN_ROLLOVER: 'generate a strong random token — set before rotating AGENT_TOKEN',
        WEBHOOK_TOKEN: 'generate a strong random token',
        WEBHOOK_TOKEN_ROLLOVER: 'generate a strong random token — set before rotating WEBHOOK_TOKEN',
        AFFILIATE_AUTH_SECRET: 'generate a strong random token — used to sign affiliate payloads',
        WEBHOOK_SIGNING_SECRET: 'generate a strong random token — HMAC signing for webhook ingestion',
        EMAIL_API_KEY: 'your Brevo or SendGrid API key',
        EMAIL_PROVIDER: 'brevo or sendgrid',
        INTERNAL_SECRET: 'generate a strong random token — sent as x-internal-secret to AI Engine',
        INTERNAL_SECRET_ROLLOVER: 'generate a strong random token — set before rotating INTERNAL_SECRET',
        SKRIP_SERVICE_TOKEN: 'bearer token for outbound Skrip API calls',
        SKRIP_WEBHOOK_SIGNING_SECRET: 'HMAC secret for verifying inbound Skrip outcome webhooks',
        SKRIP_SIGNING_SECRET: 'HMAC for outbound signing to Skrip (optional — falls back to WEBHOOK_SIGNING_SECRET)',
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/...',
        DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/...',
        RAZORPAY_KEY_ID: 'rzp_live_xxxxxxxxxxxxx',
        RAZORPAY_KEY_SECRET: 'your Razorpay key secret',
        STRIPE_SECRET_KEY: 'sk_live_xxxxxxxxxxxxx',
      };
      const hint = hints[task.secret] || '';
      if (hint) console.log(dim(`  Hint: ${hint}`));

      const value = await ask(`  Value for ${task.secret}`);
      if (!value) { console.log(warn(`  Skipped (empty)`)); continue; }

      // Pipe value via stdin to wrangler secret put (avoids shell injection)
      const result = spawnSync(
        'npx', ['wrangler', 'secret', 'put', task.secret],
        {
          cwd: ROOT,
          input: value + '\n',
          encoding: 'utf-8',
          env: { ...process.env, FORCE_COLOR: '0' },
        }
      );
      if (result.status !== 0) {
        console.log(fail(`  Failed to set ${task.secret}: ${(result.stderr ?? '').trim()}`));
      } else {
        console.log(ok(`  ${task.secret} uploaded to Cloudflare`));
      }
    }

    // ── Migration ──
    else if (task.migration) {
      const localOnly = await confirm('  Apply locally (--local) only?', false);
      const args = ['d1', 'migrations', 'apply', 'visibility-marketing-db'];
      if (localOnly) args.push('--local');

      console.log(dim(`  Running: npx wrangler ${args.join(' ')} ...`));
      const result = spawnSync('npx', ['wrangler', ...args], {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      if (result.status !== 0) {
        console.log(fail(`  Migration failed: ${(result.stderr ?? '').trim()}`));
      } else {
        console.log(ok(`  Migration applied`));
        if (result.stdout) console.log(dim(result.stdout.trim()));
      }
    }
  }

  // Write wrangler.toml if changed
  if (tomlUpdated !== toml) {
    writeFileSync(TOML_PATH, tomlUpdated, 'utf-8');
    console.log(`\n${ok('wrangler.toml saved')}`);
  }
}

// ─── Affiliate payout guidance ────────────────────────────────────────────────

function printAffiliateGuidance(local) {
  if (local.payoutProvider === 'stub') return;

  console.log(`\n${bold('Next step — configure affiliate payout methods:')}`);
  console.log(dim('  After deploying the worker, call the admin API for each affiliate:\n'));

  if (local.payoutProvider === 'razorpay') {
    console.log(dim(`  # UPI method`));
    console.log(dim(`  curl -X PUT https://<worker>.workers.dev/api/affiliate/<code>/payout-details \\`));
    console.log(dim(`    -H "Authorization: Bearer \$ADMIN_TOKEN" \\`));
    console.log(dim(`    -H "Content-Type: application/json" \\`));
    console.log(dim(`    -d '{"method":"upi","upiId":"user@oksbi","accountHolderName":"Name"}'`));
    console.log();
    console.log(dim(`  # Bank method`));
    console.log(dim(`  curl -X PUT https://<worker>.workers.dev/api/affiliate/<code>/payout-details \\`));
    console.log(dim(`    -H "Authorization: Bearer \$ADMIN_TOKEN" \\`));
    console.log(dim(`    -H "Content-Type: application/json" \\`));
    console.log(dim(`    -d '{"method":"bank","accountHolderName":"Name","ifsc":"HDFC0001234","accountNumber":"123456"}'`));
  } else if (local.payoutProvider === 'stripe') {
    console.log(dim(`  curl -X PUT https://<worker>.workers.dev/api/affiliate/<code>/payout-details \\`));
    console.log(dim(`    -H "Authorization: Bearer \$ADMIN_TOKEN" \\`));
    console.log(dim(`    -H "Content-Type: application/json" \\`));
    console.log(dim(`    -d '{"method":"stripe","stripeAccountId":"acct_1xxxxxxx"}'`));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  // ── Load local config ──
  let local;
  try {
    local = readLocalConfig();
  } catch (err) {
    console.error(fail(`Cannot read wrangler.toml: ${err.message}`));
    process.exit(1);
  }

  console.log(info(`Worker: ${bold(local.workerName)}   Provider: ${bold(local.payoutProvider)}   Env: ${bold(local.environment)}`));

  // ── Fetch remote status ──
  process.stdout.write('\n  Checking remote secrets... ');
  const secrets = fetchRemoteSecrets(local.workerName);
  console.log(secrets ? `${C.green}done${C.reset}` : `${C.yellow}offline${C.reset}`);

  process.stdout.write('  Checking migrations...     ');
  const migrations = fetchMigrationStatus(local.dbName);
  console.log(migrations.ok ? `${C.green}done${C.reset}` : `${C.yellow}offline${C.reset}`);

  // ── Print full status ──
  printStatus(local, secrets, migrations);

  if (CHECK_ONLY) {
    console.log();
    rl.close();
    return;
  }

  // ── Build todo list ──
  const todos = buildTodoList(local, secrets, migrations);

  if (todos.length === 0) {
    console.log(`\n${ok(bold('All required items are already configured.'))} Nothing to do.`);
    printAffiliateGuidance(local);
    console.log();
    rl.close();
    return;
  }

  // ── Interactive configure ──
  await configure(local, todos);

  // Reload local after possible changes
  local = readLocalConfig();
  printAffiliateGuidance(local);

  console.log(`\n${bold('Done.')} Re-run ${dim('node scripts/activate.mjs --check')} to verify.\n`);
  rl.close();
}

main().catch((err) => {
  console.error(`\n${fail('Unexpected error:')} ${err.message}`);
  rl.close();
  process.exit(1);
});
