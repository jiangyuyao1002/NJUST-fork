# Third-Party Notices

This file lists third-party software and licenses used by or distributed with this project.

## Upstream Project

This project is a derivative of [Roo Code](https://github.com/RooVetGit/Roo-Code), originally licensed under the **Apache License 2.0**. We gratefully acknowledge the Roo Code contributors.

> Copyright Roo Code contributors
> Licensed under the Apache License, Version 2.0.

All modifications made by the NJUST_AI team are also licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file in this repository for the full license text.

## Key Third-Party Dependencies

| Package | License | Usage |
|---------|---------|-------|
| zod | MIT | Runtime type validation (published with `@njust-ai/types`) |
| typescript | Apache-2.0 | TypeScript compiler |
| esbuild | MIT | JavaScript bundler |
| eslint | MIT | Linting |
| vitest | MIT | Testing framework |
| turbo | MPL-2.0 | Monorepo build orchestration |
| prettier | MIT | Code formatting |

## Full Software Bill of Materials (SBOM)

A complete SBOM in SPDX JSON format can be generated from the lockfile:

```bash
node scripts/generate-sbom.mjs
```

This produces a `bom-YYYY-MM-DD.spdx.json` file listing all transitive dependencies with versions and integrity checksums.
