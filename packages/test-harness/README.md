# Test harness

This package owns tests that cross machine or process boundaries: disposable
Docker environments, crash labs, provider fixtures, release-shaped journeys,
and sanitized evidence reports. Production packages expose the narrow seams;
the harness proves those seams against real boundary behavior.

Provider credentials are never implicit. Authenticated journeys require
dedicated test inputs and must report unavailable authority rather than reuse a
developer's live provider home. Generated scratch reports stay outside the
repository unless a spec deliberately promotes them into its `assets/`; the
default lab output is written under the operating system's temporary directory.
