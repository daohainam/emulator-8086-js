# 8086 Emulator

<https://daohainam.github.io/emulator-8086-js/>

A browser-based Intel 8086 CPU emulator with an integrated assembler, debugger, and VGA text mode display. Built with React and Vite.

## Features

- **Two execution engines** — AST interpreter for the code editor, and a true hardware X86 binary decoder for boot/BIN mode
- **Assembler** — Write x86 assembly in the browser editor and run it directly
- **Boot mode** — Load raw binary opcodes onto a virtual disk and boot from it (requires 0xAA55 signature at offset 510)
- **VGA text mode** — 80×25 display with 16-color DOS palette (VRAM at 0xB8000)
- **Interactive debugger** — Step through instructions; inspect and edit registers, flags, and memory in real time
- **Memory file loading** — Load `.bin`, `.hex`, `.com`, `.exe` files directly into RAM at a chosen segment:offset
- **PC speaker** — Audio output via Web Audio API (I/O port 0x61)
- **I/O log** — Track port reads/writes during execution

## Getting Started

```bash
npm install
npm run dev
```

Open the local URL shown by Vite. Write assembly in the editor, click **Assemble**, then use **Run** or **Step** to execute.

To run a binary: load a `.bin` file via the memory viewer or click **Boot** to boot from the virtual disk.

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
| **AST Interpreter** | Assemble button | Parses assembly text into an instruction tree and interprets it. Supports a core subset of instructions. |
| **Hardware X86 Decoder** | Boot button or loading a binary file | Decodes real x86 machine code byte-by-byte from memory, just like the real CPU. Supports the full instruction set below. |

The active engine is shown in the header: `AST INTERPRETER` or `X86 HARDWARE`.

## Supported Instructions (Hardware Engine)

**Data transfer:**
`MOV` `XCHG` `LEA` `LDS` `LES` `XLAT` `PUSH` `POP` `PUSHA` `POPA` `PUSHF` `POPF` `LAHF` `SAHF` `IN` `OUT`

**Arithmetic:**
`ADD` `ADC` `SUB` `SBB` `MUL` `IMUL` `DIV` `IDIV` `INC` `DEC` `NEG` `CMP`

**BCD/ASCII adjust:**
`AAA` `AAS` `AAM` `AAD` `DAA` `DAS` `CBW` `CWD`

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
- `INT 10h AH=0Eh` — TTY character output to VGA

**Flag control:**
`STC` `CLC` `CMC` `STD` `CLD` `STI` `CLI`

**Misc:**
`NOP` `HLT` `WAIT` `LOCK` `ESC`

## Memory Map

| Address | Description |
|---|---|
| 0x00000–0x9FFFF | General RAM (640 KB) |
| 0xB8000–0xB8F9F | VGA text mode VRAM (80×25 × 2 bytes) |

Each VGA cell is two bytes: ASCII character + color attribute (low nibble = foreground, high nibble = background).

## UI Overview

- **ORG (Origin):** Sets the load address and initial IP for the assembler
- **Keep RAM:** Preserves memory contents across Reset/Assemble cycles
- **Memory viewer:** Shows 8 rows × 16 bytes starting at any segment:offset; bytes are editable
- **Load button:** Loads a binary or hex file into memory at the current segment:offset
- **Registers panel:** All 13 registers are editable while not running; flags and their binary representation are shown live
