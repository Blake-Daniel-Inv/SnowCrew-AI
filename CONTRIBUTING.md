# Contributing to SnowCrew AI

Thanks for your interest in contributing! This is a small, MIT-licensed project and
contributions are welcome via pull request.

## Development Setup

```bash
git clone https://github.com/Blake-Daniel-Inv/SnowCrew-AI.git
cd SnowCrew-AI
npm install
npm run dev      # http://localhost:3000
```

See the [README](README.md) for environment variables and integration setup.

## Before You Open a PR

Make sure all three pass locally — CI runs the same checks:

```bash
npm run lint     # ESLint
npm test         # vitest
npm run build    # production build must succeed
```

## Pull Request Guidelines

- Fork the repo and work on a feature branch (`feat/...`, `fix/...`).
- Keep changes focused — one logical change per PR.
- Match the surrounding TypeScript style; the ESLint config is the source of truth.
- Add or update tests for behavior changes. Tests live alongside source as `*.test.ts`.
- Write a clear PR description explaining the *why*, not just the *what*.

## Never Commit Secrets

- `.env`, `.env.local`, and `.env.*.local` are gitignored — keep it that way.
- Never commit real tokens, keys, or account identifiers, **even in tests**. Use obvious
  dummy fixtures (e.g. `ghp_aaaabbbbccccdddd...`) as the existing test suite does.

## Scope

This is a focused tool for building, running, and exporting CrewAI agents and crews with
Snowflake and GitHub integrations. Features well outside that scope may be declined — please
open an issue to discuss before investing in a large PR.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
