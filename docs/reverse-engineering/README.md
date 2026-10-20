# Reverse engineering in SUPER

`super investigate <path> [--query=text] [--json]` collects read-only static evidence from local JavaScript, TypeScript, and HTML files. It reports module imports and exports, route registrations, Electron IPC names, and matching text with a relative path, line, column, and SHA-256 digest of the source file. It skips symbolic links and dependency/build folders; file count and size are bounded. The target is never loaded or executed.

This is an original first capability inspired by the investigation model described in [REA](https://github.com/morluto/rea). It does not contain REA code or install REA. A finding is a clue tied to source bytes, not a verified behavioral reconstruction. Inspect the evidence, trace the relevant flow manually, then design and test an independent implementation for SUPER. Do not infer runtime behavior solely from matches.

Later adapters can add native analysis, saved captures, browser observation, and controlled runtime inspection through the existing authorization and execution contracts. Those capabilities are not implemented here.
