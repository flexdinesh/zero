# 0150: Copy the connect command on `--remote`

- Status: Accepted
- Date: 2026-11-15
- Extends: [0098](0098-remote-connections.md)

## Context

`zero <path> --remote` prints `zero connect <string>`, usually in an SSH
session, and the person copies it by hand to their computer. A command running
on the server cannot reach the computer's clipboard, except through the
terminal: OSC 52 asks the terminal to set its clipboard, and it travels through
SSH. Native tools (`pbcopy`, `wl-copy`, `xclip`) would copy on the server.

## Decision

- `zero <path> --remote` writes the printed `zero connect <string>` to stdout
  as OSC 52 (`ESC ]52;c;<base64> BEL`) when stdout is a terminal and `TERM` is
  not `dumb`, and prints `copied to your clipboard (if your terminal allows OSC
  52).` under the command. OSC 52 reports nothing back, so the notice hedges.
- Multiplexers: inside tmux (`$TMUX`) the sequence goes raw and again wrapped
  in DCS passthrough (`ESC Ptmux;`, ESC doubled, `ESC \`), so either
  `set-clipboard on` or `allow-passthrough on` works; the copies are identical.
  Inside GNU screen (`$STY`) it goes in DCS chunks of at most 76 bytes, under
  screen's 768-byte limit. Zellij and plain terminals take it raw.
- `--no-copy` turns it off; it needs `--remote`.
- Only startup copies. `zero remote status` and `rotate` print the command and
  copy nothing; `--tailscale` prints a URL and copies nothing.

## Consequences

- The string is a password, and clipboard managers keep history; `--no-copy`
  is the opt-out.
- Terminals without OSC 52 (GNOME Terminal and other VTE terminals, Apple
  Terminal), tmux with neither setting, and iTerm2 without clipboard access
  allowed copy nothing; the notice says it may not have worked.
- tmux inside tmux gets one level of wrapping only.
