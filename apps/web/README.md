# RCC Web Console (Experimental)

The public alpha setup path is Telegram-first. This web console code remains in the repository for ongoing development, but it is not documented as the public onboarding path.

Do not use the web console in public docs or launch claims until it passes fresh security review and end-to-end browser testing for the current branch.

Current boundary:

- Telegram is the supported public operator surface.
- Web control requires explicit local configuration and a private token.
- Hosted relay requires separate deployment, bearer tokens, durable storage verification, and security review.
- Web/relay must not receive Codex/OpenAI credentials.
