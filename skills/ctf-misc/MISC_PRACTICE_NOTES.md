# MISC Practice Notes (from packaged sets)

Purpose: capture reusable patterns observed in packaged practice materials without changing execution architecture.

## Common patterns

- multi-layer encoding
- archive nesting + password reuse
- text artifacts hidden in comments/metadata
- image/audio artifacts requiring tool extraction
- simple constraint logic (Z3 or scripted search)

## Efficiency tips

- run quick automated decoders first (base/hex/url)
- script nested archive unpacking to save time
- always capture evidence for failed attempts too
- stop when partial flag appears; sanitize before submit
