# Move-session spike (throwaway)

This is the spike for `docs/superpowers/plans/2026-11-02-move-chat-spike.md`. It is deleted before the move-chat build merges.

Build it from `packages/service`: `node ../../spikes/move-session/build.mjs` writes `dist/spike.mjs`.

## Task 2: Windows → Ubuntu PC (owner)

On This PC, copy the bundle and the exported chat to the Ubuntu PC. Use your own SSH user:

```powershell
scp C:\github\personal\threadgarden\.claude\worktrees\remote-machines-4\spikes\move-session\dist\spike.mjs C:\tmp\tg-move-spike.json <you>@192.168.1.101:~/
```

On the Ubuntu PC, over SSH:

```sh
mkdir -p ~/threadgarden/projects/tg-move-spike && git -C ~/threadgarden/projects/tg-move-spike init
N=~/.local/share/threadgarden-headless/current/bin/node
$N ~/spike.mjs resume ~/tg-move-spike.json --cwd ~/threadgarden/projects/tg-move-spike --claude ~/.local/bin/claude
$N ~/spike.mjs resume ~/tg-move-spike.json --cwd ~/threadgarden/projects/tg-move-spike --claude ~/.local/bin/claude --prompt "Spike check 2, no tools: in one line, quote the question I asked you in my previous message."
```

Paste both outputs back. The first must name ORNN-FORGE and the subagent's files. The second must quote the first spike check.

## Task 4: back to This PC (owner, then agent)

On the Ubuntu PC, `~/tg-move-spike.json` is now the chat's store, with the Ubuntu turns in it. Copy it back to This PC:

```powershell
scp <you>@192.168.1.101:~/tg-move-spike.json C:\tmp\tg-move-spike-back.json
```

The agent then resumes it into the original `C:\tmp\tg-move-spike`.

## Tidy up (owner, on the Ubuntu PC)

```sh
rm -rf ~/spike.mjs ~/tg-move-spike.json ~/threadgarden/projects/tg-move-spike
```
