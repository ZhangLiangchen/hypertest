#!/usr/bin/env node
// Hypertest CLI entry. Node >= 22.18 strips TypeScript types natively, so the
// workspace packages are executed from source without a build step.
import { main } from '@hypertest/cli';

const code = await main(process.argv.slice(2));
process.exitCode = code;
