# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server with HMR
npm run build      # Production build (output to dist/)
npm run lint       # Run ESLint
npm run preview    # Preview production build locally
```

No test suite is configured.

## Architecture

This is an Intel 8086 processor emulator with a web-based IDE and debugger, built with React 19 + Vite + Tailwind CSS.

**The emulator is split across two source files:**
- `src/App.jsx` — all UI components, CPU state, and the hardware binary decoder engine
- `src/Assembler8086.js` — standalone two-pass NASM-compatible x86 assembler that compiles source text to a `Uint8Array` of machine code

`App.jsx` is structured in three sections marked by comments: constants/utilities, UI sub-components, and the main app + CPU core logic.

### CPU State Model

All CPU state lives in a single `useRef` object (`eng`):
- **Registers:** `reg` — AX, BX, CX, DX, SI, DI, SP (init 0xFFFE), BP, CS, DS, SS, ES, IP
- **Flags:** `flags` — ZF, SF, CF, OF, DF, IF (init 1), AF, PF
- **Memory:** `mem` — 1MB `Uint8Array`; `calcPhys(seg, offset)` converts segment:offset to 20-bit physical address
- **Disk:** `disk` — 64KB `Uint8Array` (virtual disk, 32 sectors × 512 bytes in viewer)
- **I/O ports:** `ioPorts` — plain object keyed by port number

A `forceRender()` function (dummy `useState` counter) is called explicitly after each step to update the UI without putting CPU state in React state.

### Single Execution Engine

There is only one execution engine: the **Hardware X86 Binary Decoder** (`executeBinaryStep`). It decodes real x86 machine code byte-by-byte from `mem` using CS:IP and supports the full 8086 instruction set including ModRM, segment overrides, and REP prefixes.

The old AST interpreter has been removed. All execution goes through the binary decoder.

### Assembly Flow

1. User writes NASM-compatible x86 assembly in the `CodeEditor`
2. Clicking **Assemble** calls `assemble()` in `App.jsx`, which:
   - Detects any `ORG` directive in the source to determine the load address
   - Falls back to the **ORG (Origin)** input field value if no `ORG` directive is present
   - Calls `new Assembler8086().assemble(sourceCode)` → returns a `Uint8Array`
   - Loads the binary into `eng.current.mem` at the correct address
   - Sets `CS = 0x0000`, `IP = loadAddress`
3. The user can then **Run** or **Step** through the binary decoder

### Key Functions in App.jsx

| Function | Purpose |
|---|---|
| `assemble()` | Calls Assembler8086, loads binary into memory, sets CS:IP |
| `executeBinaryStep()` | Decodes and executes one real x86 opcode (hardware engine) |
| `executeStep()` | Thin wrapper — just calls `executeBinaryStep()` |
| `runLoop()` | `requestAnimationFrame` loop; calls `executeStep()` ~20× per frame |
| `stepUI()` | Executes one step, logs `CS:IP | bytes` to System Logs |
| `push16(e, v)` / `pop16(e)` | Stack operations using SS:SP |
| `packFlags(e)` / `unpackFlags(val)` | Serialize/deserialize flags register |
| `handleOut(port, val)` | Handle OUT instruction — port 0x61 drives PC speaker |
| `bootFromDisk()` | Copies disk sector 0 to 0x7C00, verifies 0xAA55, runs from there |
| `handleLoadMemory(addr, data, name)` | Loads file bytes into `mem` |

### Assembler8086.js

A two-pass NASM-compatible assembler exported as `export { Assembler8086 }`.

```js
const binary = new Assembler8086().assemble(sourceCode); // returns Uint8Array
```

**Pass 1** — builds the symbol table (labels → addresses) and calculates instruction sizes.
**Pass 2** — encodes each instruction to bytes using the symbol table for label resolution.

Key features:
- All labels stored uppercase for case-insensitive resolution
- `ORG` / `.ORG` directive (also `[ORG ...]` bracketed form)
- `DB` / `DW` data directives (strings, hex `0xNN` / `NNh`, decimal, char literals `'A'`)
- `TIMES N DB/DW val` — repeat directive; supports `$` (current address) and `$$` (section base)
- Segment overrides: `ES:[DI]`, `[CS:BX+SI]`, etc.
- Addressing modes: all 8086 modes — `[BX+SI]`, `[BP+DI+10]`, `[disp16]`, etc.
- `BYTE` / `BYTE PTR` / `WORD` / `WORD PTR` size specifiers
- Disambiguation: when a register operand determines memory size, the correct rule is chosen automatically

### VGA Display

`VGAMonitor` renders an 80×25 grid by reading `mem` at physical address 0xB8000. Each cell is two bytes: ASCII code + color attribute (low nibble = foreground, high nibble = background) using `DOS_COLORS` (16-color palette). `INT 10h` BIOS video services are handled inside `executeBinaryStep`.

### I/O Ports

- **Port 0x60:** Keyboard input
- **Port 0x61:** PC speaker — bits control timer 2 gate and speaker gate; frequency is derived from the timer 2 countdown written via consecutive OUT calls to port 0x42. Uses Web Audio API square-wave oscillator.
- **Port 0x70:** Virtual disk sector select
- **Port 0x71:** Virtual disk transfer (1 = read sector to DS:BX, 2 = write DS:BX to sector)

### UI Sub-components

| Component | Purpose |
|---|---|
| `HeaderControls` | Toolbar: Audio, Boot, Assemble, Reset, Run/Stop, Step buttons |
| `CodeEditor` | Plain textarea with ORG offset input, Keep RAM checkbox |
| `VGAMonitor` | 80×25 VGA text display |
| `DiskViewer` | Hex view of virtual disk sectors 0–31 |
| `MemoryViewer` | 8-row × 16-byte hex editor at any seg:offset; supports file load |
| `RegistersPanel` | Editable registers, live flags, BIOS status, system logs |

### UI Language

Internal comments and some UI labels are in Vietnamese. The default demo program (`DEFAULT_CODE`) is a NASM-compatible "Hello 8086" example that writes colored characters directly to VGA VRAM.
