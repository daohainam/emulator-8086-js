# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server with HMR
npm run build      # Production build (output to dist/)
npm run lint       # Run ESLint
npm run preview    # Preview production build locally
npm test           # Vitest: CPU, assembler, BIOS, devices, samples (+ SingleStepTests/8086 if downloaded)
```

`npm test` is the safety net for CPU/assembler/BIOS changes. `TEST_ALL=1 npm test` runs the tests listed as known-open
(`OPEN` sets at the top of each test file) as ordinary tests, to see which ones now pass.

## Architecture

This is an Intel 8086 processor emulator with a web-based IDE and debugger, built with React 19 + Vite + Tailwind CSS.

**Source layout:**
- `src/App.jsx` — all UI components, state management, run loop, keyboard handling
- `src/CPU8086.js` — the CPU core: binary decoder (`executeBinaryStep`), `executeStep` (halt / trap flag / interrupt shadow / IRQ delivery), memory helpers, flags, `createEngine`
- `src/Machine.js` — `resetMachine` (the one reset path for Reset/Assemble/Boot), `startProgram`, `bootFromDisk`
- `src/Assembler8086.js` + `src/asm/` — two-pass NASM-compatible assembler (`expression.js` = expression parser, `instructions.js` = instruction table)
- `src/bios/` — BIOS: `rom.js` (ROM image + IVT), `bda.js` (BIOS Data Area), `int10.js` `int13.js` `int16.js` `misc.js` (INT 11h/12h/15h/1Ah, default handlers)
- `src/devices/` — I/O bus and devices (8259 PIC, keyboard controller, speaker, virtual disk)
- `test/` — Vitest suites; `test/singlestep.js` runs the SingleStepTests/8086 hardware vectors
- `bios/` — an old standalone NASM BIOS ROM. **Not loaded** by the emulator (superseded by `src/bios/`); kept for reference

`App.jsx` is structured in three sections marked by comments: constants/utilities, UI sub-components, and the main app.

### CPU State Model

All CPU state lives in a single `useRef` object (`eng`), created by `createEngine()`:
- **Registers:** `reg` — AX, BX, CX, DX, SI, DI, SP (init 0xFFFE), BP, CS, DS, SS, ES, IP
- **Flags:** `flags` — ZF, SF, CF, OF, DF, IF, AF, PF, TF. `packFlags` returns the 8086 image (bit 1 and bits 12-15 set)
- **Memory:** `mem` — 1MB `Uint8Array`; `calcPhys(seg, offset)` converts segment:offset to a 20-bit physical address. CPU writes at `>= ROM_BASE` (0xF0000) are ignored; host-side writes use `writeMem8Safe`, which bypasses the protection
- **Disks:** `disk` — 128KB virtual hard disk; `floppy` — 1.44MB image
- **Model/state:** `cpuModel` (`'8086'` default, or `'186'`), `halted` (idle after HLT), `inhibitIRQ` (STI / MOV SS / POP SS shadow), `hle` (BIOS callback table), `fault` (message for a fatal exception)

A `forceRender()` function (dummy `useState` counter) is called after each frame/step to update the UI without putting CPU state in React state. Screen cursor and video mode live in the BIOS Data Area (`src/bios/bda.js`), not in the engine.

### Single Execution Engine

There is only one execution engine: the **Hardware X86 Binary Decoder** (`executeBinaryStep`). It decodes real x86 machine code byte-by-byte from `mem` using CS:IP.

- **Default = strict 8086**: no shift-count masking, `PUSH SP` pushes `SP-2`, `IDIV` faults on quotient `0x80`/`0x8000`, undocumented aliases (`60-6F`→Jcc, `C0/C1`→RET, `C8/C9`→RETF, `0F`=POP CS, `D6`=SALC, `F1`=LOCK, shift `/6`=SETMO) and no `#UD`. Word accesses wrap inside the segment (`readWordSeg`/`writeWordSeg`).
- **`cpuModel = '186'`** enables PUSHA/POPA, ENTER/LEAVE, PUSH imm, IMUL imm, BOUND, INS/OUTS, shifts by imm8, masks shift counts, and raises INT 6 on undefined opcodes. Gate any 186 behaviour with `is186`.
- `executeStep` wraps it: idle while `halted`, single-step trap (TF → INT 1), interrupt shadow, then hardware IRQ delivery from the PIC. It returns `false` when the CPU must stop: **HLT with IF=0 or no unmasked IRQ source**, or a fatal exception. Otherwise HLT sets `halted` and the CPU sleeps until an IRQ.
- `INT n` **always** vectors through the IVT (`raiseInt`, which clears IF and TF). There are no JS special cases for 10h/13h/16h.

