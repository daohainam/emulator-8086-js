# 8086 Emulator

<https://daohainam.github.io/emulator-8086-js/>

A browser-based Intel 8086 CPU emulator with an integrated assembler, debugger, and VGA text mode display. Built with React and Vite.

## Features

- **Assembler** — Write x86 assembly code and assemble it in the browser
- **CPU emulation** — Full 8086 register set, flags, segmented memory (1MB), and 20+ instructions
- **VGA text mode** — 80×25 display with 16-color DOS palette (mapped at 0xB8000)
- **Interactive debugger** — Step through instructions, inspect/edit registers and flags, view memory
- **Boot mode** — Load raw opcodes onto a virtual 64KB disk and boot from it (requires 0xAA55 signature)
- **PC speaker** — Audio output via Web Audio API (I/O port 0x61)
- **I/O log** — Track port reads/writes during execution

## Getting Started

```bash
npm install
npm run dev
```

Open the local URL shown by Vite. Write assembly in the editor, click **Assemble**, then use **Run** or **Step** to execute.

## Commands

```bash
npm run dev       # Dev server with HMR
npm run build     # Production build → dist/
npm run preview   # Preview production build
npm run lint      # ESLint
```

## Supported Instructions

**Data transfer:**
`MOV` `XCHG` `LEA` `LDS` `LES` `XLAT` `PUSH` `POP` `PUSHA` `POPA` `PUSHF` `POPF` `LAHF` `SAHF` `IN` `OUT`

**Arithmetic:**
`ADD` `ADC` `SUB` `SBB` `MUL` `IMUL` `DIV` `IDIV` `INC` `DEC` `NEG` `CMP`

**BCD/ASCII adjust:**
`AAA` `AAS` `AAM` `AAD` `DAA` `DAS` `CBW` `CWD`

**Logic & shifts:**
`AND` `OR` `XOR` `NOT` `TEST` `SHL` `SAL` `SHR` `SAR` `ROL` `ROR` `RCL` `RCR`

**String:**
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

## Memory Map

| Address | Description |
|---|---|
| 0x00000–0x9FFFF | General RAM |
| 0xB8000–0xB8F9F | VGA text mode VRAM (80×25 × 2 bytes) |

Each VGA cell is two bytes: ASCII character + color attribute (low nibble = foreground, high nibble = background).
