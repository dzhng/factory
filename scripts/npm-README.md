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

Use `npm update -g @dzhng/factory` to update an npm-managed installation.
Run `factory uninstall` before removing the package to remove its owned hooks.

Captured evidence is plaintext and intended for Git; it may contain secrets.
Read [the security model](https://github.com/dzhng/factory/blob/main/SECURITY.md)
before enabling capture. See [the project](https://github.com/dzhng/factory) for
the architecture and documentation.
