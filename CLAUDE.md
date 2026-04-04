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

**The entire emulator lives in a single file: `src/App.jsx`.** There is no separation into modules — the assembler, CPU engines, and UI are all in one file, structured in three sections marked by comments: constants/utilities, UI sub-components, and the main app + CPU core logic.

### CPU State Model

All CPU state lives in a single `useRef` object (`eng`):
- **Registers:** `reg` — AX, BX, CX, DX, SI, DI, SP (init 0xFFFE), BP, CS, DS, SS, ES, IP
- **Flags:** `flags` — ZF, SF, CF, OF, DF, IF (init 1), AF, PF
- **Memory:** `mem` — 1MB `Uint8Array`; `calcPhys(seg, offset)` converts segment:offset to 20-bit physical address
- **Disk:** `disk` — 64KB `Uint8Array` (virtual disk, 32 sectors × 512 bytes in viewer)
- **I/O ports:** `ioPorts` — plain object keyed by port number

A `forceRender()` function (dummy `useState` counter) is called explicitly after each step to update the UI without putting CPU state in React state.

### Two Execution Engines

The active engine is tracked by `execMode` state (`"AST"` or `"BIN"`).

1. **AST Interpreter (`executeAstStep`)** — `assemble()` parses text into an instruction object array (`insts`) + `labels` map. `executeAstStep()` walks the array by index (IP = array index, not byte address). Supports a core subset: MOV, ADD, SUB, CMP, INC, DEC, PUSH, POP, CALL, RET, JMP, JZ/JE, JNZ/JNE, LOOP, IN, OUT, INT, HLT, plus REP-prefixed string ops.

2. **Hardware X86 Decoder (`executeBinaryStep`)** — Decodes real x86 machine code byte-by-byte from `mem` using CS:IP. Activated by the **Boot** button or by loading a binary file into memory. Supports the full 8086 instruction set including ModRM, segment overrides, and REP prefixes.

Loading a `.bin`/`.hex`/`.com`/`.exe` file automatically switches `execMode` to `"BIN"`.

### Key Functions

| Function | Purpose |
|---|---|
| `assemble()` | Parses assembly source into `insts[]` + `labels{}` |
| `executeAstStep()` | Executes one AST instruction (AST engine) |
| `executeBinaryStep()` | Decodes and executes one real x86 opcode (hardware engine) |
| `runLoop()` | `requestAnimationFrame` loop; calls the active engine per frame |
| `getOpVal(e, op)` / `writeOpVal(e, dst, val)` | Resolve and write operand values (registers, memory, immediates) |
| `resolveOffset(e, expr)` | Handle addressing modes (direct, register indirect, based, indexed) |
| `push16(e, v)` / `pop16(e)` | Stack operations using SS:SP |
| `packFlags(e)` / `unpackFlags(val)` | Serialize/deserialize flags register |
| `handleOut(port, val)` | Handle OUT instruction — port 0x61 drives PC speaker |
| `bootFromDisk()` | Copies assembled code to disk, verifies 0xAA55, switches to BIN mode |
| `handleLoadMemory(addr, data, name)` | Loads file bytes into `mem`, switches to BIN mode |

### VGA Display

`VGAMonitor` renders an 80×25 grid by reading `mem` at physical address 0xB8000. Each cell is two bytes: ASCII code + color attribute (low nibble = foreground, high nibble = background) using `DOS_COLORS` (16-color palette). `INT 10h AH=0Eh` (TTY output) is handled in `executeAstStep` and writes to VGA via `writeToVGA()`.

### I/O Ports

- **Port 0x60:** Keyboard input
- **Port 0x61:** PC speaker — bits control timer 2 gate and speaker gate; frequency is derived from the timer 2 countdown written via consecutive OUT calls. Uses Web Audio API square-wave oscillator.

### UI Sub-components

| Component | Purpose |
|---|---|
| `HeaderControls` | Toolbar: Audio, Boot, Assemble, Reset, Run/Stop, Step buttons |
| `CodeEditor` | Textarea with active-line highlight overlay, ORG offset input, Keep RAM checkbox |
| `VGAMonitor` | 80×25 VGA text display |
| `DiskViewer` | Hex view of virtual disk sectors 0–31 |
| `MemoryViewer` | 8-row × 16-byte hex editor at any seg:offset; supports file load |
| `RegistersPanel` | Editable registers, live flags, BIOS status, system logs |

### UI Language

Internal comments and some UI labels are in Vietnamese. The default demo program (`DEFAULT_CODE`) writes a multicolor "Hello 8086" string directly to VGA VRAM.
