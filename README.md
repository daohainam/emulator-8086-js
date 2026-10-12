# 8086 Emulator

<https://daohainam.github.io/emulator-8086-js/>

A browser-based Intel 8086 CPU emulator with an integrated NASM-compatible assembler, hardware binary decoder, debugger, BIOS and VGA text mode display. Built with React and Vite.

## Features

- **NASM-compatible assembler** — Write x86 assembly in the browser editor; click **Assemble** to compile directly to machine code and load into RAM. Forward references, full NASM integer expressions, `BYTE`/`WORD` size qualifiers, far `JMP`/`CALL`, and a `CPU` directive
- **Strict 8086, optional 80186** — The CPU core is a real 8086 (including its quirks and undocumented opcodes). Pick **80186** in the CPU selector, or put `cpu 186` in the source, to enable `PUSHA/POPA`, `ENTER/LEAVE`, `PUSH imm`, `IMUL r,r/m,imm`, `BOUND`, `INS/OUTS` and shifts by an immediate
- **Hardware X86 binary decoder** — Executes real x86 machine code byte-by-byte from memory using CS:IP, with ModRM, segment overrides, REP prefixes, the trap flag, interrupt shadows and HLT that sleeps until an interrupt
- **Real BIOS interface** — A BIOS ROM is built into segment F000 at reset. Every `INT n` goes through the interrupt vector table, so programs can hook, chain to and replace BIOS vectors. Services are implemented in JavaScript behind small ROM stubs
- **Boot mode** — Write a boot sector, click **Boot** to load it at 0x7C00 and start execution (requires the `0xAA55` boot signature; `DL = 80h`)
- **VGA text mode** — 80×25 display with 16-color DOS palette (VRAM at 0xB8000), cursor and mode kept in the BIOS Data Area
- **Selectable speed** — 4.77 MHz (default), 10 MHz or Max; timing loops behave like real hardware
- **Interactive debugger** — Step through instructions; each Step logs `CS:IP | bytes` to the System Log; inspect and edit registers, flags, and memory in real time
- **Memory viewer** — 8-row × 16-byte hex editor navigable to any segment:offset; load `.bin`/`.com`/`.exe` files directly into RAM
- **Disk viewer** — Hex view and editing of the 128 KB virtual hard disk and the 1.44 MB floppy image
- **PC speaker** — Audio output via Web Audio API (frequency via port 0x42, enable via port 0x61)
- **Hardware models** — 8259 PIC, keyboard controller (scan codes on port 0x60), virtual disk ports

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
npm test          # Vitest: CPU, assembler, BIOS, devices and sample programs
```

### Hardware conformance tests

`npm test` includes an exhaustive 8-bit ALU check and a hardware-conformance runner for the
[SingleStepTests/8086](https://github.com/SingleStepTests/8086) vectors (generated on a real 8086). The vectors are
large, so they are not in the repository: download them yourself into `test/data/8086/v1/` (or point
`SINGLESTEP_DIR` at them) and `npm test` runs them automatically; without the data that suite is skipped.
Use `SINGLESTEP_LIMIT=200` for a quick run and `SINGLESTEP_MIN_PASS` to change the per-opcode pass threshold.

## Assembly Syntax

The assembler (`src/Assembler8086.js`, with `src/asm/`) is NASM-compatible.

```nasm
ORG 100h              ; Set origin (also updates CS:IP at load time)

start:
    mov ax, 0B800h
    mov es, ax
    xor di, di
    mov si, msg           ; msg is defined below: forward references are fine
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
| `ORG addr` / `[ORG addr]` | Set assembly origin and load address |
| `DB/DW/DD val, ...` | Define data; numbers, expressions, `'char'`, `"string"` (strings pad to the unit size like NASM) |
| `TIMES n DB/DW/DD ...` or `TIMES n instr` | Repeat; `n` may use `$` (current addr) and `$$` (section base) |
| `name EQU expr` | Constant; may refer to labels defined later |
| `RESB/RESW/RESD n` | Reserve zeroed space |
| `ALIGN n [, db fill]` | Pad to a multiple of `n` (NOP by default) |
| `CPU 8086` / `CPU 186` | Select the instruction set (186 also switches the emulated CPU) |
| `BITS 16`, `SECTION`, `GLOBAL`, `EXTERN` | Accepted and ignored (only 16-bit code is supported) |
| `%define NAME value` | Text substitution. Other `%` directives are rejected |

