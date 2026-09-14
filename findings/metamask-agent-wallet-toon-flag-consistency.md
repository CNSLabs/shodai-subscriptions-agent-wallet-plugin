# Plugin management advertises but rejects TOON output

## Impact

`mm plugins --help` advertises `--toon` as a global output flag, but
`mm plugins --toon` rejects it. An agent following the CLI's own help incurs a
failed command and must retry with JSON or text. No wallet state or funds are at
risk.

## Reproduction

This was reproduced with clean installations of Agent Wallet 6.2.0 and 6.2.1:

```sh
mm plugins --help
mm plugins --toon
```

The help output lists `--toon` and describes the available formats as `text`,
`json`, and `toon`. The command exits with status 1 and returns:

```yaml
ok: false
error:
  code: UNKNOWN
  message: "Nonexistent flag: --toon"
```

The plugin-management command defines `--json` and `--core`, but not the
advertised TOON shorthand.

## Expected behavior

Global flags shown by a command's help should be accepted by that command.
Either plugin management should support TOON output or its help should not
advertise `--toon` there.

## Workaround

Use `mm plugins --json` when machine-readable plugin information is required.
