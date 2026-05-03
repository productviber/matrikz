# Setup Instructions

## Install Dependencies

The codebase requires dependencies to be installed before compiling. Run:

```bash
# Navigate to the project root
cd visibility-marketing

# Install dependencies using pnpm (recommended)
pnpm install

# Or using npm
npm install
```

## Verify Installation

After installing dependencies, verify that everything is working:

```bash
# Type check the project
pnpm typecheck

# Or run lint
pnpm build
```

## Workspace Structure

The project uses a monorepo structure managed by **pnpm workspaces**. Dependencies are resolved across:

- `packages/design-system` - Shared UI components and tokens
- `packages/analytics` - Analytics worker
- `packages/marketer` - Marketing worker

All three packages will have access to shared dependencies after running `pnpm install`.

## Key Dependencies

- **React** - UI component framework
- **TypeScript** - Type checking and compilation
- **Wrangler** - Cloudflare Workers CLI
- **Vite** - Build tool
- **@tamyla/clodo-framework** - HTTP framework for workers
- **itty-router** - Lightweight routing library

## First Time Setup

```bash
# 1. Install all dependencies
pnpm install

# 2. Type check
pnpm typecheck

# 3. Build design system
cd packages/design-system
pnpm typecheck

# 4. Build analytics worker
cd ../analytics
pnpm typecheck

# 5. Build marketer worker
cd ../marketer
pnpm typecheck
```

## Running Locally

Once dependencies are installed:

```bash
# Terminal 1 - Analytics Worker
cd packages/analytics
pnpm dev

# Terminal 2 - Marketer Worker
cd packages/marketer
pnpm dev
```

## Troubleshooting

### "Cannot find module 'react'"
- Ensure `pnpm install` has completed successfully
- Check that `node_modules` directory exists in the project root
- Try deleting `pnpm-lock.yaml` and running `pnpm install` again

### "JSX element implicitly has type 'any'"
- Ensure `@types/react` is installed
- Check that `tsconfig.json` has correct settings (should be done automatically)
- Clear TypeScript cache with `rm -rf dist/` and try again

### Port already in use
Workers run on ports 8787 and 8788 by default:
```bash
# Use custom ports
pnpm dev -- --port 3100
```
