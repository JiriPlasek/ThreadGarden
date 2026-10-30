# pahub

## Repository layout

- `packages/protocol` - shared types and zod schemas for the service/UI protocol
- `packages/service` - long-lived TypeScript service (coming)
- `apps/desktop` - Tauri shell and SvelteKit UI (coming)

## Development

Requires Node 22 and pnpm.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm format
```
