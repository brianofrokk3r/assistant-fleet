#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "$FLEET_GIT_USERNAME" ;;
  *) printf '%s\n' "$FLEET_GIT_TOKEN" ;;
esac
