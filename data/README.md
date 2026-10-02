# Runtime state

The control plane writes `state.json` here atomically. It contains tenant
configuration and secret references, never resolved secret values.
