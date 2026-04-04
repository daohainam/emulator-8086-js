# 8086 Emulator

<https://daohainam.github.io/emulator-8086-js/>

A browser-based Intel 8086 CPU emulator with an integrated assembler, debugger, and VGA text mode display. Built with React and Vite.

## Features

- **Two execution engines** — AST interpreter for the code editor, and a true hardware X86 binary decoder for boot/BIN mode
- **Assembler** — Write x86 assembly in the browser editor and run it directly
- **Boot mode** — Assemble code to the virtual disk and boot from it (requires 0xAA55 signature); boot sector loaded at 0x7C00
- **VGA text mode** — 80×25 display with 16-color DOS palette, blinking cursor (VRAM at 0xB8000)
- **Interactive debugger** — Step through instructions; inspect and edit registers, flags, and memory in real time
- **Two memory viewers** — Each navigable to any segment:offset; second viewer toggleable, defaults to VGA VRAM (0xB800:0000)
- **Memory file loading** — Load `.bin`, `.hex`, `.com`, `.exe` files directly into RAM at a chosen segment:offset
- **PC speaker** — Audio output via Web Audio API (I/O port 0x61, frequency via port 0x42)
- **Disk I/O** — Virtual disk accessible via ports 0x70 (sector select) and 0x71 (read/write)
- **I/O log** — Track port reads/writes during execution

## Getting Started

```bash
npm install
npm run dev
```

Open the local URL shown by Vite. Write assembly in the editor, click **Assemble**, then use **Run** or **Step** to execute.

To run a binary: load a `.bin` file via the memory viewer (switches to BIN mode automatically), or use **Boot** to boot from the virtual disk.

## Commands

```bash
npm run dev       # Dev server with HMR
npm run build     # Production build → dist/
npm run preview   # Preview production build
npm run lint      # ESLint
```

## Execution Engines

| Mode | Trigger | Description |
|---|---|---|
| **AST Interpreter** | Assemble button | Parses assembly text into an instruction tree and interprets it. Supports the full instruction set. |
| **Hardware X86 Decoder** | Boot button or loading a binary file | Decodes real x86 machine code byte-by-byte from memory using CS:IP. Supports the full instruction set. |

The active engine is shown in the header: `AST INTERPRETER` or `X86 HARDWARE`. The code editor is locked while in BIN mode.

## Supported Instructions

Both engines support the same instruction set.

**Data transfer:**
`MOV` `XCHG` `LEA` `LDS` `LES` `XLAT/XLATB` `PUSH` `POP` `PUSHA` `POPA` `PUSHF` `POPF` `LAHF` `SAHF` `IN` `OUT` `LEAVE`

**Arithmetic:**
`ADD` `ADC` `SUB` `SBB` `MUL` `IMUL` `DIV` `IDIV` `INC` `DEC` `NEG` `CMP` `CBW` `CWD`

**BCD/ASCII adjust:**
`AAA` `AAS` `AAM` `AAD` `DAA` `DAS`

**Logic & shifts:**
`AND` `OR` `XOR` `NOT` `TEST` `SHL` `SAL` `SHR` `SAR` `ROL` `ROR` `RCL` `RCR`

**String (with REP/REPE/REPNE prefix):**
`MOVS/MOVSB/MOVSW` `LODS/LODSB/LODSW` `STOS/STOSB/STOSW` `CMPS/CMPSB/CMPSW` `SCAS/SCASB/SCASW`

**Control flow:**
`JMP` `CALL` `RET` `RETF` `LOOP` `LOOPE/LOOPZ` `LOOPNE/LOOPNZ` `JCXZ`
`JZ/JE` `JNZ/JNE` `JA/JNBE` `JAE/JNB/JNC` `JB/JNAE/JC` `JBE/JNA`
`JG/JNLE` `JGE/JNL` `JL/JNGE` `JLE/JNG` `JO` `JNO` `JS` `JNS` `JP/JPE` `JNP/JPO`

**Interrupt:**
`INT` `INTO` `IRET`

**Flag control:**
`STC` `CLC` `CMC` `STD` `CLD` `STI` `CLI`

**Misc:**
`NOP` `HLT` `WAIT` `LOCK` `ESC`

## INT 10h — Video Services

| AH | Function |
|---|---|
| 0x00 | Set video mode / clear screen |
| 0x02 | Set cursor position (DH=row, DL=col) |
| 0x06 | Scroll up / clear window |
| 0x09 | Write character and attribute at cursor (AL=char, BL=attr, CX=count) |
| 0x0E | Teletype output (AL=char); handles `\r`, `\n`, `\b`, auto-scroll |

## Memory Map

| Address | Description |
|---|---|
| 0x00000–0x003FF | Interrupt Vector Table (IVT) |
| 0x00400 | BIOS keyboard buffer |
| 0x07C00–0x07DFF | Boot sector load address (512 bytes) |
| 0xB8000–0xB8F9F | VGA text mode VRAM (80×25 × 2 bytes) |
| 0xF0000–0xF7FFF | BIOS ROM area (32 KB) |

Each VGA cell is two bytes: ASCII character + color attribute (low nibble = foreground, high nibble = background).

## I/O Ports

| Port | Description |
|---|---|
| 0x42 | Timer 2 frequency divider (write low byte then high byte) |
| 0x60 | Keyboard input (also written to memory at 0x0400) |
| 0x61 | PC speaker control (bits 0+1 enable speaker using frequency from port 0x42) |
| 0x70 | Virtual disk sector select |
| 0x71 | Virtual disk transfer: 1 = read sector → DS:BX, 2 = write DS:BX → sector |

## UI Overview

- **ORG (Origin):** Sets the load address and initial IP for the assembler
- **Keep RAM:** Preserves memory contents across Reset/Assemble cycles
- **Memory viewers:** Show 8 rows × 16 bytes at any segment:offset; bytes are editable; a second viewer can be toggled on
- **Load button:** Loads a binary or hex file into memory at the current segment:offset; automatically switches to BIN mode
- **Registers panel:** All 13 registers are editable while not running; flags and their 16-bit binary representation are shown live
