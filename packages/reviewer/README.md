# Reviewer boundary

This package owns the security boundary between a verified review bundle and an
ephemeral Docker reviewer. Mount planning is pure and rejects host-path overlap
or provider-auth targets outside the selected provider's namespace. Execution
then observes the container Docker actually created, rather than treating the
requested arguments as proof.

The reviewer package never discovers repository state, provider credentials, or
review subjects. Upstream code supplies already-verified paths; the test harness
owns fake images, live journeys, and human-readable reports.

