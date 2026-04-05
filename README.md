# 8086 Emulator

<https://daohainam.github.io/emulator-8086-js/>

A browser-based Intel 8086 CPU emulator with an integrated NASM-compatible assembler, hardware binary decoder, debugger, and VGA text mode display. Built with React and Vite.

## Features

- **NASM-compatible assembler** — Write x86 assembly in the browser editor; click **Assemble** to compile directly to machine code and load into RAM
- **Hardware X86 binary decoder** — Executes real x86 machine code byte-by-byte from memory using CS:IP; full 8086 instruction set with ModRM, segment overrides, and REP prefixes
- **Boot mode** — Write a boot sector, click **Boot** to load it at 0x7C00 and start execution (requires `0xAA55` boot signature)
- **VGA text mode** — 80×25 display with 16-color DOS palette (VRAM at 0xB8000)
- **Interactive debugger** — Step through instructions; each Step logs `CS:IP | bytes` to the System Log; inspect and edit registers, flags, and memory in real time
- **Memory viewer** — 8-row × 16-byte hex editor navigable to any segment:offset; load `.bin`/`.com`/`.exe` files directly into RAM
- **Disk viewer** — Hex view and editing of the 64KB virtual disk (32 sectors × 512 bytes)
- **PC speaker** — Audio output via Web Audio API (frequency via port 0x42, enable via port 0x61)
- **Disk I/O** — Virtual disk accessible via ports 0x70 (sector select) and 0x71 (read/write)

## Getting Started

```bash
npm install
npm run dev
```

Open the local URL shown by Vite. Write assembly in the editor, click **Assemble**, then use **Run** or **Step** to execute.

To run a binary: load a `.bin`/`.com` file via the memory viewer, or use **Boot** to boot from the virtual disk.

## Commands

```bash
npm run dev       # Dev server with HMR
npm run build     # Production build → dist/
npm run preview   # Preview production build
npm run lint      # ESLint
```

## Assembly Syntax

The assembler (`src/Assembler8086.js`) is NASM-compatible.

```nasm
ORG 100h              ; Set origin (also updates CS:IP at load time)

start:
    mov ax, 0B800h
    mov es, ax
    xor di, di
    lea si, msg
    mov cx, 5

.loop:
    lodsb
    mov [es:di], al
    inc di
    mov byte [es:di], 0Eh
    inc di
    loop .loop
    hlt

msg db 'Hello'
```

**Directives:**

| Directive | Description |
|---|---|
| `ORG addr` | Set assembly origin and load address |
| `DB val, ...` | Define byte(s); accepts numbers, `'char'`, `"string"` |
| `DW val, ...` | Define word(s) |
| `TIMES n DB/DW val` | Repeat data — `n` may use `$` (current addr) and `$$` (section base) |

**Addressing modes** — all standard 8086 modes supported:

```nasm
mov ax, [bx]          ; register indirect
mov ax, [bx+si]       ; base + index
mov ax, [bp+4]        ; base + displacement
mov ax, [bx+si+10]    ; base + index + displacement
mov ax, [1000h]       ; direct
mov [es:di], al       ; segment override
mov byte [bx], 0Fh    ; size specifier + immediate
```

**Number formats:** `0xFF` · `0FFh` · `255` · `'A'`

## Supported Instructions

**Data transfer:**
`MOV` `XCHG` `LEA` `LDS` `LES` `XLAT/XLATB` `PUSH` `POP` `PUSHA` `POPA` `PUSHF` `POPF` `LAHF` `SAHF` `IN` `OUT` `LEAVE`

**Arithmetic:**
`ADD` `ADC` `SUB` `SBB` `MUL` `IMUL` `DIV` `IDIV` `INC` `DEC` `NEG` `CMP` `CBW` `CWD`

**BCD/ASCII adjust:**
`AAA` `AAS` `AAM` `AAD` `DAA` `DAS`

**Logic & shifts:**
`AND` `OR` `XOR` `NOT` `TEST` `SHL/SAL` `SHR` `SAR` `ROL` `ROR` `RCL` `RCR`

**String (with REP/REPE/REPNE prefix):**
`MOVSB/MOVSW` `LODSB/LODSW` `STOSB/STOSW` `CMPSB/CMPSW` `SCASB/SCASW`

**Control flow:**
`JMP` `CALL` `RET` `RETF` `LOOP` `LOOPE/LOOPZ` `LOOPNE/LOOPNZ` `JCXZ`
`JZ/JE` `JNZ/JNE` `JA/JNBE` `JAE/JNB/JNC` `JB/JNAE/JC` `JBE/JNA`
`JG/JNLE` `JGE/JNL` `JL/JNGE` `JLE/JNG` `JO` `JNO` `JS` `JNS` `JP/JPE` `JNP/JPO`

**Interrupt:** `INT` `INTO` `IRET`

**Flag control:** `STC` `CLC` `CMC` `STD` `CLD` `STI` `CLI`

**Misc:** `NOP` `HLT` `WAIT` `LOCK`

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
| 0x60 | Keyboard input (also written to BIOS buffer at 0x0400) |
| 0x61 | PC speaker control (bits 0+1 enable speaker; frequency set via port 0x42) |
| 0x70 | Virtual disk sector select |
| 0x71 | Virtual disk transfer: 1 = read sector → DS:BX, 2 = write DS:BX → sector |

## UI Overview

- **ORG (Origin):** Used as the load address when the source has no `ORG` directive
- **Keep RAM:** Preserves memory contents across Reset/Assemble cycles
- **Memory viewer:** Shows 8 rows × 16 bytes at any segment:offset; bytes are editable; a second viewer can be toggled on
- **Load button:** Loads a binary file into memory at the current segment:offset
- **Registers panel:** All 13 registers are editable while not running; flags shown live
- **System Logs:** Shows port I/O activity and, for each **Step**, the address and raw bytes of the executed instruction (`CS:IP | XX XX ...`)