### BIOS (HLE through the IVT)

`resetMachine` (Machine.js) rebuilds RAM, installs the ROM (`installRom`), initialises the BDA and the IVT, resets the devices, and parks the CPU at the reset vector `FFFF:0000` (JMP FAR to an idle HLT in ROM).

Each BIOS service is a 4-byte ROM stub in segment F000 — `FE 38 <id>` then `CF` (IRET). `FE /7` is an undefined 8086 encoding, used here as a **host callback**: the CPU runs `e.hle[id](e, ctx)` (JavaScript). A handler may return `'retry'` (blocking service: the stub re-runs with IF=1) or `'stop'` (fatal: stops the run loop, message in `e.fault`). CF/ZF results are merged into the stacked FLAGS so the following IRET delivers them. To add a service: write the handler in `src/bios/`, register its id in `HLE_ID`/`HANDLERS`/`VECTOR_SERVICES` in `rom.js`.

Unused vectors point at a dummy IRET (`F000:FF53`); vectors 08h–0Fh acknowledge the PIC (EOI); INT 0 and 6 are fatal.

### Assembly Flow

1. User writes NASM-compatible x86 assembly in the `CodeEditor`
2. Clicking **Assemble** calls `assemble()` in `App.jsx`, which:
   - Reads the **ORG (Origin)** input field and the **CPU** selector as *fallbacks*
   - Calls `assembler.assemble(code, { origin: fallbackOrg, cpu })` → returns a `Uint8Array`
   - Reads the real load address from `assembler.origin` and the required CPU level from `assembler.cpu` — an `ORG` / `cpu` directive in the source wins. These are **never** re-derived by regex-matching the source text; the assembler is the single source of truth.
   - Calls `resetMachine` (via `resetCPU`), then `startProgram(e, binary, origin)` → `CS = 0x0000`, `IP = origin`
   - Sets `eng.cpuModel = assembler.cpu` and logs `assembler.warnings`
3. The user can then **Run** or **Step** through the binary decoder

### Key Functions

| Function | Purpose |
|---|---|
| `assemble()` (App) | Assemble, reset the machine, load the program, set CS:IP and CPU model |
| `executeStep(e, ctx)` | One CPU step incl. halt/trap/IRQ handling; `ctx = { bus, pic, keyboard }` |
| `executeBinaryStep(e, ctx)` | Decode and execute one real x86 instruction |
| `raiseInt(e, vector)` | Interrupt entry: push FLAGS/CS/IP, clear IF+TF, load from IVT |
| `resetMachine(e, { bus })` | Power-on: RAM, ROM, IVT, BDA, devices, reset vector |
| `runLoop()` (App) | `requestAnimationFrame` loop with a time-based instruction budget (speed selector; ≤12 ms per frame) |
| `stepUI()` (App) | Executes one step, logs `CS:IP | bytes` to System Logs |
| `push16(e, v)` / `pop16(e)` | Stack operations using SS:SP |
| `packFlags(e)` / `unpackFlags(e, val)` | Serialize/deserialize FLAGS |
| `handleKeyDown/Up` (App) | Browser key → (ASCII, scan code): BDA buffer via `enqueueKey` + scan code on port 0x60 + IRQ1 pulse |

### Assembler8086.js

```js
const assembler = new Assembler8086();
const binary = assembler.assemble(sourceCode);                          // Uint8Array
const binary2 = assembler.assemble(src, { origin: 0x100, cpu: '186' }); // fallbacks when the source has no ORG / cpu directive
assembler.origin;    // address the emitted bytes belong at — load them here
assembler.cpu;       // '8086' | '186': CPU level the program needs
assembler.warnings;  // non-fatal diagnostics, e.g. an immediate that does not fit its operand
```