**Expressions:** `+ - * / // % %% << >> & | ^ ~ ( )`, `$`, `$$`, labels (`.local` labels supported).
**Number formats:** `0xFF` · `0FFh` · `255` · `0b101` · `101b` · `17o` · `'A'` · `'AB'`.

**Addressing modes** — all standard 8086 modes supported:

```nasm
mov ax, [bx]          ; register indirect
mov ax, [bx+si]       ; base + index
mov ax, [bp+4]        ; base + displacement
mov ax, [bx+si+10]    ; base + index + displacement
mov ax, [table+2]     ; direct (table may be defined later)
mov [es:di], al       ; segment override
mov word [bx], 0F0Fh  ; size specifier + immediate
jmp 0:start           ; far jump (also `call far [mem]`, `jmp far seg:off`)
```

A memory operand without a size that could mean a byte or a word (`mov [x], 5`, `inc [x]`) is an error, as in NASM —
write `byte`/`word`. The one exception is the legacy form `lea si, label`, still accepted.

## Supported Instructions

**Data transfer:**
`MOV` `XCHG` `LEA` `LDS` `LES` `XLAT/XLATB` `PUSH` `POP` `PUSHF` `POPF` `LAHF` `SAHF` `IN` `OUT`

**Arithmetic:**
`ADD` `ADC` `SUB` `SBB` `MUL` `IMUL` `DIV` `IDIV` `INC` `DEC` `NEG` `CMP` `CBW` `CWD`

**BCD/ASCII adjust:**
`AAA` `AAS` `AAM` `AAD` `DAA` `DAS` (`AAM`/`AAD` take an optional base)

**Logic & shifts:**
`AND` `OR` `XOR` `NOT` `TEST` `SHL/SAL` `SHR` `SAR` `ROL` `ROR` `RCL` `RCR` (by 1 or `CL`; by an immediate needs 186)

**String (with REP/REPE/REPNE prefix):**
`MOVSB/MOVSW` `LODSB/LODSW` `STOSB/STOSW` `CMPSB/CMPSW` `SCASB/SCASW`

**Control flow:**
`JMP` `CALL` (near, far, indirect) `RET` `RETF` `LOOP` `LOOPE/LOOPZ` `LOOPNE/LOOPNZ` `JCXZ`
`JZ/JE` `JNZ/JNE` `JA/JNBE` `JAE/JNB/JNC` `JB/JNAE/JC` `JBE/JNA`
`JG/JNLE` `JGE/JNL` `JL/JNGE` `JLE/JNG` `JO` `JNO` `JS` `JNS` `JP/JPE` `JNP/JPO`
(`JMP` is relaxed from short to near automatically; conditional jumps reach ±127 bytes, as on a real 8086)

**Interrupt:** `INT` `INT3` `INTO` `IRET`

**Flag control:** `STC` `CLC` `CMC` `STD` `CLD` `STI` `CLI`

**Misc:** `NOP` `HLT` `WAIT` `LOCK` `SALC`

**80186 only (`cpu 186`):** `PUSHA` `POPA` `ENTER` `LEAVE` `BOUND` `INSB/INSW` `OUTSB/OUTSW`, `PUSH imm`, `IMUL r,r/m,imm`, shifts and rotates by an immediate.

## BIOS Services

All reached with `INT n` through the interrupt vector table.

| Interrupt | Functions |
|---|---|
| `INT 10h` video | 00 set mode · 01 cursor shape · 02/03 set/get cursor · 05 select page · 06/07 scroll up/down · 08 read char/attr · 09/0A write char (+attr) · 0E teletype · 0F get mode · 13 write string · 1A display code |
| `INT 11h` | Equipment list |
| `INT 12h` | Conventional memory size (640 KB) |
| `INT 13h` disk | 00 reset · 01 status · 02/03 read/write CHS · 04 verify · 08 drive parameters · 15 disk type — floppy `DL=00h` and hard disk `DL=80h` |
| `INT 15h` | 86 wait · 88 extended memory (none) · other functions return `CF=1, AH=86h` |
| `INT 16h` keyboard | 00/10 read key (blocks) · 01/11 peek · 02/12 shift flags · 05 store key |
| `INT 1Ah` time | 00/01 tick count · 02/04 RTC time/date (host clock) |

