# pi-fm-bridge

A [pi](https://pi.dev) package that adds Apple's on-device Foundation Model as a provider,
with native tool calling, through [fm-bridge](https://github.com/tomx-sh/fm-bridge).

The model runs locally and costs nothing per token. pi's tools work: the model reads files,
runs commands and edits code, and answers directly when no tool is needed.

## Requirements

- macOS 27 with Apple Intelligence turned on
- `fm-bridge` on your `PATH`:

  ```bash
  git clone https://github.com/tomx-sh/fm-bridge && cd fm-bridge
  scripts/build-sdk.sh
  uv tool install --editable .
  ```

## Install

```bash
pi install git:github.com/tomx-sh/pi-fm-bridge          # follows main
pi install git:github.com/tomx-sh/pi-fm-bridge@v0.1.0   # pinned to a release
```

Or try it for one session with `pi -e git:github.com/tomx-sh/pi-fm-bridge`.

Then pick **Apple On-Device** in `/model`, or start pi with `--model apple-fm/system`.

## Recommended settings

The model has an 8192-token context window. pi's default compaction settings (16K tokens
reserved) are larger than the whole window and would compact after every turn. Add this to
`~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "modelOverrides": {
      "apple-fm/system": { "reserveTokens": 2048, "keepRecentTokens": 2048 }
    }
  }
}
```

## What the extension does

- Registers the provider `apple-fm` with the model `system`, served by fm-bridge on
  `http://127.0.0.1:1977/v1`.
- Starts fm-bridge the first time the model is used and stops it when pi quits. A bridge
  that is already running is reused and left alone.
- Registers the model with no output cap. pi clamps a declared cap to the window minus a
  4096-token margin minus the prompt; in an 8K window that falls to 1 token once the
  conversation passes about 4K tokens.

`/fm status`, `/fm start` and `/fm stop` manage the bridge by hand. Its log is
`$TMPDIR/pi-fm-bridge.log`.

| Variable | Default | Effect |
|---|---|---|
| `FM_BRIDGE_BIN` | `fm-bridge` | Command that starts the bridge |
| `FM_BRIDGE_PORT` | `1977` | Port the bridge listens on |

## Limits

pi's system prompt and tools take about 1,400 tokens, which leaves roughly 6,700 for the
conversation. A single large tool result, such as reading a big file, can exceed the window on
its own; pi then reports a context-length error.

## License

[MIT](LICENSE)
