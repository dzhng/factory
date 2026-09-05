# Native directory-read regression

The recurring CLI association-review failure originated at the directory
reader's EOF/error distinction. Its `readdir` call returned a pointer or null;
JavaScript separately cleared and read libc's thread-local `errno` to distinguish
normal EOF from failure. Runtime work between those steps could change errno.

A deterministic external-FFI fixture reproduces the exact error with errno 9:
the real native reader reaches EOF, unrelated native work changes errno after
the call, and the old reader rejects the unchanged directory. The new reader
uses bounded native batches whose signed byte count distinguishes data, EOF,
and error directly. It retains directory-descriptor confinement and raw names.

Evidence boundary: 140 naturally repeated exact CLI fixtures did not reproduce
the intermittent failure. The native/runtime action responsible for the original
spontaneous errno value was not captured. The deterministic regression proves
and removes the erroneous dependence on that mutable side channel; it is not a
claim to have captured the spontaneous event.

Verification includes the exact installed-CLI association fixture; the full
repository and CLI package suites; native macOS ordinary-tree, long-name batching,
and confinement cases; and Docker regressions for runtime errno interference,
real native read failure, zero-inode Linux entries, and multi-batch enumeration.
Negative mutations proved that accepting native failures as EOF or reading only
the first batch makes the corresponding regressions fail.

Independent Codex review accepted the native layouts, confinement, bounds, and
EOF/error separation. A subsequent primary-source check additionally pinned the
platform distinction for vacant inode entries.

Platform contracts were checked against [Apple's directory reader](https://github.com/apple-oss-distributions/Libc/blob/main/gen/FreeBSD/readdir.c),
[glibc's batch reader](https://github.com/bminor/glibc/blob/master/sysdeps/unix/sysv/linux/getdirentries64.c),
and [glibc's entry reader](https://github.com/bminor/glibc/blob/master/sysdeps/unix/sysv/linux/readdir64.c).
