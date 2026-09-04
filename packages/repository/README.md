# Repository store

This package is Factory's only writer under `.factory`. It checks the root
manifest before any broader read or mutation, writes immutable records through
atomic create-only operations, and preserves content it does not own.

Callers provide contract-owned paths rather than filesystem strings. Runtime
state and Git operations remain outside this boundary; object and record
verification must be reproducible from the committed tree alone.
