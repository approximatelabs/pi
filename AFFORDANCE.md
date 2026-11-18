# pi with an Affordance agent core

This is [pi](https://github.com/earendil-works/pi) 1.5.1, a coding agent for the terminal, with one
change. The agent core, the loop that builds what the model reads, calls the model and runs its
tools, is an [Affordance](https://github.com/approximatelabs/affordance) app:
`packages/agent/affordance/app.tsx`. Everything else is pi: the interface, settings, models,
themes, extensions and sessions.

Each session's agent is journaled, so stopping pi and starting it again continues the session
where it was. The journals are under `~/.pi/agent/affordance/`. More on
[affordance.rs/showcase/pi](https://affordance.rs/showcase/pi).

## Install

pia needs Node.js 22.19 or newer, on macOS or Linux. This installs pi 1.5.1 with this agent core,
and the `affordance` command, into `~/.local/share/pia`, and puts `pia` in `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/approximatelabs/pi/affordance/install-pia.sh | sh
```

Then run `pia`. It is pi with every option and setting pi has. For example, with an OpenRouter
key in `OPENROUTER_API_KEY`:

```sh
pia --provider openrouter --model qwen/qwen3-32b
```

`PI_AGENT_CORE=pi pia` runs pi's own agent loop instead. Run the install line again to update.

## Building from this branch

```sh
cargo install affordance
git clone -b affordance https://github.com/approximatelabs/pi && cd pi
npm install --ignore-scripts
npm run build
node packages/coding-agent/dist/cli.js
```

This branch is kept on pi 1.5.1. It does not follow pi's releases.
