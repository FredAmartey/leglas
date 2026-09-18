# Security

Leglas is a development tool. It runs on your machine, proxies the dev
server you are already running and never ships to production. The parts
that face anything beyond localhost are the share listener and the tunnel
it borrows, so those are where a report matters most, but anything that
lets a page, a viewer or a request do more than it should is in scope.

## Supported versions

The latest release on npm. A fix goes out as a new version; older versions
are not patched.

## Reporting a vulnerability

Use GitHub's private reporting:
[github.com/FredAmartey/leglas/security/advisories/new](https://github.com/FredAmartey/leglas/security/advisories/new).
Do not open a public issue for something exploitable.

Say what you found, how to reproduce it and what it lets someone do. You
will hear back from the maintainer. This is a one-person project, so
expect days rather than hours. When the fix ships, the changelog entry
credits you unless you ask it not to.
