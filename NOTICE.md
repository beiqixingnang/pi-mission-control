# Attribution

Pi Mission Control combines local extensions developed for this project with code adapted from the MIT-licensed Pi project and its extension examples, including the subagent example and custom compaction patterns.

Upstream: https://github.com/earendil-works/pi

Pi and its host-provided libraries remain separate runtime installations. Runtime libraries are declared as peer dependencies and resolved by the Pi extension loader; published npm packages and their installed dependencies are not bundled into the plugin package.

The Git repository also contains an unmodified Pi 1.3.0 source snapshot under `vendor/pi-1.3.0/`. Its original MIT license and copyright notice are retained at `vendor/pi-1.3.0/LICENSE` (Copyright (c) 2025 Mario Zechner). See `vendor/README.md` for the archive identity and checksum. This source snapshot is excluded from the plugin's npm package and does not replace the installed Pi runtime.