Pipeline: preprocess (`%define` only; other `%` directives are errors) → **pass 1** (layout + symbol table; operand expressions stay symbolic, a not-yet-defined symbol makes the operand `unresolved` which always selects the wide 16-bit encoding) → **relaxation** (short `JMP`s that do not reach become near; pass 1 repeats until nothing changes) → **pass 2** (resolve expressions, encode, verify sizes).

- Instruction table in `src/asm/instructions.js`: ordered rules per mnemonic with operand classes (`rm8`, `rm16`, `m8`, `m16`, `m32`, `moff16`, `imm`, `one`, ...) and `enc` functions; `cpu: '186'` gates 186 rules; an unsized memory operand that could be a byte or a word is an **error** (NASM behaviour). `size` is derived from `enc`, so size and encoding cannot drift.
- Expressions in `src/asm/expression.js`: NASM operators, `$`/`$$`, labels, `.local` labels; no `eval`/`Function`.
- Symbols are case-insensitive (stored upper-case); duplicates are errors.
- `origin` is the `ORG` in effect when the first byte was emitted, or `options.origin` when the source declares no `ORG`. Read it after every `assemble()` call.

### VGA Display

`VGAMonitor` renders an 80×25 grid by reading `mem` at the active text page (0xB8000 + page × 4 KB, page from the BDA). Each cell is two bytes: ASCII code + color attribute (low nibble = foreground, high nibble = background) using `DOS_COLORS`. `INT 10h` (src/bios/int10.js) keeps cursor/mode in the BDA; blanks are SPACE with the requested attribute; teletype keeps the attribute already on screen.

### I/O Ports

- **Port 0x20/0x21:** 8259 PIC
- **Port 0x60 / 0x64:** keyboard controller — scan codes (make; break = make|0x80) / status
- **Port 0x61 / 0x42:** PC speaker (Web Audio square wave); frequency from the timer 2 divisor
- **Port 0x70 / 0x71:** virtual disk block select / transfer (16-byte blocks; collides with the AT CMOS — prefer INT 13h)
- Unclaimed ports read `0xFF`. There is no PIT/IRQ0 yet (INT 1Ah and BDA 0x46C follow the host clock)

### UI Sub-components

| Component | Purpose |
|---|---|
| `HeaderControls` | Toolbar: Audio, Boot, Assemble, Reset, Speed, Run/Stop, Step |
| `CodeEditor` | Plain textarea with ORG offset input and CPU selector |
| `VGAMonitor` | 80×25 VGA text display (a keyboard-capture region) |
| `KeyboardPanel` | Keyboard buffer view and "Type here" field (keyboard-capture region) |
| `DiskViewer` | Hex view of the virtual disk |
| `MemoryViewer` | 8-row × 16-byte hex editor at any seg:offset; supports file load |
| `RegistersPanel` | Editable registers, live flags, CPU/BIOS status, system logs |

Keys are handled by one handler on the root element and only when focus is inside a `data-kbd-capture` element.

### UI Language

Internal comments and some UI labels are in Vietnamese. The default demo program (`DEFAULT_CODE`) is a NASM-compatible "Hello 8086" example that writes colored characters directly to VGA VRAM.

### BIOS Interrupt simulation

Refer to this document: `http://www.techhelpmanual.com/95-interrupts_and_bios_services.html` for BIOS interrupt services

### Testing

- `test/helpers.js`: `makeEngine`, `makeMachine` (with BIOS), `loadProgram`, `runToStop`, `asmHex`, `makeRegistrar` (known-open defects as `it.fails`)
- Add a regression test with every CPU/assembler/BIOS fix. 8086 behaviour should be checked against SingleStepTests where possible.
- SingleStepTests/8086 data is untrusted input and large: keep it in `test/data/` (git-ignored), never commit it.

### Assembly samples

Defaults:
  - ORG 100h
  - Use HLT instruction to stop program (HLT with interrupts disabled, or with no unmasked IRQ, stops the emulator)
  - Only use interrupt 0x10, 0x13 and 0x16 (0x11, 0x12, 0x15, 0x1A also exist)
  - Prefer using VGA memory (0xB800:0x0000) to write to screen
