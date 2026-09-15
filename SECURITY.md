# Security policy

## Supported versions

Maprama is pre-1.0. Security fixes are made on `main` and released in the
latest `0.x` version only.

## Reporting a vulnerability

Please **do not** open a public issue, discussion or pull request for a
security problem.

Report it privately through GitHub security advisories:
<https://github.com/CraftsManShip001/maprama/security/advisories/new>
(the repository's **Security** tab → **Report a vulnerability**).

Include the affected package and version, a description of the issue, steps
to reproduce and, if you have one, a suggested fix. We aim to acknowledge a
report within a week and will keep you updated until it is resolved. Once a
fix is released we publish an advisory and credit you unless you prefer
otherwise.

Examples of issues we care about: a page other than the engine document being
able to run inside the WebView host or forge engine events (such as
`drop:collect`), bypasses of drop collection verification in the hosted
service, and injection through world data, labels or model URLs.
