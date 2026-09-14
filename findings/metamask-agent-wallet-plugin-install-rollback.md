# Valid npm plugin is removed after installation

## Impact

Agent Wallet reports that `velvet-anvil@0.1.0` was installed, then immediately
removes it and exits successfully. The commands are unavailable afterward. This
blocks the normal npm distribution path and gives both users and automation a
false success signal.

## Reproduction

The following was reproduced independently with Agent Wallet 6.2.0 and 6.2.1,
using a fresh home directory and npm prefix for each run:

```sh
root="$(mktemp -d)"
mkdir -p "$root/home" "$root/prefix"
npm install --prefix "$root/prefix" @metamask/agent-wallet@6.2.1
mm="$root/prefix/node_modules/.bin/mm"

HOME="$root/home" "$mm" config set experimentalPlugins true
HOME="$root/home" "$mm" plugins install velvet-anvil --accept-permissions
```

The install command prints:

```text
@metamask/agent-wallet: Installing plugin velvet-anvil@latest... installed v0.1.0
@metamask/agent-wallet: Uninstalling velvet-anvil... done
```

It exits with status 0. The resulting Agent Wallet data package has no plugin
dependency or Oclif plugin entry, and `mm shodai --help` reports that the command
does not exist.

## Package validation

The published npm tarball contains:

- `oclif.manifest.json` with all four `shodai` commands;
- the compiled command modules under `dist/commands`; and
- the Agent Wallet plugin metadata in `package.json`.

Oclif loads the unpacked package as a valid plugin. Installing it through
Oclif's plugin manager without Agent Wallet's consent hook registers the package
and exposes its commands. These checks narrow the failure to Agent Wallet's
post-install handling rather than a missing manifest or invalid package layout.

## Relevant Agent Wallet behavior

After an approved npm install, Agent Wallet 6.2.0 and 6.2.1 look up the newly
installed plugin in the current Oclif plugin registry using
`config.plugins.get(metadata.name)?.root`. The check is in
`dist/hooks/postrun/pluginConsent.js`. If that lookup does not return a root
containing `oclif.manifest.json`, Agent Wallet uninstalls the package and throws
`PLUGIN_MANIFEST_FILE_MISSING`.

In this reproduction, the manifest exists on disk but the post-install check
does not obtain a usable root from the registry. The evidence does not establish
why the in-memory registry lacks that root, so the exact internal cause remains
an Agent Wallet implementation question.

## Expected behavior

- A valid, approved npm plugin remains installed and its commands are available
  on the next invocation.
- A rejected or rolled-back installation exits nonzero and identifies the
  validation that actually failed.

## Candidate correction

Before treating the manifest as missing, refresh the plugin registry or resolve
the newly installed package from Agent Wallet's data-directory `node_modules`
path, then validate the manifest there. Agent Wallet's local-plugin handling
already uses a data-directory fallback when a registry root is unavailable.
The fallback should still validate the exact approved package and version.
