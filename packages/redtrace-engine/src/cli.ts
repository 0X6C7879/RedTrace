// Every product entry point boots the same native DSH composition.
await import(new URL('../../../scripts/run-redtrace-node.mjs', import.meta.url).href)
