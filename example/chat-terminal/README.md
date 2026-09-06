# chat-terminal

A p2p chat CLI on `@cero-base/cero` and `chat-backend`. One file, no transport, no UI framework: the best place to read the API in use.

## Usage

```
node index.js [--name <name>] [--storage <dir>]                 create a room and print an invite
node index.js --join <invite> [--name <name>] [--storage <dir>]  join a room
node index.js --phrase "<words>" --storage <dir>                   recover your identity on this machine
node index.js --help
```

Storage defaults to a fresh temporary directory, so each run is a fresh identity. Pass `--storage <dir>` to keep your identity and rooms across runs. `--bootstrap host:port,...` (or the `CERO_BOOTSTRAP` environment variable) points the DHT at custom bootstrap nodes; the test uses it with a local testnet.

## Try it

Terminal A:

```
node index.js --name alice
# invite (share to add peers):
yry15qszb93m...
```

Terminal B:

```
node index.js --join yry15qszb93m... --name bob
```

Type a line and press enter to send. `/invite` prints a fresh invite, `/quit` exits.

## Recover on another machine

The first run prints your phrase:

```
# phrase (keep it, it recovers you on another machine): word word word ...
```

On another machine, with the first one still running, that phrase makes it your device too. It gets its own writer, pulls your rooms and messages, and reopens your room:

```
node index.js --phrase "word word word ..." --storage ./me --name laptop-2
```

Nothing is created twice. If none of your machines is reachable the open fails with `TIMED_OUT` rather than start a second history.

## Tests

```
npm test
```

Spawns two `chat-terminal` processes on a local hyperswarm testnet, pairs them through the invite, and checks that each side sees the other's message.
