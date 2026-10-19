# Conversation archive research (2026-10-19)

This is an isolated feasibility experiment, not a Pi extension or an installed
export command. Production runtime, settings, ownership and version are unchanged.

The light UI uses only synthetic messages/goals. The large benchmark reads the
original historical log without retaining its body. The token benchmark is **not
a complete public-export policy**, lineage resolver, branch projector or archive
generator. The preview builder generates synthetic shards, not a real export.

Detailed design and limits: [research report](../../docs/design/mission-control-v2/CONVERSATION-ARCHIVE-RESEARCH.md).

## Reproduce

Install this isolated directory with `npm ci --ignore-scripts --no-audit --no-fund`.
From the repository root, choose unused output paths:

```sh
node --max-old-space-size=128 experiments/conversation-export/stream-bench.mjs generate .reference/export-test/giant.jsonl .reference/export-test/expected.json
node --max-old-space-size=128 experiments/conversation-export/stream-bench.mjs scan .reference/export-test/giant.jsonl .reference/export-test/result.json sink
node experiments/conversation-export/build-preview.mjs .reference/export-test/preview .reference/export-test/result.json.body.bin
```

Compare expected `sha256/textBytes` to result `textSha256/textBytes` and to the
streamed output file. The fixture includes a single >128 MiB visible string,
another 128 MiB extension string, escaped HTML, Chinese, emoji, LF and Unicode
separators, and an incomplete final JSONL record.

For a real log, use `scan <file> <report.json>` without `sink`: only hashes/counts
are produced. The reader freezes the last complete LF prefix at the original
EOF. It does not coordinate a global snapshot across other files or a database.

The preview works with ordinary local HTTP hosting. In this environment Browser
blocked file-protocol navigation; **file double-click compatibility has not been
verified**. It needs no external CDN. Classic-script shards contain strictly
encoded JSON data; displayed body uses textContent. Prototype search scans shards
with bounded application cache; production should index text and must separately
measure actual browser heap/RSS, not infer it from a small Map.

The generated artifacts, logs and large fixtures belong under ignored
`.reference/`, not in the package. Do not point a preview server at the entire
repository or at the user's real session directory.
