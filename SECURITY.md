# Security policy

## Supported versions

Security fixes are applied to the current `main` branch and the latest published release. Older releases should be upgraded before requesting a backport.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the repository host's private security-advisory channel or contact the maintainers privately through the project profile. Include reproduction steps, affected versions, impact, and any suggested mitigation. Do not include live credentials or customer data.

You can expect an acknowledgement within five business days. The maintainers will validate the report, coordinate a fix and disclosure timeline, and credit the reporter unless anonymity is requested.

## Scope

Reports are especially useful for:

- authentication bypass or API-key leakage (headers, logs, error messages);
- webhook `X-Signature` verification flaws (timing, encoding, or secret handling);
- PII exposure in logs, errors, persisted reports, or Git history (`input_claims`, `output_claims`, emails, identity document numbers);
- request-construction flaws that could leak one tenant's case data to another.

The project does not accept real secrets in test cases. Use obviously synthetic values (see `test/` for the convention) and never commit a live `CERTN_API_KEY` or webhook secret.
