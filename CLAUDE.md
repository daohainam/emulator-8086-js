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

**The entire emulator lives in a single file: `src/App.jsx` (~700 lines).** There is no separation into modules — the assembler, CPU engine, and UI are all in one monolithic React component.

### CPU Emulation Model

- **State storage:** All CPU state (registers, flags, memory, disk, I/O) is held in a `useRef` object (`cpuRef`) so it persists across renders without triggering re-renders.
- **Manual re-render:** A `forceRender()` function (via a dummy `useState` counter) is called explicitly after each step to update the UI.
- **Memory:** 1MB `Uint8Array` with segmented addressing — `calcPhys(seg, offset)` converts segment:offset to a 20-bit physical address.
- **Disk:** 64KB `Uint8Array` simulating a virtual disk.

### Two Execution Modes

1. **Assembly mode** — `assemble()` parses text into instruction objects, then `executeStep()` interprets them. This is the primary mode for the code editor.
2. **Boot mode** — `bootFromDisk()` writes raw opcodes to the disk image and executes them directly (requires 0xAA55 boot signature). Triggered by the boot-from-disk button.

### Key Functions

| Function | Purpose |
|---|---|
| `assemble()` | Parses assembly source into instruction array + labels map |
| `executeStep()` | Executes one instruction (20+ opcodes supported) |
| `runLoop()` | `requestAnimationFrame` loop for continuous execution |
| `getOpVal()` / `writeOpVal()` | Resolve and write operand values (registers, memory, immediates) |
| `resolveOffset()` | Handle addressing modes (direct, register indirect, based, indexed) |
| `push16()` / `pop16()` | Stack operations using SS:SP |
| `packFlags()` / `unpackFlags()` | Serialize/deserialize flags register for PUSHF/POPF/IRET |

### VGA Display

Renders an 80×25 text mode grid by reading from virtual memory at 0xB8000. Each character cell is two bytes: ASCII code + color attribute (foreground/background from the 16-color DOS palette).

### I/O Ports

- **Port 0x60:** Keyboard input
- **Port 0x61:** PC speaker control (Web Audio API oscillator)

### Supported Instructions

MOV, ADD, SUB, MUL, DIV, CMP, AND, OR, XOR, NOT, SHL, SHR, SAL, SAR, ROL, ROR, LOOP, JMP, JZ/JE, JNZ/JNE, CALL, RET, PUSH, POP, PUSHF, POPF, INT, IRET, INC, DEC, OUT, IN, HLT, NOP

### UI Language

The default code example and some UI labels are in Vietnamese.