Unused vectors point at a dummy `IRET`; hardware IRQ vectors 08h–0Fh acknowledge the PIC. A divide error or invalid
opcode with no guest handler stops the emulator with a message instead of running garbage. `HLT` sleeps until an
interrupt when interrupts are enabled and an IRQ is unmasked, and stops the emulator otherwise (so programs that end in
`hlt` still stop).

## Memory Map

| Address | Description |
|---|---|
| 0x00000–0x003FF | Interrupt Vector Table (IVT) |
| 0x00400–0x004FF | BIOS Data Area (keyboard buffer, video mode, cursor, tick counter, ...) |
| 0x07C00–0x07DFF | Boot sector load address (512 bytes) |
| 0xB8000–0xBFFFF | VGA text pages (80×25 × 2 bytes, 4 KB each) |
| 0xF0000–0xFFFFF | BIOS ROM (write-protected for the CPU): service stubs at F000:E000, reset vector at FFFF:0000 |

Each VGA cell is two bytes: ASCII character + color attribute (low nibble = foreground, high nibble = background).
After a reset the CPU starts at `FFFF:0000`, which jumps to an idle `HLT` in ROM; **Assemble** and **Boot** start your
program with the flags/registers a finished POST would leave (`IF=1`, `SP=FFFE`; boot also sets `DL=80h`, `SP=7C00`).

## I/O Ports

| Port | Description |
|---|---|
| 0x20/0x21 | 8259 PIC (command / data). Reset state: all IRQs masked, vector base 08h |
| 0x42 | Timer 2 frequency divider (write low byte then high byte) |
| 0x60 | Keyboard controller output: scan codes (set 1), make on press, make\|0x80 on release |
| 0x61 | PC speaker control (bits 0+1 enable speaker; frequency set via port 0x42) |
| 0x64 | Keyboard controller status (bit 0 = output buffer full) |
| 0x70 | Virtual disk block select (0–255, 16 bytes each) |
| 0x71 | Virtual disk transfer: 1 = block → DS:BX, 2 = DS:BX → block. These two ports collide with the AT CMOS/RTC; prefer `INT 13h` |

Ports that no device claims read as `0xFF`. There is no PIT (ports 0x40–0x43 other than the speaker divider) and no IRQ0
timer yet: `INT 1Ah` and the BDA tick counter follow the host clock instead.

**Keyboard:** the host plays the role of the BIOS keyboard handler. A key press puts an (ASCII, scan code) pair into the BDA
buffer for `INT 16h` and also delivers the scan code through port 0x60 with an IRQ1 pulse, so a program that installs
its own `INT 9` handler (and unmasks IRQ1) sees real hardware behaviour. Keys typed in the code editor never reach the
emulator — click the VGA screen or the "Type here" field first.

## UI Overview

- **ORG (Origin):** Used as the load address when the source has no `ORG` directive. An `ORG` in the source (including the bracketed `[ORG ...]` form, with or without a trailing comment) always takes precedence.
- **CPU:** `8086` or `80186`. A `cpu 186` line in the source selects 186 when you assemble.
- **Speed:** 4.77 MHz, 10 MHz or Max.
- **Memory viewer:** Shows 8 rows × 16 bytes at any segment:offset; bytes are editable; a second viewer can be toggled on
- **Load button:** Loads a binary file into memory at the current segment:offset
- **Registers panel:** All 13 registers are editable while not running; flags shown live
- **System Logs:** Shows port I/O activity, assembler warnings, and, for each **Step**, the address and raw bytes of the executed instruction (`CS:IP | XX XX ...`)

## Samples

`samples/` holds ready-to-assemble programs: `hello8086` (direct VGA writes), `helloworld` and `keyboard` (BIOS INT 10h/16h),
`reverse-string`, `bootsector` (Boot mode), `int-hook` (hook and chain a BIOS vector) and `hlt-wait` (sleep in `HLT` until the
keyboard IRQ). The `bios/` folder holds an older standalone ROM source that the emulator no longer loads; the built-in
BIOS lives in `src/bios/`.
