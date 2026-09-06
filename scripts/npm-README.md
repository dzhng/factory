# Factory

Capture native Codex and Claude Code Sessions, review their evidence in isolated
Docker containers, and keep decisions beside code in Git.

```sh
npm install -g @dzhng/factory
factory install
```

The package includes self-contained executables for macOS arm64 and glibc Linux
x64. Node 22 or newer launches the selected executable; Bun is not required.
Docker is required for reviews, with an existing Codex or Claude CLI login.
`factory install` explicitly enables provider hooks. Installing the npm package
alone does not change provider settings or capture repository evidence.

Use `factory upgrade` to update a global npm installation, or `factory upgrade
--check` to check without installing. Normal work commands also check npm and
install newer stable releases automatically; the next invocation uses the new
binary. Offline checks and failed upgrades do not prevent the requested command.
Use `--no-auto-upgrade` or `FACTORY_NO_AUTO_UPGRADE=1` to skip automatic upgrades,
or disable checks persistently with `factory configure --global --update-checks false`.
Capture hooks, automatic-review workers, version queries, configuration,
diagnostics, and uninstall never auto-upgrade. Source checkouts, project-local
installs, and non-npm package managers are not automatically modified.

Run `factory uninstall` before removing the package to remove its owned hooks.

Captured evidence is plaintext and intended for Git; it may contain secrets.
Read [the security model](https://github.com/dzhng/factory/blob/main/SECURITY.md)
before enabling capture. See [the project](https://github.com/dzhng/factory) for
the architecture and documentation.
