# Pi-only worker container

This is Cairn's upstream Kali worker image with the Claude Code and Codex packages
removed. It installs Pi and copies the benchmark Skills directly to the Pi user
configuration directory at `/home/kali/.pi/agent/skills`.

The image is not built during the baseline-validation phase.
