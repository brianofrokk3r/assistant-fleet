# Local secret files

This directory is mounted read-only at `/run/secrets` in the control plane. Store
secret files here only for local use and reference them with `file:///run/secrets/...`.
All contents other than this README are ignored by Git.
