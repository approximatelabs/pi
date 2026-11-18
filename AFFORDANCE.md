# pi with an Affordance agent core

This is [pi](https://github.com/earendil-works/pi) 1.5.1, a coding agent for the terminal, with one
change. The agent core, the loop that builds what the model reads, calls the model and runs its
tools, is an [Affordance](https://github.com/approximatelabs/affordance) app:
`packages/agent/affordance/app.tsx`. Everything else is pi: the interface, settings, models,
themes, extensions and sessions.

Each session's agent is journaled, so stopping pi and starting it again continues the session
where it was. The journals are under `~/.pi/agent/affordance/`. More on
[affordance.rs/showcase/pi](https://affordance.rs/showcase/pi).

## Running it

pi needs Node.js 22.19 or newer. Install the `affordance` command, then build pi from this branch:

```sh
cargo install affordance
git clone -b affordance https://github.com/approximatelabs/pi && cd pi
npm install --ignore-scripts
npm run build
node packages/coding-agent/dist/cli.js
```

Every pi option works. For example, with an OpenRouter key in `OPENROUTER_API_KEY`:

```sh
node packages/coding-agent/dist/cli.js --provider openrouter --model qwen/qwen3-32b
```

`PI_AGENT_CORE=pi` runs pi's own agent loop instead.

This branch is kept on pi 1.5.1. It does not follow pi's releases.
