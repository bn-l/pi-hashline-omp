# pi-hashline-omp

A [pi coding agent](https://github.com/badlogic/pi-mono) extension that replaces the built-in `read`, `edit`, and `grep` tools with [oh-my-pi](https://github.com/can1357/oh-my-pi)'s hashline editing system.

Powered by [`@oh-my-pi/hashline`](https://www.npmjs.com/package/@oh-my-pi/hashline) (the standalone hashline engine) and a bracket/indentation-based block resolver for syntactic block operations.

## Features

- **Hash-anchored reads** — every line is tagged with a content-derived hash
- **Text-DSL patch language** — `SWAP`, `DEL`, `INS`, `REM`, `MV` operations
- **Syntactic block ops** — `SWAP.BLK`, `DEL.BLK`, `INS.BLK.POST` for brace languages, Python, shell, and Markdown
- **Stale-anchor detection** — edits are rejected if the file changed since your last read
- **Grep with anchors** — search results feed directly into edit calls
- **Atomic writes** — temp-file-then-rename for safety

## Install

```bash
pi install ./pi-hashline-omp
```

## Usage

After installation, the extension automatically overrides `read`, `edit`, and `grep`. Start a new pi session and the hashline system will be active.

### Read

```
read({ path: "src/main.ts" })
```

Returns:
```
[src/main.ts#A1B2]
1:function hello() {
2:  return "world";
3:}
```

### Edit

Copy the `#TAG` from your read output:

```
edit({ input: "[src/main.ts#A1B2]
SWAP 2.=2:
+  return \"hashline\";" })
```

### Block Edit

```
edit({ input: "[src/main.ts#A1B2]
SWAP.BLK 1:
+function hello() {
+  return \"hashline\";
+}" })
```

### Delete / Move

```
edit({ input: "[old.ts#A1B2]
MV new.ts" })

edit({ input: "[junk.ts#A1B2]
REM" })
```

## Test

```bash
bun test
```
